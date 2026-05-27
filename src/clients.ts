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
  type HiAgentGatewayClient,
  type HiAgentPlatformClient,
  type HiAgentPlatformWellKnown,
} from '@hirey/hi-agent-sdk';
import {
  quarantineStaleIdentity,
  readState,
  type HiPersistedState,
  type StaleIdentityQuarantine,
} from './state.js';

export type HiAuthorizedClients = {
  state: HiPersistedState;
  accessToken: string;
  gateway: HiAgentGatewayClient;
  platform: HiAgentPlatformClient;
  wellKnown: HiAgentPlatformWellKnown;
  quarantined: StaleIdentityQuarantine | null;
};

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
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  if (status === 401 || status === 403) return true;
  const msg = String((err as any)?.message || err).toLowerCase();
  return msg.includes('401')
      || msg.includes('invalid_client')
      || msg.includes('invalid_grant')
      || msg.includes('unauthorized');
}

export async function buildAuthorizedClients(args: {
  stateDir: string;
  profile: string;
  platformBaseUrl: string;
}): Promise<HiAuthorizedClients> {
  const state = await readState(args.stateDir, args.profile);
  if (!state.identity) {
    throw new Error('hi_identity_missing: run hi_agent_install before calling authorized tools');
  }
  let token;
  try {
    token = await exchangeHiAgentClientCredentialsToken({
      tokenUrl: state.identity.token_url,
      clientId: state.identity.client_id,
      clientSecret: state.identity.client_secret,
    });
  } catch (err) {
    if (isOAuthIdentityRejection(err)) {
      // identity 真被 platform 拒了——quarantine 旧 state 文件、in-memory flag 让下一轮 tool
      // response surface。caller 看到 hi_identity_quarantined 之后要走 hi_agent_install 重新注册。
      const { quarantined } = await quarantineStaleIdentity(
        args.stateDir, args.profile, state, 'oauth_unauthorized',
      );
      if (quarantined) _lastQuarantineNotice = quarantined;
      throw new Error('hi_identity_quarantined: OAuth refused stored credentials; run hi_agent_install to re-register');
    }
    throw err;
  }
  const clients = await createHiAgentClients({
    platformBaseUrl: args.platformBaseUrl,
    token: token.access_token,
  });
  return {
    state,
    accessToken: token.access_token,
    gateway: clients.gateway,
    platform: clients.platform,
    wellKnown: clients.wellKnown,
    quarantined: peekQuarantineNotice(),
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
