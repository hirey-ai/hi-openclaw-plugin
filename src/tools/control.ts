// 9 个本地 control tools：安装、状态、诊断、恢复、事件和身份收敛。
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
  type BootstrapOnboardingPayload,
} from '@hirey/hi-agent-contracts';
import {
  buildAuthorizedClients,
  invalidateAuthorizedClients,
  ensureCredential,
  getStatusPluginReleasePolicy,
  loadStateWithQuarantine,
  peekQuarantineNotice,
} from '../clients.js';
import {
  resolveStateDir,
  resolveOpenClawStateRoot,
  resolveStateFile,
  updateState,
} from '../state.js';
import {
  ensureOpenClawHooksConfigured,
  ensurePluginToolsAlsoAllowed,
  findRecentUserSessionKey,
  readGatewayPort,
  resolveOpenClawConfigPath,
} from '../utils/openclaw-config.js';
import { buildErrorDetailFields } from '../utils/error-detail.js';
import { PLUGIN_VERSION } from '../version.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

function defaultStateDir(config: Required<HiOpenClawPluginConfig>): string {
  return config.stateDir || resolveStateDir(config.profile);
}

export function isVerifiedModernIdentity(me: any, storedAgentId: string): boolean {
  return ['agent_id','person_id','workspace_id','agent_session_id'].every(key =>
    typeof me?.[key] === 'string' && me[key].trim().length > 0)
    && !!storedAgentId && me.agent_id === storedAgentId;
}

// 找 OpenClaw workspace 路径——register API 不暴露，只能从已知约定推。
// 优先级：env > openclaw.json 里 agents.defaults.workspace > 默认 ~/.openclaw/workspace。
function resolveOpenClawWorkspaceDir(): string {
  const envDir = (process.env.OPENCLAW_WORKSPACE_DIR || '').trim();
  if (envDir) return envDir;
  // try openclaw.json
  try {
    const cfg = JSON.parse(
      fsSync.readFileSync(resolveOpenClawConfigPath(), 'utf8'),
    );
    const wd = cfg?.agents?.defaults?.workspace;
    if (typeof wd === 'string' && wd.trim()) return wd.trim();
  } catch {
    // file missing / parse error / ...：都没所谓，用约定默认
  }
  return path.join(resolveOpenClawStateRoot(), 'workspace');
}

// OpenClaw 的"它叫什么名字"在 workspace/IDENTITY.md。SOUL.md 协议要求 LLM 每个 session
// 都读 IDENTITY.md，绝大多数活跃 OpenClaw 都会填好 Name 字段。我们 install 时直接读这个
// 文件来取真实的 agent 名字，避免所有人 display_name 都掉成同一个 'OpenClaw Hi Agent' 默认值。
//
// 文件长这样（模板 + 填好 = 都常见）：
//   - **Name:** Sage
//     _(pick something you like)_
//
// 用户填的 LLM 通常会把占位符 _(...)_ 留下或删掉，所以不能光看下一行。
// 我们用 inline 正则抓 ** Name :** 后面那一段；如果抓到的是模板占位符 _(...)_、空字符串、
// 或包含 "pick something" 这类提示词，就当成"还没填"返回 null。
function readOpenClawIdentityName(workspaceDir: string): string | null {
  try {
    const file = path.join(workspaceDir, 'IDENTITY.md');
    const content = fsSync.readFileSync(file, 'utf8');
    // 抓 "**Name:** XXX"，inline 形式（同一行有内容），避免抓到下一行的占位说明。
    const inline = content.match(/\*\*Name:\*\*[ \t]+([^\n_*][^\n]*)/);
    if (inline) {
      const raw = inline[1].trim();
      // 模板占位 / 空 / 仍是提示词：当成没填
      if (!raw) return null;
      if (raw.startsWith('_(') || raw.startsWith('(')) return null;
      if (/pick something|fill this/i.test(raw)) return null;
      // 限制长度，防 LLM 误填进段落
      return raw.slice(0, 80);
    }
    // 抓下一行的形式："**Name:**\nFoo"
    const block = content.match(/\*\*Name:\*\*[^\n]*\n[ \t]*([^\n_*][^\n]*)/);
    if (block) {
      const raw = block[1].trim();
      if (!raw) return null;
      if (raw.startsWith('_(') || raw.startsWith('(')) return null;
      if (/pick something|fill this/i.test(raw)) return null;
      return raw.slice(0, 80);
    }
    return null;
  } catch {
    return null;
  }
}

// Defense in depth for remote control responses, including nested installation
// credentials. Claim-export's short-lived claim_token is intentionally supported.
export function redactControlCredentials(value: unknown): any {
  if (Array.isArray(value)) return value.map(redactControlCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/^(client_secret|api_key|hooks_token|access_token|refresh_token|authorization|password|secret)$/i.test(key),
  ).map(([key, item]) => [key, redactControlCredentials(item)]));
}

function asJsonResult(payload: Record<string, unknown>): PluginToolResult {
  const safe = redactControlCredentials(payload);
  return {
    structuredContent: safe,
    content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }],
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
        // Policy and identity are independent remote reads. Start the bounded
        // policy check now, but do not delay OAuth/discovery or the real /me.
        const pluginPolicy = getStatusPluginReleasePolicy(config.platformBaseUrl, !!args.include_remote);
        const summary = {
          ok: true,
          plugin: 'hi-openclaw-plugin',
          plugin_version: PLUGIN_VERSION,
          plugin_policy: null as Record<string, unknown> | null,
          profile: config.profile,
          state_dir: stateDir,
          state_file: resolveStateFile(stateDir, config.profile),
          platform_base_url: config.platformBaseUrl,
          webhook_path: config.webhookPath,
          quarantined_stale_identity: peekQuarantineNotice(),
          summary: {
            connected: !!state.identity,
            // registered = 本机已有稳定 agent（register-once）。注意：registered≠identity-bound——
            // agent 可能还没绑手机/邮箱/Google（写操作会被平台 gate 挡住），但读/搜索已可用。
            registered: !!(state.identity && state.identity.agent_id),
            ready_for_public_reads: !!state.identity,
            activated: !!state.identity?.activated_at,
            agent_id: state.identity?.agent_id || null,
            installation_id: state.identity?.installation_id || null,
          },
          // Allowlist the diagnostic state; never serialize persisted identity or
          // arbitrary future state fields into the model's context.
          state: {
            profile: state.profile,
            identity: state.identity ? {
              agent_id: state.identity.agent_id,
              installation_id: state.identity.installation_id,
              anonymous: state.identity.anonymous,
              activated_at: state.identity.activated_at,
              plugin_version_synced: state.identity.plugin_version_synced,
            } : null,
            runtime: {
              last_consumed_stream_seq: state.runtime.last_consumed_stream_seq,
              updated_at: state.runtime.updated_at,
              install: {
                host_kind: state.runtime.install.host_kind,
                receiver_last_started_at: state.runtime.install.receiver_last_started_at,
                receiver_has_error: !!state.runtime.install.receiver_last_error,
                hooks_configured: !!state.runtime.install.hooks_token,
                gateway_port: state.runtime.install.gateway_port,
              },
            },
          },
          remote: null as Record<string, unknown> | null,
        };
        const finish = async () => {
          summary.plugin_policy = await pluginPolicy;
          return asJsonResult(summary);
        };
        if (args.include_remote && state.identity) {
          try {
            const auth = await buildAuthorizedClients({
              stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl,
            });
            if (auth.accessToken.startsWith('hi_ai_')) {
              summary.summary.activated = false;
              summary.remote = {authenticated: true, status: 'pending', ready_for_public_reads: true, identity_bound: false};
              return finish();
            }
            if (state.identity.api_key) {
              const me = await auth.gateway.me() as any;
              summary.remote = {me};
              summary.summary.activated = isVerifiedModernIdentity(me, state.identity.agent_id);
              return finish();
            }
            const [me, installation, endpoints, subscriptions] = await Promise.all([
              auth.gateway.me(),
              auth.gateway.getInstallation(),
              auth.gateway.listEndpoints(),
              auth.gateway.listSubscriptions(),
            ]);
            summary.remote = { me, installation, endpoints, subscriptions };
          } catch (err: any) {
            summary.summary.activated = false;
            summary.remote = { error: String(err?.message || err) };
          }
        }
        return finish();
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
    label: 'Hi agent setup',
    description:
      'AGENT-side setup step on the Hi platform. Ensures this OpenClaw host has ONE STABLE agent + credential (register-once). The credential is persisted locally and REUSED forever — restart / new window / repeated calls all map to the SAME agent_id (no duplicate-agent churn; that churn was the old bug). Modern event reception remains disabled unless the user separately opts into modernEvents with an approved local session or external channel destination; setup does not claim push readiness. After it returns, reading & searching Hi (people, listings, taxonomy) work immediately even while the installation is pending. The agent starts UNBOUND (no verified identity): WRITING — creating/editing a profile, posting a listing, contacting anyone, scheduling — is gated by the platform and requires the user to bind an identity first, default Google (google_link) or phone (phone_binding) or email (email_binding). A `phone_binding_required` / `needs_binding` error on a write means exactly this: bind once, then retry the write — binding attaches to the SAME agent (no new agent). Fully idempotent. NOTE: structurally different from `openclaw plugins install clawhub:hirey` or `openclaw plugins install npm:@hirey-ai/hirey` (the CLI command that lays the plugin tarball on disk + registers it with the gateway). The CLI install puts hi_* tools on the gateway; THIS tool sets up the Hi-platform agent so those tools work. Always report the REAL agent_id returned by this tool; never fabricate one. If you cannot see this tool in your run inventory yet, the install just completed — wait for the user\'s next message.',
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
        subscribe_default_topics: {
          type: 'boolean',
          description: 'Subscribe to all default event topics (agent.message.created, pairing.*, listing_matching_session.updated, meeting.*, hi.release.published). Default true.',
          default: true,
        },
        metadata: {
          type: 'object',
          description: 'Custom metadata and channel attribution are not supported by the modern registration endpoint. Non-empty metadata is rejected instead of silently claiming attribution succeeded. Omit this field for normal setup.',
          additionalProperties: true,
        },
      },
    },
    async execute(_id, params): Promise<PluginToolResult> {
      const args = (params || {}) as {
        display_name?: string;
        agent_kind?: string;
        host_session_key?: string;
        subscribe_default_topics?: boolean;
        metadata?: Record<string, unknown>;
      };
      try {
        // Step 1: ensure a STABLE agent (register-once) — 绝不重注册。已有 identity → 复用；没有
        // → 注册一次（pending Agent 已可公开 read/search，不调用已下线的 activate 路径）。
        // 这是零 churn 的根：旧逻辑在 state 缺失 / OAuth 抖动 quarantine 时反复 register 新 agent，
        // 每次都多一个孤儿。注册出来的 agent **未绑定身份**：读/搜索放行，写被平台 gate 挡到绑定为止。
        // display_name 解析：caller 显式传 > workspace/IDENTITY.md 的 Name > 'OpenClaw Hi Agent'。
        const workspaceDir = resolveOpenClawWorkspaceDir();
        const identityName = readOpenClawIdentityName(workspaceDir);
        const resolvedDisplayName = args.display_name?.trim() || identityName || 'OpenClaw Hi Agent';
        const callerMetadata =
          args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata) ? args.metadata : {};
        let state = await ensureCredential({
          stateDir,
          profile: config.profile,
          platformBaseUrl: config.platformBaseUrl,
          displayName: resolvedDisplayName,
          metadata: callerMetadata,
        });

        // Step 2: build authorized clients（client_credentials 换 token）。
        const auth = await buildAuthorizedClients({ stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl });

        // Pending tokens deliberately cannot access private /me or legacy
        // installation/delivery endpoints. Do not turn this expected state into
        // a failed install or create another Agent to repair it.
        if (auth.accessToken.startsWith('hi_ai_')) {
          return asJsonResult({
            ok: true, mode: 'registered', registered: true,
            agent_id: state.identity?.agent_id, ready_for_public_reads: true,
            activated: false, hooks_ready: false, push_ready: false,
            binding_required: true, next: 'google_link',
            summary: {connected: true, registered: true, agent_id: state.identity?.agent_id,
              ready_for_public_reads: true, activated: false, hooks_ready: false},
          });
        }

        // Step 3: 读回 remote canonical agent_id（ensureCredential 已 register，这里应有值）。
        let me: any = null;
        try { me = await auth.gateway.me(); } catch { me = null; }
        const registeredAgentId = String(me?.agent_id || me?.agent?.agent_id || state.identity?.agent_id || '').trim();
        if (state.identity?.api_key) {
          const bound = isVerifiedModernIdentity(me, state.identity.agent_id);
          if (!bound) return asErrorResult('hi_identity_response_incomplete');
          await updateState(stateDir, config.profile, cur => ({...cur, identity: cur.identity ? {
            ...cur.identity, agent_id: registeredAgentId, anonymous: false,
            activated_at: cur.identity.activated_at || new Date().toISOString(),
          } : null}));
          return asJsonResult({ok: true, mode: 'registered', registered: true,
            agent_id: registeredAgentId, ready_for_public_reads: true, activated: true,
            hooks_ready: false, push_ready: false,
            warnings: ['native_delivery_not_verified'],
            summary: {connected: true, registered: true, agent_id: registeredAgentId,
              ready_for_public_reads: true, activated: true, hooks_ready: false},
          });
        }

        // 把 remote canonical 身份回写本地（agent_id/installation_id/activated_at）。
        const installationResp = await auth.gateway.getInstallation().catch(() => null);
        const remoteInstallationId = String(
          (installationResp?.installation as any)?.installation_id
          || (me?.installation as any)?.installation_id
          || '',
        ).trim();
        const remoteActivatedAt = String(
          (installationResp?.installation as any)?.activated_at
          || (me?.installation as any)?.activated_at
          || '',
        ).trim() || null;
        state = await updateState(stateDir, config.profile, (cur) => ({
          ...cur,
          identity: cur.identity
            ? {
                ...cur.identity,
                agent_id: registeredAgentId,
                installation_id: remoteInstallationId || cur.identity.installation_id,
                installation_subject:
                  remoteInstallationId || cur.identity.installation_subject || cur.identity.client_id,
                display_name: String(me?.agent?.display_name || cur.identity.display_name),
                agent_kind: String(me?.agent?.agent_kind || cur.identity.agent_kind),
                activated_at: remoteActivatedAt || cur.identity.activated_at,
                anonymous: false,
              }
            : cur.identity,
        }));

        // Step 4: declare delivery capabilities + bind session
        // Native plugin 跑在用户本机的 OpenClaw gateway 进程内，daemon 主动从平台 SSE / claim
        // 拉事件再 POST hooks/agent —— 这在 hi 平台业务定义上等价于"本机 receiver daemon"。
        // 因此声明 local_receiver（让 hi 平台的 bootstrap install_welcome_recommendation 等
        // 业务 push gate 把我们识别为可送达的 host receiver）+ pull_stream（声明 SSE 这条主路径）
        // + claim_ack（声明 fallback 路径）。preferred=local_receiver 跟老 hi-agent-receiver
        // 的官方语义对齐，让平台业务层对我们的对待跟传统 receiver 完全一致。
        //
        // default_reply_route：LLM 显式传 host_session_key 时优先用；未传时 fallback 到
        // findRecentUserSessionKey() 自动探测当前活跃用户 session，确保 push 不会因为 LLM
        // 忘传 session key 而永远掉进 isolated hook 黑洞。探测失败（首次安装前 sessions 文件
        // 还不存在）才 omit 这两个字段，让 daemon 侧的 no_route_info_fallback 路径兜底。
        const resolvedSessionKey =
          (args.host_session_key ? args.host_session_key.trim() : null)
          || findRecentUserSessionKey();
        const deliveryCapsBody: Record<string, unknown> = {
          preferred: 'local_receiver',
          capabilities: [
            { kind: 'local_receiver', status: 'active', config: {} },
            { kind: 'pull_stream', status: 'active', config: {} },
            { kind: 'claim_ack', status: 'active', config: {} },
          ],
        };
        if (resolvedSessionKey) {
          deliveryCapsBody.route_missing_policy = 'use_explicit_default_route';
          deliveryCapsBody.default_reply_route = {
            installation_id: state.identity!.installation_id,
            session_key: resolvedSessionKey,
            delivery_context: { channel: 'last', to: null, account_id: null, thread_id: null },
          };
        }
        let installationUpdate: any = null;
        let installationUpdateError: { message: string; response_body?: unknown } | null = null;
        try {
          // 一起把 plugin metadata 推上去——平台 installation.metadata_json 是 admin/ops 排查
          // "用户跑的什么版本"的唯一可信来源；不带 metadata 的 update 会让 install 记录永远停在
          // 首次 register 那个版本，老用户升级后平台看不到任何版本号变化。
          installationUpdate = await auth.gateway.updateInstallation({
            metadata: {
              host: 'openclaw',
              plugin: 'hi-openclaw-plugin',
              plugin_version: PLUGIN_VERSION,
            },
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
        // updateInstallation 成功才把 plugin_version_synced 推进——失败保持原样，下次启动 reconcile
        // 还会再试一次。
        if (!installationUpdateError) {
          state = await updateState(stateDir, config.profile, (cur) => ({
            ...cur,
            identity: cur.identity
              ? { ...cur.identity, plugin_version_synced: PLUGIN_VERSION }
              : cur.identity,
          }));
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
        // 跟 hi-mcp-server handleInstall 镜像：即使 host 未加载随包 Skills，安装结果
        // 也要自带 onboarding 行为规则，让 welcome 流程不依赖另一个文件或请求。
        //
        // 业界 SaaS / 对话式 AI onboarding 共识（Build context, Ask intent EARLY, Show
        // populated state preview, Single clear next action）+ 我们 prod 数据观察（10 个
        // 新装 owner 里只有一半发了 friendship listing，剩下一半实际意图是招聘 / 找房 /
        // 合伙人）共同推出的引导设计。
        //
        // 不再为欢迎卡片额外调用已下线的 hi.agent-listings/browse_recent。这个
        // 预览不是安装成功的必要结果，额外网络请求还会拉长首次响应。新版只返回
        // onboarding 指令和意图选项；真正的业务读写由 workspace_workflows 一次返回。
        let welcome: BootstrapOnboardingPayload | null = null;
        try {
          // 仅在 install 主链没出错且 hooks 配好时返回 welcome。
          const installOk = !installationUpdateError && !hooksConfigureError;
          if (installOk) {
            welcome = {
              kind: INSTALL_WELCOME_ONBOARDING_KIND,
              instruction_to_llm: INSTALL_WELCOME_ONBOARDING_INSTRUCTION,
              recent_activity: [],
              intent_options: [...DEFAULT_INTENT_OPTIONS],
            };
          }
        } catch {
          // welcome 整体失败也 fail-soft：install 主流程返回 ok=true，welcome=null 让 LLM
          // fallback 到自然行为（拿到 install ok 后给 owner 一句"装好了"），不阻断 install。
          welcome = null;
        }

        return asJsonResult({
          ok: !installationUpdateError && !hooksConfigureError,
          mode: 'registered',
          registered: true,
          agent_id: registeredAgentId,
          profile: config.profile,
          state_dir: stateDir,
          quarantined_stale_identity: peekQuarantineNotice(),
          ready_for_public_reads: true,
          installation: installationUpdate,
          installation_update_error: installationUpdateError,
          subscriptions: subscriptionsResp,
          hooks_configure: hooksConfigure ? {
            hooks_path: hooksConfigure.hooks_path,
            gateway_port: hooksConfigure.gateway_port,
            changed: hooksConfigure.changed,
            configured: true,
          } : null,
          hooks_configure_error: hooksConfigureError,
          // 这台 OpenClaw 现在有一个稳定 agent，重启/开新窗口都是同一个，不会再新建。
          // 读/搜索已可用；写操作（建档/发listing/联系人/约meeting）若还没绑定身份，会被平台
          // 挡住（needs_binding / phone_binding_required）——届时默认用 Google（google_link），
          // 也可手机（phone_binding）/邮箱（email_binding）。绑定挂到同一个 agent，不会新建。
          write_requires_binding: {
            recommended: 'google_link',
            options: [
              { tool: 'google_link', note: 'Sign in with Google（默认推荐）' },
              { tool: 'phone_binding', note: '手机验证码：action:"bind" 发码 → action:"verify" 提交 SMS code' },
              { tool: 'email_binding', note: '邮箱验证码（或邮箱里的 Google 登录）' },
            ],
            note: '绑定后这台机器仍是同一个 agent（绑定只是把身份挂上去，不新建 agent）。',
          },
          // "用新 agent 还是接回之前的 agent"的选择路径：若用户在别的设备上有想继续用的旧
          // agent，可在旧设备 hi_agent_claim_export 导出凭单、这台 hi_agent_claim_redeem 接回，
          // 即变回那个旧 agent（listings/会话/对端回复都在）。
          previous_agent_choice: {
            current_agent_id: registeredAgentId,
            keep_current: '直接用这个 agent（默认）。',
            switch_to_previous:
              '如果你之前在别的设备上已经有一个想继续用的 Hi agent：在那台旧设备调 hi_agent_claim_export 拿一次性凭单，'
              + '再在这台调 hi_agent_claim_redeem 输入凭单，这台就变回那个旧 agent。',
          },
          summary: {
            agent_id: state.identity?.agent_id,
            installation_id: state.identity?.installation_id,
            connected: true,
            ready_for_public_reads: true,
            activated: !!state.identity?.activated_at,
            event_path: 'plugin_native_hooks_loopback',
            installation_update_succeeded: !installationUpdateError,
            hooks_ready: !!hooksConfigure && !hooksConfigureError,
            push_path_hint: hooksConfigure
              ? `http://127.0.0.1:${hooksConfigure.gateway_port}${hooksConfigure.hooks_path}/agent`
              : null,
            default_reply_route_bound: !!resolvedSessionKey,
            default_reply_route_session_key_source: resolvedSessionKey
              ? (args.host_session_key?.trim() ? 'caller' : 'auto_detected')
              : 'not_bound',
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
        if (auth.accessToken.startsWith('hi_ai_')) {
          return asJsonResult({ok: true, connected: true, activated: false,
            ready_for_public_reads: true, blockers: [], warnings: ['pending_installation_public_reads_only'],
            delivery_probe: 'not_run_pending_identity'});
        }
        if (state.identity.api_key) {
          const me = await auth.gateway.me() as any;
          const bound = isVerifiedModernIdentity(me, state.identity.agent_id);
          return asJsonResult({ok: bound, connected: true, activated: bound,
            ready_for_public_reads: true, push_ready: false,
            blockers: bound ? [] : ['hi_identity_response_incomplete'],
            warnings: ['native_delivery_not_verified'], delivery_probe: 'not_run',
            agent_id: me.agent_id || me.agent?.agent_id || null});
        }
        const installation = await auth.gateway.getInstallation();
        const activated = !!installation.installation?.activated_at;
        if (!activated) warnings.push('pending_installation_public_reads_only');

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

        // 2026-05：身份分叉检测。admin consolidate / mergeAgents 之后 agent_installations.agent_id
        // 被改成 target，但本地 state.identity.agent_id 还是 merge 前快照——客户端没机制知道自己被
        // 合并掉了。表现是 LLM 看到 "我以为是 ag_X 但 /me 说我是 ag_Y" 然后反复 reset / re-install /
        // 再造孤儿。这里对比 local vs /me vs installation 三个 agent_id，任何不一致直接 blocker，
        // hint 是调 hi_agent_state_resync 把本地刷回 canonical（不是 hi_agent_install 重装，那会
        // 让现有 OAuth 凭证失效再造一条孤儿 installation）。include_remote=false 时跳过——
        // 没远端数据没法比对。
        if (args.include_remote !== false && me) {
          const localAgentId = String(state.identity?.agent_id || '').trim() || null;
          const remoteMeAgentId = String((me as any)?.agent?.agent_id || '').trim() || null;
          const remoteInstallationAgentId = String((installation.installation as any)?.agent_id || '').trim() || null;
          if (localAgentId && remoteMeAgentId && localAgentId !== remoteMeAgentId) {
            blockers.push(
              `agent_identity_split:local=${localAgentId},remote_me=${remoteMeAgentId},remote_installation=${remoteInstallationAgentId || 'unknown'}`,
            );
          } else if (remoteMeAgentId && remoteInstallationAgentId && remoteMeAgentId !== remoteInstallationAgentId) {
            warnings.push(
              `remote_agent_id_mismatch:me=${remoteMeAgentId},installation=${remoteInstallationAgentId}`,
            );
          }
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
          ready_for_public_reads: true,
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
      'DESTRUCTIVE — avoid unless the user explicitly asks to wipe local Hi state. Clears the persisted local credential (the stable hi_ak_ key) + receiver cursor. The platform-side agent is NOT destroyed, but this host loses its link to it. After reset, this host falls back to anonymous read-only and the NEXT bind will re-converge to the same workspace by phone/email/Google — but if you only want to move this identity to another device, prefer hi_agent_claim_export (old device) + hi_agent_claim_redeem (new device) instead of reset, which keeps the SAME agent with zero churn. Do NOT call reset to "fix" a perceived problem; it is not a troubleshooting step (use hi_agent_status / hi_agent_doctor first).',
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
          // Only an existing persisted identity proves bootstrap completed.
          // Unknown-outcome fences without an identity must survive reset.
          const beforeReset = await loadStateWithQuarantine(stateDir, config.profile, config.platformBaseUrl);
          await fs.rm(file, { force: true });
          invalidateAuthorizedClients(stateDir, config.profile);
          if (beforeReset.identity && /^[A-Za-z0-9_-]+$/.test(config.profile)) {
            await fs.rm(path.join(stateDir, `${config.profile}.registration-pending.json`), {force: true});
          }
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

// ---------- hi_agent_recover ----------
// 跟 hi_agent_reset 是反向操作：1.0.x 之前的 quarantine 逻辑会在 issuer ↔ platform_base_url
// origin 不同时把 state file 改名成 .stale-<host>-<ts>.bak 再 fresh register（导致旧 listings
// 跟 pairings 留在已经成 orphan 的旧 agent 上）。1.0.35 之后的 reactive quarantine 不再
// pre-emptive 触发，但**老用户磁盘上的 .stale-*.bak 还在**，需要一条能 surface + 还原它们的
// 工具：列出来 → 选哪一个 → rename 回 active state → 用旧 token 试 OAuth → 如果 platform 还
// 承认就成功，旧 listings 跟 inbox 自然回来。
//
// 设计要点：
// - **action=list**：扫 stateDir 下所有 .stale-*.bak，parse 文件内容拿 previous_agent_id /
//   previous_issuer / activated_at，返给 LLM 一组卡片。不读破坏性的就只是 fs.readdir+JSON.parse。
// - **action=restore**：先把当前 active state 改名（保护 currently-running identity，叫
//   .pre-recover-<ts>.bak），再把选中的 .stale 改回 active，最后调一次 OAuth 验证。如果
//   OAuth 401，恢复回原来的（避免用户卡进无效身份）；OAuth 200 就成。
// - 故意不暴露 force / skip_verify：恢复一个旧 identity 但平台已经把它清掉了的情况，没有
//   "强制保留"的有意义语义——下一次 tool call 还是会 401。让 LLM 引导用户去 hi_agent_install
//   重起。
export function buildHiAgentRecoverTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: 'hi_agent_recover',
    label: 'Hi agent recover',
    description:
      'Recover an orphaned Hi identity from a .stale-*.bak backup left behind by the old pre-emptive quarantine path. Use this when the user reports "my agent_id changed after a restart" or "my old listings/inbox disappeared". `action=list` enumerates available backups; `action=restore` swaps the chosen backup back into the active state file and re-validates it against the Hi platform via OAuth. Restore is safe — if the old token no longer authenticates, the change is rolled back and the user must run hi_agent_install for a fresh agent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'restore'],
          description: "'list' = enumerate available backups; 'restore' = swap one back in.",
        },
        backup_path: {
          type: 'string',
          description: 'Required for action=restore — full path to a backup returned by list.',
        },
      },
      required: ['action'],
    },
    async execute(_id, params): Promise<PluginToolResult> {
      const args = (params || {}) as { action: 'list' | 'restore'; backup_path?: string };
      try {
        if (args.action === 'list') {
          let entries: string[] = [];
          try { entries = await fs.readdir(stateDir); } catch (err: any) {
            if (err?.code === 'ENOENT') return asJsonResult({ ok: true, state_dir: stateDir, backups: [] });
            throw err;
          }
          const backups: any[] = [];
          for (const entry of entries) {
            if (!entry.endsWith('.bak')) continue;
            if (!entry.includes('.stale-')) continue;
            const full = path.join(stateDir, entry);
            const stat = await fs.stat(full).catch(() => null);
            if (!stat?.isFile()) continue;
            let parsed: any = null;
            try {
              parsed = JSON.parse(await fs.readFile(full, 'utf8'));
            } catch {
              // 不可解析的就当成空 metadata，但仍 surface 路径让用户处理
            }
            backups.push({
              backup_path: full,
              size_bytes: stat.size,
              mtime: stat.mtime.toISOString(),
              previous_agent_id: parsed?.identity?.agent_id ?? null,
              previous_installation_id: parsed?.identity?.installation_id ?? null,
              previous_issuer: parsed?.identity?.issuer ?? null,
              previous_display_name: parsed?.identity?.display_name ?? null,
              previous_activated_at: parsed?.identity?.activated_at ?? null,
            });
          }
          // 最近的（按 mtime）排前，方便 LLM 推荐"上次的旧身份"
          backups.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
          return asJsonResult({
            ok: true,
            state_dir: stateDir,
            backups,
            note: backups.length === 0
              ? 'No quarantine backups found. If the user is missing listings/inbox the orphan is on a different host or the bak file was already cleaned.'
              : 'Show backups to the user; let them pick by previous_agent_id or previous_activated_at. Pass backup_path to action=restore.',
          });
        }

        if (args.action !== 'restore') {
          return asErrorResult('hi_agent_recover_unknown_action', { action: args.action });
        }
        const backupPath = String(args.backup_path || '').trim();
        if (!backupPath) {
          return asErrorResult('hi_agent_recover_missing_backup_path', {
            hint: 'Call action=list first to obtain a valid backup_path.',
          });
        }
        // 防止恶意路径跳出 stateDir
        const resolvedBackup = path.resolve(backupPath);
        const resolvedStateDir = path.resolve(stateDir);
        if (!resolvedBackup.startsWith(resolvedStateDir + path.sep) && resolvedBackup !== resolvedStateDir) {
          return asErrorResult('hi_agent_recover_backup_outside_state_dir', {
            backup_path: resolvedBackup,
            state_dir: resolvedStateDir,
          });
        }
        const backupExists = await fs.stat(resolvedBackup).then((s) => s.isFile()).catch(() => false);
        if (!backupExists) {
          return asErrorResult('hi_agent_recover_backup_not_found', { backup_path: resolvedBackup });
        }

        const activeStateFile = resolveStateFile(stateDir, config.profile);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const preRecoverBackup = `${activeStateFile}.pre-recover-${ts}.bak`;

        // 1) 先把当前 active state 保护好（如果有的话）
        let hadActive = false;
        try {
          await fs.rename(activeStateFile, preRecoverBackup);
          hadActive = true;
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err;
        }

        // 2) 把选定的 backup 拷贝回 active（用 copy 而不是 rename，保留 .bak 给用户审计）
        await fs.copyFile(resolvedBackup, activeStateFile);

        // 3) 用恢复的 identity 试一次 OAuth；通过就成、失败就 rollback
        try {
          const auth = await buildAuthorizedClients({
            stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl,
          });
          // 同时 cleanup：删 .stale 副本（已经 restore 到 active 了，留着以后混淆）
          await fs.unlink(resolvedBackup).catch(() => undefined);
          return asJsonResult({
            ok: true,
            restored_from: resolvedBackup,
            agent_id: auth.state.identity?.agent_id ?? null,
            installation_id: auth.state.identity?.installation_id ?? null,
            display_name: auth.state.identity?.display_name ?? null,
            issuer: auth.state.identity?.issuer ?? null,
            previous_active_saved_as: hadActive ? preRecoverBackup : null,
            note: 'Recovery succeeded — OAuth re-authenticated the restored identity. Old listings, pairings, and inbox should reappear on next status/feed call.',
          });
        } catch (err: any) {
          // OAuth 没认证通过——平台可能已经把这个 agent 清掉了。Rollback。
          await fs.unlink(activeStateFile).catch(() => undefined);
          if (hadActive) {
            await fs.rename(preRecoverBackup, activeStateFile).catch(() => undefined);
          }
          return asErrorResult('hi_agent_recover_oauth_rejected', {
            backup_path: resolvedBackup,
            previous_agent_id: undefined,
            detail: String(err?.message || err),
            hint: 'The platform no longer recognizes this old identity. Active state has been rolled back. Run hi_agent_install for a fresh agent.',
          });
        }
      } catch (err: any) {
        return asErrorResult('hi_agent_recover_failed', buildErrorDetailFields(err));
      }
    },
  };
}

// 2026-05：hi_agent_state_resync — server-side admin consolidate / mergeAgents 之后把
// 本地持久化 identity 拉回 remote canonical（/me + /installation 当前真值）。专为
// hi_agent_doctor 报 `agent_identity_split` blocker 之后兜底用；只刷 agent_id /
// display_name / delivery_capabilities，不动 installation_id 跟长期凭证（client_id /
// client_secret 等）。跟 hi_agent_recover 是两条互补恢复路径：
//   - recover: 从 .stale-*.bak 备份文件 rollback 回旧身份（quarantine 早期路径）
//   - state_resync: 把本地 forward sync 到 remote 已 merge 完的新身份
// installation_id 漂移（极少见——client_credentials 凭证已经认不得当前 install）则
// resync 救不了，必须重新走 hi_agent_install 拿新凭证。
export function buildHiAgentStateResyncTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: 'hi_agent_state_resync',
    label: 'Hi agent state resync',
    description:
      'Pull canonical agent_id / installation_id / display_name from gateway /me + /installation and patch the local state file to match. Use this when hi_agent_doctor reports `agent_identity_split:local=...,remote_me=...` — that blocker means server-side admin consolidate (e.g. agentMerge) reassigned this installation to a different agent_id but the local state file is still on the pre-merge snapshot. Idempotent (no-op when local already matches remote). Does NOT touch installation_id or long-lived credentials (client_id / client_secret); if installation_id itself has drifted, fails with a clear error and asks for hi_agent_install instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute(_id, _params): Promise<PluginToolResult> {
      try {
        const auth = await buildAuthorizedClients({ stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl });
        const [me, installation] = await Promise.all([
          auth.gateway.me(),
          auth.gateway.getInstallation(),
        ]);
        const remoteAgentId = String((me as any)?.agent?.agent_id || '').trim() || null;
        const remoteInstallationId = String((installation.installation as any)?.installation_id || '').trim() || null;
        const remoteDisplayName = String((me as any)?.agent?.display_name || '').trim() || null;
        const remoteAgentKind = String((me as any)?.agent?.agent_kind || '').trim() || null;
        const remoteActivatedAt = String((installation.installation as any)?.activated_at || '').trim() || null;
        const remoteDeliveryCapabilities = (installation.installation as any)?.delivery_capabilities || null;
        if (!remoteAgentId || !remoteInstallationId) {
          return asErrorResult('state_resync_remote_unreadable', {
            hint: 'gateway /me or /installation did not return canonical IDs; bearer may not be provisioned. Run hi_agent_install first.',
          });
        }
        const before = auth.state;
        const beforeIdentity = before.identity;
        const beforeAgentId = beforeIdentity?.agent_id || null;
        const beforeInstallationId = beforeIdentity?.installation_id || null;
        if (!beforeIdentity) {
          return asErrorResult('state_resync_no_local_identity', {
            hint: 'local state has no identity yet; run hi_agent_install before resync.',
          });
        }
        const agentIdDrift = beforeAgentId !== remoteAgentId;
        const installationIdDrift = beforeInstallationId !== remoteInstallationId;
        if (!agentIdDrift && !installationIdDrift) {
          return asJsonResult({
            ok: true,
            patched: false,
            reason: 'no_drift',
            identity: { agent_id: beforeAgentId, installation_id: beforeInstallationId },
          });
        }
        if (installationIdDrift) {
          return asErrorResult('state_resync_installation_id_drift_unrecoverable', {
            local_installation_id: beforeInstallationId,
            remote_installation_id: remoteInstallationId,
            hint: 'Local installation_id no longer matches the bearer; client_credentials cannot reauthenticate. Run hi_agent_install for a fresh agent/credentials.',
          });
        }
        await updateState(stateDir, config.profile, (current) => ({
          ...current,
          identity: current.identity
            ? {
                ...current.identity,
                agent_id: remoteAgentId,
                display_name: remoteDisplayName || current.identity.display_name,
                agent_kind: remoteAgentKind || current.identity.agent_kind,
                activated_at: remoteActivatedAt || current.identity.activated_at,
                delivery_capabilities: remoteDeliveryCapabilities || current.identity.delivery_capabilities,
              }
            : current.identity,
          runtime: { ...current.runtime, updated_at: new Date().toISOString() },
        }));
        return asJsonResult({
          ok: true,
          patched: true,
          reason: 'agent_id_resynced_from_remote',
          before: { agent_id: beforeAgentId, installation_id: beforeInstallationId },
          after: { agent_id: remoteAgentId, installation_id: remoteInstallationId },
        });
      } catch (err: any) {
        return asErrorResult('hi_agent_state_resync_failed', buildErrorDetailFields(err));
      }
    },
  };
}

// ---------- hi_agent_claim_export / hi_agent_claim_redeem (2026-06) ----------
// 登录后"重挂凭单"：在已绑手机的 agent 上 export 一个一次性短过期凭单，到另一台新设备 redeem，
// 把这台设备挂回同一个 agent（同一身份，数据都在），不必重新绑手机。直接打 gateway 的
// /v1/agents/claim/*（与 connect/activate 同一 registry base），复用 buildAuthorizedClients 的 bearer。
function claimRegistryBase(auth: { wellKnown?: unknown }, config: Required<HiOpenClawPluginConfig>): string {
  const wk = auth.wellKnown as any;
  return (wk?.platform?.registry_base_url || wk?.registry_base_url || config.platformBaseUrl) as string;
}

export function buildHiAgentClaimExportTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: 'hi_agent_claim_export',
    label: 'Hi agent claim export',
    description:
      '导出一个一次性、短过期的"重挂凭单"（claim token），用于把另一台新设备挂回**当前这个 agent**（同一身份）。要求当前 agent 已绑定手机号（=工作区所有权证明；没绑会 403，请先绑手机）。返回的 claim_token 像密码一样——谁 redeem 谁就接入这个 agent，只发给你自己的其它设备。典型场景：换电脑 / 重装 / 凭证丢了，不想变成一个新的空 agent、也不想重新绑手机——在老设备上 export，到新设备上调 hi_agent_claim_redeem，继续用同一个 agent（listings / 会话 / 对端回复都在）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_id, _params): Promise<PluginToolResult> {
      try {
        const auth = await buildAuthorizedClients({ stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl });
        const res = await fetch(`${claimRegistryBase(auth, config)}/v1/agents/claim/export`, {
          method: 'POST',
          headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
          body: '{}',
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) return asErrorResult(String((data as any)?.error || 'claim_export_failed'), data);
        return asJsonResult(data);
      } catch (err: any) {
        return asErrorResult('hi_agent_claim_export_failed', buildErrorDetailFields(err));
      }
    },
  };
}

export function buildHiAgentClaimRedeemTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: 'hi_agent_claim_redeem',
    label: 'Hi agent claim redeem',
    description:
      '在一台**新设备 / 新安装**上消费另一台设备用 hi_agent_claim_export 导出的 claim_token，把当前安装重挂到那个 agent——之后你就是同一个 agent（之前的 listings、会话、对端回复都在，可直接接着回复）。一次性使用，用过即作废；过期 / 被吊销 / 已用过都会被拒。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { claim_token: { type: 'string', description: '老设备 hi_agent_claim_export 返回的一次性凭单 secret。' } },
      required: ['claim_token'],
    },
    async execute(_id, params): Promise<PluginToolResult> {
      const claimToken = String((params as any)?.claim_token || '').trim();
      if (!claimToken) return asErrorResult('missing_claim_token');
      try {
        const auth = await buildAuthorizedClients({ stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl });
        const res = await fetch(`${claimRegistryBase(auth, config)}/v1/agents/claim/redeem`, {
          method: 'POST',
          headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ claim_token: claimToken }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) return asErrorResult(String((data as any)?.error || 'claim_redeem_failed'), data);
        return asJsonResult(data);
      } catch (err: any) {
        return asErrorResult('hi_agent_claim_redeem_failed', buildErrorDetailFields(err));
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
    buildHiAgentRecoverTool(config),
    buildHiAgentStateResyncTool(config),
    buildHiPullEventsTool(config),
    buildHiAgentClaimExportTool(config),
    buildHiAgentClaimRedeemTool(config),
  ];
}
