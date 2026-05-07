// hi-openclaw-plugin entry: register Hirey AI 的 control tools + 14 platform capabilities +
// agent-events claim service + webhook ingress route 进 OpenClaw gateway 进程。
//
// 设计原则：
// 1. Idempotent：plugin loader 可能用不同 api 实例多次调本入口（懒加载、CLI 热加载、gateway
//    hot-apply）。WeakSet<api> 守 register 不要重复。
// 2. 缺能力 fail-soft：老 host 可能没 registerService 或 registerHttpRoute；feature-detect 后
//    skip + warn，不要 throw 让 host 起不来。
// 3. 真业务全部委托给 @hirey/hi-agent-sdk + 平台 /v1/capabilities/<id>/call，本文件只做 wiring。

import type {
  PluginRegisterApi,
  PluginToolDefinition,
  HiOpenClawPluginConfig,
} from './types.js';
import { buildAllControlTools } from './tools/control.js';
import { buildAllCapabilityTools } from './tools/capabilities.js';
import { buildAgentEventsService } from './services/agent-events.js';
import { buildWebhookRoute } from './routes/webhook.js';

const _registeredApis = new WeakSet<PluginRegisterApi>();

function defaultedConfig(raw: HiOpenClawPluginConfig | undefined): Required<HiOpenClawPluginConfig> {
  return {
    platformBaseUrl: raw?.platformBaseUrl?.trim() || 'https://hi.hirey.ai',
    profile: raw?.profile?.trim() || 'openclaw-main',
    stateDir: raw?.stateDir?.trim() || '',
    webhookPath: raw?.webhookPath?.trim() || '/hi/webhook',
    claimPollIntervalMs: Math.max(250, Number(raw?.claimPollIntervalMs ?? 1500)),
    claimLeaseMs: Math.max(1000, Number(raw?.claimLeaseMs ?? 60000)),
  };
}

export default function registerHiOpenClawPlugin(api: PluginRegisterApi): void {
  if (_registeredApis.has(api)) return;
  _registeredApis.add(api);

  const logger = api.logger ?? console;
  const config = defaultedConfig(api.pluginConfig);

  // ---- tools ----
  // OpenClaw SDK 的 registerTool 签名是：
  //   api.registerTool(factory: (ctx) => Tool | null, options: { names: [singleName] })
  // 每次调一个 tool。factory 在每个 LLM session 启动时被调一次，返回该 session 可见的 tool 实例
  // （可以根据 ctx.agentId / ctx.sessionKey 决定是否暴露）。这里我们让每个 hi tool 总是 visible（无 gating）。
  if (typeof api.registerTool !== 'function') {
    logger.warn?.(
      '[hi-openclaw-plugin] host does not expose api.registerTool; tools will not be visible. Upgrade OpenClaw to >=2026.4.23.',
    );
  } else {
    const controlTools = buildAllControlTools(config);
    const capabilityTools = buildAllCapabilityTools(config);
    const allTools: PluginToolDefinition[] = [...controlTools, ...capabilityTools];
    for (const tool of allTools) {
      api.registerTool(
        () => tool,
        { names: [tool.name] },
      );
    }
    logger.info?.('[hi-openclaw-plugin] registered tools', { count: allTools.length, names: allTools.map(t => t.name) });
  }

  // ---- service / route ----
  // 1.0.9 起恢复 daemon claim/SSE 模式，但走 push 推送架构（拉到 event 后 POST hooks/agent
  // loopback，OpenClaw 自动按 channel/to 把 LLM 输出推到用户 iMessage/Telegram 等已配置的
  // channel）。
  //
  // 修 OOM 的关键不在去循环（业务上 push 必须长跑，pull 模型是错的），而在：
  //   - 主路径换成 SSE pull_stream 长连接（1 个 conn hold 60+ 秒，重连周期分钟级），不再
  //     每 1.5s 新建 fetch agent
  //   - 启动 + 重连前先 claim drain backlog 兜底
  //   - 不缓存 client（每次重连重建，跟官方 hi-agent-receiver runStreamLoop 等价）
  //   - hooks/agent 投递的 fetch 是 fire-and-forget，不长占 socket
  if (typeof api.registerService === 'function') {
    api.registerService(buildAgentEventsService(config));
  } else {
    logger.warn?.(
      '[hi-openclaw-plugin] host does not expose api.registerService; agent-events daemon will not run, push delivery disabled. Upgrade OpenClaw to >=2026.4.23.',
    );
  }
  if (typeof api.registerHttpRoute === 'function') {
    api.registerHttpRoute(buildWebhookRoute(config, logger));
  }

  logger.info?.(
    '[hi-openclaw-plugin] registered v1.0.0',
    { platform: config.platformBaseUrl, profile: config.profile, webhook: config.webhookPath },
  );
}
