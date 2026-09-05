import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveOpenClawStateRoot } from '../state.js';
import { resolveOpenClawConfigPath } from '../utils/openclaw-config.js';
import { isOpenClawPluginInstallCommand } from '../index.js';

const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf8')) as {
  contracts?: { tools?: string[] };
};
const control = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');

test('OpenClaw manifest exposes only current platform capabilities plus local control tools', () => {
  const expected = new Set([
    'hi_agent_status', 'hi_agent_install', 'hi_agent_doctor', 'hi_agent_reset',
    'hi_agent_recover', 'hi_agent_state_resync', 'hi_agent_claim_export',
    'hi_agent_claim_redeem', 'hi_pull_events',
    'email_binding', 'google_link', 'phone_binding', 'workspace_workflows',
  ]);
  assert.deepEqual(new Set(manifest.contracts?.tools), expected);
});

test('OpenClaw runtime does not call retired business capability routes', () => {
  assert.doesNotMatch(
    control,
    /callCapability\(['"]hi\.(?:owners|agent-listings|matching-sessions|pairings|thread-meetings)/,
  );
});

test('OpenClaw package includes canonical use, events, repair, and registration skills', () => {
  for (const name of ['hi-register', 'hi-use', 'hi-events', 'hi-repair']) {
    assert.equal(existsSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url)), true, name);
  }
});

test('OpenClaw profile isolation controls plugin config and identity state paths', () => {
  const stateRoot = path.resolve('/tmp/hirey-openclaw-profile');
  assert.equal(
    resolveOpenClawStateRoot({ OPENCLAW_STATE_DIR: stateRoot }),
    stateRoot,
  );
  assert.equal(
    resolveOpenClawConfigPath({ OPENCLAW_STATE_DIR: stateRoot }),
    path.join(stateRoot, 'openclaw.json'),
  );
  assert.equal(
    resolveOpenClawConfigPath({
      OPENCLAW_STATE_DIR: stateRoot,
      OPENCLAW_CONFIG_PATH: '/tmp/custom-openclaw.json',
    }),
    path.resolve('/tmp/custom-openclaw.json'),
  );
});

test('OpenClaw defers config self-heal while the host install transaction is active', () => {
  assert.equal(isOpenClawPluginInstallCommand(['node', 'openclaw', 'plugins', 'install', '-l', '.']), true);
  assert.equal(isOpenClawPluginInstallCommand(['node', 'openclaw', 'plugins', 'doctor']), false);
  assert.equal(isOpenClawPluginInstallCommand(['node', 'openclaw', 'gateway', 'start']), false);
});
