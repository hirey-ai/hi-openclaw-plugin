import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing_deliverModernEventToHooks, __testing_readModernHooksConfig } from './agent-events.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('modern hooks read current isolated host config without mutating it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-hooks-config-test-'));
  const configPath = path.join(dir, 'isolated.json');
  const env = { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: path.join(dir, 'wrong') };
  try {
    assert.equal(await __testing_readModernHooksConfig(env), null);
    for (const config of [
      { hooks: { enabled: true, token: 'fixture-token', path: '/custom-hooks' }, gateway: { port: 12345 } },
      { hooks: { enabled: false, token: 'fixture-token' } },
      { hooks: { enabled: true } },
      { hooks: { enabled: true, token: 'fixture-token', path: '//other' } },
      { hooks: { enabled: true, token: 'fixture-token' }, gateway: { port: -1 } },
    ]) {
      const before = JSON.stringify(config);
      await fs.writeFile(configPath, before);
      const result = await __testing_readModernHooksConfig(env);
      if ('gateway' in config && config.gateway?.port === 12345) {
        assert.deepEqual(result, { hooks_token: 'fixture-token', hooks_path: '/custom-hooks', gateway_port: 12345 });
      } else assert.equal(result, null);
      assert.equal(await fs.readFile(configPath, 'utf8'), before);
    }
    await fs.writeFile(configPath, '{');
    assert.equal(await __testing_readModernHooksConfig(env), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('modern hook uses fixed local route, stable idempotency and strict acceptance', async () => {
  const original = globalThis.fetch;
  try {
    for (const result of [{ ok: true, runId: 'run-test' }, { ok: false, runId: 'run-test' }, { ok: true }, {}]) {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        assert.equal(body.channel, 'test-channel');
        assert.equal(body.to, 'test-local');
        assert.equal(body.sessionKey, undefined);
        assert.equal(new Headers(init!.headers).get('idempotency-key'), 'hirey-event:agev_test');
        return new Response(JSON.stringify(result));
      };
      const accepted = await __testing_deliverModernEventToHooks({
        runtime: { hooks_token: 'local-test', hooks_path: '/hooks', gateway_port: 1234 },
        route: { channel: 'test-channel', to: 'test-local' }, signal: new AbortController().signal,
        event: { event_id: 'agev_test', topic: 'test', payload: {}, reply_route_snapshot: {
          session_key: 'must-not-rotate', delivery_context: { channel: 'untrusted', to: 'wrong-user' },
        } },
      });
      assert.equal(accepted, result.ok === true && 'runId' in result);
    }
    globalThis.fetch = async () => { assert.fail('missing route must not wake a hook'); };
    assert.equal(await __testing_deliverModernEventToHooks({
      runtime: { hooks_token: 'local-test', hooks_path: '/hooks', gateway_port: 1234 },
      route: { channel: 'test-channel' }, signal: new AbortController().signal, event: {},
    }), false);
    assert.equal(await __testing_deliverModernEventToHooks({
      runtime: { hooks_token: 'local-test', hooks_path: '/hooks', gateway_port: 1234 },
      route: { channel: 'webchat', to: 'main' }, signal: new AbortController().signal, event: {},
    }), false);

    let localBody: any = null;
    globalThis.fetch = async (_url, init) => {
      localBody = JSON.parse(init!.body as string);
      return Response.json({ ok: true, runId: 'run-local' });
    };
    assert.equal(await __testing_deliverModernEventToHooks({
      runtime: { hooks_token: 'local-test', hooks_path: '/hooks', gateway_port: 1234 },
      route: { localSession: true }, signal: new AbortController().signal,
      event: { event_id: 'agev_local', topic: 'test', payload: {} },
    }), true);
    assert.equal(localBody.channel, 'last');
    assert.equal(localBody.to, undefined);
    assert.equal(localBody.deliver, false);
    assert.equal(localBody.sessionKey, undefined);
  } finally { globalThis.fetch = original; }
});
