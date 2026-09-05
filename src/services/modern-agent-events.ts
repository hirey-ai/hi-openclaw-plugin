import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PLUGIN_VERSION } from '../version.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ModernEvent = {
  event_id: string;
  lease_token: string;
  lease_expires_at: string;
  topic: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
};

export type ModernEventReceiverOptions = {
  platformBaseUrl: string;
  signal: AbortSignal;
  intervalMs?: number;
  receiptFile?: string;
  // Returning null must be side-effect-free: no registration, hook repair or claim.
  ready: () => Promise<{ token: string } | null>;
  deliver: (event: ModernEvent, signal: AbortSignal) => Promise<boolean>;
  fetch?: typeof fetch;
  onError?: () => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

// Gateway 8608db4: claim returns the full snapshot, so no extra GET is needed.
// At-least-once delivery: receipts suppress repeats while this process lives;
// hook acceptance is not proof of model completion or external channel delivery.
export async function runModernEventReceiver(options: ModernEventReceiverOptions): Promise<void> {
  const fetcher = options.fetch ?? fetch;
  const interval = Math.max(30_000, options.intervalMs || 30_000);
  const receipts = new Set<string>();
  if (options.receiptFile) {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(options.receiptFile, 'utf8'));
      if (!Array.isArray(saved) || saved.length > 1000 || saved.some(id => typeof id !== 'string')) {
        throw new Error('invalid_event_receipts');
      }
      saved.forEach(id => receipts.add(id));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error('event_receipt_read_failed');
    }
  }
  const saveReceipts = async () => {
    if (!options.receiptFile) return;
    await fs.mkdir(path.dirname(options.receiptFile), { recursive: true, mode: 0o700 });
    const temp = `${options.receiptFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify([...receipts]), { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, options.receiptFile);
    } finally { await fs.unlink(temp).catch(() => {}); }
  };
  let claimKey = randomUUID();
  let reconcileOffset = 0;
  const request = async (path: string, body: unknown, token: string) => {
    const response = await fetcher(`${options.platformBaseUrl.replace(/\/+$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'x-hirey-plugin-host': 'openclaw', 'x-hirey-plugin-version': PLUGIN_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error(`agent_events_http_${response.status}`);
    const data = await response.json() as { result?: any };
    if (!data || !Object.hasOwn(data, 'result')) throw new Error('agent_events_invalid_response');
    return data.result;
  };
  const post = request;
  while (!options.signal.aborted) {
    try {
      const ready = await options.ready();
      if (ready && !options.signal.aborted) {
        // Only unresolved ACKs / restart receipts incur a GET. One rotating
        // lookup per cycle bounds recovery traffic and runs before capacity gate.
        const pending = [...receipts];
        if (pending.length) {
          const id = pending[reconcileOffset++ % pending.length];
          try {
            const current = await request(`/v1/agent-events/${encodeURIComponent(id)}`, undefined, ready.token);
            if (current?.event_id === id && current?.status === 'acked') {
              receipts.delete(id);
              await saveReceipts();
            }
          } catch {
            // 404, malformed responses and outages are not completion proof.
          }
        }
        // Do not evict unknown receipts. Reconciliation above can free capacity.
        if (receipts.size < 1000 && !options.signal.aborted) {
        const claimed = await post('/v1/agent-events/claim', { idempotency_key: claimKey }, ready.token);
        if (!claimed || !Object.hasOwn(claimed, 'event')) throw new Error('agent_events_invalid_claim');
        const event = claimed.event as ModernEvent | null;
        if (event === null) {
          claimKey = randomUUID();
        } else {
          if (typeof event.event_id !== 'string' || !event.event_id ||
              typeof event.lease_token !== 'string' || !event.lease_token ||
              !Number.isFinite(Date.parse(event.lease_expires_at))) {
            throw new Error('agent_events_invalid_lease');
          }
          // Never launch a hook outside its lease. Gateway has no renew API.
          const remaining = Date.parse(event.lease_expires_at) - Date.now() - 5_000;
          if (remaining <= 0) {
            // The claim response is structurally valid but can no longer be used. A new
            // idempotency key is required on the next cycle; reusing the old key can make the
            // gateway replay this same expired lease forever.
            claimKey = randomUUID();
          } else if (!options.signal.aborted) {
            let delivered = receipts.has(event.event_id);
            if (!delivered) {
              try {
                delivered = await options.deliver(event, AbortSignal.any([
                  options.signal, AbortSignal.timeout(Math.min(remaining, 30_000)),
                ]));
              } catch { delivered = false; }
              if (delivered) {
                receipts.add(event.event_id);
                await saveReceipts();
              }
            }
            if (!options.signal.aborted) {
              if (delivered) await saveReceipts();
              const result = await post('/v1/agent-events/ack', {
                event_id: event.event_id, lease_token: event.lease_token,
                outcome: delivered ? 'delivered' : 'failed',
                ...(!delivered ? { error_code: 'local_hook_delivery_failed' } : {}),
              }, ready.token);
              if (result?.event_id !== event.event_id || !(delivered
                ? result?.status === 'acked'
                : ['pending', 'dead_letter'].includes(result?.status))) {
                throw new Error('agent_events_invalid_ack');
              }
              receipts.delete(event.event_id);
              await saveReceipts();
              claimKey = randomUUID();
            }
          }
        }
        }
      }
    } catch {
      // Preserve claim key and successful local receipt across transport errors.
      // Never log payloads, credentials, lease tokens or response bodies.
      if (!options.signal.aborted) options.onError?.();
    }
    if (options.signal.aborted) break;
    try {
      if (options.wait) await options.wait(interval, options.signal);
      else await delay(interval, undefined, { signal: options.signal });
    } catch { break; }
  }
}
