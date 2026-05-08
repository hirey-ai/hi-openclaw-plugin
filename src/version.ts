// Plugin runtime version 来源：package.json 单一数据源（不再 hardcode）。
//
// 业界共识（StackOverflow #9153571 / Node.js 官方惯例 / GitHub oh-my-opencode#842
// 的同名 bug "Hardcoded version string in CLI output causes inconsistency with npm
// version"）：CLI / agent metadata / status surface 暴露的 version 必须从 package.json
// 同步读，否则 bump 版本号时漏改一处会让 owner / 平台 registry / 升级管线全部看到错版本
// 号，无法定位"哪个版本有 bug、哪个版本已修"。
//
// 实现方式：ESM 文件相对路径用 `new URL('../package.json', import.meta.url)`。dist/version.js
// 编译落到 dist/version.js，import.meta.url 指向 dist/version.js，`../package.json` 解到
// 项目根的 package.json（npm 安装后是 hirey/package.json，跟仓库结构一致）。这种 fs+URL
// 方案不依赖 import attributes（TS rootDir=./src 会拒绝 `import pkg from '../package.json'`），
// 也不依赖 require（plugin 是 pure ESM）。
//
// 同步读一次缓存到 module-level 常量：plugin 每次进程启动只走一次 fs.readFileSync，
// 之后所有引用点零开销，避免变成热路径里的 syscall。

import { readFileSync } from 'node:fs';

function readPluginVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: unknown };
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    if (!version) {
      // package.json 没有 version 字段是 npm 包结构错误，不能默默吞 —— 让上层 logger
      // 看到 "version_unknown" 比看到一个错版本号要好得多。
      return 'version_unknown';
    }
    return version;
  } catch (err) {
    // 安装错误 / 文件被删 —— 同上，不要静默 fallback 到一个看似合理的版本号。
    return 'version_unknown';
  }
}

export const PLUGIN_VERSION: string = readPluginVersion();
