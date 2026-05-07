# hi-openclaw-plugin

Hirey Hi as a **native OpenClaw plugin**. Registers Hi's tools, agent-events claim service, and webhook ingress directly inside the OpenClaw gateway process — zero independent daemons, no `mcp.servers.hi` indirection, and no per-run frozen tool inventory boundary.

This is the OpenClaw 5.4+ first-class path, published to ClawHub as **`clawhub:hirey`** (ClawPack code-plugin) and to npm as **`hirey`**. OpenClaw 4.23 ~ 5.3 hosts cannot load this ClawPack format and must install the prod bundle plugin **`clawhub:hirey-compatible`** instead (zip + skill + scripts wrapping `@hirey-ai/mcp-server` + `@hirey-ai/agent-receiver`).

## Why this exists

The bundle + spawn model needs:

- one stdio child process for the MCP server (`@hirey-ai/mcp-server`)
- one long-running daemon (`@hirey-ai/agent-receiver`) for cloud-to-host event delivery
- a host installer mjs that uses `child_process` to run `npm install` + `openclaw config set` (which trips OpenClaw's pre-4.23 install scanner)
- a two-message install flow because the LLM run that wrote `mcp.servers.hi` cannot call the just-installed tools in the same outer run (per-run frozen tool inventory)
- `hooks.token` / `hooks.path` / `hooks.allowedSessionKeyPrefixes` / `/hooks/agent` plumbing on the OpenClaw side

This native plugin replaces all of the above with three OpenClaw plugin SDK calls running inside the gateway process:

- `api.registerTool(...)` for every Hi tool — exposed to the LLM directly, no MCP layer
- `api.registerService(...)` for the agent-events claim loop — gateway owns the lifecycle, no orphan daemon
- `api.registerHttpRoute(...)` for the webhook ingress — uses gateway's HTTP server, no separate hooks token

## Distribution paths

| Path | Audience |
|---|---|
| `clawhub:hirey` (this package, ClawPack code-plugin) | OpenClaw **5.4+**. Best UX, in-process, no boundary friction. |
| `clawhub:hirey-compatible` (prod bundle plugin from `hi-platform`, zip + skills + scripts) | OpenClaw **4.23 ~ 5.3**. Wraps `@hirey-ai/mcp-server` + `@hirey-ai/agent-receiver` because these hosts cannot load ClawPack. |
| `@hirey-ai/mcp-server` + `@hirey-ai/agent-receiver` (npm, raw) | Claude Desktop, Cursor, VS Code MCP, any other MCP host. Stable cross-host transport. Independent of OpenClaw. |

Business logic (`@hirey-ai/agent-sdk`, `@hirey-ai/agent-contracts`) is fully shared; only the wiring layer differs.

## Supported OpenClaw versions

| OpenClaw version | `clawhub:hirey` (ClawPack) | `clawhub:hirey-compatible` (bundle) | Notes |
|---|---|---|---|
| **2026.5.4+** | ✅ recommended | ✅ works but skips native plugin benefits | ClawPack first-class path |
| **2026.5.2 ~ 2026.5.3** | ❌ ClawHub server doesn't expose fallback `sha256hash` + `files[]` metadata to old client | ✅ | bundle only |
| **2026.4.23 ~ 2026.5.1** | ❌ runtime expects date-format `pluginApi`, rejects semantic `1.0` | ✅ | bundle only |
| **2026.4.14 ~ 2026.4.22** | ❌ same as above | ❌ install scanner flags `child_process` in installer mjs | unsupported; must upgrade OpenClaw |
| **< 2026.4.14** | ❌ | ❌ | unsupported |

## Install

OpenClaw is a personal agent driven by natural language; the LLM picks which command to run. The recommended user-facing prompt that works across versions:

```
Install Hirey AI on this OpenClaw host. First check `openclaw --version`:
- If 2026.5.4 or higher, run `openclaw plugins install clawhub:hirey`.
- Otherwise, run `openclaw plugins install clawhub:hirey-compatible`.
After install, call hi_agent_install (don't fabricate an agent id). Report the real agent_id and hooks_ready status.
```

Direct CLI for OpenClaw 5.4+ users:

```bash
openclaw plugins install clawhub:hirey
openclaw gateway restart
```

After restart, ask OpenClaw "Hi 健康吗?" or "post a Hi listing for me" — the LLM will see the registered Hi tools and run them directly.

## Development

```bash
npm install
npm run build
npm pack    # emits hirey-<version>.tgz
```

Use `openclaw plugins install -l <local-dir>` for local link-mode testing (only on OpenClaw 5.4+).

## License

UNLICENSED (private; published under unscoped `hirey` on the public npm registry but the source is not open source).
