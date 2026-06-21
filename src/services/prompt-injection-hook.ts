// before_prompt_build hook handler：每次 OpenClaw 准备 LLM turn 时，OpenClaw 调这个
// hook 让插件 append 内容到 system prompt 末尾。我们用它把 Hi 平台 push 过来还没被
// LLM 读到的 event 注入 LLM context。
//
// 触发模型（在 192.168.3.27 OpenClaw 2026.5.6 实测确认）：
//   - ctx.trigger === 'user' 时 fire：用户驱动的 turn（TUI、channel inbound、
//     gateway call agent）。我们要 inject 的就是这种。
//   - ctx.trigger === 'cron' 时也 fire：daemon 自己 POST /hooks/agent 触发的隔离
//     cron turn。注入会污染 daemon 自己的 push-rendering turn，必须 SKIP。
//   - ctx.sessionKey 可信：OpenClaw 自己填的，不来自 LLM args。
//
// 失败模式都是 graceful：读 pending-pushes 文件失败 → return void 不 inject，OpenClaw
// 跑 LLM turn 不带 push context（degrades to current behavior）。永远不抛错给 OpenClaw。

import { readUndeliveredPendingPushes, markDelivered, type PendingPushEntry } from './pending-pushes.js';
import { resolveStateDir } from '../state.js';
import type { HiOpenClawPluginConfig, PluginLogger } from '../types.js';

// 单次注入最多带多少条 pending push。超过的部分仍留在文件里、下次 fire 时再带。
// 50 是 pending-pushes 文件的 hard cap；这里 10 是单次 prompt 增量的合理上限——
// 一次 prompt 加 10 条 push 文本（每条预期 < 2KB）也就 ~20KB system context，prompt
// caching 覆盖之后边际成本可忽略。
const MAX_INJECTED_PER_TURN = 10;

function shouldInjectForTurn(ctx: unknown): { ok: true; sessionKey: string } | { ok: false; reason: string } {
  if (!ctx || typeof ctx !== 'object') return { ok: false, reason: 'no_ctx' };
  const c = ctx as Record<string, unknown>;
  if (c.trigger !== 'user') {
    // skip cron (daemon 自己的 push turn) / heartbeat / memory / etc.
    return { ok: false, reason: `trigger=${String(c.trigger ?? 'undefined')}` };
  }
  const sk = typeof c.sessionKey === 'string' ? c.sessionKey.trim() : '';
  if (!sk) return { ok: false, reason: 'no_session_key' };
  // hook:* / bootstrap:* 是 OpenClaw 自动开的旁路 session，没有 user transcript。
  // cron:* 是 cron 任务自己的 session prefix，也不是用户 chat。
  if (sk.startsWith('hook:') || sk.startsWith('bootstrap:') || sk.startsWith('cron:')) {
    return { ok: false, reason: `skipped_prefix:${sk.split(':')[0]}` };
  }
  // agent:main:hook:<uuid> / agent:main:bootstrap:<uuid> 也要 skip（hook 字符串在
  // 第三段）。startsWith 检不到 agent:main: 之后的 hook，用 includes 兜一道。
  if (sk.includes(':hook:') || sk.includes(':bootstrap:')) {
    return { ok: false, reason: 'skipped_nested_throwaway' };
  }
  return { ok: true, sessionKey: sk };
}

function renderPendingPushesAsSystemContext(entries: readonly PendingPushEntry[]): string {
  const lines: string[] = [];
  lines.push('<hi_pending_pushes>');
  lines.push('The Hi platform delivered the following INBOUND event(s) to this user since the last LLM turn.');
  lines.push('Each entry is something a COUNTERPARTY (another party\'s agent) or the Hi platform sent — it is NOT your own prior message. Do not mistake these for things you already said or wrote; read them as inbound context you are receiving.');
  lines.push('The user may be responding to one of these now. Treat them as inbound conversational context.');
  lines.push('Newest events appear LAST.');
  lines.push('');
  for (const [i, entry] of entries.entries()) {
    const dt = new Date(entry.queued_at).toISOString();
    const topicSuffix = entry.topic ? ` topic=${entry.topic}` : '';
    lines.push(`[${i + 1}] ${dt}${topicSuffix} event_id=${entry.event_id}`);
    lines.push(entry.rendered_text);
    lines.push('');
  }
  lines.push('</hi_pending_pushes>');
  return lines.join('\n');
}

export type BeforePromptBuildHookResult = { appendSystemContext?: string } | void;

export function createBeforePromptBuildHook(args: {
  config: Required<HiOpenClawPluginConfig>;
  logger?: PluginLogger;
}) {
  const stateDir = args.config.stateDir || resolveStateDir(args.config.profile);
  const log = args.logger;
  return async function beforePromptBuildHook(
    _event: unknown,
    ctx: unknown,
  ): Promise<BeforePromptBuildHookResult> {
    try {
      const decision = shouldInjectForTurn(ctx);
      if (!decision.ok) return;

      const undelivered = readUndeliveredPendingPushes({
        stateDir,
        sessionKey: decision.sessionKey,
      });
      if (undelivered.length === 0) return;

      // 单次最多注入 N 条；多余的保留到下次 fire。按时间顺序留最早的 N 条（FIFO），
      // 避免最新事件把最早事件挤出来用户看不到。
      const toInject = undelivered.slice(0, MAX_INJECTED_PER_TURN);
      const appendSystemContext = renderPendingPushesAsSystemContext(toInject);

      // 标记 delivered；失败不阻塞投递（最坏下一轮再注入一次，幂等可接受）。
      try {
        markDelivered({
          stateDir,
          sessionKey: decision.sessionKey,
          event_ids: toInject.map((e) => e.event_id),
        });
      } catch (err: any) {
        log?.warn?.('[hi-openclaw-plugin] pending-pushes markDelivered failed (will re-inject next turn)', {
          error: String(err?.message || err),
          session_key: decision.sessionKey,
        });
      }

      log?.info?.('[hi-openclaw-plugin] injected pending pushes into LLM system prompt', {
        session_key: decision.sessionKey,
        injected_count: toInject.length,
        remaining: undelivered.length - toInject.length,
      });
      return { appendSystemContext };
    } catch (err: any) {
      // 任何意外都 swallow。OpenClaw 的 hook 错误处理我们不依赖；让 LLM turn 继续跑。
      log?.warn?.('[hi-openclaw-plugin] before_prompt_build hook threw, skipping injection', {
        error: String(err?.message || err),
      });
      return;
    }
  };
}
