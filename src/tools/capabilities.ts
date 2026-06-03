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
import type { PluginToolDefinition, PluginToolResult, HiOpenClawPluginConfig, PluginToolContext } from '../types.js';
import { buildAuthorizedClients } from '../clients.js';
import { resolveStateDir } from '../state.js';
import { buildErrorDetailFields } from '../utils/error-detail.js';
import type { PublicAgentCapability } from '@hirey/hi-agent-sdk';

// 从 OpenClaw runtime ctx 抽出可信的 host_session_key + delivery_context，注入到 capability
// 调用参数的 _ctx 字段里。Hi 平台 src/services/agentReplyRoutes.ts:142 extractHostReplyRoute
// 读取这些字段把当前 session 当成"事件源会话"持久化进 agent_workflow_routes 表，后续异步
// event 出箱时按 thread_action -> pairing -> listing -> install_default 优先级回放到这条
// session。不注入的话平台只能 fallback 到"最近会话"启发式（findRecentUserSessionKey），
// 在多 channel/多 session 用户上会把 push 注到错的 session。
//
// 信任策略：runtime ctx 的值是 host 进程自己填的，不可被 LLM args 覆写。execute(params, ...)
// 收到的 params 即使带了 _ctx，也用 runtime ctx 的值覆盖 host_session_key / host_reply_route
// 这两个权威字段。LLM 仍可用 params._ctx 传其它非路由字段（保持 forward-compat）。
// Exported for unit testing. Not part of the public plugin API surface.
export function enrichParamsWithHostContext(
  params: unknown,
  ctx: PluginToolContext,
): Record<string, unknown> {
  const base = (params && typeof params === 'object' && !Array.isArray(params))
    ? { ...(params as Record<string, unknown>) }
    : {};
  const sessionKey = typeof ctx.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
  const dc = (ctx.deliveryContext && typeof ctx.deliveryContext === 'object')
    ? ctx.deliveryContext
    : undefined;
  const channel = typeof dc?.channel === 'string' && dc.channel.trim() ? dc.channel.trim() : undefined;
  const to = typeof dc?.to === 'string' && dc.to.trim() ? dc.to.trim() : undefined;
  const accountId = typeof dc?.accountId === 'string' && dc.accountId.trim() ? dc.accountId.trim() : undefined;
  const threadId = typeof dc?.threadId === 'string' && dc.threadId.trim() ? dc.threadId.trim() : undefined;
  if (!sessionKey && !channel && !to && !accountId && !threadId) {
    return base;
  }
  const existingCtx = (base._ctx && typeof base._ctx === 'object' && !Array.isArray(base._ctx))
    ? { ...(base._ctx as Record<string, unknown>) }
    : {};
  const hostReplyRoute: Record<string, unknown> = {};
  if (sessionKey) hostReplyRoute.session_key = sessionKey;
  if (channel || to || accountId || threadId) {
    const deliveryContext: Record<string, unknown> = {};
    if (channel) deliveryContext.channel = channel;
    if (to) deliveryContext.to = to;
    if (accountId) deliveryContext.account_id = accountId;
    if (threadId) deliveryContext.thread_id = threadId;
    hostReplyRoute.delivery_context = deliveryContext;
  }
  // 覆盖 LLM 提供的同名字段：路由真相只能来自 runtime。其它 _ctx 字段保留以便 forward-compat。
  if (sessionKey) existingCtx.host_session_key = sessionKey;
  if (Object.keys(hostReplyRoute).length > 0) existingCtx.host_reply_route = hostReplyRoute;
  base._ctx = existingCtx;
  return base;
}

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

// 平台写操作 gate：匿名（未绑定身份）调用写类 capability 时，平台返回
// phone_binding_required 一类的身份门禁错误（读/搜索匿名放行，写需要已验证身份）。
// anonymous-first 改造后这是**预期**的正常分叉，不是 bug —— 把它识别出来，回一条
// Google 优先的绑定引导，让 LLM 去绑定再重试，而不是当成普通失败甩给用户。
function looksLikeBindingGate(err: unknown): boolean {
  const fields = buildErrorDetailFields(err);
  const hay = `${fields.error_message} ${(() => {
    try { return JSON.stringify(fields.platform_response ?? ''); } catch { return ''; }
  })()}`.toLowerCase();
  // 显式 gate code（codex 线上 onboarding 文案钦定的 phone_binding_required）+ 等价变体。
  if (/phone_binding_required|binding_required|requires?_?identity|identity_required/.test(hay)) return true;
  // 自然语言变体：requires a phone-verified identity / must bind / not verified ...
  if (/requires?\s+a?\s*phone|phone[-\s]?verified|verified\s+identity|must\s+(bind|verify)|not\s+verified/.test(hay)) {
    return true;
  }
  // 403 + 身份/绑定/手机/邮箱 关键词：兜底（平台未来若换 code 也不漏）。
  if (fields.status === 403 && /(identity|bind|verif|phone|email|anonymous|forbidden)/.test(hay)) return true;
  return false;
}

// 写操作 gate 命中时回给 LLM 的结构化绑定引导。Google 默认、手机/邮箱次之，并明确
// "绑定后重试不会新建 agent / 不会变成另一个 agent"，对齐零 churn 语义。
function bindingGateResult(capabilityId: string, err: unknown): PluginToolResult {
  return {
    ...asJsonResult({
      ok: false,
      error: 'needs_binding',
      needs_binding: true,
      capability_id: capabilityId,
      instruction_to_llm:
        '这是写操作（建档/发 listing/联系人/约 meeting 等），需要先把身份绑定到 Hi。'
        + '绑定后用同样的参数重试这条操作即可——绑定不会新建 agent，也不会把你变成另一个 agent。'
        + '默认、最省事的方式是用 Google 登录：调用 google_link 工具。'
        + '用户不想用 Google 时，可改用 phone_binding（先 action:"bind" 发码，再 action:"verify" 提交短信验证码）'
        + '或 email_binding（邮箱验证码）。'
        + '注意：这里的"绑定手机/邮箱/Google"是把身份绑到 Hi 账号/工作区，不是宿主自带的电话/Gmail/邮箱连接器。',
      how_to_bind: {
        recommended: 'google_link',
        options: [
          { tool: 'google_link', note: 'Sign in with Google（默认推荐，最省事）' },
          { tool: 'phone_binding', note: '手机号验证码：action:"bind" 发码 → action:"verify" 提交 SMS code' },
          { tool: 'email_binding', note: '邮箱验证码（或邮箱里的 Google 登录）' },
        ],
      },
      retry_after_bind: '绑定成功后，用相同参数再次调用 ' + capabilityId + ' 对应的工具即可。',
      ...buildErrorDetailFields(err),
    }),
    isError: true,
  };
}

function buildCapabilityTool(
  spec: PublicAgentCapability,
  config: Required<HiOpenClawPluginConfig>,
  ctx: PluginToolContext,
): PluginToolDefinition {
  const stateDir = defaultStateDir(config);
  // spec.parameters 原样作为 OpenClaw tool parameters：平台 schema 就是 single source of truth，
  // plugin 这边不做任何 properties / required 加工。schema 形态在 build-time（snapshot 写出
  // 时）和 runtime（loadCapabilitySnapshot）都校验过 parameters 必须是 plain object，到这里
  // 一定可用，不需要任何 fallback。
  //
  // ctx 由 OpenClaw 在每次 LLM session materialize tool 时传进来，含当前 sessionKey /
  // deliveryContext 等可信运行时字段。execute 闭包 capture 一份，调 capability 时通过
  // enrichParamsWithHostContext 注入到 _ctx.host_session_key + host_reply_route，让 Hi
  // 平台的 workflow route binding 拿到事件源会话。详见 enrichParamsWithHostContext 注释。
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
        const enrichedParams = enrichParamsWithHostContext(params, ctx);
        const result = await auth.platform.callCapability(
          spec.capability_id,
          enrichedParams,
        );
        return asJsonResult({ ok: true, ...(result as Record<string, unknown>), capability_id: spec.capability_id });
      } catch (err: any) {
        // 写操作 gate：匿名调用写类 capability 命中平台 phone_binding_required 一类身份门禁
        // 时，回 Google 优先的绑定引导（让 LLM 绑定再重试），而不是当成普通失败。这是
        // anonymous-first 下的预期分叉。读/搜索匿名放行，不会走到这里。
        if (looksLikeBindingGate(err)) {
          return bindingGateResult(spec.capability_id, err);
        }
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
//
// ctx：OpenClaw 每次 LLM session materialize tools 时传进来的可信运行时上下文。同一个 spec
// 在不同 session 里 build 出来的 PluginToolDefinition 之间 descriptor（name/desc/parameters）
// 完全一致（来自 build-time snapshot），execute 闭包 capture 各自 session 的 sessionKey /
// deliveryContext。注：OpenClaw 5.2+ 在 register 阶段会 cache descriptor，但 execute 仍按
// 每次 session materialize 时返回的 tool object 绑定，所以闭包 capture 的 ctx 不会跨 session 串。
export function buildAllCapabilityTools(
  config: Required<HiOpenClawPluginConfig>,
  specs: readonly PublicAgentCapability[],
  ctx: PluginToolContext = {},
): PluginToolDefinition[] {
  return specs.map((spec) => buildCapabilityTool(spec, config, ctx));
}

// 把一个 capability spec 暴露给 host 的 registerTool factory：每次 host materialize 时
// 用传进来的 ctx 重新 build tool（execute 闭包 capture per-session 的 sessionKey）。
//
// 这里没有缓存 —— 跟 register 阶段一次性 build 全量不同，host materialize 时 spec 仍是
// 同一个常量引用，descriptor 仍来自 build-time snapshot，构造代价可忽略。
export function buildCapabilityToolFactory(
  spec: PublicAgentCapability,
  config: Required<HiOpenClawPluginConfig>,
): (ctx: PluginToolContext) => PluginToolDefinition {
  return (ctx) => buildCapabilityTool(spec, config, ctx);
}

export function getCapabilityToolNames(specs: readonly PublicAgentCapability[]): string[] {
  return specs.map((c) => c.tool_name);
}
