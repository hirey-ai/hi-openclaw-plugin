// 持久化 hi identity + receiver runtime cursor 到 ~/.openclaw/hi-mcp/<profile>/<profile>.json。
// 跟 hi-mcp-server 的 state schema 完全兼容 —— OpenClaw 同台机器装过 hi-mcp-server bundle
// 之后切到 native plugin 时，能直接复用已有 identity，不需要重新 register。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type HiIdentityState = {
  // 2026-06 anonymous-first 改造：匿名阶段 agent_id / installation_id 为 ''（空串 = 还没
  // 绑定身份、平台还没 materialize agent）。一旦用户绑定 Google/手机/邮箱，平台懒加载出
  // 唯一 agent，下一次 buildAuthorizedClients()/me 会把真实 agent_id 回填、anonymous 置 false。
  // 全程 client_id/client_secret（即 api_key 解出来的那对）不变 —— 这是"同一身份、零 churn"
  // 的根。空串而非 null 是为了不破坏既有大量 `state.identity.agent_id` 的 string 类型读取点。
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
  // true = 这套凭证是匿名 hi_ak_ key（POST /v1/agents/api-keys {anonymous:true} 铸的），
  // 还没绑定任何人类身份、平台侧还没 materialize agent（agent_id===''）。读/搜索可用，写
  // 会被平台 phone_binding_required gate 挡住直到绑定。绑定后回填 agent_id 并置 false。
  // 老 state 文件（eager-register 时代）没这个字段 → 视作已绑定（false），不打扰存量用户。
  anonymous: boolean;
  // 原始 hi_ak_ 串（base64url(JSON{v,id,secret})）。client_id/client_secret 已经从它解出来
  // 单独存了，api_key 留底用于诊断 / 跨设备复制粘贴。可能为 null（老 state 或 register 路径）。
  api_key: string | null;
  // 上一次成功把本机 plugin metadata + delivery_capabilities 同步到平台时使用的 plugin 版本。
  // 启动 reconcile 用这个跟当前 PLUGIN_VERSION 比对：不同就推一次 updateInstallation 把新版本
  // metadata + 新 capability 声明送上去，避免出现"本地升级了但平台 installation 记录还按老
  // 版本路由"的孤儿状态。null = 老 state 文件、reconcile 视作首次升级。
  plugin_version_synced: string | null;
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
  // Native plugin daemon 把 hi event 投递回本机 OpenClaw gateway 走 /hooks/agent；
  // hooks_token 跟 hooks_path 是 install tool 写入 ~/.openclaw/openclaw.json 的同一份值。
  // gateway_port 默认 18789，但 plugin 启动时会从 OpenClaw 实际配置/runtime context 校正。
  hooks_token: string | null;
  hooks_path: string | null;
  gateway_port: number | null;
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
        hooks_token: null,
        hooks_path: null,
        gateway_port: null,
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
      identity: parsed.identity
        ? {
            ...parsed.identity,
            // 老 state 文件没有这个字段；视作 unknown，让 reconcile 跑一次把它写上。
            plugin_version_synced:
              (parsed.identity as Partial<HiIdentityState>).plugin_version_synced ?? null,
            // anonymous-first 改造前的 state 文件没有 anonymous/api_key：
            // - anonymous 缺省 false：存量用户都是 eager-register 出来的已绑定 agent，
            //   绝不能被误判成"匿名、可重铸"，否则升级即 churn。
            // - api_key 缺省 null：老凭证不是 hi_ak_ 铸的，没有原始串可留底。
            anonymous: (parsed.identity as Partial<HiIdentityState>).anonymous ?? false,
            api_key: (parsed.identity as Partial<HiIdentityState>).api_key ?? null,
          }
        : null,
      runtime: {
        last_consumed_stream_seq: Number(parsed.runtime?.last_consumed_stream_seq || 0),
        last_claim_lease_id: parsed.runtime?.last_claim_lease_id ?? null,
        install: {
          host_kind: parsed.runtime?.install?.host_kind ?? null,
          webhook_path: (parsed.runtime?.install as any)?.webhook_path ?? null,
          receiver_last_started_at: parsed.runtime?.install?.receiver_last_started_at ?? null,
          receiver_last_error: parsed.runtime?.install?.receiver_last_error ?? null,
          hooks_token: (parsed.runtime?.install as any)?.hooks_token ?? null,
          hooks_path: (parsed.runtime?.install as any)?.hooks_path ?? null,
          gateway_port: (parsed.runtime?.install as any)?.gateway_port ?? null,
        },
        updated_at: parsed.runtime?.updated_at ?? null,
      },
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return buildEmptyState(profile);
    throw err;
  }
}

// Crash-safe atomic write: a SIGKILL / power loss mid-write must never leave a
// truncated credential file (the "hi creds mysteriously vanished → forced
// re-login" bug). Write to a unique temp, fsync, then atomically rename over the
// target. mode 0o600 because the state carries client_secret.
async function atomicWriteFile(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fh = await fs.open(tmp, 'w', 0o600);
    await fh.writeFile(data, 'utf8');
    await fh.sync();
    await fh.close();
    fh = undefined;
    await fs.rename(tmp, file);
  } catch (error) {
    if (fh) {
      try { await fh.close(); } catch {}
    }
    try { await fs.unlink(tmp); } catch {}
    throw error;
  }
}

export async function writeState(stateDir: string, profile: string, state: HiPersistedState): Promise<void> {
  const file = resolveStateFile(stateDir, profile);
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
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
// 2026-05：保留这个 helper 给老调用方 / test，但**不再用它做 pre-emptive quarantine 决策**——
// issuer 和 platform_base_url 经常合法地分到不同 subdomain（e.g., issuer=`auth.hirey.ai`、
// base=`hi.hirey.ai`），URL string 比较太脆。quarantine 现在只在 OAuth 真 401 之后触发。
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
  reason: 'platform_base_url_mismatch' | 'oauth_unauthorized';
  previous_issuer: string;
  previous_agent_id: string;
  previous_installation_id: string;
};

// 同台机器先后装过两套 channel（早期 hi.hireyapp.us / 现在 hi.hirey.ai）会让 state 里
// 的 identity 是另一个 platform 颁的，OAuth 必 401。这里把旧 state 文件 rename 成
// .stale-<host>-<ts>.bak，返回干净 state，下一轮 install 自动 fresh register。
//
// **2026-05 改成 reactive**：以前 readState 之后就 pre-emptive 比 issuer ↔ base URL string，
// 不同 origin 就 quarantine——但平台合法变更过 issuer subdomain（auth.hirey.ai 等），导致
// 全网用户每次重启都炸 identity、孤儿 agent 满天飞。新策略是：保留 identity 状态进 OAuth，
// 真拿到 401 / invalid_client 再 quarantine——能用就不动。这个函数现在不主动比 URL，只在
// OAuth 失败之后被显式调用做迁移落地。
export async function quarantineStaleIdentity(
  stateDir: string,
  profile: string,
  state: HiPersistedState,
  reason: StaleIdentityQuarantine['reason'],
): Promise<{ state: HiPersistedState; quarantined: StaleIdentityQuarantine | null }> {
  if (!state.identity) return { state, quarantined: null };
  const persistedIssuer = (state.identity.issuer || '').trim();
  const stateFile = resolveStateFile(stateDir, profile);
  let envTag = '';
  try { envTag = new URL(persistedIssuer || 'about:blank').host.replace(/[^a-zA-Z0-9._-]/g, '_'); } catch {}
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
    reason,
    previous_issuer: persistedIssuer,
    previous_agent_id: state.identity.agent_id,
    previous_installation_id: state.identity.installation_id,
  };
  console.warn(JSON.stringify({
    event: 'hi_identity_quarantined',
    reason,
    previous_agent_id: state.identity.agent_id,
    previous_issuer: persistedIssuer,
    backup_path: backupPath,
  }));
  return { state: buildEmptyState(state.profile), quarantined };
}

// 老入口：保留只为 backward compatibility，**新代码不要调**。原 pre-emptive URL 比较已经
// 不可靠（参见 quarantineStaleIdentity 注释），新代码全部走 OAuth 401 → quarantineStaleIdentity。
// 这里直接 no-op，把 identity 原样返回。
export async function quarantineStaleIdentityIfNeeded(
  _stateDir: string,
  _profile: string,
  state: HiPersistedState,
  _currentPlatformBaseUrl: string,
): Promise<{ state: HiPersistedState; quarantined: StaleIdentityQuarantine | null }> {
  return { state, quarantined: null };
}
