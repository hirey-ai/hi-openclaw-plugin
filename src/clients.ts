// 包装 @hirey/hi-agent-sdk 的客户端构造，加 stale-identity quarantine。
// hi platform 用 OAuth client_credentials grant：identity 里的 client_id/secret 拿 access_token，
// 然后用 access_token 调 gateway/platform。

import {
  createHiAgentClients,
  exchangeHiAgentClientCredentialsToken,
  type HiAgentGatewayClient,
  type HiAgentPlatformClient,
  type HiAgentPlatformWellKnown,
} from '@hirey/hi-agent-sdk';
import {
  quarantineStaleIdentityIfNeeded,
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

// 模块级 quarantine 通知：load state 时如果发现 stale，挂一个 in-memory flag，
// 让所有后续 tool response 都能 surface 一次（直到 plugin restart 自然清掉）。
let _lastQuarantineNotice: StaleIdentityQuarantine | null = null;

export function peekQuarantineNotice(): StaleIdentityQuarantine | null {
  return _lastQuarantineNotice;
}

export async function loadStateWithQuarantine(
  stateDir: string,
  profile: string,
  currentPlatformBaseUrl: string,
): Promise<HiPersistedState> {
  const raw = await readState(stateDir, profile);
  const { state, quarantined } = await quarantineStaleIdentityIfNeeded(
    stateDir, profile, raw, currentPlatformBaseUrl,
  );
  if (quarantined) _lastQuarantineNotice = quarantined;
  return state;
}

export async function buildAuthorizedClients(args: {
  stateDir: string;
  profile: string;
  platformBaseUrl: string;
}): Promise<HiAuthorizedClients> {
  const state = await loadStateWithQuarantine(args.stateDir, args.profile, args.platformBaseUrl);
  if (!state.identity) {
    throw new Error('hi_identity_missing: run hi_agent_install before calling authorized tools');
  }
  const token = await exchangeHiAgentClientCredentialsToken({
    tokenUrl: state.identity.token_url,
    clientId: state.identity.client_id,
    clientSecret: state.identity.client_secret,
  });
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
