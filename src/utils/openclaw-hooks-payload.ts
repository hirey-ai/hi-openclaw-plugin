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

function buildOpenClawContinuationMessage(
  event: AgentGatewayEventSnapshot,
  messagePrefix: string | null,
): string {
  const parts: string[] = [];
  if (messagePrefix) parts.push(messagePrefix);
  if ((event as any)?.preview?.text) parts.push(String((event as any).preview.text));
  parts.push(JSON.stringify({
    topic: event.topic,
    resource_ref: (event as any).resource_ref || {},
    payload: (event as any).payload || {},
  }));
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
