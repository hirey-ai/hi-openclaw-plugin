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
  set.add('hook:');
  set.add(activeAgentPrefix);
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
