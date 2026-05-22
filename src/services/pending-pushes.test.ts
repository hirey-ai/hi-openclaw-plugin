// Unit tests for pending-pushes module: per-sessionKey persistent queue, dedupe,
// markDelivered + TTL GC, multi-session isolation.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendPendingPush,
  readUndeliveredPendingPushes,
  markDelivered,
  gcPendingPushes,
  pendingPushesFileFor,
  pendingPushesDirFor,
} from './pending-pushes.js';

const TEST_STATE_DIR = path.join(os.tmpdir(), `hi-pending-pushes-test-${process.pid}-${Date.now()}`);

beforeEach(() => {
  try {
    fs.rmSync(pendingPushesDirFor(TEST_STATE_DIR), { recursive: true, force: true });
  } catch { /* ignore */ }
});

after(() => {
  try {
    fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
});

test('appendPendingPush writes new entry; readUndeliveredPendingPushes returns it', () => {
  const sessionKey = 'agent:main:telegram:default:direct:walter-123';
  appendPendingPush({
    stateDir: TEST_STATE_DIR,
    sessionKey,
    entry: { event_id: 'evt-1', queued_at: 1000, rendered_text: 'hello push' },
  });
  const undelivered = readUndeliveredPendingPushes({ stateDir: TEST_STATE_DIR, sessionKey });
  assert.equal(undelivered.length, 1);
  assert.equal(undelivered[0].event_id, 'evt-1');
  assert.equal(undelivered[0].rendered_text, 'hello push');
});

test('appendPendingPush dedupes by event_id', () => {
  const sessionKey = 'agent:main:main';
  const r1 = appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey,
    entry: { event_id: 'evt-dup', queued_at: 1000, rendered_text: 'first' },
  });
  const r2 = appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey,
    entry: { event_id: 'evt-dup', queued_at: 2000, rendered_text: 'second (should be dropped)' },
  });
  assert.equal(r1.wrote, true);
  assert.equal(r2.wrote, false);
  assert.equal(r2.reason, 'duplicate_event_id');
  const undelivered = readUndeliveredPendingPushes({ stateDir: TEST_STATE_DIR, sessionKey });
  assert.equal(undelivered.length, 1);
  assert.equal(undelivered[0].rendered_text, 'first', 'original kept, dup ignored');
});

test('markDelivered sets delivered_at; subsequent read excludes them', () => {
  const sessionKey = 'agent:main:imessage:direct:+86001';
  for (const id of ['a', 'b', 'c']) {
    appendPendingPush({
      stateDir: TEST_STATE_DIR, sessionKey,
      entry: { event_id: id, queued_at: 1000, rendered_text: `msg-${id}` },
    });
  }
  assert.equal(readUndeliveredPendingPushes({ stateDir: TEST_STATE_DIR, sessionKey }).length, 3);
  markDelivered({ stateDir: TEST_STATE_DIR, sessionKey, event_ids: ['a', 'c'] });
  const after = readUndeliveredPendingPushes({ stateDir: TEST_STATE_DIR, sessionKey });
  assert.equal(after.length, 1);
  assert.equal(after[0].event_id, 'b');
});

test('multi-session isolation: different sessionKeys do not see each others entries', () => {
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: 'agent:main:telegram:a',
    entry: { event_id: 'tele-1', queued_at: 1000, rendered_text: 'for tele' },
  });
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: 'agent:main:imessage:b',
    entry: { event_id: 'imsg-1', queued_at: 1000, rendered_text: 'for imsg' },
  });
  const tele = readUndeliveredPendingPushes({ stateDir: TEST_STATE_DIR, sessionKey: 'agent:main:telegram:a' });
  const imsg = readUndeliveredPendingPushes({ stateDir: TEST_STATE_DIR, sessionKey: 'agent:main:imessage:b' });
  assert.equal(tele.length, 1);
  assert.equal(tele[0].event_id, 'tele-1');
  assert.equal(imsg.length, 1);
  assert.equal(imsg[0].event_id, 'imsg-1');
});

test('pendingPushesFileFor uses sha256 hash of sessionKey (deterministic, path-safe)', () => {
  const sessionKey = 'agent:main:telegram:default:direct:+86001';
  const fp1 = pendingPushesFileFor(TEST_STATE_DIR, sessionKey);
  const fp2 = pendingPushesFileFor(TEST_STATE_DIR, sessionKey);
  assert.equal(fp1, fp2, 'same input → same path');
  assert.ok(fp1.endsWith('.jsonl'));
  assert.ok(!fp1.includes(':'), 'no path-unsafe chars in filename');
  const fp3 = pendingPushesFileFor(TEST_STATE_DIR, 'different-session');
  assert.notEqual(fp1, fp3, 'different sessionKey → different path');
});

test('readUndeliveredPendingPushes returns empty array when file does not exist', () => {
  const result = readUndeliveredPendingPushes({
    stateDir: TEST_STATE_DIR,
    sessionKey: 'agent:main:never-touched',
  });
  assert.equal(result.length, 0);
});

test('markDelivered on never-existed sessionKey is a no-op (no crash)', () => {
  // Should not throw
  markDelivered({
    stateDir: TEST_STATE_DIR,
    sessionKey: 'agent:main:phantom',
    event_ids: ['e1', 'e2'],
  });
});

test('markDelivered after 24h+ prunes the delivered entry; file deleted if no remaining', () => {
  const sessionKey = 'agent:main:gc-test';
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey,
    entry: { event_id: 'e1', queued_at: 1000, rendered_text: 'msg' },
  });
  // Manually rewrite with delivered_at far in the past
  const filePath = pendingPushesFileFor(TEST_STATE_DIR, sessionKey);
  const past = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
  fs.writeFileSync(filePath, JSON.stringify({
    event_id: 'e1', queued_at: 1000, rendered_text: 'msg', delivered_at: past,
  }) + '\n');
  // Trigger markDelivered with empty ids — it still prunes
  markDelivered({ stateDir: TEST_STATE_DIR, sessionKey, event_ids: [] });
  assert.equal(fs.existsSync(filePath), false, 'file deleted when only entries were expired delivered');
});

test('gcPendingPushes scans dir, prunes expired delivered, removes empty files', () => {
  // session A: only expired delivered
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: 'agent:main:A',
    entry: { event_id: 'a1', queued_at: 1000, rendered_text: 'a', delivered_at: Date.now() - 48 * 60 * 60 * 1000 },
  });
  // session B: undelivered (keep)
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: 'agent:main:B',
    entry: { event_id: 'b1', queued_at: 1000, rendered_text: 'b' },
  });
  // session C: recent delivered (keep)
  appendPendingPush({
    stateDir: TEST_STATE_DIR, sessionKey: 'agent:main:C',
    entry: { event_id: 'c1', queued_at: 1000, rendered_text: 'c', delivered_at: Date.now() - 60_000 },
  });

  const result = gcPendingPushes({ stateDir: TEST_STATE_DIR });
  assert.equal(result.scanned, 3);
  assert.equal(result.removed, 1, 'session A file removed');
  assert.equal(fs.existsSync(pendingPushesFileFor(TEST_STATE_DIR, 'agent:main:A')), false);
  assert.equal(fs.existsSync(pendingPushesFileFor(TEST_STATE_DIR, 'agent:main:B')), true);
  assert.equal(fs.existsSync(pendingPushesFileFor(TEST_STATE_DIR, 'agent:main:C')), true);
});

test('gcPendingPushes on non-existent dir is no-op', () => {
  const result = gcPendingPushes({ stateDir: path.join(os.tmpdir(), 'nonexistent-xyz-' + Date.now()) });
  assert.equal(result.scanned, 0);
  assert.equal(result.pruned, 0);
  assert.equal(result.removed, 0);
});

test('cap at MAX_TOTAL_ENTRIES (50) — oldest dropped when exceeded', () => {
  const sessionKey = 'agent:main:cap-test';
  for (let i = 0; i < 60; i++) {
    appendPendingPush({
      stateDir: TEST_STATE_DIR, sessionKey,
      entry: { event_id: `e${i}`, queued_at: i * 1000, rendered_text: `m${i}` },
    });
  }
  const undelivered = readUndeliveredPendingPushes({ stateDir: TEST_STATE_DIR, sessionKey });
  assert.equal(undelivered.length, 50, 'capped at 50');
  // Newest 50 should be kept (e10..e59)
  assert.equal(undelivered[0].event_id, 'e10');
  assert.equal(undelivered[49].event_id, 'e59');
});

test('malformed lines in file do not crash; valid entries returned', () => {
  const sessionKey = 'agent:main:malformed-test';
  const filePath = pendingPushesFileFor(TEST_STATE_DIR, sessionKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({ event_id: 'good-1', queued_at: 1000, rendered_text: 'ok' }),
      'this is not json',
      '',
      JSON.stringify({ event_id: 'good-2', queued_at: 2000, rendered_text: 'ok2' }),
      JSON.stringify({ event_id: '', queued_at: 3000, rendered_text: 'empty id should be skipped' }),
    ].join('\n'),
  );
  const undelivered = readUndeliveredPendingPushes({ stateDir: TEST_STATE_DIR, sessionKey });
  assert.equal(undelivered.length, 2);
  assert.equal(undelivered[0].event_id, 'good-1');
  assert.equal(undelivered[1].event_id, 'good-2');
});
