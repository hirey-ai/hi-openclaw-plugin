// Hi push 推送 daemon —— OpenClaw native plugin 内的 in-process 长跑 service。
//
// 等价于老 hi-agent-receiver 的 runStreamLoop：
//   1. 启动 → 先 claim drain backlog（把暂存的 owner-actionable events 清掉）
//   2. 主路径连 SSE pull_stream（一个长连接 hold 60+ 秒，server 主动推 event id）
//   3. 收到 SSE event id → fetch event detail → 投递给 OpenClaw → ack consumed
//   4. SSE 断了 → backoff + 回到第 1 步重新 drain + 重连
//
// 这种 outbound-initiated 长连接是 NAT 后面 local agent 收云上 push 的业界 best practice
// （2026 年 webhook 主导期已经被 SSE / claim 取代），跟 hi-agent-receiver 的官方 daemon 一致。
//
// 投递路径：daemon 拉到 event 后通过 buildOpenClawHookPayloadWithRoute 转成跟老 receiver
// 完全一致的 hook payload，POST 到本机 OpenClaw gateway 的 /<hooks.path>/agent 端点。
// gateway 收到 → dispatchAgentHook → runCronIsolatedAgentTurn → LLM 跑 turn
// → OpenClaw 按 hook payload 里的 channel/to 自动通过 iMessage / Telegram 等已注册 channel
// 把 LLM 输出送到用户。这一段 OpenClaw 自己负责，plugin 不参与。
//
// 关键设计：每次 SSE 重连 / drain 都 fresh 重建 OAuth + clients，不缓存，跟 receiver 完全
// 等价。SSE 断重连周期是分钟级（不是秒级），所以重建 client 的 GC 压力小，不会像 1.0.4 那样
// 每秒新 fetch agent 把 gateway 进程 4 GB heap 撑爆。

import type {
  PluginServiceContext,
  PluginServiceDefinition,
  HiOpenClawPluginConfig,
} from '../types.js';
import {
  buildAuthorizedClients,
  type HiAuthorizedClients,
} from '../clients.js';
import { resolveStateDir, readState, updateState } from '../state.js';
import { buildOpenClawHookPayloadWithRoute } from '../utils/openclaw-hooks-payload.js';
import { streamAgentEvents } from '@hirey/hi-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 找用户在 OpenClaw 上**最近活跃的非 hook session_key**。
// 用于把 install_welcome_recommendation 这种 "owner 安装欢迎" 类一次性 push 直接落到用户
// 当前正在用的 chat 里（不要走默认 hook:<uuid> 的 isolated session，否则用户在主对话窗
// 看不到，等于装完一片空白 → 流失）。
//
// hook:* session 是 OpenClaw 给 isolated agentTurn 自动开的旁路 session，用户在主 chat
// 看不到；所以这里显式 skip。
//
// 其它常规 push（agent.message.created / pairing.* / meeting.* 等）保留 OpenClaw 默认行为
// （isolated hook session），不动 sessionKey，由 OpenClaw 决定怎么 surface 到 user channel。
function findRecentUserSessionKey(): string | null {
  // OpenClaw 默认 agent id 是 main；多 agent 户暂不覆盖，需要时再扩 plugin config 暴露。
  const sessionsFile = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
  try {
    const raw = fs.readFileSync(sessionsFile, 'utf8');
    const parsed = JSON.parse(raw) as { sessions?: Array<{ key?: string; updatedAt?: number }> };
    const sessions = parsed.sessions || [];
    const filtered = sessions.filter((s) => {
      const k = String(s.key || '');
      // skip hook:* + 空 + 我们之前已知的 install/health 元 session 命名
      return k.length > 0 && !k.includes(':hook:') && !k.includes(':bootstrap:');
    });
    filtered.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return filtered[0]?.key || null;
  } catch {
    return null;
  }
}

// 哪些 event topics + payload kind 应该被强制落到 user 当前 chat。
// 当前只有 install_welcome_recommendation 一种 — 它是用户安装完毕后的"第一印象"消息，
// 必须立即看到才不会让 owner 觉得"装完没事干"流失。
function shouldRouteToUserCurrentChat(event: any): boolean {
  const kind = event?.payload?.kind;
  return kind === 'install_welcome_recommendation';
}

// SSE 重连之间的最小等待，避免连接抖动时疯狂重连。线性 backoff 上限。
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
// 没装 identity / hooks 配置时的 idle backoff。daemon 不会强求 install，等 install_tool 跑完。
const IDLE_BACKOFF_MS = 30_000;

type DaemonRuntimeConfig = {
  hooks_token: string;
  hooks_path: string;
  gateway_port: number;
};

function resolveHooksUrl(rt: DaemonRuntimeConfig): string {
  const path = rt.hooks_path.startsWith('/') ? rt.hooks_path : `/${rt.hooks_path}`;
  // path 形如 "/hooks"；最终 endpoint 是 "/hooks/agent"
  const cleanedPath = path.endsWith('/') ? path.slice(0, -1) : path;
  return `http://127.0.0.1:${rt.gateway_port}${cleanedPath}/agent`;
}

async function deliverEventToHooks(args: {
  hooksUrl: string;
  hooksToken: string;
  event: any;
  logger: NonNullable<PluginServiceContext['logger']>;
}): Promise<{ ok: boolean; status: number; body: string }> {
  // 选择性 sessionKey override：只有 install_welcome_recommendation 这种"安装欢迎"
  // 一次性事件，强制落到用户当前 chat（让用户立刻看到 Hi 推的人，避免装完空白流失）。
  // 其他常规 push 不传 session_key，让 OpenClaw 默认 hook:<uuid> 路径处理。
  let payloadConfig: { session_key?: string } | null = null;
  if (shouldRouteToUserCurrentChat(args.event)) {
    const sk = findRecentUserSessionKey();
    if (sk) {
      payloadConfig = { session_key: sk };
      args.logger.info?.('[hi-openclaw-plugin] routing install_welcome push to user current chat', {
        session_key: sk, kind: args.event?.payload?.kind,
      });
    } else {
      args.logger.warn?.('[hi-openclaw-plugin] install_welcome push: no recent non-hook session found, falling back to default hook routing');
    }
  }
  // 投递 hook payload：跟老 receiver 完全同形态。
  const body = buildOpenClawHookPayloadWithRoute({ event: args.event, config: payloadConfig });
  const response = await fetch(args.hooksUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${args.hooksToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    args.logger.warn?.('[hi-openclaw-plugin] hook delivery failed', {
      status: response.status,
      url: args.hooksUrl,
      body_preview: text.slice(0, 240),
    });
    return { ok: false, status: response.status, body: text };
  }
  return { ok: true, status: response.status, body: text };
}

export function buildAgentEventsService(
  config: Required<HiOpenClawPluginConfig>,
): PluginServiceDefinition {
  const stateDir = config.stateDir || resolveStateDir(config.profile);
  let stopped = false;
  let activeAbort: AbortController | null = null;

  return {
    id: 'hi-agent-events',

    async start(ctx: PluginServiceContext) {
      stopped = false;
      const logger = ctx.logger;
      logger.info?.('[hi-openclaw-plugin] agent-events service starting (sse pull_stream + claim drain)', {
        profile: config.profile,
        platform: config.platformBaseUrl,
      });

      const isReady = async (): Promise<{
        auth: HiAuthorizedClients | null;
        rt: DaemonRuntimeConfig | null;
      }> => {
        const state = await readState(stateDir, config.profile);
        if (!state.identity) return { auth: null, rt: null };
        const inst = state.runtime?.install;
        if (!inst?.hooks_token || !inst?.hooks_path || !inst?.gateway_port) {
          return { auth: null, rt: null };
        }
        const auth = await buildAuthorizedClients({
          stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl,
        }).catch((err: any) => {
          const msg = String(err?.message || err);
          if (!msg.includes('hi_identity_missing')) {
            logger.warn?.('[hi-openclaw-plugin] auth client build failed', { error: msg });
          }
          return null;
        });
        if (!auth) return { auth: null, rt: null };
        return {
          auth,
          rt: {
            hooks_token: inst.hooks_token,
            hooks_path: inst.hooks_path,
            gateway_port: inst.gateway_port,
          },
        };
      };

      // 把一个 event snapshot 走完整的 deliver-then-ack 流程。
      const deliverAndAck = async (params: {
        auth: HiAuthorizedClients;
        rt: DaemonRuntimeConfig;
        event: any;
        leaseId?: string | null;
      }) => {
        const { auth, rt, event, leaseId } = params;
        const hooksUrl = resolveHooksUrl(rt);
        let result: any = null;
        try {
          const r = await deliverEventToHooks({
            hooksUrl, hooksToken: rt.hooks_token, event, logger,
          });
          result = r;
        } catch (err: any) {
          // 投递异常 → ack failed，平台后续重投。
          await auth.gateway.ackEvents({
            ...(leaseId ? { lease_id: leaseId } : {}),
            acks: [{
              event_id: event.event_id,
              status: 'failed',
              last_error: String(err?.message || err),
              retry_after_ms: 60_000,
            }],
          } as any).catch(() => {});
          return;
        }
        if (!result.ok) {
          await auth.gateway.ackEvents({
            ...(leaseId ? { lease_id: leaseId } : {}),
            acks: [{
              event_id: event.event_id,
              status: 'failed',
              last_error: `hook_delivery_${result.status}`,
              retry_after_ms: 60_000,
            }],
          } as any).catch(() => {});
          return;
        }
        await auth.gateway.ackEvents({
          ...(leaseId ? { lease_id: leaseId } : {}),
          acks: [{
            event_id: event.event_id,
            status: 'consumed',
          }],
        } as any).catch((err: any) => {
          logger.warn?.('[hi-openclaw-plugin] event ack failed', { error: String(err?.message || err) });
        });
        // bump runtime cursor
        await updateState(stateDir, config.profile, (cur) => ({
          ...cur,
          runtime: {
            ...cur.runtime,
            last_consumed_stream_seq: Math.max(
              cur.runtime.last_consumed_stream_seq,
              Number(event.stream_seq) || 0,
            ),
            updated_at: new Date().toISOString(),
          },
        })).catch(() => {});
      };

      // 启动 / 重连前 drain backlog —— 用 short claim 把已经累积的 events 清完。
      const drainBacklog = async (auth: HiAuthorizedClients, rt: DaemonRuntimeConfig) => {
        while (!stopped) {
          const state = await readState(stateDir, config.profile);
          const claimed = await auth.gateway.claimEvents({
            after_seq: state.runtime.last_consumed_stream_seq || 0,
            limit: 20,
            ...(state.runtime.last_claim_lease_id ? { claim_lease_id: state.runtime.last_claim_lease_id } : {}),
          } as any);
          await updateState(stateDir, config.profile, (cur) => ({
            ...cur,
            runtime: {
              ...cur.runtime,
              last_claim_lease_id: claimed.claim_lease_id || cur.runtime.last_claim_lease_id,
            },
          })).catch(() => {});
          const items = (claimed?.items || []) as any[];
          if (items.length === 0) return;
          logger.info?.(`[hi-openclaw-plugin] drained ${items.length} backlog event(s)`, {
            first_topic: items[0]?.topic,
          });
          for (const ev of items) {
            if (stopped) return;
            await deliverAndAck({ auth, rt, event: ev, leaseId: claimed.claim_lease_id });
          }
        }
      };

      // 一次 SSE 长连接 session。流抽干 / 断 / throw 时返回，外层做重连。
      const runOneSseSession = async (auth: HiAuthorizedClients, rt: DaemonRuntimeConfig) => {
        const state = await readState(stateDir, config.profile);
        const lastSeq = state.runtime.last_consumed_stream_seq || 0;
        const streamUrl = (auth.gateway as any).streamUrl
          ? (auth.gateway as any).streamUrl(lastSeq)
          : `${config.platformBaseUrl}/v1/agent-events/stream${lastSeq ? `?after_seq=${lastSeq}` : ''}`;
        logger.info?.('[hi-openclaw-plugin] sse connect', { url: streamUrl, after_seq: lastSeq });
        for await (const envelope of streamAgentEvents({
          url: streamUrl,
          token: auth.accessToken,
        })) {
          if (stopped) return;
          if (envelope.event !== 'agent_event') continue;
          const eventId = (envelope.data as any)?.event_id;
          if (!eventId || typeof eventId !== 'string') continue;
          // SSE envelope 里通常是 envelope（精简）；一些字段（reply_route_snapshot / payload）可能要 fetch
          // 完整 snapshot 才有，跟 receiver 一致。
          let fullEvent: any = envelope.data;
          if (typeof (auth.gateway as any).fetchEvent === 'function') {
            try {
              const fetched = await (auth.gateway as any).fetchEvent(eventId);
              if (fetched?.ok && fetched?.event) fullEvent = fetched.event;
            } catch (err: any) {
              logger.warn?.('[hi-openclaw-plugin] fetchEvent failed, using envelope only', {
                event_id: eventId,
                error: String(err?.message || err),
              });
            }
          }
          await deliverAndAck({ auth, rt, event: fullEvent, leaseId: null });
        }
      };

      // 主循环：drain → SSE → drain → SSE …
      const runMainLoop = async () => {
        let backoffMs = RECONNECT_BASE_MS;
        while (!stopped) {
          const ready = await isReady();
          if (!ready.auth || !ready.rt) {
            await sleep(IDLE_BACKOFF_MS);
            continue;
          }
          try {
            await drainBacklog(ready.auth, ready.rt);
            backoffMs = RECONNECT_BASE_MS;
            await runOneSseSession(ready.auth, ready.rt);
            // 流自然结束（远端关闭），立刻重新 drain + 重连
            backoffMs = RECONNECT_BASE_MS;
          } catch (err: any) {
            const msg = String(err?.message || err);
            logger.warn?.('[hi-openclaw-plugin] sse loop error, will reconnect', { error: msg, backoff_ms: backoffMs });
            await sleep(backoffMs);
            backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
          }
        }
      };

      // 用 abort signal 让 stop() 能干净中断 SSE / sleep
      const abort = new AbortController();
      activeAbort = abort;
      void runMainLoop();
      logger.info?.('[hi-openclaw-plugin] agent-events service started');
    },

    async stop(ctx: PluginServiceContext) {
      stopped = true;
      if (activeAbort) {
        try { activeAbort.abort(); } catch {}
        activeAbort = null;
      }
      ctx.logger.info?.('[hi-openclaw-plugin] agent-events service stopped');
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
