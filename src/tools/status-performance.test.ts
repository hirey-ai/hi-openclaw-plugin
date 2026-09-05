import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildEmptyState, writeState, updateState} from '../state.js';
import {buildAuthorizedClients} from '../clients.js';
import {buildHiAgentStatusTool} from './control.js';

async function fixture() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'hi-status-perf-'));
  const state = buildEmptyState('perf');
  state.identity = {agent_id: 'a', client_id: 'fixture-client', client_secret: 'fixture-secret',
    token_url: 'https://oauth.invalid/token', api_key: 'fixture-key', activated_at: null} as any;
  await writeState(stateDir, 'perf', state);
  const config = {stateDir, profile: 'perf', platformBaseUrl: 'https://perf.invalid',
    webhookPath: '/hi', claimPollIntervalMs: 30_000, claimLeaseMs: 30_000, modernEvents: {}};
  return {config, cleanup: () => rm(stateDir, {recursive: true, force: true})};
}

function mockNetwork(delay = 0) {
  const calls: {path: string; start: number; end: number}[] = [];
  let rejectMe = false;
  let lifetime = 3600;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const call = {path: url.pathname, start: performance.now(), end: 0};
    calls.push(call);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-hirey-plugin-host'), 'openclaw');
    assert.equal(headers.get('x-hirey-plugin-version'), '1.0.75');
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    call.end = performance.now();
    let body: unknown;
    if (url.pathname === '/token') body = {access_token: 'fixture-access', expires_in: lifetime};
    else if (url.pathname.includes('.well-known')) {
      assert.equal(headers.get('authorization'), null, 'discovery must remain public');
      body = {platform: {platform_base_url: 'https://business.invalid', registry_base_url: 'https://gateway.invalid'}};
    } else if (url.pathname === '/v1/capabilities') body = {_meta: {hirey_plugin: {update_required: false}}};
    else if (url.pathname === '/v1/agents/me') {
      assert.equal(url.origin, 'https://gateway.invalid');
      assert.equal(headers.get('authorization'), 'Bearer fixture-access');
      if (rejectMe) return Response.json({error: 'unauthorized'}, {status: 401});
      body = {agent_id: 'a', person_id: 'p', workspace_id: 'w', agent_session_id: 's'};
    } else throw Error(`unexpected request ${url.pathname}`);
    return Response.json(body);
  };
  return {calls, fetchImpl, reject: () => {rejectMe = true;}, expire: () => {lifetime = 1;}};
}

test('cold status overlaps policy, OAuth and discovery; warm status still verifies real identity', async t => {
  const f = await fixture();
  const network = mockNetwork(60);
  const original = globalThis.fetch;
  globalThis.fetch = network.fetchImpl;
  try {
    // Previous implementation awaited these four reads in sequence. Measure
    // its network critical path with exactly the same controlled request delay.
    const baselineStart = performance.now();
    for (let n = 0; n < 4; n++) await new Promise(resolve => setTimeout(resolve, 60));
    const baselineMs = performance.now() - baselineStart;
    const tool = buildHiAgentStatusTool(f.config);
    const start = performance.now();
    const result = await tool.execute('cold', {include_remote: true});
    const optimizedMs = performance.now() - start;
    assert.equal((result.structuredContent as any).summary.activated, true);
    assert.equal(network.calls.length, 4);
    const firstWave = network.calls.filter(call => call.path !== '/v1/agents/me');
    assert.ok(Math.max(...firstWave.map(c => c.start)) < Math.min(...firstWave.map(c => c.end)),
      'policy, OAuth and public discovery must be in flight together');
    const me = network.calls.find(c => c.path === '/v1/agents/me')!;
    assert.ok(me.start >= Math.max(...firstWave.filter(c => c.path !== '/v1/capabilities').map(c => c.end)));
    t.diagnostic(JSON.stringify({baselineRequests: 4, optimizedRequests: 4, baselineMs, optimizedMs}));
    const beforeWarm = network.calls.length;
    await tool.execute('warm', {include_remote: true});
    assert.deepEqual(network.calls.slice(beforeWarm).map(c => c.path).sort(), ['/v1/agents/me', '/v1/capabilities']);
  } finally {globalThis.fetch = original; await f.cleanup();}
});

test('401 drops cached authorization and never reports remote activation from local state', async () => {
  const f = await fixture();
  const network = mockNetwork();
  const original = globalThis.fetch;
  globalThis.fetch = network.fetchImpl;
  try {
    const tool = buildHiAgentStatusTool(f.config);
    await tool.execute('valid', {include_remote: true});
    await updateState(f.config.stateDir, f.config.profile, state => ({...state,
      identity: {...state.identity!, activated_at: new Date().toISOString()}}));
    network.reject();
    const failed = await tool.execute('rejected', {include_remote: true});
    assert.equal((failed.structuredContent as any).summary.activated, false);
    assert.equal((failed.structuredContent as any).remote.error, 'unauthorized');
    const before = network.calls.length;
    await tool.execute('retry', {include_remote: true});
    assert.ok(network.calls.slice(before).some(c => c.path === '/token'));
  } finally {globalThis.fetch = original; await f.cleanup();}
});

test('short token lifetime is not extended by the authorization cache', async () => {
  const f = await fixture();
  const network = mockNetwork(); network.expire();
  const original = globalThis.fetch; globalThis.fetch = network.fetchImpl;
  try {
    await buildAuthorizedClients(f.config);
    await buildAuthorizedClients(f.config);
    assert.equal(network.calls.filter(c => c.path === '/token').length, 2);
  } finally {globalThis.fetch = original; await f.cleanup();}
});

test('concurrent client requests share one exchange; changing target origin does not reuse authorization', async () => {
  const f = await fixture();
  const network = mockNetwork(10);
  const original = globalThis.fetch; globalThis.fetch = network.fetchImpl;
  try {
    const [a, b] = await Promise.all([buildAuthorizedClients(f.config), buildAuthorizedClients(f.config)]);
    assert.equal(a, b);
    assert.equal(network.calls.filter(c => c.path === '/token').length, 1);
    await buildAuthorizedClients({...f.config, platformBaseUrl: 'https://another.invalid'});
    assert.equal(network.calls.filter(c => c.path === '/token').length, 2);
  } finally {globalThis.fetch = original; await f.cleanup();}
});
