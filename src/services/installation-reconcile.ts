// 启动时一次性 reconcile：把当前 plugin metadata + delivery_capabilities 推到平台
// installation.metadata_json + delivery_capabilities_json，让平台的 admin / bootstrap worker /
// route hint 永远跟本机 plugin 实际版本对齐。
//
// 背景：1.0.33 → 1.0.36 升级时，老用户 state.identity 已经存在，hi_agent_install 没有自动重跑
// Step 4，导致平台 installation 记录里 metadata.plugin_version 永远是首次 register 那个值、
// delivery_capabilities 也是最早那次声明。后果之一是 1.0.34 新增的 hi.event-groups 能力相关
// 的 push gate / fanout 逻辑感知不到本机已经能处理新事件。
//
// 这条 reconcile 是 fail-soft 的：
// - 任何 step 失败都不影响 plugin register（fire-and-forget），只 logger.warn。
// - OAuth 401 走 clients.ts 的 reactive quarantine——会把 state file rename 成 .stale，
//   下次 LLM 自然走 hi_agent_install fresh register。
// - 跟 hi_agent_install Step 4 共享 deliveryCapsBody 形状（同一份 delivery 声明），但 reconcile
//   不 touch hooks_token / hooks_path（那条是 hi_agent_install 的 Step 4.5，跟 plugin upgrade
//   无关，由独立的 ensureOpenClawHooksConfigured 兜底）。
// - 触发条件：state.identity.plugin_version_synced !== PLUGIN_VERSION。第一次老用户启动 1.0.37
//   时 plugin_version_synced=null，必跑一次；之后 PLUGIN_VERSION 不变就 skip。

import { buildAuthorizedClients } from '../clients.js';
import { resolveStateDir, readState, updateState } from '../state.js';
import { findRecentUserSessionKey } from '../utils/openclaw-config.js';
import { PLUGIN_VERSION } from '../version.js';
import type { HiOpenClawPluginConfig } from '../types.js';

export type ReconcileLogger = {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
};

export type ReconcileResult =
  | { status: 'skipped'; reason: 'no_identity' | 'version_already_synced' }
  | { status: 'done'; from: string | null; to: string }
  | { status: 'failed'; error: string };

export async function reconcileInstallationOnBoot(
  config: Required<HiOpenClawPluginConfig>,
  logger: ReconcileLogger,
): Promise<ReconcileResult> {
  const stateDir = config.stateDir || resolveStateDir(config.profile);

  let state;
  try {
    state = await readState(stateDir, config.profile);
  } catch (err: any) {
    logger.warn?.('[hi-openclaw-plugin] reconcile: readState failed', { error: String(err?.message || err) });
    return { status: 'failed', error: String(err?.message || err) };
  }

  if (!state.identity) {
    return { status: 'skipped', reason: 'no_identity' };
  }

  // anonymous-first：匿名/未绑定凭证没有 installation（平台还没 materialize agent），
  // updateInstallation 必然 404/无意义。这里直接 skip，等用户绑定身份、hi_agent_install
  // finalize 写好 installation_id 之后，下次启动 reconcile 再正常跑。
  if (state.identity.anonymous || !state.identity.installation_id || !state.identity.agent_id) {
    return { status: 'skipped', reason: 'no_identity' };
  }

  const synced = state.identity.plugin_version_synced;
  if (synced === PLUGIN_VERSION) {
    return { status: 'skipped', reason: 'version_already_synced' };
  }

  logger.info?.('[hi-openclaw-plugin] reconcile: plugin version drift detected, pushing fresh installation state to platform', {
    plugin_version_synced: synced,
    plugin_version_current: PLUGIN_VERSION,
    agent_id: state.identity.agent_id,
    installation_id: state.identity.installation_id,
  });

  let auth;
  try {
    auth = await buildAuthorizedClients({
      stateDir,
      profile: config.profile,
      platformBaseUrl: config.platformBaseUrl,
    });
  } catch (err: any) {
    // hi_identity_quarantined / hi_identity_missing 都是 expected 路径——前者由 OAuth 401
    // 触发的 reactive quarantine，state 已经被 rename 成 .stale，下次 LLM 自然 hi_agent_install
    // 重起；后者是 readState 之后 identity 又消失的极端竞态，同样让 LLM 路径兜底。
    logger.warn?.('[hi-openclaw-plugin] reconcile: skipped (identity unusable, LLM will be prompted to hi_agent_install)', {
      error: String(err?.message || err),
    });
    return { status: 'failed', error: String(err?.message || err) };
  }

  const resolvedSessionKey = findRecentUserSessionKey();
  const deliveryCapsBody: Record<string, unknown> = {
    preferred: 'local_receiver',
    capabilities: [
      { kind: 'local_receiver', status: 'active', config: {} },
      { kind: 'pull_stream', status: 'active', config: {} },
      { kind: 'claim_ack', status: 'active', config: {} },
    ],
  };
  if (resolvedSessionKey && state.identity.installation_id) {
    deliveryCapsBody.route_missing_policy = 'use_explicit_default_route';
    deliveryCapsBody.default_reply_route = {
      installation_id: state.identity.installation_id,
      session_key: resolvedSessionKey,
      delivery_context: { channel: 'last', to: null, account_id: null, thread_id: null },
    };
  }

  try {
    await auth.gateway.updateInstallation({
      metadata: {
        host: 'openclaw',
        plugin: 'hi-openclaw-plugin',
        plugin_version: PLUGIN_VERSION,
      },
      delivery_capabilities: deliveryCapsBody,
    } as any);
  } catch (err: any) {
    logger.warn?.('[hi-openclaw-plugin] reconcile: updateInstallation rejected by platform', {
      error: String(err?.message || err),
      response_body: err?.response_body ?? err?.responseBody ?? err?.body ?? null,
    });
    return { status: 'failed', error: String(err?.message || err) };
  }

  // 平台已经 ack 完整 payload；把本地 marker 推到新版本，避免下次启动重复推。
  await updateState(stateDir, config.profile, (cur) => ({
    ...cur,
    identity: cur.identity
      ? { ...cur.identity, plugin_version_synced: PLUGIN_VERSION }
      : cur.identity,
  }));

  logger.info?.('[hi-openclaw-plugin] reconcile: installation state synced to platform', {
    plugin_version_from: synced,
    plugin_version_to: PLUGIN_VERSION,
  });
  return { status: 'done', from: synced, to: PLUGIN_VERSION };
}
