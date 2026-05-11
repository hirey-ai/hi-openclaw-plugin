# hi-openclaw-plugin

Hirey Hi as a **native OpenClaw plugin**. Registers Hi's tools, agent-events claim service, and webhook ingress directly inside the OpenClaw gateway process — zero independent daemons, no `mcp.servers.hi` indirection, and no per-run frozen tool inventory boundary.

This is the OpenClaw 5.2+ first-class path, published to ClawHub as **`clawhub:hirey`** (ClawPack code-plugin) and to npm as **`hirey`**. OpenClaw 4.23 ~ 5.1 hosts cannot load this ClawPack format and must install the prod bundle plugin **`clawhub:hirey-compatible`** instead (zip + skill + scripts wrapping `@hirey-ai/mcp-server` + `@hirey-ai/agent-receiver`). All OpenClaw 4.23+ hosts can install `clawhub:hirey-compatible` as a universal fallback.

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
| `clawhub:hirey` (this package, ClawPack code-plugin) | OpenClaw **5.2+**. Best UX, in-process, no boundary friction. |
| `clawhub:hirey-compatible` (prod bundle plugin from `hi-platform`, zip + skills + scripts) | **All OpenClaw 4.23+ hosts**. Required for 4.23 ~ 5.1 (those hosts cannot load ClawPack); optional fallback for 5.2+ if the ClawPack install path has any issue. Wraps `@hirey-ai/mcp-server` + `@hirey-ai/agent-receiver`. |
| `@hirey-ai/mcp-server` + `@hirey-ai/agent-receiver` (npm, raw) | Claude Desktop, Cursor, VS Code MCP, any other MCP host. Stable cross-host transport. Independent of OpenClaw. |

Business logic (`@hirey-ai/agent-sdk`, `@hirey-ai/agent-contracts`) is fully shared; only the wiring layer differs.

## Supported OpenClaw versions

| OpenClaw version | `clawhub:hirey` (ClawPack) | `clawhub:hirey-compatible` (bundle) | Notes |
|---|---|---|---|
| **2026.5.2+** | ✅ recommended (in-process) | ✅ works but skips native plugin benefits | ClawPack first-class path |
| **2026.4.23 ~ 2026.5.1** | ❌ runtime expects date-format `pluginApi`, rejects semantic `1.0` | ✅ recommended | bundle is the only path |
| **2026.4.14 ~ 2026.4.22** | ❌ same as above | ❌ install scanner flags `child_process` in installer mjs | unsupported; must upgrade OpenClaw |
| **< 2026.4.14** | ❌ | ❌ | unsupported |

## Install

### Pre-flight: avoid the approval loop (one-time, ~5 seconds, recommended)

On a default OpenClaw host, `tools.exec` runs in `security=allowlist` + `ask=off` and the natural-language install path stalls in an approval loop: each `/approve <token>` retry rotates the token because the gateway's followup dispatch can't reuse the approved session token (upstream tracked at [openclaw/openclaw#58662](https://github.com/openclaw/openclaw/issues/58662) and [#27831](https://github.com/openclaw/openclaw/issues/27831)). Before chatting with OpenClaw, paste this in your shell once:

```bash
openclaw approvals set --stdin << 'JSON'
{
  "version": 1,
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "**/openclaw",
          "argPattern": "^plugins\\s+install\\s+clawhub:hirey(\\b|$)",
          "source": "manual"
        }
      ]
    }
  }
}
JSON
```

The change is live — no `openclaw gateway restart` needed. The allowlist is intentionally narrow: it only matches `openclaw plugins install clawhub:hirey*` (covers `clawhub:hirey`, `clawhub:hirey --force`, and the bundle name `clawhub:hirey-compatible`); it does NOT broaden any other openclaw subcommand.

With pre-flight set, the install prompt below finishes in **2 chat turns, 0 `/approve` prompts** (verified end-to-end on OpenClaw 2026.5.6). Without pre-flight, expect 4–6 turns with several token-paste round-trips.

### Natural-language install (after pre-flight)

OpenClaw is a personal agent driven by natural language; the LLM picks which command to run. The recommended user-facing prompt that works across versions:

```
Install Hirey AI on this OpenClaw host. First check `openclaw --version`:
- If 2026.5.2 or higher, run `openclaw plugins install clawhub:hirey`.
- Otherwise (OpenClaw 2026.4.23 ~ 2026.5.1), run `openclaw plugins install clawhub:hirey-compatible --dangerously-force-unsafe-install`.
The `--dangerously-force-unsafe-install` flag is required only for the bundle path: it is OpenClaw's own break-glass override that lets community bundles ship a setup-time `child_process` helper for `npm install` + `openclaw config set`. The ClawPack path is in-process and does not need the flag.
After install, call hi_agent_install (don't fabricate an agent id). Report the real agent_id and hooks_ready status.
```

Direct CLI for OpenClaw 5.2+ users:

```bash
openclaw plugins install clawhub:hirey
openclaw gateway restart
```

For OpenClaw 4.23 ~ 5.1 users (bundle path), or any 5.2+ user who wants the bundle as a universal fallback:

```bash
openclaw plugins install clawhub:hirey-compatible --dangerously-force-unsafe-install
openclaw gateway restart
```

The `--dangerously-force-unsafe-install` flag is required because OpenClaw 4.14+ install scanner blocks community bundles that ship a `child_process` import; our `openclaw-host-installer.mjs` legitimately uses `child_process.execFile` to spawn `npm install` and `openclaw config set` during setup. This is the OpenClaw-provided override flag (docs/cli/plugins.md), not a bypass of security controls.

After restart, ask OpenClaw "Hi 健康吗?" or "post a Hi listing for me" — the LLM will see the registered Hi tools and run them directly.

## Development

```bash
npm install
npm run build
npm pack    # emits hirey-<version>.tgz
```

Use `openclaw plugins install -l <local-dir>` for local link-mode testing (only on OpenClaw 5.2+).

## License

UNLICENSED (private; published under unscoped `hirey` on the public npm registry but the source is not open source).
