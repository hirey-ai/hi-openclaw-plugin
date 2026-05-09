// Hi 平台 capability tool 的 generic dispatcher。每个 capability 都通过 platform 的
// /v1/capabilities/<capability_id>/call 调用——平台那侧已经做完整的 input schema 校验、
// authorization、业务逻辑。plugin 这边只做 thin 转发。
//
// schema 来源（1.0.20 起）：build-time snapshot。
//
// scripts/snapshot-capabilities.mjs 在 npm publish / npm pack / clawhub publish 之前会
// 一次性 fetch prod https://hi.hirey.ai/v1/capabilities，把 14 个（未来 N 个）
// PublicAgentCapability 的完整 input schema 写到 dist/capabilities.snapshot.json。
// register 阶段同步 readFileSync 加载这份 snapshot，原样作为 OpenClaw registerTool 的
// parameters。这样：
//   - register 完全是同步函数 → 满足 OpenClaw v2026.4.23+ runPluginRegisterSync 的硬性
//     要求（async register 直接 throw "plugin register must be synchronous"，详见
//     openclaw/openclaw#67900 / PR #67941 / CHANGELOG.md:707）
//   - 跟 OpenClaw 5.2+ 引入的 plugin tool descriptor cache（PR #76079）兼容：register
//     时 api.registerTool(...) 拿到的 descriptor 就是最终用于 prompt-time planning 的
//     descriptor，不需要任何运行时 mutate
//   - LLM / openclaw-control-ui / 任意 strict-mode 的 tool calling 框架都能直接看到跟
//     prod 完全一致的 properties / required / enum 列表，不会因为本地 plugin 写死的
//     极简 schema（只有 additionalProperties:true）导致 strict 校验把 action /
//     listing_id 之类参数静默丢掉，让平台收到空 args 后回 "unsupported action"
//
// 历史：
//   1.0.0 ~ 1.0.15：hardcoded 14 个 CapabilitySpec + bare additionalProperties:true schema。
//     OpenAI strict mode 把 properties 静默剥光，调用方传 action 字段被丢，平台 422
//     unsupported action（线上 repro：listing_taxonomy(action="list_types") /
//     agent_listings(action="upsert"))。
//   1.0.16 ~ 1.0.19：改成 register-time runtime fetch（async function register +
//     await fetchPublicCapabilities）。schema 跟 prod 对齐了，但违反 OpenClaw 4.23+
//     的 sync register 硬约束，host loader hard reject，整个 plugin register 失败 →
//     hi_agent_install 等所有 tool 都注册不上来，用户装完插件完全没工具可用。
//   1.0.20+：build-time snapshot。register 是 sync，schema 来自 plugin 发布时刻拉的
//     prod /v1/capabilities 快照；platform 加新 capability / 改 schema 时 plugin 必须
//     重发版才能跟进，这是 OpenClaw plugin SDK 的固有约束（plugin descriptor 在
//     register 阶段就 freeze 进 host 的 tool descriptor cache，runtime mutate 也无效）。

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import type { PluginToolDefinition, PluginToolResult, HiOpenClawPluginConfig } from '../types.js';
import { buildAuthorizedClients } from '../clients.js';
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

function buildCapabilityTool(
  spec: PublicAgentCapability,
  config: Required<HiOpenClawPluginConfig>,
): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  // spec.parameters 原样作为 OpenClaw tool parameters：平台 schema 就是 single source of truth，
  // plugin 这边不做任何 properties / required 加工。schema 形态在 build-time（snapshot 写出
  // 时）和 runtime（loadCapabilitySnapshot）都校验过 parameters 必须是 plain object，到这里
  // 一定可用，不需要任何 fallback。
  return {
    name: spec.tool_name,
    label: spec.title || `Hi ${spec.tool_name}`,
    description: spec.description || `Hi capability ${spec.capability_id}.`,
    parameters: spec.parameters,
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

// 同步从 dist/capabilities.snapshot.json 读 build-time snapshot。register 阶段调用。
//
// snapshot 文件由 scripts/snapshot-capabilities.mjs 在 npm prepack 时写出（fetch
// https://hi.hirey.ai/v1/capabilities → 校验形态 → 写到 dist/）。snapshot 是
// PublicAgentCapability[] 数组（不带 wrapper），跟 fetchPublicCapabilities 返回值
// 形态完全一致。
//
// fail-close：snapshot 缺失 / 不是数组 / 数组为空 / 单 item 缺关键字段，全部 throw。
// register 入口的 try/catch 已经被 1.0.20 删掉，这里 throw 会冒到 plugin loader，
// 整个 plugin register 失败、host doctor 报错。这正是想要的行为：plugin tarball 应该
// 100% 是带着合法 snapshot 出去的，runtime load 失败说明 tarball 自身坏掉，不应该
// 用兜底 schema 偷偷续命。
//
// 解析在 module 级别完成（loadCapabilitySnapshot 是普通函数，不缓存到 module 顶层
// const）：plugin loader 多次 register（不同 api 实例）时各自 load 一次 snapshot；
// 实际 disk read 是同一个 file，OS page cache 兜着，cost 可忽略。模块顶层缓存反而
// 让 module 出错时机更早，定位更难。
function resolveSnapshotPath(): string {
  // ESM 下 __dirname 不存在，用 import.meta.url 解析当前 module 文件所在目录。
  // 当前文件编译后位于 dist/tools/capabilities.js，snapshot 在 dist/capabilities.snapshot.json，
  // 所以是 ../capabilities.snapshot.json。
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'capabilities.snapshot.json');
}

export function loadCapabilitySnapshot(): PublicAgentCapability[] {
  const snapshotPath = resolveSnapshotPath();
  let raw: string;
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8');
  } catch (err: any) {
    throw new Error(
      `hi_capabilities_snapshot_missing: ${snapshotPath} not readable (${err?.code || err?.message || err}). `
        + `dist/capabilities.snapshot.json must be written by scripts/snapshot-capabilities.mjs at build time. `
        + `If you ran tsc directly without prepack, run \`node scripts/snapshot-capabilities.mjs\` to populate it.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(
      `hi_capabilities_snapshot_corrupt: ${snapshotPath} not valid JSON (${err?.message || err})`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `hi_capabilities_snapshot_shape: expected PublicAgentCapability[] array, got ${typeof parsed}`,
    );
  }
  if (parsed.length === 0) {
    throw new Error(
      `hi_capabilities_snapshot_empty: snapshot has 0 items — refuse to register plugin with no capability tools`,
    );
  }
  // 跟 scripts/snapshot-capabilities.mjs 同一份字段级校验（snapshot 写出时已经验过，但
  // 万一 npm tarball 在传输/解压过程中损坏，这里再校一次更稳）：每个 item 必须含
  // capability_id / tool_name / parameters。
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`hi_capabilities_snapshot_item_shape: capability item not a plain object`);
    }
    const it = item as Record<string, unknown>;
    if (typeof it.capability_id !== 'string' || !it.capability_id) {
      throw new Error(`hi_capabilities_snapshot_item_field: capability missing capability_id`);
    }
    if (typeof it.tool_name !== 'string' || !it.tool_name) {
      throw new Error(`hi_capabilities_snapshot_item_field: ${it.capability_id} missing tool_name`);
    }
    if (!it.parameters || typeof it.parameters !== 'object' || Array.isArray(it.parameters)) {
      throw new Error(`hi_capabilities_snapshot_item_field: ${it.capability_id} missing parameters object`);
    }
  }
  return parsed as PublicAgentCapability[];
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
