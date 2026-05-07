// 持久化 hi identity + receiver runtime cursor 到 ~/.openclaw/hi-mcp/<profile>/<profile>.json。
// 跟 hi-mcp-server 的 state schema 完全兼容 —— OpenClaw 同台机器装过 hi-mcp-server bundle
// 之后切到 native plugin 时，能直接复用已有 identity，不需要重新 register。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type HiIdentityState = {
  agent_id: string;
  installation_id: string;
  display_name: string;
  agent_kind: string;
  client_id: string;
  client_secret: string;
  installation_subject: string;
  issuer: string;
  audience: string;
  token_url: string;
  jwks_url: string;
  activated_at: string | null;
  delivery_capabilities: Record<string, unknown> | null;
};

export type HiPlatformState = {
  platform_base_url: string;
  registry_base_url: string;
  fetched_at: string;
};

export type HiInstallRuntimeState = {
  host_kind: string | null;
  webhook_path: string | null;
  receiver_last_started_at: string | null;
  receiver_last_error: string | null;
};

export type HiRuntimeState = {
  last_consumed_stream_seq: number;
  last_claim_lease_id: string | null;
  install: HiInstallRuntimeState;
  updated_at: string | null;
};

export type HiPersistedState = {
  profile: string;
  platform: HiPlatformState | null;
  identity: HiIdentityState | null;
  runtime: HiRuntimeState;
};

export const DEFAULT_PROFILE = 'openclaw-main';

export function resolveStateDir(profile: string): string {
  return path.join(os.homedir(), '.openclaw', 'hi-mcp', profile);
}

export function resolveStateFile(stateDir: string, profile: string): string {
  return path.join(stateDir, `${profile}.json`);
}

export function buildEmptyState(profile: string): HiPersistedState {
  return {
    profile,
    platform: null,
    identity: null,
    runtime: {
      last_consumed_stream_seq: 0,
      last_claim_lease_id: null,
      install: {
        host_kind: null,
        webhook_path: null,
        receiver_last_started_at: null,
        receiver_last_error: null,
      },
      updated_at: null,
    },
  };
}

export async function readState(stateDir: string, profile: string): Promise<HiPersistedState> {
  const file = resolveStateFile(stateDir, profile);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<HiPersistedState>;
    return {
      profile: typeof parsed.profile === 'string' && parsed.profile.trim() ? parsed.profile : profile,
      platform: parsed.platform ?? null,
      identity: parsed.identity ?? null,
      runtime: {
        last_consumed_stream_seq: Number(parsed.runtime?.last_consumed_stream_seq || 0),
        last_claim_lease_id: parsed.runtime?.last_claim_lease_id ?? null,
        install: {
          host_kind: parsed.runtime?.install?.host_kind ?? null,
          webhook_path: (parsed.runtime?.install as any)?.webhook_path ?? null,
          receiver_last_started_at: parsed.runtime?.install?.receiver_last_started_at ?? null,
          receiver_last_error: parsed.runtime?.install?.receiver_last_error ?? null,
        },
        updated_at: parsed.runtime?.updated_at ?? null,
      },
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return buildEmptyState(profile);
    throw err;
  }
}

export async function writeState(stateDir: string, profile: string, state: HiPersistedState): Promise<void> {
  const file = resolveStateFile(stateDir, profile);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function updateState(
  stateDir: string,
  profile: string,
  updater: (current: HiPersistedState) => HiPersistedState,
): Promise<HiPersistedState> {
  const current = await readState(stateDir, profile);
  const next = updater(current);
  await writeState(stateDir, profile, next);
  return next;
}

// 比较两 URL 的 origin（scheme + host + port），用来判断 identity 是不是当前 platform 颁的。
export function urlsHaveSameOrigin(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

export type StaleIdentityQuarantine = {
  backup_path: string;
  reason: 'platform_base_url_mismatch';
  previous_issuer: string;
  previous_agent_id: string;
  previous_installation_id: string;
};

// 同台机器先后装过两套 channel（早期 hi.hireyapp.us / 现在 hi.hirey.ai）会让 state 里
// 的 identity 是另一个 platform 颁的，OAuth 必 401。这里检测 issuer mismatch 时把旧 state
// 文件 rename 成 .stale-<host>-<ts>.bak，返回干净 state，下一轮 install 自动 fresh register。
export async function quarantineStaleIdentityIfNeeded(
  stateDir: string,
  profile: string,
  state: HiPersistedState,
  currentPlatformBaseUrl: string,
): Promise<{ state: HiPersistedState; quarantined: StaleIdentityQuarantine | null }> {
  if (!state.identity) return { state, quarantined: null };
  const persistedIssuer = (state.identity.issuer || '').trim();
  const currentBase = (currentPlatformBaseUrl || '').trim();
  if (!persistedIssuer || !currentBase) return { state, quarantined: null };
  if (urlsHaveSameOrigin(persistedIssuer, currentBase)) return { state, quarantined: null };

  const stateFile = resolveStateFile(stateDir, profile);
  let envTag = '';
  try { envTag = new URL(persistedIssuer).host.replace(/[^a-zA-Z0-9._-]/g, '_'); } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${stateFile}.stale-${envTag || 'unknown'}-${ts}.bak`;
  try {
    await fs.rename(stateFile, backupPath);
  } catch (err: any) {
    // ENOENT 容忍：state 文件已经被外部清掉了，但 in-memory state 仍 stale
    if (err?.code !== 'ENOENT') {
      // 不阻塞主流程，继续返回 fresh state
    }
  }
  const quarantined: StaleIdentityQuarantine = {
    backup_path: backupPath,
    reason: 'platform_base_url_mismatch',
    previous_issuer: persistedIssuer,
    previous_agent_id: state.identity.agent_id,
    previous_installation_id: state.identity.installation_id,
  };
  return { state: buildEmptyState(state.profile), quarantined };
}
