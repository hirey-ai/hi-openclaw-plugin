import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEmptyState, writeState } from '../state.js';
import { getStatusPluginReleasePolicy } from '../clients.js';
import { buildHiAgentStatusTool, redactControlCredentials } from './control.js';

test('local status excludes persisted credentials from both result formats and does not wait for network', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hi-status-test-'));
  const originalFetch = globalThis.fetch;
  let finish!: (value: Response) => void;
  let requests = 0;
  globalThis.fetch = (() => { requests++; return new Promise(resolve => { finish = resolve; }); }) as typeof fetch;
  try {
    const state = buildEmptyState('test');
    state.identity = {
      agent_id: 'agent-test', installation_id: 'installation-test',
      client_secret: 'FAKE_CLIENT_SECRET', api_key: 'FAKE_API_KEY',
      unexpected_credential: 'FAKE_FUTURE_SECRET', anonymous: false,
    } as any;
    state.runtime.install.hooks_token = 'FAKE_HOOK_SECRET';
    state.runtime.install.receiver_last_error = 'failure with FAKE_API_KEY';
    await writeState(dir, 'test', state);
    const tool = buildHiAgentStatusTool({
      modernEvents: {},
      stateDir: dir, profile: 'test', platformBaseUrl: 'https://status-fixture.invalid',
      webhookPath: '/hi', claimPollIntervalMs: 30_000, claimLeaseMs: 30_000,
    });
    // Fetch cannot resolve until after execute: a regression that waits for the
    // network makes this test fail instead of silently accepting slow status.
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      tool.execute('test', {}),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('local status waited for network')), 500); }),
    ]).finally(() => clearTimeout(timer));
    for (const output of [JSON.stringify(result.structuredContent), JSON.stringify(result.content)]) {
      assert.doesNotMatch(output, /FAKE_|client_secret|api_key|hooks_token|unexpected_credential/);
      assert.match(output, /agent-test/);
    }
    assert.equal((result.structuredContent as any).plugin_policy.check_status, 'refreshing');
    finish(new Response(JSON.stringify({ _meta: { hirey_plugin: { update_required: true, update_command: 'upgrade test' } } })));
    await new Promise(resolve => setImmediate(resolve));
    const cached = await tool.execute('test-2', {});
    assert.equal((cached.structuredContent as any).plugin_policy.update_required, true);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('nested install and remote control responses cannot expose long-lived secrets', () => {
  const safe = redactControlCredentials({
    hooks_configure: { hooks_token: 'FAKE_HOOK', gateway_port: 18789 },
    remote: { installations: [{ client_secret: 'FAKE_SECRET', api_key: 'FAKE_KEY', access_token: 'FAKE_ACCESS', id: 'i' }] },
    claim_token: 'one-time-transfer',
  });
  assert.doesNotMatch(JSON.stringify(safe), /FAKE_/);
  assert.equal(safe.hooks_configure.gateway_port, 18789);
  assert.equal(safe.claim_token, 'one-time-transfer');
});

test('release cache shares concurrent requests and keeps different servers separate', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(JSON.stringify({ _meta: { hirey_plugin: { update_required: true } } }));
  }) as typeof fetch;
  try {
    await Promise.all([
      getStatusPluginReleasePolicy('https://cache-a.invalid', true),
      getStatusPluginReleasePolicy('https://cache-a.invalid/', true),
    ]);
    assert.equal(requests, 1);
    await getStatusPluginReleasePolicy('https://cache-b.invalid', true);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('failed release check stays unknown and is cached to avoid retrying on every status', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error('offline'); }) as typeof fetch;
  try {
    const result = await getStatusPluginReleasePolicy('https://cache-offline.invalid', true);
    assert.equal(result.check_status, 'unavailable');
    assert.equal(result.update_required, null);
    assert.equal(result.update_recommended, null);
    await getStatusPluginReleasePolicy('https://cache-offline.invalid');
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('transient refresh failure preserves a known mandatory upgrade as stale', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    if (++requests > 1) throw new Error('temporary outage');
    return new Response(JSON.stringify({ _meta: { hirey_plugin: {
      update_required: true, latest: '2.0.0', update_command: 'upgrade test',
    } } }));
  }) as typeof fetch;
  try {
    const first = await getStatusPluginReleasePolicy('https://cache-stale.invalid', true);
    assert.equal(first.check_status, 'checked');
    const failed = await getStatusPluginReleasePolicy('https://cache-stale.invalid', true);
    assert.equal(failed.check_status, 'stale');
    assert.equal(failed.update_required, true);
    assert.equal(failed.latest, '2.0.0');
    assert.equal(failed.update_command, 'upgrade test');
    assert.equal((await getStatusPluginReleasePolicy('https://cache-stale.invalid')).update_required, true);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = originalFetch; }
});
