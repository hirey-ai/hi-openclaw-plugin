// 把 hi 平台 event 转成 OpenClaw /hooks/agent 接受的 hook payload。
// 本文件是从 hi-agent-receiver/src/server.ts 复制过来的等价实现，让 native plugin 走的
// 投递语义跟老 hi-agent-receiver daemon 完全一致。
// 同步源：/Users/lawrence/Code/Hi/hi-agent-receiver/src/server.ts:173–217 (May 2026)
//   - buildOpenClawContinuationMessage()
//   - buildOpenClawHookPayloadWithRoute()
// 改动后请同步两处。

import type {
  AgentGatewayEventSnapshot,
  OpenClawHooksAgentEndpointConfig,
} from '@hirey/hi-agent-contracts';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 2026-05：pairing.* event 里每条 need_ref 都带 platform 算好的
// viewer_relation_role: "self" | "counterparty" | "unknown"（hi-platform
// 在 sanitizePairingNeedRefsForSurface 按收件人 agent_id 派生）。早期 bot LLM
// 容易把 relation_role(absolute) 当 viewer-relative 用，结果把自己 listing 的
// owner profile 当成"对方"渲染（5/18 Walter "对方=我自己" bug 的直接成因）。
// 这里在 message 顶部插一段 hint + 把 counterpart/self listing_id 提到顶层，
// 让 bot LLM 不必再用 relation_role 推断。
function buildPairingViewerHint(event: AgentGatewayEventSnapshot): {
  hint: string;
  helper: Record<string, unknown>;
} | null {
  const topic = String(event?.topic || '');
  if (topic !== 'pairing.created' && topic !== 'pairing.updated') return null;
  const payload = (event as any)?.payload;
  const needRefs = Array.isArray(payload?.need_refs) ? payload.need_refs : [];
  if (needRefs.length === 0) return null;
  let counterpartListingId: string | null = null;
  let selfListingId: string | null = null;
  let counterpartAgentId: string | null = null;
  let selfAgentId: string | null = null;
  for (const ref of needRefs) {
    const role = normalizeText(ref?.viewer_relation_role);
    const listingId = normalizeText(ref?.listing_id);
    const agentId = normalizeText(ref?.agent_id);
    if (role === 'counterparty' && listingId) {
      counterpartListingId = listingId;
      counterpartAgentId = agentId || null;
    } else if (role === 'self' && listingId) {
      selfListingId = listingId;
      selfAgentId = agentId || null;
    }
  }
  if (!counterpartListingId && !selfListingId) return null;
  // 一条祈使句给 LLM，明示绝不能把 self_listing_id 当成对方。
  const hint = '[hi pairing hint] When you describe the other party, use ONLY the need_ref whose viewer_relation_role === "counterparty". Never read the self need_ref (viewer_relation_role === "self") as if it were the other side — it is YOUR own listing and rendering its owner profile as "对方/counterpart" is a known bug class.';
  const helper: Record<string, unknown> = {
    counterpart_listing_id: counterpartListingId,
    self_listing_id: selfListingId,
    counterpart_agent_id: counterpartAgentId,
    self_agent_id: selfAgentId,
  };
  return { hint, helper };
}

function buildOpenClawContinuationMessage(
  event: AgentGatewayEventSnapshot,
  messagePrefix: string | null,
): string {
  const parts: string[] = [];
  if (messagePrefix) parts.push(messagePrefix);
  const viewerHint = buildPairingViewerHint(event);
  if (viewerHint) parts.push(viewerHint.hint);
  if ((event as any)?.preview?.text) parts.push(String((event as any).preview.text));
  const jsonBody: Record<string, unknown> = {
    topic: event.topic,
    resource_ref: (event as any).resource_ref || {},
    payload: (event as any).payload || {},
  };
  if (viewerHint) jsonBody.viewer_helper = viewerHint.helper;
  parts.push(JSON.stringify(jsonBody));
  return parts.filter(Boolean).join('\n\n');
}

export function buildOpenClawHookPayloadWithRoute(args: {
  event: AgentGatewayEventSnapshot;
  config?: OpenClawHooksAgentEndpointConfig | Record<string, unknown> | null;
}): {
  message: string;
  name: string;
  agentId?: string;
  sessionKey?: string;
  wakeMode: string;
  deliver: boolean;
  channel?: string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
} {
  const config = (args.config || {}) as OpenClawHooksAgentEndpointConfig & {
    session_key?: string | null;
  };
  const routeSnapshot = (args.event as any)?.reply_route_snapshot && typeof (args.event as any).reply_route_snapshot === 'object'
    ? (args.event as any).reply_route_snapshot as Record<string, unknown>
    : {};
  const deliveryContext = (routeSnapshot as any).delivery_context && typeof (routeSnapshot as any).delivery_context === 'object'
    ? (routeSnapshot as any).delivery_context as Record<string, unknown>
    : {};
  const messagePrefix = normalizeText((config as any).message_prefix) || null;
  const explicitSessionKey = normalizeText((routeSnapshot as any).session_key || (config as any).session_key) || null;
  const shouldSendLegacySessionKey = (config as any).send_session_key === true && !explicitSessionKey;
  const sessionKeyPrefix = normalizeText((config as any).session_key_prefix) || 'hi';
  return {
    message: buildOpenClawContinuationMessage(args.event, messagePrefix),
    name: normalizeText((config as any).name) || 'Hi',
    agentId: normalizeText((config as any).agent_id) || undefined,
    ...(explicitSessionKey
      ? { sessionKey: explicitSessionKey }
      : (shouldSendLegacySessionKey ? { sessionKey: `${sessionKeyPrefix}:${args.event.event_id}` } : {})),
    wakeMode: normalizeText((config as any).wake_mode) || 'now',
    deliver: (config as any).deliver !== false,
    channel: normalizeText((deliveryContext as any).channel || (config as any).channel) || undefined,
    to: normalizeText((deliveryContext as any).to || (config as any).to) || undefined,
    model: normalizeText((config as any).model) || undefined,
    thinking: normalizeText((config as any).thinking) || undefined,
    timeoutSeconds: Number((config as any).timeout_seconds || 0) || undefined,
  };
}
