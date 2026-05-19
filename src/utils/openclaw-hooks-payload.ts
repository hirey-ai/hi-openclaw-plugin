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

// 2026-05：pairing.* event hint。
//
// 平台在 enqueuePairingGatewayEvents 给每条 pairing event 注入三段渲染所需信息，
// 每段按收件人 agent_id 各算一份：
//   - payload.need_refs[].viewer_relation_role: "self"|"counterparty"|"unknown"
//     listing-based pair 用：拿对面 listing 详情用 counterpart_listing_id
//   - payload.viewer_side: "left"|"right"|"unknown"
//     listing-less pair 用：bot 直接用 pairing.{left,right}_agent_id 判 self/other
//   - payload.counterpart_snapshot: { agent, owner, company? }（per-recipient）
//     首选渲染源：对面的 agent display_name + owner headline + company display
//     name & summary。listing-less pair 没 listing 可读，必须吃这个；listing-based
//     pair 也优先用它（更稳健，避免 hi-openclaw-plugin 5/18 Walter "对方=我自己" 那类
//     bug —— 那次本质是 bot 从 self listing.text 抠 owner profile）。
//   - payload.origin: { kind: 'listing_match'|'owner_contact'|'company_contact'|'agent_contact', id }
//     pair 来源溯源，bot 可以告诉 user "Joe 从你的公司主页找到你" 之类。
//
// 这里把 helper 派生字段提到 message 顶层 + 加一条 hint 祈使句，让 LLM 不容易绕开。
function buildPairingViewerHint(event: AgentGatewayEventSnapshot): {
  hint: string;
  helper: Record<string, unknown>;
} | null {
  const topic = String(event?.topic || '');
  if (topic !== 'pairing.created' && topic !== 'pairing.updated') return null;
  const payload = (event as any)?.payload;
  if (!payload) return null;

  // ---- listing-based pair：从 need_refs 抓 counterpart/self listing ----
  const needRefs = Array.isArray(payload.need_refs) ? payload.need_refs : [];
  let counterpartListingId: string | null = null;
  let selfListingId: string | null = null;
  let counterpartAgentIdFromRefs: string | null = null;
  let selfAgentIdFromRefs: string | null = null;
  for (const ref of needRefs) {
    const role = normalizeText(ref?.viewer_relation_role);
    const listingId = normalizeText(ref?.listing_id);
    const agentId = normalizeText(ref?.agent_id);
    if (role === 'counterparty' && listingId) {
      counterpartListingId = listingId;
      counterpartAgentIdFromRefs = agentId || null;
    } else if (role === 'self' && listingId) {
      selfListingId = listingId;
      selfAgentIdFromRefs = agentId || null;
    }
  }

  // ---- listing-less pair：从 viewer_side + pairing.{left,right}_agent_id 推 ----
  const viewerSide = normalizeText(payload.viewer_side);
  const pairingObj = (payload.pairing && typeof payload.pairing === 'object') ? payload.pairing : {};
  const leftAgentId = normalizeText((pairingObj as any).left_agent_id);
  const rightAgentId = normalizeText((pairingObj as any).right_agent_id);
  let counterpartAgentIdFromSide: string | null = null;
  let selfAgentIdFromSide: string | null = null;
  if (viewerSide === 'left') {
    selfAgentIdFromSide = leftAgentId || null;
    counterpartAgentIdFromSide = rightAgentId || null;
  } else if (viewerSide === 'right') {
    selfAgentIdFromSide = rightAgentId || null;
    counterpartAgentIdFromSide = leftAgentId || null;
  }

  // counterpart_snapshot（per-recipient）—— 首选渲染源
  const snap = (payload.counterpart_snapshot && typeof payload.counterpart_snapshot === 'object')
    ? payload.counterpart_snapshot as Record<string, any>
    : null;

  // origin —— bot 可以用来说"对方是从你 owner 主页/公司主页/listing match 找到你的"
  const origin = (payload.origin && typeof payload.origin === 'object')
    ? payload.origin as Record<string, any>
    : null;

  // 如果什么都没拿到，老 listing-based pair 老路径退化 —— 不发 hint 避免噪音。
  const hasAnythingUseful = counterpartListingId || selfListingId
    || snap || counterpartAgentIdFromSide || origin;
  if (!hasAnythingUseful) return null;

  // 一条祈使句给 LLM：优先 counterpart_snapshot；其次 viewer_side；最后 need_refs。
  // 显式列举 origin.kind 怎么解释，让 bot 用 user-friendly 表述对方触达来源。
  const hint = [
    '[hi pairing hint] To render "对方/the other party" correctly, prefer this order:',
    '  1. payload.counterpart_snapshot.{agent, owner, company} — already filtered to the other side; use owner.display_name + owner.headline + company.display_name + company.summary.',
    '  2. payload.viewer_side ("left" | "right") + pairing.{left,right}_agent_id — for listing-less pairs (need_refs is empty).',
    '  3. payload.need_refs[] whose viewer_relation_role === "counterparty" — for listing-based pairs.',
    'NEVER read the "self" need_ref or the listing on YOUR side as if it were the other party — that is YOUR own listing.',
    'payload.origin.kind tells you HOW they reached you: "listing_match" (matcher recommendation), "owner_contact" (clicked your owner card), "company_contact" (clicked your company page), "agent_contact" (direct).',
  ].join('\n');

  const helper: Record<string, unknown> = {
    counterpart_listing_id: counterpartListingId,
    self_listing_id: selfListingId,
    counterpart_agent_id: counterpartAgentIdFromRefs || counterpartAgentIdFromSide,
    self_agent_id: selfAgentIdFromRefs || selfAgentIdFromSide,
    viewer_side: viewerSide || null,
    origin_kind: origin?.kind ? String(origin.kind) : null,
    origin_id: origin?.id ? String(origin.id) : null,
    counterpart_snapshot: snap,
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
