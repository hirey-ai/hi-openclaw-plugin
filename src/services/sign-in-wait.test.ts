import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAgentEventsService } from './agent-events.js';
import { buildEmptyState, writeState } from '../state.js';
import { buildAuthorizedClients, invalidateAuthorizedClients } from '../clients.js';
import {
  nextSignInWaitMs,
  notifySignedIn,
  SIGN_IN_WAIT_MAX_MS,
  SIGN_IN_WAIT_MIN_MS,
  waitForSignIn,
} from './sign-in-wait.js';

const BASE = 'https://fixture.invalid';

test('the sign-in wait grows from 5 minutes to a 6-hour cap', () => {
  let ms = 0;
  const seen: number[] = [];
  for (let i = 0; i < 10; i++) seen.push(ms = nextSignInWaitMs(ms));
  assert.equal(seen[0], SIGN_IN_WAIT_MIN_MS);
  assert.equal(seen[1], 2 * SIGN_IN_WAIT_MIN_MS);
  assert.equal(seen.at(-1), SIGN_IN_WAIT_MAX_MS);
});

test('a sign-in wait ends on notifySignedIn or abort', async () => {
  const woken = waitForSignIn(60 * 60_000);
  notifySignedIn();
  await woken;
  const abort = new AbortController();
  const aborted = waitForSignIn(60 * 60_000, abort.signal);
  abort.abort();
  await aborted;
});

// A legacy installation (installation_id set, hooks configured) whose Agent was
// never signed in: token exchange returns an anonymous hi_ai_ token.
async function legacyPendingFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-sign-in-wait-'));
  const state = buildEmptyState('fixture');
  state.identity = {
    agent_id: 'ag_fixture', installation_id: 'inst_fixture',
    client_id: 'fixture-client', client_secret: 'fixture-secret',
    token_url: `${BASE}/oauth/token`,
  } as any;
  state.runtime.install = { hooks_token: 'fixture-hooks', hooks_path: '/hooks', gateway_port: 18789 } as any;
  await writeState(dir, 'fixture', state);
  return dir;
}

function fakeFetch(token: () => string) {
  const calls: string[] = [];
  const impl = async (input: any) => {
    const url = String(input?.url ?? input);
    calls.push(new URL(url).pathname);
    if (url.endsWith('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: token(), token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/.well-known/')) {
      return new Response(JSON.stringify({ platform: { platform_base_url: BASE, registry_base_url: BASE } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Event endpoints: fail fast so the loop backs off.
    return new Response(JSON.stringify({ error: 'fixture' }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  return { calls, impl };
}

test('a pending legacy installation never claims and resumes once signed in', async () => {
  const dir = await legacyPendingFixture();
  const originalFetch = globalThis.fetch;
  let accessToken = 'hi_ai_fixtureanonymoustoken';
  const fake = fakeFetch(() => accessToken);
  globalThis.fetch = fake.impl as any;
  const warnings: string[] = [];
  const service = buildAgentEventsService({
    modernEvents: {} as any, stateDir: dir, profile: 'fixture',
    platformBaseUrl: BASE, webhookPath: '/hi',
    claimPollIntervalMs: 30_000, claimLeaseMs: 30_000,
  });
  const ctx = { logger: { warn: (msg: string) => warnings.push(msg), info: () => {} } } as any;
  try {
    await service.start(ctx);
    await new Promise(resolve => setTimeout(resolve, 200));
    const claims = () => fake.calls.filter(p => p.startsWith('/v1/agent-events')).length;
    assert.equal(claims(), 0, 'a pending Agent must not claim');
    assert.equal(fake.calls.filter(p => p === '/oauth/token').length, 1, 'one token exchange, then wait');
    assert.equal(warnings.filter(w => w.includes('not signed in')).length, 1);

    // The user signs in; the next tool call's token exchange returns a signed-in
    // token, which wakes the event service.
    accessToken = 'eyJ.fixture.signedin';
    invalidateAuthorizedClients(dir, 'fixture');
    await buildAuthorizedClients({ stateDir: dir, profile: 'fixture', platformBaseUrl: BASE });
    const deadline = Date.now() + 2_000;
    while (claims() === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(claims() > 0, 'claims resume after sign-in');
  } finally {
    await service.stop?.(ctx);
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
