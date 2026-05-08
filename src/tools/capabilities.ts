// Hi 平台 capability tool 的 generic dispatcher。每个 capability 都通过 platform 的
// /v1/capabilities/<capability_id>/call 调用——平台那侧已经做完整的 input schema 校验、
// authorization、业务逻辑。plugin 这边只做 thin 转发。
//
// 注意 schema 来源：plugin 在 register 阶段从 prod 平台 /v1/capabilities 拉一次完整
// PublicCapability 列表（含 14 个 capability 的 capability_id / tool_name / description /
// 完整 input schema），用平台返回的 schema 作为 OpenClaw registerTool 的 parameters。
// 这样 LLM / openclaw-control-ui / 任意 strict-mode 的 tool calling 框架都能直接看到
// 跟 prod 完全一致的 properties / required / enum 列表，不会因为本地 plugin 写死的极简
// schema（只有 additionalProperties:true，没有任何 properties 声明）导致 strict 校验把
// action / listing_id / 之类调用方实际想传的参数静默丢掉，让平台收到空 args 后回
// "unsupported action"。
//
// 1.0.16 之前的版本里这里写的是 14 个 hardcoded CapabilitySpec + bare schema，会发生
// 上述静默丢字段问题（线上报告：listing_taxonomy(action="list_types") 422 unsupported
// action / agent_listings(action="upsert") 422 unsupported action）。现在改成"启动时
// 一次拉取，原样回放 prod schema"，一处对齐，14 个 tool 全部受益，未来平台加新
// capability 也不需要改 plugin 代码。

import type { PluginToolDefinition, PluginToolResult, HiOpenClawPluginConfig } from '../types.js';
import { buildAuthorizedClients, buildPublicClients } from '../clients.js';
import { resolveStateDir } from '../state.js';
import { buildErrorDetailFields } from '../utils/error-detail.js';
import type { PublicAgentCapability } from '@hirey/hi-agent-sdk';

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

// 把 PublicAgentCapability 的 parameters 原样作为 OpenClaw tool parameters。
// 不在 plugin 这边做任何 properties / required 加工 —— 平台 schema 就是 single source of truth。
// 唯一的安全网：如果平台返回的 parameters 不是 plain object，给一个最小可用 schema（type:object,
// additionalProperties:true）让 OpenClaw 不至于 register 失败；这种情况理论上不该发生，发生
// 了说明平台 contract 退化或拉取过程出错，留 logger.warn 由 register caller 自己负责告警。
function pickPublicSchema(spec: PublicAgentCapability): Record<string, unknown> {
  const params = spec.parameters;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return { type: 'object', additionalProperties: true };
}

function buildCapabilityTool(
  spec: PublicAgentCapability,
  config: Required<HiOpenClawPluginConfig>,
): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  return {
    name: spec.tool_name,
    label: spec.title || `Hi ${spec.tool_name}`,
    description: spec.description || `Hi capability ${spec.capability_id}.`,
    parameters: pickPublicSchema(spec),
    async execute(_id, params): Promise<PluginToolResult> {
      try {
        const auth = await buildAuthorizedClients({
          stateDir, profile: config.profile, platformBaseUrl: config.platformBaseUrl,
        });
        const result = await auth.platform.callCapability(
          spec.capability_id,
          (params || {}) as Record<string, unknown>,
        );
        return asJsonResult({ ok: true, ...(result as Record<string, unknown>), capability_id: spec.capability_id });
      } catch (err: any) {
        // 平台 4xx 的诊断 detail 全在 err.detail.data 里（缺哪个字段 / required_for_action /
        // enum 候选值等），err.message 只是 body.error 字段的一句话。早先这里只 surface
        // err.message，等同于把诊断 swallow 掉——LLM 收到 tool result 只剩"missing fields"
        // 一句话，不知道缺哪个字段，在 owner 面前盲调死循环。详见 utils/error-detail.ts。
        return asErrorResult('capability_call_failed', {
          capability_id: spec.capability_id,
          ...buildErrorDetailFields(err),
        });
      }
    },
  };
}

// 启动时同步拉一次 platform /v1/capabilities，返回 14 个（或未来 N 个）PublicAgentCapability。
// 这里不缓存到 module-level：调用方（register 入口）持有结果，下一次 plugin reload 自然重新拉。
// 不做 retry / fallback：拉不到说明 platform 不可达或 contract 出错，让调用方决定怎么 surface
// （日志 / 不 register tools / throw 都可以），不要在 plugin 内部偷偷塞 hardcoded schema。
export async function fetchPublicCapabilities(platformBaseUrl: string): Promise<PublicAgentCapability[]> {
  const clients = await buildPublicClients(platformBaseUrl);
  const resp = await clients.platform.listCapabilities();
  const items = Array.isArray(resp.capabilities) ? resp.capabilities : [];
  if (items.length === 0) {
    throw new Error('hi_capabilities_empty: platform /v1/capabilities returned no items');
  }
  return items;
}

// 用一组 PublicAgentCapability 实例化对应的 OpenClaw plugin tools。
// 每个 capability 一个 tool；tool 的 parameters = capability.parameters（原样）。
export function buildAllCapabilityTools(
  config: Required<HiOpenClawPluginConfig>,
  specs: readonly PublicAgentCapability[],
): PluginToolDefinition[] {
  return specs.map((spec) => buildCapabilityTool(spec, config));
}

export function getCapabilityToolNames(specs: readonly PublicAgentCapability[]): string[] {
  return specs.map((c) => c.tool_name);
}
