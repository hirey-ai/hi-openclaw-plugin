import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clients = readFileSync(new URL('../clients.ts', import.meta.url), 'utf8');
const control = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');
const onboarding = readFileSync(new URL('../../skills/hi-register/SKILL.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

test('OpenClaw does not call the retired Agent activation route', () => {
  assert.doesNotMatch(clients, /gateway\.activate\s*\(/);
  assert.doesNotMatch(control, /gateway\.activate\s*\(/);
});

test('pending Agent readiness is not an install or doctor blocker', () => {
  assert.doesNotMatch(control, /blockers\.push\(['"]not_activated/);
  assert.match(control, /ready_for_public_reads/);
  assert.match(control, /pending_installation_public_reads_only/);
  assert.match(onboarding, /expected pending anonymous state, not an install failure/);
  assert.match(onboarding, /setup normally reports `push_ready:false`/);
  assert.match(onboarding, /Do not invent old `default_reply_channel` or `route_missing_policy` fields/);
});

test('install guidance uses only the version-specific scoped distributions', () => {
  assert.match(readme, /2026\.5\.4\+/);
  assert.match(readme, /npm:@hirey-ai\/hirey/);
  assert.match(readme, /The unscoped npm\s+name `hirey` is not a valid distribution path/);
  assert.doesNotMatch(readme, /published under unscoped `hirey`/);
});

test('server-provided update commands are exact allowlisted before execution', () => {
  assert.match(onboarding, /host is exactly `openclaw`/);
  assert.match(onboarding, /plugin name is exactly `hirey`/);
  assert.match(onboarding, /command is exactly `openclaw plugins update hirey`/);
});
