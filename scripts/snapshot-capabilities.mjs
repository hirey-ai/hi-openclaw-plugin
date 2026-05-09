#!/usr/bin/env node
// scripts/snapshot-capabilities.mjs
//
// 在 npm publish / npm pack / clawhub publish 之前，从 prod hi 平台一次性把 14 个（未来 N 个）
// PublicAgentCapability 的完整 input schema 拉下来，写到 dist/capabilities.snapshot.json，
// 跟随 dist/ 一起被打包进 plugin tarball。OpenClaw 端 plugin register(api) 必须是同步的
// （v2026.4.23+ runPluginRegisterSync 看到 Promise 直接 throw "plugin register must be
// synchronous"，详见 openclaw/openclaw#67900 / PR #67941 / CHANGELOG.md:707），所以
// register 阶段不能再做 async fetch。把 fetch 提前到 build-time，register 时同步从 disk
// load snapshot。
//
// 1.0.16 ~ 1.0.19 这段 commit 里我们走的是 register-time runtime fetch（违反 sync 约束），
// OpenClaw 5.2+ 的 host loader hard reject，所有 hi_* tool 都没注册成 → 用户装完插件
// 完全没工具可用。1.0.20 起回到 sync register + build-time snapshot。
//
// fail-close 设计：
// - fetch 失败 / 非 200 → process.exit(1) → npm publish 失败，不 ship 坏的 tarball
// - 响应 shape 不对（没有 capabilities 数组 / 数组为空） → process.exit(1)
// - 任何一项缺 capability_id / tool_name / parameters → process.exit(1)
// 这跟"不要兜底"、"清技术债不要保留隐藏兼容" 一致：snapshot 拉不到，整个发布就该失败，
// 不允许偷偷塞 hardcoded fallback schema 又让线上用户去发现 schema 漂移。

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const SNAPSHOT_PATH = path.join(DIST_DIR, 'capabilities.snapshot.json');

// 跟 src/index.ts defaultedConfig 里 platformBaseUrl 的默认值保持一致（'https://hi.hirey.ai'）。
// 两处都是 hardcoded prod URL（runtime 跟 build 各一份），改 prod 域名时这两处必须同步改。
// hardcoded 的好处：snapshot 永远从 prod 拉，跟最终大多数用户实际连接的平台对齐；early
// staging 内测用户即使把自己的 plugin config 切到 staging URL 跑，capability schema 也以
// prod 为准 —— 这是符合 hi 发布节奏的（staging 提前几小时上 capability，prod 紧跟着上线）。
const PLATFORM_BASE_URL = 'https://hi.hirey.ai';
const ENDPOINT = `${PLATFORM_BASE_URL}/v1/capabilities`;

async function main() {
  console.log(`[snapshot-capabilities] fetching ${ENDPOINT}`);
  const resp = await fetch(ENDPOINT, {
    headers: { accept: 'application/json' },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 400)}`);
  }
  const payload = await resp.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`response not a plain object: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  const items = payload.capabilities;
  if (!Array.isArray(items)) {
    throw new Error(`response.capabilities not an array: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  if (items.length === 0) {
    // 平台返回空数组通常意味着这次 fetch 命中了部署窗口（capabilities 表正在 migrate）或
    // 鉴权出错把 list 过滤光了。无论哪种都不能 ship —— 当前 1.0.x 系列 plugin 主要价值
    // 就是把 14 个 capability 暴露给 LLM，14 → 0 是退步而不是进步。
    throw new Error(`platform returned 0 capabilities — refusing to ship empty snapshot`);
  }
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`capability item not a plain object: ${JSON.stringify(item).slice(0, 200)}`);
    }
    if (typeof item.capability_id !== 'string' || !item.capability_id.trim()) {
      throw new Error(`capability missing capability_id: ${JSON.stringify(item).slice(0, 200)}`);
    }
    if (typeof item.tool_name !== 'string' || !item.tool_name.trim()) {
      throw new Error(`capability ${item.capability_id} missing tool_name`);
    }
    if (!item.parameters || typeof item.parameters !== 'object' || Array.isArray(item.parameters)) {
      // parameters 必须是 plain object（OpenAI/OpenClaw strict mode 的 JSON Schema 形态）。
      // 缺这个字段 plugin 那边 registerTool 会拿不到 schema → 跟 1.0.15 的 422 同病。
      throw new Error(`capability ${item.capability_id} missing parameters object`);
    }
  }

  // 注意 SNAPSHOT_PATH 是写到 dist/ 下面，跟 tsc 输出同目录。prepack 顺序是 build → snapshot：
  // npm run build 会先 clean dist/，再 tsc 编译 src → dist；之后 snapshot 才 mkdir dist
  // (idempotent, 此时 dist 已存在) 写 capabilities.snapshot.json。如果反过来跑（snapshot
  // 后 build），build 的 npm run clean 会把 snapshot 删掉。
  fs.mkdirSync(DIST_DIR, { recursive: true });
  // dump 成纯数组，不加 metadata wrapper：snapshot 形态就是 PublicAgentCapability[]，
  // 运行时 loadCapabilitySnapshot 直接用。可审计性诉求不在 hi 的考虑范围内（user_rule），
  // 不为可审计性加 fetched_at / source_url 这种字段。
  fs.writeFileSync(
    SNAPSHOT_PATH,
    `${JSON.stringify(items, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `[snapshot-capabilities] wrote ${items.length} capabilities → ${path.relative(REPO_ROOT, SNAPSHOT_PATH)}`,
  );
}

main().catch((err) => {
  console.error(`[snapshot-capabilities] failed: ${err?.message || err}`);
  process.exit(1);
});
