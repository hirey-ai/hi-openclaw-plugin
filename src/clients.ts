// 包装 @hirey/hi-agent-sdk 的客户端构造，加 stale-identity quarantine。
// hi platform 用 OAuth client_credentials grant：identity 里的 client_id/secret 拿 access_token，
// 然后用 access_token 调 gateway/platform。
//
// 2026-05：quarantine 从 "load state 时 pre-emptive 比 URL string" 改成 "OAuth 真 401 之后
// reactive 触发"。原因：URL string 比较太脆，platform 合法用过多个 issuer subdomain，老逻辑
// 每次重启都炸 identity、孤儿 agent 满天飞。新逻辑：保留 identity 进 OAuth，能用就用、真用
// 不了再 quarantine——只换掉确认坏掉的，不再 false-positive 杀健康 identity。

import {
  createHiAgentClients,
  exchangeHiAgentClientCredentialsToken,
  HiAgentGatewayClient,
  HiAgentPlatformClient,
  type HiAgentPlatformWellKnown,
} from '@hirey/hi-agent-sdk';
import {
  readState,
  updateState,
  type HiIdentityState,
  type HiPersistedState,
  type StaleIdentityQuarantine,
} from './state.js';
import { PLUGIN_VERSION } from './version.js';
import { bootstrapPendingAgent } from './bootstrap.js';
import {createHash} from 'node:crypto';

export type HiAuthorizedClients = {
  state: HiPersistedState;
  accessToken: string;
  gateway: HiAgentGatewayClient;
  platform: HiAgentPlatformClient;
  wellKnown: HiAgentPlatformWellKnown;
  quarantined: StaleIdentityQuarantine | null;
  expiresAt?: number;
};

export type HiPluginReleasePolicy = {
  host?: string;
  name?: string;
  latest?: string;
  minimum_supported?: string;
  update_required?: boolean | null;
  update_recommended?: boolean | null;
  update_command?: string;
  restart_required?: boolean;
};

const PLUGIN_POLICY_TIMEOUT_MS = 5_000;

const policyCache = new Map<string, { policy: HiPluginReleasePolicy | null; checkedAt: number; failed?: boolean; pending?: Promise<void> }>();
const POLICY_CACHE_TTL_MS = 60_000;

// Local status must remain local-speed. Refresh in the background, sharing one
// bounded request per origin; explicit remote checks wait for that same request.
export async function getStatusPluginReleasePolicy(platformBaseUrl: string, waitForRemote = false): Promise<Record<string, unknown>> {
  const key = platformBaseUrl.replace(/\/+$/, '');
  let entry = policyCache.get(key);
  if (!entry) {
    if (policyCache.size >= 64) policyCache.delete(policyCache.keys().next().value!);
    entry = { policy: null, checkedAt: 0 };
    policyCache.set(key, entry);
  }
  if (!entry.pending && (waitForRemote || Date.now() - entry.checkedAt >= POLICY_CACHE_TTL_MS)) {
    const current = entry;
    current.pending = fetchPluginReleasePolicy(key).then(policy => {
      current.policy = policy;
      current.checkedAt = Date.now();
      current.failed = false;
    }).catch(() => {
      // A temporary outage must not erase a known mandatory upgrade. Preserve
      // the last policy and explicitly mark it stale until a successful refresh.
      current.failed = true;
      current.checkedAt = Date.now();
    }).finally(() => { current.pending = undefined; });
  }
  if (waitForRemote) await entry.pending;
  return {
    host: 'openclaw', latest: null, minimum_supported: null,
    update_required: null, update_recommended: null,
    ...entry.policy,
    checked_at: entry.checkedAt ? new Date(entry.checkedAt).toISOString() : null,
    check_status: entry.pending ? 'refreshing' : entry.failed && entry.policy ? 'stale' : entry.policy ? 'checked' : 'unavailable',
  };
}

export async function fetchPluginReleasePolicy(
  platformBaseUrl: string,
  timeoutMs: number = PLUGIN_POLICY_TIMEOUT_MS,
): Promise<HiPluginReleasePolicy | null> {
  const url = `${platformBaseUrl.replace(/\/+$/, '')}/v1/capabilities`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-hirey-plugin-host': 'openclaw',
      'x-hirey-plugin-version': PLUGIN_VERSION,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`hi_plugin_policy_http_${response.status}`);
  const body = await response.json() as any;
  const policy = body?._meta?.hirey_plugin;
  return policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : null;
}

// 模块级 quarantine 通知：reactive 触发之后挂一个 in-memory flag，让后续 tool response
// 都能 surface 一次（直到 plugin restart 自然清掉）。
let _lastQuarantineNotice: StaleIdentityQuarantine | null = null;

export function peekQuarantineNotice(): StaleIdentityQuarantine | null {
  return _lastQuarantineNotice;
}

// 老入口：保留 backward compat，**现在等价于直接 readState**（pre-emptive quarantine 已经停掉，
// 见 state.ts:quarantineStaleIdentity 注释）。新代码请直接调 readState。
export async function loadStateWithQuarantine(
  stateDir: string,
  profile: string,
  _currentPlatformBaseUrl: string,
): Promise<HiPersistedState> {
  return readState(stateDir, profile);
}

// 判断 OAuth token exchange 抛出的 err 是不是"identity 已经被 platform 拒掉"（401 /
// invalid_client / invalid_grant）。@hirey/hi-agent-sdk 的 exchange 抛出的是普通 Error，
// message 里通常带 status code + OAuth2 error code，我们 best-effort 匹配。
function isOAuthIdentityRejection(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as any)?.message || err).toLowerCase();
  // HARD identity rejection: the OAuth server explicitly disowned this client.
  // These are the only signals that should quarantine a stored identity.
  if (msg.includes('invalid_client') || msg.includes('invalid_grant')) return true;
  // SOFT 401/403/unauthorized (or a transport hiccup) is often TRANSIENT — an
  // hi-auth blip, a clock-skew JWT reject, a brief network 401. Quarantining on
  // these false-positives renames a HEALTHY identity and forces a needless
  // re-register ("my agent changed for no reason"). Default: do NOT quarantine
  // on a soft 401 — surface the error and let the next turn retry. Opt back into
  // the old aggressive behavior with HI_OPENCLAW_QUARANTINE_ON_SOFT_401=1.
  if (!/^(1|true|yes|on)$/i.test(process.env.HI_OPENCLAW_QUARANTINE_ON_SOFT_401 || '')) return false;
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  return status === 401 || status === 403 || msg.includes('401') || msg.includes('unauthorized');
}

// single-flight：装好插件后的第一波 read/搜索可能多个 tool 并发触发 ensureCredential，
// 用一把 in-process 锁（键到 stateDir|profile）保证只 register 一次、不并发铸两个 agent。
const _ensureInflight = new Map<string, Promise<HiPersistedState>>();

// 凭证装配（2026-06 anonymous→register-once 改造核心）。
//
// 本地已有 identity → 原样复用，**绝不重注册**。这是"同一个 agent、零 churn"的根：openclaw
// 旧逻辑在 state 缺失 / OAuth 抖动 quarantine 时反复 register 新 agent，每次都多一个孤儿
// （prod 观察到 91% 的 agent 是孤儿）。现在堵上所有"自动重注册"的口子：本函数有凭证就复用、
// buildAuthorizedClients 不再 auto-quarantine 重注册、hi_agent_install 去掉 replace_existing_state、
// reset 加重警告。
//
// 没有 identity → 注册一个稳定 agent（register-once）。openclaw 是 native plugin、直连
// 平台/gateway（不像 codex 走 mcp.hirey.ai/mcp edge 懒加载 agent），read/search 必须有一个
// 已注册 agent（browse_recent/search 要 runtime agent_id），所以这里注册一次。pending Agent
// 已可用于公开读/搜索；不再调用已下线的 activate 路径。注册出来的 agent **未绑定身份**
//（没有 owner_customer_id/手机）：读/搜索
// 放行，写操作被平台 phone_binding_required gate 挡住，直到用户绑 Google/手机/邮箱——绑定
// 通过 dual-anchor 收敛到用户工作区，**同一个 agent 复用**。displayName/metadata 透传给 register
// （metadata 典型用于邀请落地页的 channel_code 渠道归因）。
export async function ensureCredential(args: {
  stateDir: string;
  profile: string;
  platformBaseUrl: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}): Promise<HiPersistedState> {
  const existing = await readState(args.stateDir, args.profile);
  if (existing.identity) return existing;
  const lockKey = `${args.stateDir}|${args.profile}`;
  const inflight = _ensureInflight.get(lockKey);
  if (inflight) return inflight;
  const p = (async () => {
    // 拿到 slot 后再读一次：可能上一个并发请求刚注册完。
    const recheck = await readState(args.stateDir, args.profile);
    if (recheck.identity) return recheck;
    const callerMetadata =
      args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata) ? args.metadata : {};
    const reg = await bootstrapPendingAgent({
      ...args,
      metadata: callerMetadata,
    });
    const identity: HiIdentityState = {
      agent_id: reg.agentId,
      installation_id: '',
      display_name: args.displayName?.trim() || 'OpenClaw Hi Agent',
      agent_kind: 'external',
      client_id: reg.clientId,
      client_secret: reg.clientSecret,
      installation_subject: reg.clientId,
      issuer: new URL(reg.tokenUrl).origin,
      audience: '',
      token_url: reg.tokenUrl,
      jwks_url: reg.jwksUrl,
      activated_at: null,
      delivery_capabilities: null,
      plugin_version_synced: null,
      anonymous: true,
      api_key: reg.apiKey,
    };
    const next = await updateState(args.stateDir, args.profile, (cur) => ({
      ...cur,
      platform: {
        platform_base_url: args.platformBaseUrl,
        registry_base_url: args.platformBaseUrl,
        fetched_at: new Date().toISOString(),
      },
      identity,
    }));
    console.log(JSON.stringify({ event: 'hi_openclaw_agent_registered', profile: args.profile, agent_id: identity.agent_id }));
    return next;
  })().finally(() => { _ensureInflight.delete(lockKey); });
  _ensureInflight.set(lockKey, p);
  return p;
}

const authorizedCache = new Map<string, {value?: HiAuthorizedClients; pending?: Promise<HiAuthorizedClients>}>();
export function invalidateAuthorizedClients(stateDir: string, profile: string) {
  const prefix = `${stateDir}|${profile}|`;
  for (const key of authorizedCache.keys()) if (key.startsWith(prefix)) authorizedCache.delete(key);
}

export async function buildAuthorizedClients(args: {stateDir: string; profile: string; platformBaseUrl: string}): Promise<HiAuthorizedClients> {
  const state = await ensureCredential(args);
  const fingerprint = createHash('sha256').update(`${state.identity?.client_id}|${state.identity?.client_secret}`).digest('hex');
  const key = `${args.stateDir}|${args.profile}|${args.platformBaseUrl}|${fingerprint}`;
  let entry = authorizedCache.get(key);
  if (entry?.pending) return entry.pending;
  if (entry?.value && (entry.value.expiresAt || 0) > Date.now()) return entry.value;
  if (!entry) {
    if (authorizedCache.size >= 64) authorizedCache.delete(authorizedCache.keys().next().value!);
    entry = {}; authorizedCache.set(key, entry);
  }
  const current = entry;
  current.pending = buildAuthorizedClientsUncached(args, state).then(value => {current.value = value; return value;})
    .finally(() => {current.pending = undefined;});
  return current.pending;
}

async function buildAuthorizedClientsUncached(args: {
  stateDir: string;
  profile: string;
  platformBaseUrl: string;
}, state: HiPersistedState): Promise<HiAuthorizedClients> {
  // 没有 identity 时不再 throw hi_identity_missing，而是 register-once 一个稳定 agent —— 这样
  // "装好插件直接搜索"就能用；register-once + 复用 = 零 churn。
  if (!state.identity) {
    throw new Error('hi_identity_unavailable: agent registration failed; retry hi_agent_status');
  }
  const contextualFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('x-hirey-plugin-host', 'openclaw');
    headers.set('x-hirey-plugin-version', PLUGIN_VERSION);
    const response = await fetch(input, {...init, headers, signal: init?.signal || AbortSignal.timeout(15_000)});
    if (response.status === 401) invalidateAuthorizedClients(args.stateDir, args.profile);
    return response;
  };
  // Discovery is public and independent of OAuth. Do not send a bearer to the
  // discovery host, and do not serialize two network round trips on cold start.
  const discovery = createHiAgentClients({platformBaseUrl: args.platformBaseUrl, token: '', fetchImpl: contextualFetch});
  let token;
  let discovered;
  let tokenReceivedAt = 0;
  try {
    const deadline = AbortSignal.timeout(15_000);
    [token, discovered] = await Promise.all([exchangeHiAgentClientCredentialsToken({
      tokenUrl: state.identity.token_url,
      clientId: state.identity.client_id,
      clientSecret: state.identity.client_secret,
      fetchImpl: (input, init) => contextualFetch(input, {...init, signal: deadline}),
    }).then(value => {tokenReceivedAt = Date.now(); return value;}), discovery]);
  } catch (err) {
    // 关键反 churn 改动：OAuth 失败**不再 auto-quarantine + 重注册**（那正是 openclaw 满天飞
    // 孤儿 agent 的根因——一次抖动/吊销就换一个新 agent）。保留本地凭证、抛清晰错误：让用户
    // 重试，或重新绑定 Google/手机/邮箱（dual-anchor 会把这台设备收敛回同一工作区/agent），
    // 绝不悄悄换 agent。真要重置只能显式 hi_agent_reset（已加重警告）。
    if (isOAuthIdentityRejection(err)) {
      throw new Error(
        'hi_identity_oauth_rejected: stored credentials were refused by OAuth. Do NOT reset — retry shortly, '
        + 'or re-bind Google/phone/email to reconverge this workspace (the stable agent is kept, no new agent is minted).',
      );
    }
    throw err;
  }
  const wellKnown = discovered.wellKnown;
  const clientOptions = {token: token.access_token, fetchImpl: contextualFetch};
  const platform = new HiAgentPlatformClient({...clientOptions,
    baseUrl: String(wellKnown?.platform?.platform_base_url || '').trim() || args.platformBaseUrl});
  const gateway = new HiAgentGatewayClient({...clientOptions,
    baseUrl: String(wellKnown?.platform?.registry_base_url || '').trim() || args.platformBaseUrl});
  return {
    state,
    accessToken: token.access_token,
    gateway,
    platform,
    wellKnown,
    quarantined: peekQuarantineNotice(),
    expiresAt: tokenReceivedAt + Math.min(token.access_token.startsWith('hi_ai_') ? 10_000 : 60_000,
      Math.max(0, Number(token.expires_in || 0) * 1000 - 30_000)),
  };
}

// 不需要 OAuth 的端点（register / well-known / public capabilities listing），直接构造 client。
export async function buildPublicClients(platformBaseUrl: string): Promise<{
  gateway: HiAgentGatewayClient;
  platform: HiAgentPlatformClient;
  wellKnown: HiAgentPlatformWellKnown;
}> {
  const clients = await createHiAgentClients({ platformBaseUrl, token: '' });
  return clients;
}
