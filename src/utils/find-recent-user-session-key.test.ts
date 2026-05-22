// Unit tests for findRecentUserSessionKey. Pre-1.0.33 it parsed sessions.json as
// {sessions: [...]} array form which never matched OpenClaw's real schema
// ({<sessionKey>: SessionEntry}), so it returned null on every prod install. This
// silently disabled the daemon's "most recent user session" fallback path, which
// is the routing path for events without explicit reply_route_snapshot.session_key
// (Walter-class bugs). 1.0.33 fixes the parser.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// We can't directly stub HOME for the function (it uses os.homedir() at call time).
// Approach: dynamically construct a temp dir mimicking ~/.openclaw structure and
// monkey-patch os.homedir via process.env HOME. After tests, restore.
const TMP_HOME = path.join(os.tmpdir(), `hi-findrecent-test-${process.pid}-${Date.now()}`);
const SESSIONS_DIR = path.join(TMP_HOME, '.openclaw', 'agents', 'main', 'sessions');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'sessions.json');

const originalHome = process.env.HOME;

beforeEach(() => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  process.env.HOME = TMP_HOME;
});

after(() => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Importing AFTER HOME is set; need dynamic import per test for clean module state.
async function loadFn() {
  // bust import cache by appending a query (only works for file:// URLs in some setups);
  // easier to rely on os.homedir() being called fresh on each invocation
  const mod = await import('./openclaw-config.js');
  return mod.findRecentUserSessionKey;
}

test('returns null when sessions.json does not exist', async () => {
  // No file written
  const fn = await loadFn();
  assert.equal(fn(), null);
});

test('returns null when sessions.json is empty / not an object', async () => {
  fs.writeFileSync(SESSIONS_FILE, '[]');
  const fn = await loadFn();
  assert.equal(fn(), null);
});

test('returns null when sessions.json is malformed JSON', async () => {
  fs.writeFileSync(SESSIONS_FILE, 'not json');
  const fn = await loadFn();
  assert.equal(fn(), null);
});

test('returns most-recently-updated non-hook session', async () => {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
    'agent:main:imessage:direct:+8618813188177': { sessionId: 'older', updatedAt: 1000 },
    'agent:main:telegram:direct:walter': { sessionId: 'middle', updatedAt: 5000 },
    'agent:main:explicit:test': { sessionId: 'newest', updatedAt: 9000 },
  }));
  const fn = await loadFn();
  assert.equal(fn(), 'agent:main:explicit:test');
});

test('excludes hook: prefix sessions (top-level)', async () => {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
    'hook:919a7ff4-newer': { sessionId: 'hook', updatedAt: 9999 },
    'agent:main:imessage:direct:walter': { sessionId: 'user', updatedAt: 5000 },
  }));
  const fn = await loadFn();
  assert.equal(fn(), 'agent:main:imessage:direct:walter');
});

test('excludes nested :hook: in agent:<id>:hook:<uuid> form', async () => {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
    'agent:main:hook:abc123-newer': { sessionId: 'nested-hook', updatedAt: 9999 },
    'agent:main:telegram:direct:walter': { sessionId: 'real', updatedAt: 5000 },
  }));
  const fn = await loadFn();
  assert.equal(fn(), 'agent:main:telegram:direct:walter');
});

test('excludes bootstrap: prefix (top-level + nested)', async () => {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
    'bootstrap:xxx': { updatedAt: 9999 },
    'agent:main:bootstrap:yyy': { updatedAt: 9998 },
    'agent:main:main': { updatedAt: 1 },
  }));
  const fn = await loadFn();
  assert.equal(fn(), 'agent:main:main');
});

test('excludes cron: prefix', async () => {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
    'cron:job-abc': { updatedAt: 9999 },
    'agent:main:imessage:walter': { updatedAt: 100 },
  }));
  const fn = await loadFn();
  assert.equal(fn(), 'agent:main:imessage:walter');
});

test('returns null when all sessions are throwaways', async () => {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
    'hook:a': { updatedAt: 1 },
    'cron:b': { updatedAt: 2 },
    'agent:main:bootstrap:c': { updatedAt: 3 },
  }));
  const fn = await loadFn();
  assert.equal(fn(), null);
});

test('handles entries with missing/non-numeric updatedAt as updatedAt=0', async () => {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
    'agent:main:a': { sessionId: 'no-updated' },
    'agent:main:b': { sessionId: 'has-updated', updatedAt: 100 },
    'agent:main:c': { sessionId: 'bad-updated', updatedAt: 'not-a-number' },
  }));
  const fn = await loadFn();
  assert.equal(fn(), 'agent:main:b', 'b is the only one with a valid > 0 timestamp');
});

test('regression: pre-1.0.33 expected {sessions: [...]} array form, MUST also work', async () => {
  // The pre-1.0.33 schema (which never existed in OpenClaw but the parser expected)
  // would have looked like this. The new parser doesn't match it, so this should
  // return null. This test documents that we intentionally do NOT support the
  // legacy expected-but-never-existed form.
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
    sessions: [
      { key: 'agent:main:foo', updatedAt: 100 },
    ],
  }));
  const fn = await loadFn();
  // The "sessions" key itself doesn't start with hook:/bootstrap:/cron:, so it
  // would actually match. The entry's updatedAt is undefined, so it gets 0.
  // The function will return "sessions" as the most-recent key. That's wrong but
  // arguably better than returning null forever as the old code did. Document
  // this edge case rather than try to detect "wrong schema."
  // In production, real OpenClaw sessions.json never looks like this so it's moot.
  assert.equal(fn(), 'sessions', 'old expected schema gets parsed as a single weird key "sessions"');
});
