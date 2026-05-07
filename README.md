# hi-openclaw-plugin

Hirey Hi as a **native OpenClaw plugin**. Registers Hi's tools, agent-events claim service, and webhook ingress directly inside the OpenClaw gateway process — zero independent daemons, no `mcp.servers.hi` indirection, and no per-run frozen tool inventory boundary.

This is the OpenClaw 5.x first-class path. Pre-5.x users keep using the existing ClawHub bundle (`clawhub:hirey-openclaw-hi-install` / `clawhub:hirey-ai`) which auto-spawns `@hirey/hi-mcp-server` and `@hirey/hi-agent-receiver` as separate processes.

## Why this exists

The bundle + spawn model needs:

- one stdio child process for the MCP server (`hi-mcp-server`)
- one long-running daemon (`hi-agent-receiver`) for cloud-to-host event delivery
- a host installer mjs that uses `child_process` to run `npm install` + `openclaw config set` (which trips OpenClaw's pre-4.23 install scanner)
- a two-message install flow because the LLM run that wrote `mcp.servers.hi` cannot call the just-installed tools in the same outer run (per-run frozen tool inventory)
- `hooks.token` / `hooks.path` / `hooks.allowedSessionKeyPrefixes` / `/hooks/agent` plumbing on the OpenClaw side

This native plugin replaces all of the above with three OpenClaw plugin SDK calls running inside the gateway process:

- `api.registerTool(...)` for every Hi tool — exposed to the LLM directly, no MCP layer
- `api.registerService(...)` for the agent-events claim loop — gateway owns the lifecycle, no orphan daemon
- `api.registerHttpRoute(...)` for the webhook ingress — uses gateway's HTTP server, no separate hooks token

## Strategy: dual-track distribution

Hirey runs both forms in parallel:

| Path | Audience |
|---|---|
| `@hirey-ai/mcp-server` + `@hirey-ai/agent-receiver` (npm) | Claude Desktop, Cursor, VS Code MCP, any other MCP host. Stable cross-host transport. |
| `@hirey-ai/openclaw-plugin` (this package, ClawHub: `hirey-ai-openclaw`) | OpenClaw 5.x. Best UX, in-process, no boundary friction. |
| `clawhub:hirey-ai` ClawHub bundle | OpenClaw 4.x fallback. Wraps the npm packages above. |

Business logic (`@hirey-ai/agent-sdk`, `@hirey-ai/agent-contracts`) is fully shared; only the wiring layer differs.

## Supported OpenClaw versions

- **2026.5.4+**: native plugin path (this package). Recommended.
- **2026.4.23 ~ 2026.5.3**: works via npm install `@hirey-ai/openclaw-plugin` directly; ClawPack ClawHub-preferred is 5.2+.
- **2026.4.0 ~ 2026.4.22**: install scanner blocks (community plugin install). Use the bundle path with `--link` workaround.
- **< 2026.4.0**: not supported. Upgrade OpenClaw.

## Install

```bash
openclaw plugins install clawhub:hirey-ai-openclaw
openclaw gateway restart
```

After restart, ask OpenClaw "Hi 健康吗?" or "post a Hi listing for me" — the LLM will see the registered Hi tools and run them directly.

## Development

```bash
npm install
npm run build
npm pack    # emits hirey-ai-openclaw-<version>.tgz
```

Use `openclaw plugins install -l <local-dir>` for local link-mode testing.

## License

UNLICENSED (private; published under `@hirey-ai` scope on the public npm registry but the source is not open source).
