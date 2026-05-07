// 4 个核心 control tools：hi_agent_status / hi_agent_install / hi_agent_doctor / hi_agent_reset。
// 业务逻辑全部委托给 @hirey/hi-agent-sdk 已封装好的 platform/gateway client，本文件只做：
// - input schema 定义
// - state file 持久化跟 OAuth client 装配
// - tool result 组装

import type { PluginToolDefinition, PluginToolResult, HiOpenClawPluginConfig } from '../types.js';
import type { AgentGatewayTopic } from '@hirey/hi-agent-sdk';
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
          plugin_version: '1.0.0',
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
        return asErrorResult('hi_agent_status_failed', { detail: String(err?.message || err) });
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
      },
    },
    async execute(_id, params): Promise<PluginToolResult> {
      const args = (params || {}) as {
        display_name?: string;
        agent_kind?: string;
        host_session_key?: string;
        replace_existing_state?: boolean;
        subscribe_default_topics?: boolean;
      };
      try {
        let state = await loadStateWithQuarantine(stateDir, config.profile, config.platformBaseUrl);

        // Step 1: register if needed
        let registerResp: any = null;
        if (!state.identity || args.replace_existing_state) {
          const pub = await buildPublicClients(config.platformBaseUrl);
          registerResp = await pub.gateway.register({
            display_name: args.display_name?.trim() || 'OpenClaw Hi Agent',
            agent_kind: args.agent_kind?.trim() || 'external',
            capabilities: [],
            metadata: { host: 'openclaw', plugin: 'hi-openclaw-plugin', plugin_version: '1.0.0' },
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
        // 在 native plugin 模式下，事件是通过 plugin 自己 register 的 webhook route 跟 service 投递的，
        // 不再需要外部 receiver daemon 也不再需要 OpenClaw hooks token 那一套间接层。
        // delivery_capabilities 声明 generic_webhook 指向 plugin 自己的 /<webhook_path>。
        const installationUpdate = await auth.gateway.updateInstallation({
          delivery_capabilities: {
            preferred: 'generic_webhook',
            capabilities: [
              { kind: 'generic_webhook', status: 'active', config: { url: 'plugin-internal:' + config.webhookPath } },
              { kind: 'pull_stream', status: 'active', config: {} },
            ],
            route_missing_policy: 'use_explicit_default_route',
            default_reply_route: args.host_session_key ? {
              installation_id: state.identity!.installation_id,
              session_key: args.host_session_key,
              delivery_context: { channel: 'last', to: null, account_id: null, thread_id: null },
            } : null,
          } as any,
        });

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

        return asJsonResult({
          ok: true,
          profile: config.profile,
          state_dir: stateDir,
          quarantined_stale_identity: peekQuarantineNotice(),
          register: registerResp,
          activate: activateResp,
          installation: installationUpdate,
          subscriptions: subscriptionsResp,
          summary: {
            agent_id: state.identity?.agent_id,
            installation_id: state.identity?.installation_id,
            connected: true,
            activated: !!state.identity?.activated_at,
            event_path: 'plugin_native',
          },
        });
      } catch (err: any) {
        return asErrorResult('hi_agent_install_failed', { detail: String(err?.message || err), stack: err?.stack });
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
            if (deliveryProbe?.results?.some((r: any) => !r.ok)) {
              blockers.push('delivery_probe_failed');
            }
          } catch (err: any) {
            blockers.push('delivery_probe_threw:' + String(err?.message || err));
          }
        }

        return asJsonResult({
          ok: blockers.length === 0,
          profile: config.profile,
          platform_base_url: config.platformBaseUrl,
          state_dir: stateDir,
          quarantined_stale_identity: peekQuarantineNotice(),
          connected: true,
          activated,
          push_ready: !!deliveryProbe?.ok,
          blockers, warnings,
          delivery_capabilities: installation.installation?.delivery_capabilities ?? null,
          remote: { me, installation, endpoints, subscriptions },
          delivery_probe: deliveryProbe,
        });
      } catch (err: any) {
        return asErrorResult('hi_agent_doctor_failed', { detail: String(err?.message || err) });
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
        return asErrorResult('hi_agent_reset_failed', { detail: String(err?.message || err) });
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
  ];
}
