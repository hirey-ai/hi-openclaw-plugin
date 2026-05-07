// hi-openclaw-plugin entry: register Hi 的 tool / service / route 进 OpenClaw gateway 进程。
//
// 设计原则：
// 1. Idempotent：OpenClaw runtime 在同一进程里可能用不同的 api 实例多次调本入口（懒加载、CLI 热加载、
//    gateway hot-apply 都触发），所以用 WeakSet<api> 守卫。module-level 单 boolean 在多 api 实例
//    时会丢漏注册。
// 2. 缺能力 fail-soft：老 host 可能没 registerService 或 registerHttpRoute；用 ?. 调用 + logger.warn
//    告诉用户哪部分降级了，不要直接 throw 让 host 起不来。
// 3. 真业务逻辑都委托给 hi-agent-sdk —— 这个文件以及 src/tools/* / src/services/* 里只做 wiring。

import type {
  PluginRegisterApi,
  PluginToolDefinition,
  PluginToolResult,
  HiOpenClawPluginConfig,
} from './types.js';

const _registeredApis = new WeakSet<PluginRegisterApi>();

function defaultedConfig(raw: HiOpenClawPluginConfig | undefined): Required<HiOpenClawPluginConfig> {
  // 这些 default 跟 openclaw.plugin.json 的 configSchema default 字段对齐；任何一处改动两处都得动。
  return {
    platformBaseUrl: raw?.platformBaseUrl?.trim() || 'https://hi.hirey.ai',
    profile: raw?.profile?.trim() || 'openclaw-main',
    stateDir: raw?.stateDir?.trim() || '',
    webhookPath: raw?.webhookPath?.trim() || '/hi/webhook',
    claimPollIntervalMs: Math.max(250, Number(raw?.claimPollIntervalMs ?? 1500)),
    claimLeaseMs: Math.max(1000, Number(raw?.claimLeaseMs ?? 60000)),
  };
}

function buildHiAgentStatusTool(config: Required<HiOpenClawPluginConfig>): PluginToolDefinition {
  // 第一阶段最小可验证 tool：返回 plugin runtime 状态。这是 risk-降低 milestone 的"LLM 真能调到"
  // 那一步的目标 tool。后续真正 wire 业务时这个 tool 会被替换成调 sdk client.gateway.me() 的
  // 完整 hi_agent_status，但 contract 一样：tool name 不变，schema 不变，LLM 看到的是同一个 tool。
  return {
    name: 'hi_agent_status',
    label: 'Hi agent status',
    description:
      'Reports whether Hi (Hirey AI) is healthy on this OpenClaw host. Run this when the user asks "is Hi working?" or before any other Hi tool call to confirm the runtime is ready.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_remote: {
          type: 'boolean',
          description: 'If true, also call the Hi platform /me endpoint to confirm the agent identity is still recognized server-side. Default false.',
          default: false,
        },
      },
    },
    async execute(_toolCallId, _params): Promise<PluginToolResult> {
      const summary = {
        ok: true,
        plugin: 'hi-openclaw-plugin',
        plugin_version: '0.1.0',
        platform_base_url: config.platformBaseUrl,
        profile: config.profile,
        webhook_path: config.webhookPath,
        // identity / connected / activated / push_ready 等 runtime 字段在后续 wiring 加业务逻辑时才会
        // 真接入。当前是 skeleton，先暴露 plugin meta 让 risk milestone 能看到 tool 真被 LLM 调到。
        skeleton: true,
      };
      return {
        structuredContent: summary,
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  };
}

export default function registerHiOpenClawPlugin(api: PluginRegisterApi): void {
  if (_registeredApis.has(api)) return;
  _registeredApis.add(api);

  const logger = api.logger ?? console;
  const config = defaultedConfig(api.pluginConfig);

  if (typeof api.registerTool !== 'function') {
    logger.warn?.(
      '[hi-openclaw-plugin] host does not expose api.registerTool; plugin loaded but no Hi tools will be visible. Upgrade OpenClaw to >=2026.5.4.',
    );
    return;
  }

  // Phase 2 milestone：Hi tools 一次性 register。第一阶段只 ship hi_agent_status，验证 OpenClaw
  // 接受我们 plugin 的 SDK contract + LLM 真能调到。后续 tool（agent_listings / matching_sessions
  // / pairings / thread_meetings / hi_agent_install / etc）按 hi-mcp-server 的现有 schema 复刻，
  // execute 内部走 createHiAgentClients(...) sdk 调用。
  api.registerTool(
    () => [buildHiAgentStatusTool(config)],
    {
      names: ['hi_agent_status'],
      optional: false,
    },
  );

  // Phase 1 milestone：receiver claim loop 改 registerService（消除独立 daemon）。
  // 第一阶段先 noop service，验证 host 接受 service contract。后续真业务：起一个 long-running loop
  // 去 hi platform 的 /v1/agent-events/claim，把 events 通过 webhook route 推回当前 LLM session。
  if (typeof api.registerService === 'function') {
    api.registerService({
      id: 'hi-agent-events',
      async start(ctx) {
        ctx.logger.info?.(
          `[hi-openclaw-plugin] agent-events service started (skeleton; claim loop will be wired in next iteration)`,
          { platform: config.platformBaseUrl, profile: config.profile },
        );
      },
      async stop(ctx) {
        ctx.logger.info?.('[hi-openclaw-plugin] agent-events service stopped');
      },
    });
  } else {
    logger.warn?.(
      '[hi-openclaw-plugin] host does not expose api.registerService; agent-events claim loop will not run. Upgrade OpenClaw to >=2026.5.4.',
    );
  }

  // webhook ingress：从 hi platform receiver service push 过来的 owner-actionable events 进 gateway。
  // 第一阶段同样是骨架——返回 200 OK 让 hi platform 知道 endpoint 存在；真正的 envelope 解析跟
  // session bridge 在下一轮 wiring 加。
  if (typeof api.registerHttpRoute === 'function') {
    api.registerHttpRoute({
      path: config.webhookPath,
      auth: 'plugin',
      match: 'exact',
      handler: async (req, res) => {
        // skeleton: 接受任何 method，立刻 200。后续要 verify HMAC signature + parse envelope +
        // bridge 进当前 LLM session via api.dispatch(...) 之类的 host method。
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, skeleton: true }));
      },
    });
  } else {
    logger.warn?.(
      '[hi-openclaw-plugin] host does not expose api.registerHttpRoute; webhook ingress disabled. Upgrade OpenClaw to >=2026.5.4.',
    );
  }

  logger.info?.(
    '[hi-openclaw-plugin] registered (skeleton): 1 tool, 1 service, 1 http route',
    { platform: config.platformBaseUrl, profile: config.profile, webhookPath: config.webhookPath },
  );
}
