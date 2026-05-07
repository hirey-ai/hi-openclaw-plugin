// agent-events claim loop service：替换原 hi-agent-receiver 独立 daemon。
// 在 OpenClaw gateway 进程内长跑：周期性向平台 /v1/agent-events/claim 拉取 owner-actionable
// events，对每个 event 触发 plugin 内部 webhook route（同一进程内 fetch loopback）让 plugin
// 把 event 桥接到当前 LLM session。
//
// 这是 native plugin 替代 spawn-based receiver 的核心收益：少 1 个独立进程 + 不需要 hooks token
// 那一整套间接层。

import type { PluginServiceContext, PluginServiceDefinition, HiOpenClawPluginConfig } from '../types.js';
import { buildAuthorizedClients, peekQuarantineNotice } from '../clients.js';
import { resolveStateDir, updateState } from '../state.js';

export function buildAgentEventsService(config: Required<HiOpenClawPluginConfig>): PluginServiceDefinition {
  const stateDir = config.stateDir || resolveStateDir(config.profile);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
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

      const tick = async () => {
        if (stopped) return;
        try {
          // 没 identity 之前 claim 不可能 work，安静等到下次 install
          const auth = await buildAuthorizedClients({
            stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl,
          }).catch(() => null);
          if (!auth) {
            scheduleNext();
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
            // 把 events 通过 plugin 自己的 webhook route 投递（loopback）。
            // OpenClaw gateway HTTP server 监听端口同进程内可访问。
            const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || '18789';
            for (const ev of items) {
              try {
                await fetch(`http://127.0.0.1:${gatewayPort}${config.webhookPath}`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(ev),
                });
              } catch (err: any) {
                logger.warn?.('[hi-openclaw-plugin] webhook loopback delivery failed', { error: String(err?.message || err) });
              }
            }
            // ack consumed events back to platform
            try {
              await auth.gateway.ackEvents({
                lease_id: claim.claim_lease_id,
                acks: items.map((ev: any) => ({ event_id: ev.event_id, status: 'consumed', stream_seq: ev.stream_seq })),
              } as any);
            } catch (err: any) {
              logger.warn?.('[hi-openclaw-plugin] event ack failed', { error: String(err?.message || err) });
            }
            // bump persisted runtime cursor
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
          // identity_missing 是预期，不刷屏
          const msg = String(err?.message || err);
          if (!msg.includes('hi_identity_missing')) {
            logger.warn?.('[hi-openclaw-plugin] agent-events tick error', { error: msg });
          }
        } finally {
          scheduleNext();
        }
      };

      const scheduleNext = () => {
        if (stopped) return;
        timer = setTimeout(tick, config.claimPollIntervalMs);
      };

      // first tick immediately
      void tick();
      logger.info?.('[hi-openclaw-plugin] agent-events service started', {
        webhook_loopback: config.webhookPath,
        quarantined_stale_identity: peekQuarantineNotice(),
      });
    },
    async stop(ctx: PluginServiceContext) {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      ctx.logger.info?.('[hi-openclaw-plugin] agent-events service stopped');
    },
  };
}
