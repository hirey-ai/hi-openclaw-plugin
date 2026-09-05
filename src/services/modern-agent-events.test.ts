import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runModernEventReceiver } from './modern-agent-events.js';

const event = () => ({ event_id: 'agev_test', topic: 'message.created', payload: {}, lease_token: 'lease', lease_expires_at: new Date(Date.now() + 60_000).toISOString() });
const reply = (result: unknown) => new Response(JSON.stringify({ result }));

test('disabled readiness and empty claims never wake model; interval clamps to 30s', async () => {
  for (const enabled of [false, true]) {
    const abort = new AbortController();
    let calls = 0;
    await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal, intervalMs: 1,
      ready: async () => enabled ? { token: 'test' } : null,
      fetch: async () => { calls++; return reply({ event: null }); },
      deliver: async () => { assert.fail('no model'); },
      wait: async ms => { assert.equal(ms, 30_000); abort.abort(); },
    });
    assert.equal(calls, enabled ? 1 : 0);
  }
});

test('claim full snapshot is delivered then ACKed without GET; failure is not ACKed delivered', async () => {
  for (const accepted of [true, false]) {
    const abort = new AbortController();
    const order: string[] = [];
    await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal,
      ready: async () => ({ token: 'test' }),
      fetch: async (url, init) => {
        const body = JSON.parse(init!.body as string);
        assert.equal(init!.method, 'POST');
        if (String(url).endsWith('/claim')) { order.push('claim'); assert.ok(body.idempotency_key); return reply({ event: event() }); }
        order.push('ack'); assert.equal(body.outcome, accepted ? 'delivered' : 'failed');
        return reply({ event_id: 'agev_test', status: accepted ? 'acked' : 'pending' });
      },
      deliver: async () => { order.push('hook'); return accepted; },
      wait: async () => { abort.abort(); },
    });
    assert.deepEqual(order, ['claim', 'hook', 'ack']);
  }
});

test('ACK transport failure preserves claim key and receipt, avoiding second hook', async () => {
  const abort = new AbortController();
  let ticks = 0, hooks = 0, acks = 0;
  const keys: string[] = [];
  await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal,
    ready: async () => ({ token: 'test' }),
    fetch: async (url, init) => {
      if (init?.method === 'GET') return reply({ event_id: 'agev_test', status: 'leased' });
      const body = JSON.parse(init!.body as string);
      if (String(url).endsWith('/claim')) { keys.push(body.idempotency_key); return reply({ event: event() }); }
      if (++acks === 1) throw new Error('lost');
      return reply({ event_id: 'agev_test', status: 'acked' });
    },
    deliver: async () => { hooks++; return true; },
    wait: async () => { if (++ticks === 2) abort.abort(); },
  });
  assert.equal(hooks, 1); assert.equal(acks, 2); assert.equal(keys[0], keys[1]);
});

test('successful hook receipt survives restart with restrictive file permissions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-receipt-test-'));
  const receiptFile = path.join(dir, 'receipts.json');
  try {
    let hooks = 0;
    for (const first of [true, false]) {
      const abort = new AbortController();
      await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal, receiptFile,
        ready: async () => ({ token: 'test' }),
        fetch: async (url, init) => {
          if (init?.method === 'GET') return reply({ event_id: 'agev_test', status: 'leased' });
          if (String(url).endsWith('/claim')) return reply({ event: event() });
          if (first) throw new Error('ack unavailable');
          return reply({ event_id: 'agev_test', status: 'acked' });
        },
        deliver: async () => { hooks++; return true; },
        wait: async () => abort.abort(),
      });
      assert.equal((await fs.stat(receiptFile)).mode & 0o777, 0o600);
    }
    assert.equal(hooks, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(receiptFile, 'utf8')), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('stop cancels in-flight hook and never ACKs delivered', async () => {
  const abort = new AbortController();
  let requests = 0;
  await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal,
    ready: async () => ({ token: 'test' }),
    fetch: async () => { requests++; return reply({ event: event() }); },
    deliver: async (_event, signal) => { abort.abort(); assert.equal(signal.aborted, true); throw new Error('stopped'); },
  });
  assert.equal(requests, 1);
});

test('expired and malformed leases do not start hooks or ACK', async () => {
  for (const lease of ['invalid', new Date(0).toISOString()]) {
    const abort = new AbortController(); let requests = 0;
    await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal,
      ready: async () => ({ token: 'test' }),
      fetch: async () => { requests++; return reply({ event: { ...event(), lease_expires_at: lease } }); },
      deliver: async () => { assert.fail('invalid lease'); },
      wait: async () => abort.abort(),
    });
    assert.equal(requests, 1);
  }
});

test('expired valid lease rotates claim key and the next cycle can recover', async () => {
  const abort = new AbortController();
  const keys: string[] = [];
  let ticks = 0, hooks = 0, acks = 0;
  await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal,
    ready: async () => ({ token: 'test' }),
    fetch: async (url, init) => {
      const body = JSON.parse(init!.body as string);
      if (String(url).endsWith('/claim')) {
        keys.push(body.idempotency_key);
        return reply({ event: { ...event(), lease_expires_at: keys.length === 1
          ? new Date(0).toISOString() : new Date(Date.now() + 60_000).toISOString() } });
      }
      acks++;
      return reply({ event_id: 'agev_test', status: 'acked' });
    },
    deliver: async () => { hooks++; return true; },
    wait: async () => { if (++ticks === 2) abort.abort(); },
  });
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(hooks, 1);
  assert.equal(acks, 1);
});

test('malformed successful claim response fails closed without waking hooks', async () => {
  for (const payload of [{}, { result: {} }, { result: { event: {} } }]) {
    const abort = new AbortController(); let errors = 0;
    await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal,
      ready: async () => ({ token: 'test' }),
      fetch: async () => new Response(JSON.stringify(payload)),
      deliver: async () => { assert.fail('invalid server response'); },
      onError: () => { errors++; }, wait: async () => abort.abort(),
    });
    assert.equal(errors, 1);
  }
});

test('corrupt receipt storage fails closed before any network call', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-receipt-test-'));
  try {
    const receiptFile = path.join(dir, 'receipts.json');
    await fs.writeFile(receiptFile, '{');
    await assert.rejects(runModernEventReceiver({
      platformBaseUrl: 'https://example.test', signal: new AbortController().signal, receiptFile,
      ready: async () => { assert.fail('must not authenticate'); },
      deliver: async () => { assert.fail('must not wake model'); },
    }), /event_receipt_read_failed/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('committed ACK with lost response reconciles receipt in-process and after restart', async () => {
  for (const restart of [false, true]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-receipt-test-'));
    const receiptFile = path.join(dir, 'receipts.json');
    let committed = false, hooks = 0, gets = 0;
    try {
      for (let run = 0; run < (restart ? 2 : 1); run++) {
        const abort = new AbortController(); let ticks = 0;
        await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal, receiptFile,
          ready: async () => ({ token: 'test' }),
          fetch: async (url, init) => {
            if (init?.method === 'GET') { gets++; return reply({ event_id: 'agev_test', status: 'acked' }); }
            if (String(url).endsWith('/claim')) return reply({ event: committed ? null : event() });
            committed = true;
            throw new Error('response lost after server commit');
          },
          deliver: async () => { hooks++; return true; },
          wait: async () => { if (++ticks === (restart ? 1 : 2)) abort.abort(); },
        });
      }
      assert.equal(hooks, 1); assert.equal(gets, 1);
      assert.deepEqual(JSON.parse(await fs.readFile(receiptFile, 'utf8')), []);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('capacity gate still reconciles one receipt; unknown state is retained', async () => {
  for (const confirmed of [true, false]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-receipt-test-'));
    const receiptFile = path.join(dir, 'receipts.json');
    try {
      await fs.writeFile(receiptFile, JSON.stringify(Array.from({ length: 1000 }, (_, i) => `agev_${i}`)));
      const abort = new AbortController(); let gets = 0, claims = 0;
      await runModernEventReceiver({ platformBaseUrl: 'https://example.test', signal: abort.signal, receiptFile,
        ready: async () => ({ token: 'test' }),
        fetch: async (_url, init) => {
          if (init?.method === 'GET') {
            gets++;
            return confirmed ? reply({ event_id: 'agev_0', status: 'acked' }) : new Response('{}', { status: 404 });
          }
          claims++; return reply({ event: null });
        },
        deliver: async () => { assert.fail('no event'); }, wait: async () => abort.abort(),
      });
      assert.equal(gets, 1); assert.equal(claims, confirmed ? 1 : 0);
      assert.equal(JSON.parse(await fs.readFile(receiptFile, 'utf8')).length, confirmed ? 999 : 1000);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});
