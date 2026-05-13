// 在 hi_agent_install 期间，把 OpenClaw 的 hooks 配置补齐到能让 daemon POST 进 /hooks/agent
// 后真正 dispatch isolated agentTurn 的状态。等价于老 hi-platform/skills/openclaw-hi-install/
// scripts/openclaw-host-installer.mjs 中 buildManagedHooksConfig() + `openclaw config set hooks <json>`，
// 但 native plugin 跑 in-process，没法走 child_process 调 openclaw CLI（install scanner 会拦），
// 所以直接 fs read-modify-write ~/.openclaw/openclaw.json。
//
// 同步源：/Users/lawrence/Code/Hi/hi-platform/skills/openclaw-hi-install/scripts/openclaw-host-installer.mjs
//   - buildManagedHooksConfig (line 227)
//   - phase1 hooks write (line 661–690)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

const DEFAULT_HOOKS_PATH = '/hooks';
const DEFAULT_ACTIVE_AGENT_PREFIX = 'agent:active:';

export type OpenClawHooksConfigShape = {
  enabled?: boolean;
  path?: string;
  token?: string;
  allowRequestSessionKey?: boolean;
  allowedSessionKeyPrefixes?: string[];
  [key: string]: unknown;
};

export type EnsureHooksResult = {
  hooks_token: string;
  hooks_path: string;
  hooks_file: string;
  // changed = 我们这次实际写了 openclaw.json；为 false 表示 OpenClaw 已经满足要求，没动过。
  changed: boolean;
  previous_hooks: OpenClawHooksConfigShape | null;
  next_hooks: OpenClawHooksConfigShape;
};

function normalizeHooksPath(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_HOOKS_PATH;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_HOOKS_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function mergePrefixes(current: unknown, activeAgentPrefix: string): string[] {
  const set = new Set<string>();
  if (Array.isArray(current)) {
    for (const entry of current) {
      if (typeof entry === 'string' && entry.trim()) set.add(entry.trim());
    }
  }
  // hook:* — 默认 isolated hook session 路径（大多数 push 走这条）
  set.add('hook:');
  // agent:active:* — OpenClaw 老 active-agent 路由 prefix（保留兼容）
  set.add(activeAgentPrefix);
  // agent:* — 让 plugin daemon 把 install_welcome 这种"展示给用户"push 直接落到用户当前
  // 主 chat（agent:main:explicit:<uuid> / agent:main:main 等），OpenClaw hooks adapter 才不
  // 会拒掉这些 sessionKey。如果不放开这条 prefix，daemon override 的 sessionKey 会被
  // resolveHookSessionKey 当成 disallowed fallback 回 hook:<uuid>，导致 push 又跑回独立
  // session 用户看不到。
  set.add('agent:');
  return Array.from(set);
}

function buildManagedHooks(
  current: OpenClawHooksConfigShape | null,
  hooksPath: string,
  hooksToken: string,
  activeAgentPrefix: string,
): OpenClawHooksConfigShape {
  const base = (current && typeof current === 'object') ? { ...current } : {};
  return {
    ...base,
    enabled: true,
    path: normalizeHooksPath(hooksPath),
    token: hooksToken,
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: mergePrefixes(base.allowedSessionKeyPrefixes, activeAgentPrefix),
  };
}

function hooksConfigSatisfies(
  current: OpenClawHooksConfigShape | null,
  desired: OpenClawHooksConfigShape,
): boolean {
  if (!current) return false;
  if (current.enabled !== true) return false;
  if (normalizeHooksPath(current.path) !== normalizeHooksPath(desired.path)) return false;
  if (typeof current.token !== 'string' || !current.token.trim()) return false;
  if (current.allowRequestSessionKey !== true) return false;
  if (!Array.isArray(current.allowedSessionKeyPrefixes)) return false;
  const desiredPrefixes = desired.allowedSessionKeyPrefixes || [];
  for (const want of desiredPrefixes) {
    if (!current.allowedSessionKeyPrefixes.includes(want)) return false;
  }
  return true;
}

async function readOpenClawConfig(): Promise<{ root: Record<string, unknown>; hooks: OpenClawHooksConfigShape | null }> {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { root: {}, hooks: null };
    }
    const hooks = (parsed as any).hooks;
    return {
      root: parsed as Record<string, unknown>,
      hooks: hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? (hooks as OpenClawHooksConfigShape) : null,
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { root: {}, hooks: null };
    throw err;
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

// 主入口：保证 OpenClaw 的 hooks 段满足 native plugin daemon POST hooks/agent 的最小需求。
// 已经满足就 noop；不满足就 read-modify-write 一次（atomic rename）。
// 不破坏用户已有的 hooks 段下我们不管的字段（mappings、presets、transformsDir、gmail.* 等都保留）。
export async function ensureOpenClawHooksConfigured(args: {
  hooksPath?: string;
  activeAgentPrefix?: string;
  // 调用方可以提供已有 hooks_token（来自 plugin state），优先复用避免每次 install rotate token；
  // 没传就生成一个新的（仅当 OpenClaw config 里也没现成 token 时）。
  preferredToken?: string | null;
}): Promise<EnsureHooksResult> {
  const hooksPath = normalizeHooksPath(args.hooksPath || DEFAULT_HOOKS_PATH);
  const activeAgentPrefix = (args.activeAgentPrefix || DEFAULT_ACTIVE_AGENT_PREFIX).trim() || DEFAULT_ACTIVE_AGENT_PREFIX;

  const { root, hooks: currentHooks } = await readOpenClawConfig();
  const reuseToken =
    (typeof args.preferredToken === 'string' && args.preferredToken.trim()) ||
    (typeof currentHooks?.token === 'string' && currentHooks.token.trim()) ||
    crypto.randomBytes(24).toString('hex');

  const desired = buildManagedHooks(currentHooks, hooksPath, reuseToken, activeAgentPrefix);
  if (hooksConfigSatisfies(currentHooks, desired) && currentHooks?.token === reuseToken) {
    return {
      hooks_token: reuseToken,
      hooks_path: desired.path!,
      hooks_file: OPENCLAW_CONFIG_PATH,
      changed: false,
      previous_hooks: currentHooks,
      next_hooks: desired,
    };
  }
  const nextRoot = { ...root, hooks: desired };
  await atomicWriteJson(OPENCLAW_CONFIG_PATH, nextRoot);
  return {
    hooks_token: reuseToken,
    hooks_path: desired.path!,
    hooks_file: OPENCLAW_CONFIG_PATH,
    changed: true,
    previous_hooks: currentHooks,
    next_hooks: desired,
  };
}

// 保证 OpenClaw 当前 tools.profile (coding/messaging 默认) 下 plugin tools 仍可被 LLM 看见。
// OpenClaw 的 tool profile 是显式 allowlist —— coding profile 默认只允许 core 工具，plugin
// 工具被 filter 掉。要打开必须在 tools.alsoAllow 里加 "group:plugins" (canonical 通用钩子)。
//
// 由 plugin install tool 程序化处理这件事，绝不让 LLM 自己改 tools.allow（LLM 容易把
// alsoAllow 写成 allow，allow 是 explicit override 模式，会把 read/exec/sessions_* 等内置
// 全 filter 掉，导致 LLM 下一轮没工具可用 → embedded fallback 报错 "No callable tools remain"）。
export async function ensurePluginToolsAlsoAllowed(): Promise<{
  changed: boolean;
  also_allow_before: string[];
  also_allow_after: string[];
}> {
  const { root } = await readOpenClawConfig();
  const tools = ((root as any).tools && typeof (root as any).tools === 'object' && !Array.isArray((root as any).tools))
    ? { ...((root as any).tools as Record<string, unknown>) }
    : {};
  const currentAlsoAllow = Array.isArray((tools as any).alsoAllow)
    ? ((tools as any).alsoAllow as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  const wantToken = 'group:plugins';
  if (currentAlsoAllow.includes(wantToken) || currentAlsoAllow.includes('*')) {
    return { changed: false, also_allow_before: currentAlsoAllow, also_allow_after: currentAlsoAllow };
  }
  const nextAlsoAllow = [...currentAlsoAllow, wantToken];
  (tools as any).alsoAllow = nextAlsoAllow;
  const nextRoot = { ...root, tools };
  await atomicWriteJson(OPENCLAW_CONFIG_PATH, nextRoot);
  return { changed: true, also_allow_before: currentAlsoAllow, also_allow_after: nextAlsoAllow };
}

// 工具函数：从 OpenClaw config root 读 gateway 监听端口（支持 user 自定义；默认 18789）。
export function resolveGatewayPort(root: Record<string, unknown>): number {
  const gw = (root as any)?.gateway;
  const port = Number(gw?.port);
  if (Number.isFinite(port) && port > 0 && port < 65536) return port;
  return 18789;
}

export async function readGatewayPort(): Promise<number> {
  const { root } = await readOpenClawConfig();
  return resolveGatewayPort(root);
}

// 找用户在 OpenClaw 上最近活跃的非 hook session_key。
// hook:* / bootstrap:* 是 OpenClaw 给 isolated agentTurn 自动开的旁路 session，用户在主
// chat 看不到，必须 skip。返回 null 代表找不到任何用户可见 session（首次安装 / 文件缺失）。
// OpenClaw 默认 agent id 是 main；多 agent 户可扩 plugin config，此处暂写死。
import fsSync from 'node:fs';
export function findRecentUserSessionKey(): string | null {
  const sessionsFile = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
  try {
    const raw = fsSync.readFileSync(sessionsFile, 'utf8');
    const parsed = JSON.parse(raw) as { sessions?: Array<{ key?: string; updatedAt?: number }> };
    const sessions = parsed.sessions || [];
    const filtered = sessions.filter((s) => {
      const k = String(s.key || '');
      return k.length > 0 && !k.includes(':hook:') && !k.includes(':bootstrap:');
    });
    filtered.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return filtered[0]?.key || null;
  } catch {
    return null;
  }
}
