// 4 个核心 control tools：hi_agent_status / hi_agent_install / hi_agent_doctor / hi_agent_reset。
// 业务逻辑全部委托给 @hirey/hi-agent-sdk 已封装好的 platform/gateway client，本文件只做：
// - input schema 定义
// - state file 持久化跟 OAuth client 装配
// - tool result 组装

import type { PluginToolDefinition, PluginToolResult, HiOpenClawPluginConfig } from '../types.js';
import type { AgentGatewayTopic } from '@hirey/hi-agent-sdk';
import {
  INSTALL_WELCOME_ONBOARDING_KIND,
  INSTALL_WELCOME_ONBOARDING_INSTRUCTION,
  DEFAULT_INTENT_OPTIONS,
  type RecentActivityItem,
  type BootstrapOnboardingPayload,
} from '@hirey/hi-agent-contracts';
import {
  buildAuthorizedClients,
  buildPublicClients,
  loadStateWithQuarantine,
  peekQuarantineNotice,
} from '../clients.js';
import {
  resolveStateDir,
  resolveStateFile,
  updateState,
  type HiIdentityState,
} from '../state.js';
import { ensureOpenClawHooksConfigured, ensurePluginToolsAlsoAllowed, readGatewayPort } from '../utils/openclaw-config.js';
import { buildErrorDetailFields } from '../utils/error-detail.js';
import { PLUGIN_VERSION } from '../version.js';
import fs from 'node:fs/promises';

function defaultStateDir(config: Required<HiOpenClawPluginConfig>): string {
  return config.stateDir || resolveStateDir(config.profile);
}

function asJsonResult(payload: Record<string, unknown>): PluginToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function asErrorResult(error: string, details?: Record<string, unknown>): PluginToolResult {
  const payload: Record<string, unknown> = { ok: false, error };
  if (details) Object.assign(payload, details);
  return { ...asJsonResult(payload), isError: true };
}

// ---------- hi_agent_status ----------
export function buildHiAgentStatusTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: 'hi_agent_status',
    label: 'Hi agent status',
    description:
      'Reports whether Hirey AI is healthy on this OpenClaw host. Reads local plugin state and (when include_remote=true) verifies platform-side identity is still recognized. Run this when the user asks "is Hi working?" or before any other Hi tool call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_remote: {
          type: 'boolean',
          description: 'When true, also call the Hi platform /me endpoint to confirm the agent identity is recognized server-side. Default false.',
          default: false,
        },
      },
    },
    async execute(_id, params): Promise<PluginToolResult> {
      const args = (params || {}) as { include_remote?: boolean };
      try {
        const state = await loadStateWithQuarantine(stateDir, config.profile, config.platformBaseUrl);
        const summary = {
          ok: true,
          plugin: 'hi-openclaw-plugin',
          plugin_version: PLUGIN_VERSION,
          profile: config.profile,
          state_dir: stateDir,
          state_file: resolveStateFile(stateDir, config.profile),
          platform_base_url: config.platformBaseUrl,
          webhook_path: config.webhookPath,
          quarantined_stale_identity: peekQuarantineNotice(),
          summary: {
            connected: !!state.identity,
            activated: !!state.identity?.activated_at,
            agent_id: state.identity?.agent_id ?? null,
            installation_id: state.identity?.installation_id ?? null,
          },
          state,
          remote: null as Record<string, unknown> | null,
        };
        if (args.include_remote && state.identity) {
          try {
            const auth = await buildAuthorizedClients({
              stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl,
            });
            const [me, installation, endpoints, subscriptions] = await Promise.all([
              auth.gateway.me(),
              auth.gateway.getInstallation(),
              auth.gateway.listEndpoints(),
              auth.gateway.listSubscriptions(),
            ]);
            summary.remote = { me, installation, endpoints, subscriptions };
          } catch (err: any) {
            summary.remote = { error: String(err?.message || err) };
          }
        }
        return asJsonResult(summary);
      } catch (err: any) {
        return asErrorResult('hi_agent_status_failed', buildErrorDetailFields(err));
      }
    },
  };
}

// ---------- hi_agent_install ----------
export function buildHiAgentInstallTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: 'hi_agent_install',
    label: 'Hi agent install',
    description:
      'One-shot install entrypoint. Registers a fresh Hi agent (or reuses existing identity), activates installation, declares delivery capabilities, subscribes to default event topics, and persists identity for subsequent Hi tool calls. Idempotent — calling it after a healthy install just refreshes installation/subscription state.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        display_name: {
          type: 'string',
          description: 'Human-readable agent name. Defaults to "OpenClaw Hi Agent" if omitted.',
        },
        agent_kind: {
          type: 'string',
          description: 'Agent kind ("external" by default).',
        },
        host_session_key: {
          type: 'string',
          description: 'OpenClaw current chat canonical session key (sessions.recent[0].key). Used to bind this chat as default reply route. Optional in plugin mode — the gateway already knows the current session.',
        },
        replace_existing_state: {
          type: 'boolean',
          description: 'Force fresh registration even if existing identity is present. Default false (idempotent).',
          default: false,
        },
        subscribe_default_topics: {
          type: 'boolean',
          description: 'Subscribe to all default event topics (agent.message.created, pairing.*, listing_matching_session.updated, meeting.*, hi.release.published). Default true.',
          default: true,
        },
        metadata: {
          type: 'object',
          description: 'Optional caller-supplied metadata merged into agent metadata at first register. Common use: channel attribution `{"channel_code":"..."}` from an invite landing page. The plugin still reserves the keys host/plugin/plugin_version (always set to identify this plugin) — caller-supplied values for those keys will be ignored. MUST forward channel_code from the user prompt verbatim — do not drop it, do not modify the value.',
          additionalProperties: true,
        },
      },
    },
    async execute(_id, params): Promise<PluginToolResult> {
      const args = (params || {}) as {
        display_name?: string;
        agent_kind?: string;
        host_session_key?: string;
        replace_existing_state?: boolean;
        subscribe_default_topics?: boolean;
        metadata?: Record<string, unknown>;
      };
      try {
        let state = await loadStateWithQuarantine(stateDir, config.profile, config.platformBaseUrl);

        // Step 1: register if needed
        let registerResp: any = null;
        if (!state.identity || args.replace_existing_state) {
          const pub = await buildPublicClients(config.platformBaseUrl);
          // 调用方 metadata（典型来源：邀请落地页生成的 prompt 里 channel_code）先铺底，
          // 然后强制覆盖 host/plugin/plugin_version 三个保留字段——既允许渠道归因这种
          // 自定义 key 透传，又不让恶意调用方伪造 host=openclaw 之类的标记。
          const callerMetadata =
            args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
              ? args.metadata
              : {};
          registerResp = await pub.gateway.register({
            display_name: args.display_name?.trim() || 'OpenClaw Hi Agent',
            agent_kind: args.agent_kind?.trim() || 'external',
            capabilities: [],
            metadata: {
              ...callerMetadata,
              host: 'openclaw',
              plugin: 'hi-openclaw-plugin',
              plugin_version: PLUGIN_VERSION,
            },
          });
          const identity: HiIdentityState = {
            agent_id: registerResp.agent.agent_id,
            installation_id: registerResp.installation.installation_id,
            display_name: registerResp.agent.display_name,
            agent_kind: registerResp.agent.agent_kind,
            client_id: registerResp.auth.client_id,
            client_secret: registerResp.auth.client_secret,
            installation_subject: registerResp.auth.installation_subject ?? registerResp.installation.installation_id,
            issuer: registerResp.auth.issuer,
            audience: registerResp.auth.audience,
            token_url: registerResp.auth.token_url,
            jwks_url: registerResp.auth.jwks_url,
            activated_at: null,
            delivery_capabilities: null,
          };
          state = await updateState(stateDir, config.profile, (cur) => ({
            ...cur,
            platform: { platform_base_url: config.platformBaseUrl, registry_base_url: config.platformBaseUrl, fetched_at: new Date().toISOString() },
            identity,
          }));
        }

        // Step 2: build authorized clients
        const auth = await buildAuthorizedClients({ stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl });

        // Step 3: activate (idempotent)
        let activateResp: any = null;
        if (!state.identity?.activated_at) {
          activateResp = await auth.gateway.activate({});
          state = await updateState(stateDir, config.profile, (cur) => ({
            ...cur,
            identity: cur.identity ? { ...cur.identity, activated_at: activateResp.installation.activated_at ?? new Date().toISOString() } : cur.identity,
          }));
        }

        // Step 4: declare delivery capabilities + bind session
        // Native plugin 跑在用户本机的 OpenClaw gateway 进程内，daemon 主动从平台 SSE / claim
        // 拉事件再 POST hooks/agent —— 这在 hi 平台业务定义上等价于"本机 receiver daemon"。
        // 因此声明 local_receiver（让 hi 平台的 bootstrap install_welcome_recommendation 等
        // 业务 push gate 把我们识别为可送达的 host receiver）+ pull_stream（声明 SSE 这条主路径）
        // + claim_ack（声明 fallback 路径）。preferred=local_receiver 跟老 hi-agent-receiver
        // 的官方语义对齐，让平台业务层对我们的对待跟传统 receiver 完全一致。
        //
        // 注意 platform schema 约束：route_missing_policy=use_explicit_default_route 必须搭配
        // 实际的 default_reply_route 对象；没 host_session_key 时直接 omit 这两个字段，让平台走
        // 默认 (route_missing_policy=use_last_active_session) 兜底。
        const deliveryCapsBody: Record<string, unknown> = {
          preferred: 'local_receiver',
          capabilities: [
            { kind: 'local_receiver', status: 'active', config: {} },
            { kind: 'pull_stream', status: 'active', config: {} },
            { kind: 'claim_ack', status: 'active', config: {} },
          ],
        };
        if (args.host_session_key) {
          deliveryCapsBody.route_missing_policy = 'use_explicit_default_route';
          deliveryCapsBody.default_reply_route = {
            installation_id: state.identity!.installation_id,
            session_key: args.host_session_key,
            delivery_context: { channel: 'last', to: null, account_id: null, thread_id: null },
          };
        }
        let installationUpdate: any = null;
        let installationUpdateError: { message: string; response_body?: unknown } | null = null;
        try {
          installationUpdate = await auth.gateway.updateInstallation({
            delivery_capabilities: deliveryCapsBody,
          } as any);
        } catch (err: any) {
          // SDK 把详细 error 吞了，这里包一份 surface 出去，让 doctor / install caller 看见到底
          // 是 schema 拒绝还是平台 5xx 还是别的。安装的其它步骤照样视为成功（identity 已建好）。
          installationUpdateError = {
            message: String(err?.message || err),
            response_body: err?.response_body ?? err?.responseBody ?? err?.body ?? null,
          };
        }

        // Step 4.5: 保证 OpenClaw 主 config 的 hooks 段被启用 + 写入一致的 hooks_token，
        // 这样 native plugin daemon 拉到 hi event 后可以 POST 进 /hooks/agent 触发 isolated
        // agentTurn，OpenClaw 自动按 hook payload 的 channel/to 路由把 LLM 输出投递给用户。
        // 等价于老 bundle plugin 的 buildManagedHooksConfig + openclaw config set hooks。
        let hooksConfigure: {
          hooks_token: string; hooks_path: string; gateway_port: number; changed: boolean;
        } | null = null;
        let hooksConfigureError: { message: string } | null = null;
        try {
          const existingState = state;
          const existingToken = existingState.runtime?.install?.hooks_token || null;
          const ensure = await ensureOpenClawHooksConfigured({
            preferredToken: existingToken,
          });
          // 保证 plugin tools 在当前 tools.profile 下能被 LLM 看见 —— 程序化加 alsoAllow
          // group:plugins，避免让 LLM 自己改 tools.allow 把 core 工具误 override 掉。
          await ensurePluginToolsAlsoAllowed().catch(() => {});
          const gatewayPort = await readGatewayPort();
          hooksConfigure = {
            hooks_token: ensure.hooks_token,
            hooks_path: ensure.hooks_path,
            gateway_port: gatewayPort,
            changed: ensure.changed,
          };
          state = await updateState(stateDir, config.profile, (cur) => ({
            ...cur,
            runtime: {
              ...cur.runtime,
              install: {
                ...cur.runtime.install,
                host_kind: 'openclaw_native_plugin',
                hooks_token: ensure.hooks_token,
                hooks_path: ensure.hooks_path,
                gateway_port: gatewayPort,
              },
            },
          }));
        } catch (err: any) {
          hooksConfigureError = { message: String(err?.message || err) };
        }

        // Step 5: subscribe default topics
        // 注意：installed @hirey/hi-agent-sdk@0.1.10 的 AgentGatewayTopic union 还是老 6-topic 版（漏 hi.release.published），
        // 但平台已经支持 hi.release.published（0.1.11 sdk 才在 type 里加进来）。这里用 string[] + cast 绕开 type 漂移。
        const defaultTopics: string[] = [
          'agent.message.created', 'pairing.created', 'pairing.updated',
          'listing_matching_session.updated', 'meeting.negotiation.updated',
          'meeting.execution.requested', 'hi.release.published',
        ];
        let subscriptionsResp: any = null;
        if (args.subscribe_default_topics !== false) {
          subscriptionsResp = await auth.gateway.upsertSubscriptions({
            subscriptions: defaultTopics.map((topic) => ({
              topic: topic as AgentGatewayTopic,
              status: 'active' as const,
            })),
          });
        }

        // Step 6: post-install welcome onboarding。
        //
        // 跟 hi-mcp-server handleInstall 完全镜像设计——native plugin 用户**没有**装任何
        // hi 相关的 SKILL.md（OpenClaw 5.2+ 走 native plugin 路径），所以平台必须把
        // onboarding 行为规则**直接塞进 install 工具 result**，让 LLM 不依赖外部 SKILL
        // 也能跑 welcome 流程。这是覆盖 native plugin 主流路径的唯一同步入口。
        //
        // 业界 SaaS / 对话式 AI onboarding 共识（Build context, Ask intent EARLY, Show
        // populated state preview, Single clear next action）+ 我们 prod 数据观察（10 个
        // 新装 owner 里只有一半发了 friendship listing，剩下一半实际意图是招聘 / 找房 /
        // 合伙人）共同推出的引导设计。
        //
        // 同步路径覆盖**新装**用户；**存量**用户由 platform 端 bootstrapOnboardingFanOut
        // Worker 异步覆盖；两路 dedup 信号是 owner listing 状态（push instruction 里明确
        // 要求收到时先调 agent_listings.list，listings.length>0 就 silently consume）。
        //
        // 失败 fail-soft：拉 recent_activity 的 capability 调用任何环节失败都不影响
        // install 主流程返回 ok（welcome 是 instruction + intent_options 为核心，
        // recent_activity 只是 populated state 增强）。welcome.recent_activity_error
        // 字段把失败原因留给 LLM 知道。
        let welcome:
          | (BootstrapOnboardingPayload & { recent_activity_error?: string })
          | null = null;
        try {
          // 仅在 install 主链没出错且 hooks 配好时跑 welcome：identity 没建好 / installation
          // 还没激活时调 capability 必然 401/403，没意义且会污染 install result。
          const installOk = !installationUpdateError && !hooksConfigureError;
          if (installOk && state.identity?.activated_at) {
            let recentActivity: RecentActivityItem[] = [];
            let recentActivityError: string | null = null;
            try {
              const callResult = (await auth.platform.callCapability('hi.agent-listings', {
                action: 'browse_recent',
                limit: 8,
              })) as { ok?: boolean; result?: { items?: unknown } } | undefined;
              const items = (callResult?.result as any)?.items;
              if (Array.isArray(items)) {
                recentActivity = items
                  .filter((it: any) => it && typeof it === 'object')
                  .map((it: any) => ({
                    listing_id: String(it.listing_id || ''),
                    listing_type_id: String(it.listing_type_id || ''),
                    published_by_agent_id: String(it.published_by_agent_id || ''),
                    target_preview_text: String(it.target_preview_text || ''),
                    listing_created_at: String(it.listing_created_at || ''),
                  }))
                  .filter((it: RecentActivityItem) => it.listing_id && it.target_preview_text);
              } else {
                recentActivityError = 'browse_recent_returned_no_items_array';
              }
            } catch (err: any) {
              recentActivityError = String(err?.message || err || 'browse_recent_failed').slice(0, 240);
            }
            welcome = {
              kind: INSTALL_WELCOME_ONBOARDING_KIND,
              instruction_to_llm: INSTALL_WELCOME_ONBOARDING_INSTRUCTION,
              recent_activity: recentActivity,
              intent_options: [...DEFAULT_INTENT_OPTIONS],
              ...(recentActivityError ? { recent_activity_error: recentActivityError } : {}),
            };
          }
        } catch {
          // welcome 整体失败也 fail-soft：install 主流程返回 ok=true，welcome=null 让 LLM
          // fallback 到自然行为（拿到 install ok 后给 owner 一句"装好了"），不阻断 install。
          welcome = null;
        }

        return asJsonResult({
          ok: !installationUpdateError && !hooksConfigureError,
          profile: config.profile,
          state_dir: stateDir,
          quarantined_stale_identity: peekQuarantineNotice(),
          register: registerResp,
          activate: activateResp,
          installation: installationUpdate,
          installation_update_error: installationUpdateError,
          subscriptions: subscriptionsResp,
          hooks_configure: hooksConfigure,
          hooks_configure_error: hooksConfigureError,
          summary: {
            agent_id: state.identity?.agent_id,
            installation_id: state.identity?.installation_id,
            connected: true,
            activated: !!state.identity?.activated_at,
            event_path: 'plugin_native_hooks_loopback',
            installation_update_succeeded: !installationUpdateError,
            hooks_ready: !!hooksConfigure && !hooksConfigureError,
            push_path_hint: hooksConfigure
              ? `http://127.0.0.1:${hooksConfigure.gateway_port}${hooksConfigure.hooks_path}/agent`
              : null,
          },
          welcome,
        });
      } catch (err: any) {
        return asErrorResult('hi_agent_install_failed', {
          ...buildErrorDetailFields(err),
          stack: err?.stack,
        });
      }
    },
  };
}

// ---------- hi_agent_doctor ----------
export function buildHiAgentDoctorTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: 'hi_agent_doctor',
    label: 'Hi agent doctor',
    description:
      'Comprehensive health check: verifies persisted identity, OAuth token exchange, gateway-side activation, delivery capability declaration, and (when probe_delivery=true) sends a test delivery to confirm the webhook route works end-to-end.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_remote: {
          type: 'boolean',
          description: 'Fetch /me, /installation, /endpoints, /subscriptions from the gateway. Default true.',
          default: true,
        },
        probe_delivery: {
          type: 'boolean',
          description: 'Send a test event through the gateway to confirm webhook delivery actually fires. Default true.',
          default: true,
        },
      },
    },
    async execute(_id, params): Promise<PluginToolResult> {
      const args = (params || {}) as { include_remote?: boolean; probe_delivery?: boolean };
      const blockers: string[] = [];
      const warnings: string[] = [];
      try {
        const state = await loadStateWithQuarantine(stateDir, config.profile, config.platformBaseUrl);
        if (!state.identity) {
          blockers.push('identity_missing');
          return asJsonResult({
            ok: false, blockers, warnings,
            connected: false, activated: false,
            quarantined_stale_identity: peekQuarantineNotice(),
          });
        }
        const auth = await buildAuthorizedClients({ stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl });
        const installation = await auth.gateway.getInstallation();
        const activated = !!installation.installation?.activated_at;
        if (!activated) blockers.push('not_activated');

        let me: any = null;
        let endpoints: any = null;
        let subscriptions: any = null;
        if (args.include_remote !== false) {
          [me, endpoints, subscriptions] = await Promise.all([
            auth.gateway.me(),
            auth.gateway.listEndpoints(),
            auth.gateway.listSubscriptions(),
          ]);
        }

        let deliveryProbe: any = null;
        if (args.probe_delivery !== false && activated) {
          try {
            deliveryProbe = await auth.gateway.testDelivery({
              event_type: 'plugin.delivery.probe',
              preview: { title: 'plugin self-probe', text: 'hi-openclaw-plugin doctor delivery probe' },
            } as any);
            // 把 results[*].ok=false 拆成两类，对齐 Kubernetes liveness/readiness 的设计
            // 哲学（"detect only true unrecoverable failures，否则会 cascading failure"）：
            //
            //   - timeout（local_receiver_delivery_timeout）：probe round-trip 超过 platform
            //     gateway 的 LOCAL_RECEIVER_TEST_TIMEOUT_MS=15s，几乎全是因为 daemon 投到
            //     OpenClaw /hooks/agent 后被 isolated agent turn 同步占用（normal turn
            //     1~3 分钟），15s 之内根本不可能 ack 回来。这种 "probe timing model 跟
            //     production 投递路径不匹配" 的现象不代表 push 实际坏掉，所以归 warnings，
            //     不进 blockers，不让 owner 误以为 push 不工作。
            //   - hard failure（local_receiver_test_event_not_found / hook_delivery_4xx /
            //     auth/route 类）：是 daemon 真的没把 event 收回来或者 OpenClaw 端拒收，
            //     production push 同样会失败，进 blockers 让 owner 看到。
            for (const r of (deliveryProbe?.results ?? []) as Array<{ ok: boolean; error?: string }>) {
              if (r.ok) continue;
              const errCode = String(r.error || '');
              if (errCode === 'local_receiver_delivery_timeout') {
                warnings.push(
                  'delivery_probe_timeout: probe ack did not return within gateway 15s window; '
                  + 'OpenClaw /hooks/agent likely blocked on a synchronous isolated agent turn '
                  + '(normal turn budget exceeds probe budget). Production push delivery is unaffected.',
                );
                continue;
              }
              blockers.push(`delivery_probe_failed:${errCode || 'unknown'}`);
            }
          } catch (err: any) {
            blockers.push('delivery_probe_threw:' + String(err?.message || err));
          }
        }

        // push_ready 现在真正反映 "production push 路径是否健康"：probe 跑完且没出现
        // hard failure（hook 4xx / event_not_found / probe_threw 等）。timeout-only 的失败
        // 已经在上面降级成 warnings，不影响 push_ready；这跟 probe round-trip 跟 production
        // 路径解耦的 doctor 设计一致。
        const probeHadHardFailure = blockers.some((b) =>
          b.startsWith('delivery_probe_failed:') || b.startsWith('delivery_probe_threw:'),
        );
        const pushReady = !!deliveryProbe?.ok && !probeHadHardFailure;
        return asJsonResult({
          ok: blockers.length === 0,
          profile: config.profile,
          platform_base_url: config.platformBaseUrl,
          state_dir: stateDir,
          quarantined_stale_identity: peekQuarantineNotice(),
          connected: true,
          activated,
          push_ready: pushReady,
          blockers, warnings,
          delivery_capabilities: installation.installation?.delivery_capabilities ?? null,
          remote: { me, installation, endpoints, subscriptions },
          delivery_probe: deliveryProbe,
        });
      } catch (err: any) {
        return asErrorResult('hi_agent_doctor_failed', buildErrorDetailFields(err));
      }
    },
  };
}

// ---------- hi_agent_reset ----------
export function buildHiAgentResetTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: 'hi_agent_reset',
    label: 'Hi agent reset',
    description:
      'Reset local Hi state: clears persisted identity + receiver runtime cursor. The Hi agent on the platform side is NOT destroyed; it just becomes orphan from this OpenClaw host. Run hi_agent_install afterward to register a fresh agent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        clear_state: {
          type: 'boolean',
          description: 'Delete the state file. Default true.',
          default: true,
        },
      },
    },
    async execute(_id, params): Promise<PluginToolResult> {
      const args = (params || {}) as { clear_state?: boolean };
      try {
        const file = resolveStateFile(stateDir, config.profile);
        if (args.clear_state !== false) {
          await fs.rm(file, { force: true });
        }
        return asJsonResult({ ok: true, cleared: args.clear_state !== false, state_file: file });
      } catch (err: any) {
        return asErrorResult('hi_agent_reset_failed', buildErrorDetailFields(err));
      }
    },
  };
}

// ---------- hi_pull_events ----------
// 替代 daemon claim loop：LLM 主动调一下，从平台拉一次最新 owner-actionable events。
// 跟 OpenClaw native plugin 的 lazy/in-process 哲学一致：不开后台周期循环，而是 LLM 在
// 用户问"有没有人发消息/匹配怎么样"时按需拉。还能让 LLM 自己控制频率，避免 OOM/socket 累积。
export function buildHiPullEventsTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: 'hi_pull_events',
    label: 'Hi pull events',
    description:
      'Pull (claim) the latest owner-actionable events from the Hi platform once, ack them, and return their topics/payloads. Use this when the user asks about new Hi activity (incoming pairings, messages, meeting proposals, releases) or before deciding whether to act on a thread. Lightweight on-demand replacement for a background daemon — call it whenever fresh state is needed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'integer',
          description: 'Max events to claim in one call. Default 20.',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
        lease_ms: {
          type: 'integer',
          description: 'Lease length to request from the platform. Default 60000.',
          default: 60000,
          minimum: 5000,
          maximum: 300000,
        },
        ack: {
          type: 'boolean',
          description: 'Ack consumed events back to the platform so they will not be re-delivered. Default true.',
          default: true,
        },
      },
    },
    async execute(_id, params): Promise<PluginToolResult> {
      const args = (params || {}) as { limit?: number; lease_ms?: number; ack?: boolean };
      try {
        const auth = await buildAuthorizedClients({
          stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl,
        });
        const claim = await auth.gateway.claimEvents({
          limit: args.limit ?? 20,
          lease_ms: args.lease_ms ?? 60_000,
        } as any);
        const items = (claim?.items ?? []) as any[];
        if (args.ack !== false && items.length > 0) {
          try {
            await auth.gateway.ackEvents({
              lease_id: claim.claim_lease_id,
              acks: items.map((ev: any) => ({ event_id: ev.event_id, status: 'consumed', stream_seq: ev.stream_seq })),
            } as any);
          } catch (err: any) {
            return asJsonResult({
              ok: true,
              claimed: items.length,
              items,
              ack_error: String(err?.message || err),
              claim_lease_id: claim.claim_lease_id ?? null,
            });
          }
        }
        return asJsonResult({
          ok: true,
          claimed: items.length,
          items,
          claim_lease_id: claim.claim_lease_id ?? null,
        });
      } catch (err: any) {
        return asErrorResult('hi_pull_events_failed', buildErrorDetailFields(err));
      }
    },
  };
}

export function buildAllControlTools(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition[] {
  return [
    buildHiAgentStatusTool(config),
    buildHiAgentInstallTool(config),
    buildHiAgentDoctorTool(config),
    buildHiAgentResetTool(config),
    buildHiPullEventsTool(config),
  ];
}
