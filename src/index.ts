// hi-openclaw-plugin entry: register Hirey AI 的 control tools + 14 platform capabilities +
// agent-events claim service + webhook ingress route 进 OpenClaw gateway 进程。
//
// 设计原则：
// 1. Idempotent：plugin loader 可能用不同 api 实例多次调本入口（懒加载、CLI 热加载、gateway
//    hot-apply）。WeakSet<api> 守 register 不要重复。
// 2. 缺能力 fail-soft：老 host 可能没 registerService 或 registerHttpRoute；feature-detect 后
//    skip + warn，不要 throw 让 host 起不来。
// 3. 真业务全部委托给 @hirey/hi-agent-sdk + 平台 /v1/capabilities/<id>/call，本文件只做 wiring。
// 4. capability tool schema 不在 plugin 内部 hardcode：从 prod /v1/capabilities 拉 PublicAgentCapability
//    列表，原样把 capability.parameters 当 OpenClaw tool parameters 用。一处对齐 prod，14 个 tool
//    全部受益，未来平台加新 capability 也不用改 plugin。
//    这一段是 async fetch；OpenClaw 的 register(api) 类型是 sync，但运行时支持 async / await：
//    plugin loader 在 dynamic import 后会 `await register(api)`（实测兼容 Promise<void>）。这里
//    显式 await，防止"factory 已被注册但 schema 还没拉到" 的窗口让 LLM 看到空 schema 又调出
//    "unsupported action"。

import type {
  PluginRegisterApi,
  PluginToolDefinition,
  HiOpenClawPluginConfig,
} from './types.js';
import { buildAllControlTools } from './tools/control.js';
import { buildAllCapabilityTools, fetchPublicCapabilities } from './tools/capabilities.js';
import { buildAgentEventsService } from './services/agent-events.js';
import { buildWebhookRoute } from './routes/webhook.js';
import { ensurePluginToolsAlsoAllowed } from './utils/openclaw-config.js';

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

export default async function registerHiOpenClawPlugin(api: PluginRegisterApi): Promise<void> {
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
    // 控制工具不依赖 platform，先注册掉；capability 工具要等 schema 拉到才能注册，避免
    // 先用空 schema 注册再被 OpenClaw / OpenAI strict mode 静默剥掉所有 properties，
    // 调用方传 action 等字段被丢，落到平台时变成空 args 报 "unsupported action"。
    for (const tool of controlTools) {
      api.registerTool(() => tool, { names: [tool.name] });
    }
    try {
      const capabilitySpecs = await fetchPublicCapabilities(config.platformBaseUrl);
      const capabilityTools = buildAllCapabilityTools(config, capabilitySpecs);
      for (const tool of capabilityTools) {
        api.registerTool(() => tool, { names: [tool.name] });
      }
      const allTools: PluginToolDefinition[] = [...controlTools, ...capabilityTools];
      logger.info?.('[hi-openclaw-plugin] registered tools', {
        count: allTools.length,
        control_tools: controlTools.map(t => t.name),
        capability_tools: capabilityTools.map(t => t.name),
        capability_schema_source: `${config.platformBaseUrl}/v1/capabilities`,
      });
    } catch (err: any) {
      // platform 不可达 / contract 异常 —— capability tool 无法拿到 schema，不能用 hardcoded
      // 兜底（schema 不一致比工具缺席更危险，会让 LLM 在 owner 面前幻觉调用形态）。这里只
      // 注册控制工具，业务工具留空，让 owner 通过 hi_agent_doctor / hi_agent_status 看到为什么。
      logger.error?.(
        '[hi-openclaw-plugin] failed to fetch platform capability schemas; capability tools will NOT be registered. Resolve network/platform reachability and reload the plugin.',
        { platform_base_url: config.platformBaseUrl, error: String(err?.message || err) },
      );
    }
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

  // ---- profile self-heal ----
  // OpenClaw 的 tools.profile=coding 默认不让 plugin tools 出现在 LLM 的 toolbox。要让用户
  // 装完 plugin 立刻可用，第一次 register 时主动检查 + patch tools.alsoAllow 加 group:plugins。
  // 这件事不能等 LLM 调 hi_agent_install 时才做：那时 LLM 早已没看见 hi_agent_install。
  // 也不能依赖 LLM 自己读懂 OpenClaw 配置语义后改：之前实测 LLM 把 alsoAllow 写成 allow，
  // explicit allow override 把 read/exec/sessions_* 等内置工具全 filter 掉，整个 LLM run 没工具用。
  // 因此 plugin 自己幂等 patch，atomic write，patch 完不立刻 restart gateway —— config hot-reload
  // watcher 会自然 pick up，下一个 LLM session 起来 tool inventory 就 contains hi_*。
  void ensurePluginToolsAlsoAllowed()
    .then((res) => {
      if (res.changed) {
        logger.info?.('[hi-openclaw-plugin] auto-patched tools.alsoAllow=group:plugins so plugin tools become visible to LLM in coding profile', {
          before: res.also_allow_before, after: res.also_allow_after,
        });
      }
    })
    .catch((err: any) => {
      logger.warn?.('[hi-openclaw-plugin] tools.alsoAllow auto-patch failed (LLM may need to do it manually)', {
        error: String(err?.message || err),
      });
    });

  logger.info?.(
    '[hi-openclaw-plugin] register complete',
    { platform: config.platformBaseUrl, profile: config.profile, webhook: config.webhookPath },
  );
}
