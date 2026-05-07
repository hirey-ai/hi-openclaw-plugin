// OpenClaw plugin SDK 的稳定接口在 @openclaw/plugin-sdk 内部包里（monorepo 私有，不发 npm），
// 所以社区 plugin 的标准做法是自己 mirror 一份本地最小类型表面。我们这里只声明 hi-openclaw-plugin
// 实际用到的字段——register 入口、registerTool / registerService / registerHttpRoute 这三个能力
// 加上 logger / pluginConfig 这两个 context 入口。其他能力（registerHook / registerCli / registerChannel
// 等）等以后真用上再补。
//
// duck-typing 设计：plugin loader 在运行时只看 shape，不看类型名；我们这里类型名 PluginRegisterApi
// 是给 TS 用的，host 端跟它无关。

import type {
  IncomingMessage as NodeIncomingMessage,
  ServerResponse as NodeServerResponse,
} from 'node:http';

// 工具参数的 schema 形态：OpenClaw 内部用 typebox 风格的 JSON Schema。我们这里只要求是个普通对象，
// 在 wiring 层用现有 hi-mcp-server 的 Zod / typebox 输出即可。
export type PluginToolParameterSchema = Record<string, unknown>;

export type PluginToolResult = {
  // OpenClaw tool result 是一个 wrapper：content 是 LLM 看到的可读输出，
  // structuredContent 是机器可读的 JSON（用来给后续 tool call 复用）。
  content?: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown> | Array<unknown>;
  isError?: boolean;
};

// OpenClaw SDK 约定的 tool execute 签名是 4 个参数：(toolCallId, params, signal, onUpdate)，
// 后两个是可选的（当前实现都不依赖，但保留入参 forward-compat）。
export type PluginToolDefinition = {
  name: string;
  label?: string;
  description: string;
  parameters: PluginToolParameterSchema;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (chunk: unknown) => void,
  ) => Promise<PluginToolResult>;
};

// OpenClaw SDK 约定：一次 registerTool 注一个 tool（或返回 null 表示当前 session 不暴露此 tool）。
// 工厂会在每次 LLM session materialize 时被调一次，可基于 ctx.agentId / ctx.sessionKey 决定是否启用。
export type PluginToolFactory = (ctx: PluginToolContext) => PluginToolDefinition | null;

export type PluginToolContext = {
  // OpenClaw 在 per-LLM-run materialize tools 时调一次 factory；ctx 里通常含 sessionKey、agent id 等。
  // 我们大多数 hi tool 不依赖 ctx，所以这里保留 unknown 即可，未来需要再细化。
  readonly [key: string]: unknown;
};

export type PluginServiceContext = {
  logger: PluginLogger;
  signal?: AbortSignal;
  readonly [key: string]: unknown;
};

export type PluginServiceDefinition = {
  id: string;
  start: (ctx: PluginServiceContext) => Promise<void> | void;
  stop?: (ctx: PluginServiceContext) => Promise<void> | void;
};

export type PluginHttpRouteHandler = (
  req: NodeIncomingMessage,
  res: NodeServerResponse,
) => Promise<void> | boolean | void;

export type PluginHttpRouteDefinition = {
  path: string;
  // auth: 'plugin' = plugin 自己负责 verify 入站请求（我们这边给 hi-platform 的 webhook 用 HMAC 之类的）；
  //       'gateway' = 让 OpenClaw gateway 自己的 auth chain 处理。
  auth: 'plugin' | 'gateway';
  match?: 'exact' | 'prefix';
  handler: PluginHttpRouteHandler;
};

export type PluginLogger = {
  info?(msg: string, meta?: unknown): void;
  warn?(msg: string, meta?: unknown): void;
  error?(msg: string, meta?: unknown): void;
  debug?(msg: string, meta?: unknown): void;
};

// 整个 register 入口拿到的 api 对象。OpenClaw runtime duck-typing 决定哪些字段存在；
// 老 host 可能没有 registerService（4.x 早期），所以全部带 ? 让 plugin 能做 feature detection。
export type PluginRegisterApi = {
  // pluginConfig 由 host 从 openclaw.plugin.json 的 configSchema + 用户配置 merge 后塞进来。
  pluginConfig?: HiOpenClawPluginConfig;
  logger?: PluginLogger;

  registerTool?(factory: PluginToolFactory, options?: { names?: string[]; optional?: boolean }): void;
  registerService?(service: PluginServiceDefinition): void;
  registerHttpRoute?(route: PluginHttpRouteDefinition): void;
  // 未来要 hook event（agent_start / before_prompt_build 之类）再补：
  // on?(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void): void;
};

// 对应 openclaw.plugin.json 的 configSchema。
// 注：source 仓库这里写 early channel 默认 (https://hi.hirey.ai 既是 prod，但 channels.json 渲染
// 后 prod 渲染产物会保持这个字段不变，因为两边都连 hi.hirey.ai；早期 staging 用户在装的时候自己改
// platformBaseUrl 即可)。
export type HiOpenClawPluginConfig = {
  platformBaseUrl?: string;
  profile?: string;
  stateDir?: string;
  webhookPath?: string;
  claimPollIntervalMs?: number;
  claimLeaseMs?: number;
};
