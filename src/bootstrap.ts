import fs from 'node:fs/promises';
import path from 'node:path';
import { PLUGIN_VERSION } from './version.js';

// Registration is not idempotent server-side. An exclusive durable marker must
// precede the POST, including across processes and after uncertain failures.
export async function bootstrapPendingAgent(args: {
  stateDir: string; profile: string; platformBaseUrl: string;
  displayName?: string; metadata?: Record<string, unknown>;
}) {
  if (!/^[A-Za-z0-9_-]+$/.test(args.profile)) throw new Error('hi_bootstrap_invalid_profile');
  if (args.metadata && Object.keys(args.metadata).length) throw new Error('hi_registration_metadata_unsupported');
  const base = args.platformBaseUrl.replace(/\/+$/, '');
  const discovery = await fetch(`${base}/.well-known/hi-agent-platform.json`, {signal: AbortSignal.timeout(10_000)});
  if (!discovery.ok) throw new Error(`hi_bootstrap_discovery_http_${discovery.status}`);
  const doc = await discovery.json() as any;
  const tokenUrl = String(doc?.services?.oauth_token_url || '');
  if (!tokenUrl) throw new Error('hi_bootstrap_token_url_missing');
  const parsedTokenUrl = new URL(tokenUrl);
  if (parsedTokenUrl.protocol !== 'https:' && !(parsedTokenUrl.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(parsedTokenUrl.hostname))) throw new Error('hi_bootstrap_token_url_insecure');
  await fs.mkdir(args.stateDir, {recursive: true, mode: 0o700});
  const marker = path.join(args.stateDir, `${args.profile}.registration-pending.json`);
  let handle;
  try { handle = await fs.open(marker, 'wx', 0o600); }
  catch (error: any) {
    if (error.code === 'EEXIST') throw new Error('hi_registration_outcome_unknown: registration already attempted; recover the existing credential, do not automatically register again');
    throw error;
  }
  try { await handle.writeFile(JSON.stringify({started_at: new Date().toISOString(), platform_base_url: base})); await handle.sync(); }
  finally { await handle.close(); }
  const response = await fetch(`${base}/v1/agents/api-keys`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: {'content-type': 'application/json', 'x-hirey-plugin-host': 'openclaw', 'x-hirey-plugin-version': PLUGIN_VERSION},
    body: JSON.stringify({agent_type: 'openclaw', client_version: PLUGIN_VERSION, display_name: args.displayName || 'OpenClaw Hi Agent'}),
  });
  if (!response.ok) throw new Error(`hi_registration_failed_http_${response.status}: registration attempt retained; do not automatically retry`);
  const body = await response.json() as any;
  let key: any;
  try { key = JSON.parse(Buffer.from(String(body.api_key).replace(/^hi_ak_/, ''), 'base64url').toString('utf8')); }
  catch { throw new Error('hi_registration_invalid_response: recover existing credential; do not register again'); }
  if (!/^hi_ak_[A-Za-z0-9_-]+$/.test(String(body.api_key)) || key?.v !== 1 || typeof key.id !== 'string' || !key.id.trim() || typeof key.secret !== 'string' || !key.secret.trim() || typeof body.agent_id !== 'string' || !body.agent_id.trim() || body.status !== 'pending') {
    throw new Error('hi_registration_invalid_response: recover existing credential; do not register again');
  }
  return {agentId: body.agent_id as string, clientId: key.id as string, clientSecret: key.secret as string, apiKey: body.api_key as string, tokenUrl, jwksUrl: String(doc?.services?.jwks_url || '')};
}
