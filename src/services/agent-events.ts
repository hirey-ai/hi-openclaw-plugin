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
import { ensureOpenClawHooksConfigured, readGatewayPort, findRecentUserSessionKey } from '../utils/openclaw-config.js';
import { streamAgentEvents } from '@hirey/hi-agent-sdk';

// 哪些 event topics + payload kind 需要被强制落到 user 当前可见的 chat。
//
// install_welcome_* / category_match_notification：平台主动向 owner 说话，必须立即可见。
// 对于 reply_route_snapshot 里已带有 session_key / delivery_context 的常规事件（pairing.*
// / meeting.* / agent.message.created），平台侧已经在创建 event 时解析好路由，这里不需要
// 覆盖。只有当 event 既不属于"强制当前 chat"类型，也没有任何路由信息时（default_reply_route
// 未绑定），才 fallback 到最近用户 session，避免事件永远掉进 isolated hook 黑洞。
function shouldRouteToUserCurrentChat(event: any): boolean {
  const kind = event?.payload?.kind;
  return kind === 'install_welcome_recommendation'
    || kind === 'install_welcome_onboarding'
    || kind === 'category_match_notification';
}

function eventHasRouteInfo(event: any): boolean {
  const rs = (event as any)?.reply_route_snapshot;
  if (!rs) return false;
  return !!(rs.session_key || rs.delivery_context?.channel || rs.delivery_context?.to);
}

// SSE 重连之间的最小等待，避免连接抖动时疯狂重连。线性 backoff 上限。
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
// 没装 identity / hooks 配置时的 idle backoff。daemon 不会强求 install，等 install_tool 跑完。
const IDLE_BACKOFF_MS = 30_000;
// 单次 hooks/agent 投递的硬上限（毫秒）。OpenClaw 的 /hooks/agent 端点是同步的：收到
// payload 后会同步驱动 isolated agent turn 直到 LLM 跑完才返回 200。正常 turn 上界
// 大概 1~3 分钟（含工具调用 + LLM 推理 + channel send-back），5 分钟覆盖到所有合理的
// 慢 turn。超过这个时间几乎一定意味着 OpenClaw 端 hook handler 出问题（死锁 / runner
// 卡住 / 上游 LLM 网络挂），daemon 不能继续 hold 住它的 SSE 串行投递循环。
//
// 业界共识：Node 内置 fetch 没有默认 timeout，必须显式 AbortSignal.timeout（参考
// PostHog#13309 把 webhook timeout 收紧防 cascading failure；Node fetch 官方惯例）。
// 不设 timeout 的后果：一条卡死的 hook 会让 daemon 永远不前进，新 event 全部 backlog
// 在平台 outbox 拉不下来 —— 这是一类失败拖死整个 owner-actionable event 流。
//
// 超时触发后 fetch throw AbortError，外层走 ack failed 路径（已经存在），平台按
// retry_after_ms=60_000 重投。重投仍是同一 event_id，OpenClaw 端的 dispatchAgentHook
// 自身有 idempotency 兜底，不会重复触发同一个 turn。
const HOOKS_DELIVERY_TIMEOUT_MS = 5 * 60 * 1000;

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
  // sessionKey 注入策略：
  // 1. 强制当前 chat 的事件（install_welcome_* / category_match）→ 找最近用户 session
  // 2. event 自带 reply_route_snapshot（platform 已解析路由）→ 不覆盖，让 payload builder 直接用
  // 3. event 无任何路由信息（default_reply_route 未绑定 / install 时未传 host_session_key）
  //    → fallback 到最近用户 session，避免 event 掉进 isolated hook 黑洞用户永远看不到
  let payloadConfig: { session_key?: string } | null = null;
  const needsSessionFallback = shouldRouteToUserCurrentChat(args.event) || !eventHasRouteInfo(args.event);
  if (needsSessionFallback) {
    const sk = findRecentUserSessionKey();
    if (sk) {
      payloadConfig = { session_key: sk };
      args.logger.info?.('[hi-openclaw-plugin] routing push to user current session', {
        session_key: sk,
        topic: args.event?.topic,
        kind: args.event?.payload?.kind,
        reason: shouldRouteToUserCurrentChat(args.event) ? 'forced_current_chat' : 'no_route_info_fallback',
      });
    } else {
      args.logger.warn?.('[hi-openclaw-plugin] push has no route info and no recent user session; falling back to isolated hook routing', {
        topic: args.event?.topic,
        kind: args.event?.payload?.kind,
      });
    }
  }
  // 投递 hook payload：跟老 receiver 完全同形态。
  // 注意 fetch 的 signal：见 HOOKS_DELIVERY_TIMEOUT_MS 注释，5 分钟硬超时防止 OpenClaw 端
  // hook handler 卡死把 daemon 串行投递循环拖死。abort 会让 fetch throw AbortError，外层
  // deliverAndAck 的 catch 走 ack failed 路径（retry_after_ms=60_000），平台之后重投。
  const body = buildOpenClawHookPayloadWithRoute({ event: args.event, config: payloadConfig });
  const response = await fetch(args.hooksUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${args.hooksToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HOOKS_DELIVERY_TIMEOUT_MS),
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
        let inst = state.runtime?.install;
        if (!inst?.hooks_token || !inst?.hooks_path || !inst?.gateway_port) {
          // 自愈：identity 存在但 hooks 未配置时（hi_agent_install 在旧版本运行、或 state
          // 被部分重置），直接从 openclaw.json 补全，不等 LLM 手动跑 hi_agent_install。
          // 这解决"启动配置"类问题：插件 onStartup 启动后 daemon 能独立完成 hooks 绑定。
          try {
            const ensure = await ensureOpenClawHooksConfigured({ preferredToken: null });
            const gatewayPort = await readGatewayPort();
            const updated = await updateState(stateDir, config.profile, (cur) => ({
              ...cur,
              runtime: {
                ...cur.runtime,
                install: {
                  ...cur.runtime.install,
                  hooks_token: ensure.hooks_token,
                  hooks_path: ensure.hooks_path,
                  gateway_port: gatewayPort,
                },
              },
            }));
            inst = updated.runtime.install;
            logger.info?.('[hi-openclaw-plugin] daemon self-healed hooks config', {
              hooks_path: ensure.hooks_path,
              gateway_port: gatewayPort,
              changed: ensure.changed,
            });
          } catch (err: any) {
            logger.warn?.('[hi-openclaw-plugin] hooks self-heal failed, will retry', {
              error: String(err?.message || err),
            });
            return { auth: null, rt: null };
          }
          if (!inst?.hooks_token || !inst?.hooks_path || !inst?.gateway_port) {
            return { auth: null, rt: null };
          }
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
            hooks_token: inst.hooks_token!,
            hooks_path: inst.hooks_path!,
            gateway_port: inst.gateway_port!,
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
