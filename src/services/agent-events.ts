// agent-events claim loop service：替换原 hi-agent-receiver 独立 daemon。
// 在 OpenClaw gateway 进程内长跑：周期性向平台 /v1/agent-events/claim 拉取 owner-actionable
// events，对每个 event 触发 plugin 内部 webhook route（同一进程内 fetch loopback）让 plugin
// 把 event 桥接到当前 LLM session。
//
// 这是 native plugin 替代 spawn-based receiver 的核心收益：少 1 个独立进程 + 不需要 hooks token
// 那一整套间接层。

import type { PluginServiceContext, PluginServiceDefinition, HiOpenClawPluginConfig } from '../types.js';
import { buildAuthorizedClients, type HiAuthorizedClients } from '../clients.js';
import { resolveStateDir, readState, updateState } from '../state.js';
import { pushEventToQueue } from '../routes/webhook.js';

// 缓存 access_token + clients：client_credentials grant token 一般 TTL ~1h，频繁重换会
// 1) 浪费 OAuth /token 流量；2) 每次 createHiAgentClients 又 hold 一组 fetch / keep-alive socket
// pool 进 GC root，1.5s 一次跑一小时就是几千份 zombie clients，进程内堆爆。
// 这里改成单实例 lazy 构造 + token TTL 前自动 refresh + identity 变了就 invalidate。
type Cached = {
  identityKey: string;       // identity 的稳定 fingerprint，identity 换了 cache 就失效
  expiresAtMs: number;       // token 过期墙钟时间
  clients: HiAuthorizedClients;
};

function fingerprintIdentity(state: { identity: { client_id?: string; installation_id?: string; agent_id?: string } | null }): string {
  if (!state.identity) return '';
  return [
    state.identity.agent_id ?? '',
    state.identity.installation_id ?? '',
    state.identity.client_id ?? '',
  ].join('::');
}

export function buildAgentEventsService(config: Required<HiOpenClawPluginConfig>): PluginServiceDefinition {
  const stateDir = config.stateDir || resolveStateDir(config.profile);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let cached: Cached | null = null;
  // token-refresh 的安全缓冲：access_token 过期前 30s 主动重换。
  const TOKEN_REFRESH_LEAD_MS = 30_000;
  // identity 没装/装错时不要疯狂重试，给一个长间隔
  const IDLE_BACKOFF_MS = 30_000;

  return {
    id: 'hi-agent-events',
    async start(ctx: PluginServiceContext) {
      stopped = false;
      const logger = ctx.logger;
      logger.info?.('[hi-openclaw-plugin] agent-events service starting', {
        profile: config.profile,
        platform: config.platformBaseUrl,
        poll_interval_ms: config.claimPollIntervalMs,
      });

      const ensureClients = async (): Promise<HiAuthorizedClients | null> => {
        const now = Date.now();
        // 看 state 里 identity 有没有变（用户重装 / quarantine reset 等）
        const state = await readState(stateDir, config.profile);
        if (!state.identity) {
          if (cached) cached = null;
          return null;
        }
        const fp = fingerprintIdentity(state);
        if (cached && cached.identityKey === fp && cached.expiresAtMs > now + TOKEN_REFRESH_LEAD_MS) {
          return cached.clients;
        }
        const fresh = await buildAuthorizedClients({
          stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl,
        }).catch((err: any) => {
          const msg = String(err?.message || err);
          if (!msg.includes('hi_identity_missing')) {
            logger.warn?.('[hi-openclaw-plugin] auth client build failed', { error: msg });
          }
          return null;
        });
        if (!fresh) return null;
        // hi-agent-sdk 的 token exchange 默认用 1h TTL，没 expose 实际 expires_in；保守 50min。
        const expiresAtMs = now + 50 * 60_000;
        cached = { identityKey: fp, expiresAtMs, clients: fresh };
        logger.info?.('[hi-openclaw-plugin] auth clients (re)built', { identity_fp: fp, expires_in_min: 50 });
        return fresh;
      };

      const tick = async () => {
        if (stopped) return;
        let backoffMs = config.claimPollIntervalMs;
        try {
          const auth = await ensureClients();
          if (!auth) {
            backoffMs = IDLE_BACKOFF_MS;
            return;
          }
          const claim = await auth.gateway.claimEvents({
            limit: 20,
            lease_ms: config.claimLeaseMs,
          } as any);
          const items = (claim?.items || []) as any[];
          if (items.length > 0) {
            logger.info?.(`[hi-openclaw-plugin] claimed ${items.length} agent event(s)`, {
              first_topic: items[0]?.topic,
              first_event_id: items[0]?.event_id,
            });
            for (const ev of items) {
              try { pushEventToQueue(ev as Record<string, unknown>); }
              catch (err: any) {
                logger.warn?.('[hi-openclaw-plugin] queue push failed', { error: String(err?.message || err) });
              }
            }
            try {
              await auth.gateway.ackEvents({
                lease_id: claim.claim_lease_id,
                acks: items.map((ev: any) => ({ event_id: ev.event_id, status: 'consumed', stream_seq: ev.stream_seq })),
              } as any);
            } catch (err: any) {
              logger.warn?.('[hi-openclaw-plugin] event ack failed', { error: String(err?.message || err) });
            }
            await updateState(stateDir, config.profile, (cur) => ({
              ...cur,
              runtime: {
                ...cur.runtime,
                last_consumed_stream_seq: Math.max(
                  cur.runtime.last_consumed_stream_seq,
                  Math.max(0, ...items.map((ev: any) => Number(ev.stream_seq) || 0)),
                ),
                last_claim_lease_id: claim.claim_lease_id || cur.runtime.last_claim_lease_id,
                updated_at: new Date().toISOString(),
              },
            })).catch(() => {});
          }
        } catch (err: any) {
          const msg = String(err?.message || err);
          // 401 一般是 token 失效，立刻 invalidate cache 让下次重新换 token
          if (msg.includes('401') || /unauthorized/i.test(msg)) {
            cached = null;
          }
          if (!msg.includes('hi_identity_missing')) {
            logger.warn?.('[hi-openclaw-plugin] agent-events tick error', { error: msg });
          }
        } finally {
          scheduleNext(backoffMs);
        }
      };

      const scheduleNext = (delayMs: number) => {
        if (stopped) return;
        timer = setTimeout(tick, delayMs);
      };

      // PROBE: 二分定位 OOM —— 'first-only' 表示跑一次 tick 但不 schedule loop。
      // 能区分 OOM 来自 service register/first-tick 还是 tick 循环累积。
      const TICK_MODE = 'first-only' as 'normal' | 'first-only' | 'disabled';
      if ((TICK_MODE as string) === 'normal') {
        void tick();
      } else if ((TICK_MODE as string) === 'first-only') {
        const onceTick = async () => {
          if (stopped) return;
          try {
            const auth = await ensureClients();
            if (!auth) return;
            const claim = await auth.gateway.claimEvents({ limit: 20, lease_ms: config.claimLeaseMs } as any);
            const items = (claim?.items || []) as any[];
            for (const ev of items) {
              try { pushEventToQueue(ev as Record<string, unknown>); } catch { /* swallow */ }
            }
          } catch { /* swallow */ }
        };
        void onceTick();
      }
      // 抑制 unused warning：normal 模式下我们要保留 scheduleNext 跟 tick 引用
      void scheduleNext;
      void tick;
      logger.info?.('[hi-openclaw-plugin] agent-events service started', {
        webhook_loopback: config.webhookPath,
        tick_mode: TICK_MODE,
      });
    },
    async stop(ctx: PluginServiceContext) {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      cached = null;
      ctx.logger.info?.('[hi-openclaw-plugin] agent-events service stopped');
    },
  };
}
