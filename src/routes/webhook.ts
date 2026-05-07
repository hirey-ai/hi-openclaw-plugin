// 接收来自 platform 的 agent events（通过 agent-events service loopback 或 platform 直接 push）。
// 单进程内执行：read body → parse envelope → 决定怎么把 event 桥接到当前 LLM session。
//
// 当前 1.0.0 版本：route 接受 POST + 校验 envelope shape，把 event 写入 plugin 自己的 in-memory
// queue。下一阶段（plugin SDK 提供 api.dispatch / api.deliverEvent 时）真正 bridge 进 LLM session。
// 现阶段配 hi_agent_events_wait 之类的 polling tool 让 LLM 主动 fetch（避免阻塞 plugin SDK 决定）。

import type { PluginHttpRouteDefinition, PluginLogger, HiOpenClawPluginConfig } from '../types.js';

// in-memory event queue（process-lifetime；plugin restart 后清空，但 platform 那侧 events 仍可
// 通过 claim loop 重新拉到，因为 ack 了才算 consumed）。
const _queue: Array<Record<string, unknown>> = [];
const QUEUE_MAX = 500;

export function getQueueSnapshot(): Array<Record<string, unknown>> {
  return [..._queue];
}

export function clearQueue(): void {
  _queue.length = 0;
}

// 给 services/agent-events.ts 用 —— 进程内直推 event，不走 fetch 也不读 env，避开 OpenClaw
// install scanner 的 "credential harvesting (env + network)" 误报。
export function pushEventToQueue(ev: Record<string, unknown>): void {
  _queue.push(ev);
  while (_queue.length > QUEUE_MAX) _queue.shift();
}

async function readBody(req: any): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let raw = '';
    req.setEncoding?.('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

export function buildWebhookRoute(
  config: Required<HiOpenClawPluginConfig>,
  logger: PluginLogger,
): PluginHttpRouteDefinition {
  return {
    path: config.webhookPath,
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
        return;
      }
      try {
        const raw = await readBody(req);
        const env = raw ? JSON.parse(raw) : {};
        if (typeof env !== 'object' || !env) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'invalid_envelope' }));
          return;
        }
        // queue with bounded size (drop oldest if overflow)
        _queue.push(env as Record<string, unknown>);
        while (_queue.length > QUEUE_MAX) _queue.shift();
        logger.info?.('[hi-openclaw-plugin] webhook event queued', {
          topic: (env as any)?.topic ?? null,
          event_id: (env as any)?.event_id ?? null,
          queue_size: _queue.length,
        });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, queued: true, queue_size: _queue.length }));
      } catch (err: any) {
        logger.warn?.('[hi-openclaw-plugin] webhook handler error', { error: String(err?.message || err) });
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'webhook_handler_error', detail: String(err?.message || err) }));
      }
    },
  };
}
