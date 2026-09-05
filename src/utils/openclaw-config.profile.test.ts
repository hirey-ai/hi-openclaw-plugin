import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensurePluginToolsAlsoAllowed } from './openclaw-config.js';

test('profile config mutation stays isolated and preserves secret-safe permissions', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hirey-openclaw-profile-'));
  const configPath = path.join(stateRoot, 'custom-openclaw.json');
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = stateRoot;
  process.env.OPENCLAW_CONFIG_PATH = configPath;

  try {
    fs.writeFileSync(configPath, JSON.stringify({ tools: { profile: 'coding' } }), { mode: 0o644 });
    const result = await ensurePluginToolsAlsoAllowed();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    assert.equal(result.changed, true);
    assert.deepEqual(config.tools.alsoAllow, ['group:plugins']);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(os.homedir(), '.openclaw', 'custom-openclaw.json')), false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
