// 14 个 Hi 平台 capability tool 的 generic dispatcher。每个 capability 都通过 platform 的
// /v1/capabilities/<capability_id>/call 调用——平台那侧已经做完整的 input schema 校验、
// authorization、业务逻辑。plugin 这边只做 thin 转发。
//
// 列表跟 hi-platform 在 prod 提供的 capability 一一对应（curl https://hi.hirey.ai/v1/capabilities
// 可得 14 项）。如果未来 hi 平台加新 capability，bump plugin 1.0.x 加进列表，或者改成 startup-time
// 动态拉取。

import type { PluginToolDefinition, PluginToolResult, HiOpenClawPluginConfig } from '../types.js';
import { buildAuthorizedClients } from '../clients.js';
import { resolveStateDir } from '../state.js';

type CapabilitySpec = {
  capability_id: string;
  tool_name: string;
  description: string;
};

// 跟 prod 平台 /v1/capabilities 输出对齐
const CAPABILITIES: CapabilitySpec[] = [
  { capability_id: 'hi.agent-listings', tool_name: 'agent_listings',
    description: 'Manage Hirey AI listings — upsert (create or update with full canonical schema: listing_type_id from listing_taxonomy + canonical self/target roles + facts/requirements), update_status, get, list. Use this to publish what the owner is looking for or offering on Hi.' },
  { capability_id: 'hi.matching-sessions', tool_name: 'matching_sessions',
    description: 'Drive Hi match feed and search against an owner-published listing. Actions: match_feed (recommendation feed), search (sharper structured query when feed is sparse), contact_match (continue on a chosen match → creates pairing). Returns target_preview_text + compatibility_status per result.' },
  { capability_id: 'hi.pairings', tool_name: 'pairings',
    description: 'Pair-level continuation. Actions: create (start pairing from a match selection_key), timeline (canonical chat history + action cards + pending meeting actions), contact_target (send a message to the matched peer). Always read timeline before deciding the next pairing action.' },
  { capability_id: 'hi.thread-meetings', tool_name: 'thread_meetings',
    description: 'Meeting flow inside a pairing. Actions: start (open a meeting flow with flow_kind=start_now|need_slots|propose_slot, modality=zoom|phone), respond (accept_proposed_slot|share_availability|select_slot|approve|reject|decline depending on the action card primary_cta), get (read current state). Use propose_slot when the user has one exact future slot in mind, need_slots to exchange availability.' },
  { capability_id: 'hi.conversations', tool_name: 'conversations',
    description: 'Inspect agent.message.created envelopes and reply through a conversation thread. Used when a webhook delivers a message that needs a reply through the same thread rather than the pairing surface.' },
  { capability_id: 'hi.listing-taxonomy', tool_name: 'listing_taxonomy',
    description: 'Hi listing taxonomy lookup. Actions: list_types (canonical listing_type_id values like "recruiting", "housing", "fundraising", "social_or_friendship", etc), get_roles (canonical self/target role_type_id options for a given listing_type_id). Always call this before agent_listings(action="upsert") to pick canonical values; freelancing role names is rejected by the platform.' },
  { capability_id: 'hi.agent-credits', tool_name: 'agent_credits',
    description: 'Read remaining Hi agent credits + pricing tier for the current owner. Used when the user asks about their Hi quota or hits a paid feature.' },
  { capability_id: 'hi.content-get', tool_name: 'content_get',
    description: 'Read structured content stored on Hi (listing details, profile previews, etc) by content_id. Mostly used internally to expand previews returned by other tools.' },
  { capability_id: 'hi.content-render', tool_name: 'content_render',
    description: 'Render Hi content into a presentation surface (markdown, plain text, structured cards). Use when surfacing a listing preview or profile to the owner.' },
  { capability_id: 'hi.faq-get', tool_name: 'faq_get',
    description: 'Read a specific Hirey AI FAQ entry by id. Used when the user asks a how-to question we already have a canonical answer for.' },
  { capability_id: 'hi.faq-search', tool_name: 'faq_search',
    description: 'Free-text search over Hirey AI FAQ. Use this before answering a generic Hi how-to question with your own words; if the FAQ has it, prefer the canonical text.' },
  { capability_id: 'hi.social-org', tool_name: 'social_org',
    description: 'Read or update social-org metadata on Hi — companies, teams, organizations the owner is part of. Used for org-aware matching (e.g. "I want to find a co-founder, not anyone in my own org").' },
  { capability_id: 'hi.social-permissions', tool_name: 'social_permissions',
    description: 'Manage who can see / contact this owner on Hi. Owner-controlled visibility settings.' },
  { capability_id: 'hi.social-relationships', tool_name: 'social_relationships',
    description: 'Read or write structured relationships between Hi agents (knows / worked-with / introduced-by) — used by stronger match algorithms.' },
];

function defaultStateDir(config: Required<HiOpenClawPluginConfig>): string {
  return config.stateDir || resolveStateDir(config.profile);
}

function asJsonResult(payload: Record<string, unknown>): PluginToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function asErrorResult(error: string, details?: Record<string, unknown>): PluginToolResult {
  const payload: Record<string, unknown> = { ok: false, error };
  if (details) Object.assign(payload, details);
  return { ...asJsonResult(payload), isError: true };
}

function buildCapabilityTool(spec: CapabilitySpec, config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: spec.tool_name,
    label: `Hi ${spec.tool_name}`,
    description: spec.description,
    parameters: {
      type: 'object',
      // 平台校验严格 — 每个 capability 自己有 schema。这里 plugin 这边接 generic object，
      // 把 args 整体转发给平台 /v1/capabilities/<id>/call，由平台返回校验错误。
      additionalProperties: true,
      description: `Arguments for capability ${spec.capability_id}. Required field is "action" (capability-specific values). Other fields depend on the chosen action — fetch ${spec.capability_id} schema if you are unsure.`,
    },
    async execute(_id, params): Promise<PluginToolResult> {
      try {
        const auth = await buildAuthorizedClients({
          stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl,
        });
        const result = await auth.platform.callCapability(spec.capability_id, (params || {}) as Record<string, unknown>);
        return asJsonResult({ ok: true, ...(result as Record<string, unknown>), capability_id: spec.capability_id });
      } catch (err: any) {
        // 平台返回 422 的话 err.message 通常含 invalid_<...> + path 信息，直接 surface 给 LLM。
        return asErrorResult('capability_call_failed', {
          capability_id: spec.capability_id,
          detail: String(err?.message || err),
        });
      }
    },
  };
}

export function buildAllCapabilityTools(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition[] {
  return CAPABILITIES.map((spec) => buildCapabilityTool(spec, config));
}

export function getCapabilityToolNames(): string[] {
  return CAPABILITIES.map((c) => c.tool_name);
}
