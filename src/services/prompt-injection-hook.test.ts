// Unit tests for prompt-injection-hook: trigger filtering, sessionKey filtering,
// rendering format, mark-as-delivered idempotence.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBeforePromptBuildHook } from './prompt-injection-hook.js';
import { appendPendingPush, pendingPushesDirFor } from './pending-pushes.js';
import type { HiOpenClawPluginConfig } from '../types.js';

const TEST_STATE_DIR = path.join(os.tmpdir(), `hi-hook-test-${process.pid}-${Date.now()}`);

function makeConfig(): Required<HiOpenClawPluginConfig> {
  return {
    platformBaseUrl: 'https://example.invalid',
    profile: 'test',
    stateDir: TEST_STATE_DIR,
    webhookPath: '/hi/webhook',
    claimPollIntervalMs: 1500,
    claimLeaseMs: 60000,
  };
}

beforeEach(() => {
  try { fs.rmSync(pendingPushesDirFor(TEST_STATE_DIR), { recursive: true, force: true }); } catch { /* ignore */ }
});

after(() => {
  try { fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('hook returns void when no pending pushes exist (no false positives)', async () => {
  const hook = createBeforePromptBuildHook({ config: makeConfig() });
  const result = await hook({}, {
    sessionKey: 'agent:main:telegram:default:direct:walter-123',
    trigger: 'user',
  });
  assert.equal(result, undefined);
});

test('hook returns appendSystemContext when undelivered push exists for sessionKey', async () => {
  const sk = 'agent:main:telegram:default:direct:walter-123';
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: sk,
    entry: { event_id: 'evt-1', topic: 'pairing.created', queued_at: 1700_000_000_000, rendered_text: 'someone wants to meet you' },
  });
  const hook = createBeforePromptBuildHook({ config: makeConfig() });
  const result = await hook({}, { sessionKey: sk, trigger: 'user' }) as { appendSystemContext: string };
  assert.ok(result);
  assert.ok(typeof result.appendSystemContext === 'string');
  assert.ok(result.appendSystemContext.includes('<hi_pending_pushes>'));
  assert.ok(result.appendSystemContext.includes('someone wants to meet you'));
  assert.ok(result.appendSystemContext.includes('pairing.created'));
  assert.ok(result.appendSystemContext.includes('evt-1'));
});

test('hook skips when ctx.trigger is "cron" (daemons own /hooks/agent isolated turn)', async () => {
  const sk = 'agent:main:telegram:default:direct:walter-123';
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: sk,
    entry: { event_id: 'evt-1', queued_at: 1000, rendered_text: 'push' },
  });
  const hook = createBeforePromptBuildHook({ config: makeConfig() });
  const result = await hook({}, { sessionKey: sk, trigger: 'cron' });
  assert.equal(result, undefined, 'cron-triggered turn must NOT receive injection (daemons own isolated push turn)');
});

test('hook skips when ctx.trigger is "memory" or "heartbeat"', async () => {
  const sk = 'agent:main:main';
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: sk,
    entry: { event_id: 'evt-x', queued_at: 1000, rendered_text: 'x' },
  });
  const hook = createBeforePromptBuildHook({ config: makeConfig() });
  assert.equal(await hook({}, { sessionKey: sk, trigger: 'memory' }), undefined);
  assert.equal(await hook({}, { sessionKey: sk, trigger: 'heartbeat' }), undefined);
});

test('hook skips when sessionKey is a hook: or bootstrap: throwaway', async () => {
  // We can't write a push to these throwaway keys (no one would) but verify the
  // guard anyway in case a future caller puts something there.
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: 'agent:main:hook:919a7ff4',
    entry: { event_id: 'spurious', queued_at: 1000, rendered_text: 'should not surface' },
  });
  const hook = createBeforePromptBuildHook({ config: makeConfig() });
  assert.equal(
    await hook({}, { sessionKey: 'agent:main:hook:919a7ff4', trigger: 'user' }),
    undefined,
    'hook: prefix throwaway session must not pull push from any source',
  );
  assert.equal(
    await hook({}, { sessionKey: 'agent:main:bootstrap:xyz', trigger: 'user' }),
    undefined,
  );
  assert.equal(
    await hook({}, { sessionKey: 'cron:job-id', trigger: 'user' }),
    undefined,
  );
});

test('hook marks delivered: second fire returns void (idempotent)', async () => {
  const sk = 'agent:main:telegram:default:direct:walter';
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: sk,
    entry: { event_id: 'evt-only-once', queued_at: 1000, rendered_text: 'only once' },
  });
  const hook = createBeforePromptBuildHook({ config: makeConfig() });
  const first = await hook({}, { sessionKey: sk, trigger: 'user' });
  assert.ok(first, 'first fire injects');
  const second = await hook({}, { sessionKey: sk, trigger: 'user' });
  assert.equal(second, undefined, 'second fire is no-op (delivered marked)');
});

test('hook caps single-turn injection at 10 entries; remainder kept for next fire', async () => {
  const sk = 'agent:main:telegram:default:direct:big-queue';
  for (let i = 0; i < 15; i++) {
    appendPendingPush({
      stateDir: TEST_STATE_DIR, sessionKey: sk,
      entry: { event_id: `e${i}`, queued_at: i * 1000, rendered_text: `m${i}` },
    });
  }
  const hook = createBeforePromptBuildHook({ config: makeConfig() });
  const first = await hook({}, { sessionKey: sk, trigger: 'user' }) as { appendSystemContext: string };
  assert.ok(first);
  // First 10 in FIFO order
  for (let i = 0; i < 10; i++) {
    assert.ok(first.appendSystemContext.includes(`e${i}`), `e${i} should be in first batch`);
  }
  assert.ok(!first.appendSystemContext.includes('e10'), 'e10 should NOT be in first batch');
  // Second fire picks up the rest
  const second = await hook({}, { sessionKey: sk, trigger: 'user' }) as { appendSystemContext: string };
  assert.ok(second);
  for (let i = 10; i < 15; i++) {
    assert.ok(second.appendSystemContext.includes(`e${i}`), `e${i} should be in second batch`);
  }
});

test('hook is tolerant of missing/null/undefined ctx fields (no crash)', async () => {
  const hook = createBeforePromptBuildHook({ config: makeConfig() });
  assert.equal(await hook({}, undefined), undefined);
  assert.equal(await hook({}, null), undefined);
  assert.equal(await hook({}, {}), undefined);
  assert.equal(await hook({}, { trigger: 'user' }), undefined, 'no sessionKey');
  assert.equal(await hook({}, { sessionKey: '' }), undefined, 'empty sessionKey + missing trigger');
});

test('renders newest-last (FIFO order) so LLM sees temporal flow', async () => {
  const sk = 'agent:main:telegram:default:direct:order-test';
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: sk,
    entry: { event_id: 'first', queued_at: 1000, rendered_text: 'OLDEST' },
  });
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: sk,
    entry: { event_id: 'second', queued_at: 2000, rendered_text: 'NEWEST' },
  });
  const hook = createBeforePromptBuildHook({ config: makeConfig() });
  const result = await hook({}, { sessionKey: sk, trigger: 'user' }) as { appendSystemContext: string };
  const oldestIdx = result.appendSystemContext.indexOf('OLDEST');
  const newestIdx = result.appendSystemContext.indexOf('NEWEST');
  assert.ok(oldestIdx >= 0 && newestIdx >= 0);
  assert.ok(oldestIdx < newestIdx, 'OLDEST should appear before NEWEST in render');
});
