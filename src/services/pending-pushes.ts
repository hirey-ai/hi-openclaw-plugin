// Persistent queue of Hi push events waiting to be injected into the user's next
// LLM turn via the before_prompt_build hook. Stored per-sessionKey on disk so it
// survives gateway restarts (unlike enqueueSystemEvent which is in-memory).
//
// Why this exists：OpenClaw 的 /hooks/agent 强制 isolated cron turn 把 push 落进
// hook:<uuid> 隔离 session，用户在主 channel session 回复时 LLM 看不到 push（参见
// /tmp/hi-push-fix-spike/RESULTS.md 实测）。我们的修复路径是双轨：
//   1. 现有 /hooks/agent 投递保留——LLM 在隔离 turn 里跑出来的 channel-send 让
//      用户在 Telegram/iMessage 看到 push（UX 保留）。
//   2. 同时把 push 内容写到本文件 keyed by 用户真实 sessionKey；用户回复时
//      before_prompt_build hook 读 + 注入 system prompt（LLM context 真正看到 push）。
//
// 设计要点：
//   - keyed by sha256(sessionKey)：避免文件名中含路径不安全字符 (':')，并且 hash
//     长度固定方便 GC。
//   - JSONL 一行一 entry：append-friendly + 单条 entry 解析失败不影响其他条。
//   - delivered_at 字段：hook 投递后填时戳，下次同 sessionKey hook fire 时不重复注入；
//     GC 定期清掉 delivered>24h 的条目。
//   - MAX_TOTAL_ENTRIES 50 保险盖：极端情况下平台疯狂推 push，避免文件无限增长。
//   - dedupe by event_id：daemon 重试同一 event 时不重复入队。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type PendingPushEntry = {
  event_id: string;
  topic?: string;
  queued_at: number;
  rendered_text: string;
  delivered_at?: number | null;
};

const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOTAL_ENTRIES = 50;

export function pendingPushesDirFor(stateDir: string): string {
  return path.join(stateDir, 'pending-pushes');
}

function sessionKeyToFilename(sessionKey: string): string {
  const hash = crypto.createHash('sha256').update(sessionKey).digest('hex');
  return `${hash}.jsonl`;
}

export function pendingPushesFileFor(stateDir: string, sessionKey: string): string {
  return path.join(pendingPushesDirFor(stateDir), sessionKeyToFilename(sessionKey));
}

function readAllEntries(filePath: string): PendingPushEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const entries: PendingPushEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as PendingPushEntry;
      if (obj && typeof obj.event_id === 'string' && obj.event_id.length > 0) {
        entries.push(obj);
      }
    } catch {
      // skip malformed lines；其他正常 entry 不受影响
    }
  }
  return entries;
}

function writeAllEntries(filePath: string, entries: PendingPushEntry[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, filePath);
}

export function appendPendingPush(args: {
  stateDir: string;
  sessionKey: string;
  entry: PendingPushEntry;
}): { wrote: boolean; reason?: string } {
  const file = pendingPushesFileFor(args.stateDir, args.sessionKey);
  const entries = readAllEntries(file);
  if (entries.some((e) => e.event_id === args.entry.event_id)) {
    return { wrote: false, reason: 'duplicate_event_id' };
  }
  entries.push(args.entry);
  while (entries.length > MAX_TOTAL_ENTRIES) entries.shift();
  writeAllEntries(file, entries);
  return { wrote: true };
}

export function readUndeliveredPendingPushes(args: {
  stateDir: string;
  sessionKey: string;
}): PendingPushEntry[] {
  const file = pendingPushesFileFor(args.stateDir, args.sessionKey);
  return readAllEntries(file).filter((e) => !e.delivered_at);
}

export function markDelivered(args: {
  stateDir: string;
  sessionKey: string;
  event_ids: readonly string[];
}): void {
  const file = pendingPushesFileFor(args.stateDir, args.sessionKey);
  const entries = readAllEntries(file);
  if (entries.length === 0) return;
  const idSet = new Set(args.event_ids);
  const now = Date.now();
  const updated = entries.map((e) =>
    idSet.has(e.event_id) ? { ...e, delivered_at: now } : e,
  );
  const kept = pruneExpiredDelivered(updated, now);
  if (kept.length === 0) {
    try { fs.unlinkSync(file); } catch { /* best-effort */ }
    return;
  }
  writeAllEntries(file, kept);
}

function pruneExpiredDelivered(entries: readonly PendingPushEntry[], nowMs: number): PendingPushEntry[] {
  return entries.filter((e) => {
    if (!e.delivered_at) return true;
    return (nowMs - e.delivered_at) < DELIVERED_TTL_MS;
  });
}

// 给定 stateDir 把所有 pending-pushes 文件扫一遍，drop expired delivered；空文件删掉。
// 在 daemon 启动或周期性维护时调用即可，不必每次投递。
export function gcPendingPushes(args: { stateDir: string }): { scanned: number; pruned: number; removed: number } {
  const dir = pendingPushesDirFor(args.stateDir);
  if (!fs.existsSync(dir)) return { scanned: 0, pruned: 0, removed: 0 };
  let scanned = 0;
  let pruned = 0;
  let removed = 0;
  const now = Date.now();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(dir, f);
    scanned++;
    const entries = readAllEntries(fp);
    const kept = pruneExpiredDelivered(entries, now);
    if (kept.length === 0) {
      try { fs.unlinkSync(fp); removed++; } catch { /* best-effort */ }
    } else if (kept.length !== entries.length) {
      writeAllEntries(fp, kept);
      pruned += entries.length - kept.length;
    }
  }
  return { scanned, pruned, removed };
}
