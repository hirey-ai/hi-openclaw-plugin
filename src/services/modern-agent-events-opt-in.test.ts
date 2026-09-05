import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAgentEventsService } from './agent-events.js';
import { buildEmptyState, writeState } from '../state.js';

test('modern service starts disabled without registration, network or receipt writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-opt-in-test-'));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected network'); };
  try {
    for (const registered of [false, true]) {
      const state = buildEmptyState('fixture');
      if (registered) state.identity = {
        agent_id: 'fixture-agent', api_key: 'fixture-key',
        client_id: 'fixture-client', client_secret: 'fixture-secret',
        token_url: 'https://fixture.invalid/oauth/token',
      } as any;
      await writeState(dir, 'fixture', state);
      const before = await fs.readdir(dir);
      const service = buildAgentEventsService({
        modernEvents: {}, stateDir: dir, profile: 'fixture',
        platformBaseUrl: 'https://fixture.invalid', webhookPath: '/hi',
        claimPollIntervalMs: 30_000, claimLeaseMs: 30_000,
      });
      const ctx = { logger: {} };
      await service.start(ctx);
      await new Promise(resolve => setTimeout(resolve, 20));
      await service.stop?.(ctx);
      assert.equal(requests, 0);
      assert.deepEqual(await fs.readdir(dir), before);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
