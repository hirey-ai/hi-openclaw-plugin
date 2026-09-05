import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchPluginReleasePolicy } from '../clients.js';

test('OpenClaw reports its host and installed version when reading release policy', async () => {
  const originalFetch = globalThis.fetch;
  let observedHeaders: Headers | null = null;
  let observedSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    observedHeaders = new Headers(init?.headers);
    observedSignal = init?.signal as AbortSignal | null;
    return new Response(JSON.stringify({
      _meta: {
        hirey_plugin: {
          host: 'openclaw',
          latest: '1.0.75',
          minimum_supported: '1.0.75',
          update_required: false,
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const policy = await fetchPluginReleasePolicy('https://hi.hirey.ai/');
    assert.equal(observedHeaders?.get('x-hirey-plugin-host'), 'openclaw');
    assert.equal(observedHeaders?.get('x-hirey-plugin-version'), '1.0.75');
    assert.ok(observedSignal instanceof AbortSignal);
    assert.equal(policy?.host, 'openclaw');
    assert.equal(policy?.update_required, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenClaw release policy lookup has a bounded timeout', async () => {
  const originalFetch = globalThis.fetch;
  // AbortSignal.timeout() intentionally uses an unref'ed timer. Keep the test
  // process alive long enough to observe the abort on Node versions that exit
  // once no referenced handles remain.
  const keepAlive = setTimeout(() => {}, 100);
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;
  try {
    await assert.rejects(fetchPluginReleasePolicy('https://hi.hirey.ai/', 5), (error: any) => {
      return error?.name === 'TimeoutError';
    });
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
  }
});
