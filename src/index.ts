// hi-openclaw-plugin entry: register Hirey AI 的 control tools + 14 platform capabilities +
// agent-events claim service + webhook ingress route 进 OpenClaw gateway 进程。
//
// 设计原则：
// 1. Idempotent：plugin loader 可能用不同 api 实例多次调本入口（懒加载、CLI 热加载、gateway
//    hot-apply）。WeakSet<api> 守 register 不要重复。
// 2. 缺能力 fail-soft：老 host 可能没 registerService 或 registerHttpRoute；feature-detect 后
//    skip + warn，不要 throw 让 host 起不来。
// 3. 真业务全部委托给 @hirey/hi-agent-sdk + 平台 /v1/capabilities/<id>/call，本文件只做 wiring。
// 4. **register 必须是同步函数**。OpenClaw v2026.4.23 起 plugin loader 用 runPluginRegisterSync
//    调本入口（PR openclaw/openclaw#67941，CHANGELOG.md:707 "enforce synchronous plugin
//    registration"），看到 register 返回 Promise 直接 throw "plugin register must be
//    synchronous" 然后 plugin 整体 register 失败、所有 tool 注册不上。1.0.16 ~ 1.0.19 这段
//    把 register 错误地改成 async function 跑 await fetchPublicCapabilities(...)，导致所有
//    OpenClaw 4.23+ 用户装完插件 plugin doctor 报错、hi_* tool 全部不可用。1.0.20 起回到
//    sync register。
// 5. capability tool schema 来自 build-time snapshot：scripts/snapshot-capabilities.mjs 在
//    npm prepack 时一次性 fetch prod /v1/capabilities 写到 dist/capabilities.snapshot.json，
//    register 时同步 readFileSync 加载。register 阶段没有任何外部网络/磁盘 await，符合
//    OpenClaw sync register 约束。详见 src/tools/capabilities.ts 文件头注释。

import type {
  PluginRegisterApi,
  HiOpenClawPluginConfig,
} from './types.js';
import { buildAllControlTools } from './tools/control.js';
import { buildCapabilityToolFactory, loadCapabilitySnapshot } from './tools/capabilities.js';
import { buildAgentEventsService } from './services/agent-events.js';
import { createBeforePromptBuildHook } from './services/prompt-injection-hook.js';
import { gcPendingPushes } from './services/pending-pushes.js';
import { setPushInjectionActive } from './services/push-injection-state.js';
import { reconcileInstallationOnBoot } from './services/installation-reconcile.js';
import { resolveStateDir } from './state.js';
import { buildWebhookRoute } from './routes/webhook.js';
import { ensurePluginToolsAlsoAllowed } from './utils/openclaw-config.js';

const _registeredApis = new WeakSet<PluginRegisterApi>();

function defaultedConfig(raw: HiOpenClawPluginConfig | undefined): Required<HiOpenClawPluginConfig> {
  return {
    // 默认 prod URL；改这里时 scripts/snapshot-capabilities.mjs 的 PLATFORM_BASE_URL 也要同步改。
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
  //
  // OpenClaw 5.2+ (PR #76079) 在 register 阶段会把 api.registerTool(...) 拿到的 tool descriptor
  // cache 到 prompt-time planning 路径，运行时再 mutate descriptor 也不会被 LLM 看见——所以
  // 必须在 register 这一刻就把所有 tool 用最终完整的 schema 一次性注册掉。
  if (typeof api.registerTool !== 'function') {
    logger.warn?.(
      '[hi-openclaw-plugin] host does not expose api.registerTool; tools will not be visible. Upgrade OpenClaw to >=2026.4.23.',
    );
  } else {
    const controlTools = buildAllControlTools(config);
    // capability schema 从 dist/capabilities.snapshot.json 同步 load。snapshot 缺失/坏掉/为空
    // 会 throw（loadCapabilitySnapshot 内部 fail-close），冒到 plugin loader 让 register 失败、
    // host doctor 直接 surface — 而不是 silently 注册一组 hi_* tool 但少一半 capability。
    // 不在这层 try/catch 把异常吞掉：snapshot 异常意味着 plugin tarball 自身坏了（snapshot
    // build 时已经验过形态），偷偷续命比报错更危险。
    const capabilitySpecs = loadCapabilitySnapshot();
    for (const tool of controlTools) {
      api.registerTool(() => tool, { names: [tool.name] });
    }
    // capability tool 注册策略：把 spec 包成 per-session factory，每次 OpenClaw materialize
    // tool 时调一次 buildCapabilityTool(spec, config, ctx) —— execute 闭包 capture 当前 LLM
    // session 的 sessionKey + deliveryContext，capability 调用时注入 _ctx.host_session_key
    // 让 Hi 平台 workflow route binding 抓住事件源会话。
    //
    // 跟 1.0.x 早期"register 时一次性 build 全量 tool"的差别：descriptor (name/desc/parameters)
    // 完全等价（spec 来自 build-time snapshot），只是 execute 闭包从 module-level 单例改成
    // per-session 实例。OpenClaw 5.2+ descriptor cache (PR #76079) 看的是 descriptor 字段，
    // 它们没变；execute 是 host materialize 时拿到的 tool object 上的方法，自然带 per-session
    // 的 ctx。无 schema 漂移风险。
    for (const spec of capabilitySpecs) {
      api.registerTool(buildCapabilityToolFactory(spec, config), { names: [spec.tool_name] });
    }
    logger.info?.('[hi-openclaw-plugin] registered tools', {
      count: controlTools.length + capabilitySpecs.length,
      control_tools: controlTools.map(t => t.name),
      capability_tools: capabilitySpecs.map(s => s.tool_name),
      capability_schema_source: 'build-time snapshot (dist/capabilities.snapshot.json)',
      host_session_capture: 'enabled (per-session factory injects _ctx.host_session_key)',
    });
  }

  // ---- before_prompt_build hook (push context injection) ----
  // OpenClaw 的 /hooks/agent 在 isolated cron turn 跑 LLM，那一段 push 内容永远进不了
  // 用户真实 channel session 的 LLM context（实测 /tmp/hi-push-fix-spike/RESULTS.md）。
  // 我们在用户回复的 LLM turn 之前用 before_prompt_build hook 注入 pending push——
  // 这是 OpenClaw 公开 plugin SDK API，trigger==='user' 时 fire（在 192.168.3.27 5.6
  // 上 verified）。daemon 自己的 /hooks/agent isolated turn 走 trigger='cron'，hook
  // handler 跳过。
  //
  // env HI_PUSH_INJECTION=off 一键禁用 hook 注册，回到 daemon 单独通过 /hooks/agent 投
  // 递的老行为（pending push 仍然会写文件但永远不会被 LLM 读到，相当于 no-op）。
  const injectionDisabled = (process.env.HI_PUSH_INJECTION || '').trim().toLowerCase() === 'off';
  if (injectionDisabled) {
    logger.info?.('[hi-openclaw-plugin] push context injection DISABLED by HI_PUSH_INJECTION=off');
  } else if (typeof api.on === 'function') {
    try {
      const hookHandler = createBeforePromptBuildHook({ config, logger });
      api.on('before_prompt_build', hookHandler);
      setPushInjectionActive(true);
      logger.info?.('[hi-openclaw-plugin] registered before_prompt_build hook for push context injection');
    } catch (err: any) {
      logger.warn?.('[hi-openclaw-plugin] before_prompt_build hook registration failed; falling back to legacy /hooks/agent delivery', {
        error: String(err?.message || err),
      });
    }
  } else {
    logger.warn?.(
      '[hi-openclaw-plugin] host does not expose api.on; push context injection disabled (legacy /hooks/agent delivery). Upgrade OpenClaw to >=2026.4.21 to enable injection.',
    );
  }

  // 启动时 sweep 一次 pending-pushes 目录清掉已 delivered 24h+ 的 entry。同步 io，
  // 在 register 这个进程上下文里跑一次足够（不持续后台 GC，文件量很小）。
  try {
    const stateDir = config.stateDir || resolveStateDir(config.profile);
    const gcResult = gcPendingPushes({ stateDir });
    if (gcResult.scanned > 0) {
      logger.info?.('[hi-openclaw-plugin] pending-pushes startup gc', gcResult);
    }
  } catch (err: any) {
    logger.warn?.('[hi-openclaw-plugin] pending-pushes startup gc failed', { error: String(err?.message || err) });
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

  // 启动时跑一次 reconcile：state.identity 已存在但 plugin_version_synced 跟当前 PLUGIN_VERSION
  // 不一致时（比如老用户从 1.0.33 升到 1.0.37），主动把新版本 metadata + 当前 delivery_capabilities
  // 推一次给平台。fire-and-forget，所有错误 fail-soft。详见 installation-reconcile.ts 文件头。
  void reconcileInstallationOnBoot(config, logger).catch((err: any) => {
    logger.warn?.('[hi-openclaw-plugin] installation reconcile threw unexpectedly (should be fail-soft inside)', {
      error: String(err?.message || err),
    });
  });

  logger.info?.(
    '[hi-openclaw-plugin] register complete',
    { platform: config.platformBaseUrl, profile: config.profile, webhook: config.webhookPath },
  );
}
