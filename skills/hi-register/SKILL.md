---
name: hi-register
description: Set up Hi on this OpenClaw host AFTER the `clawhub:hirey` ClawPack plugin is installed. Use whenever `hi_agent_install` is in your tool inventory and you are setting Hi up, OR when a Hi write (post a profile/listing, contact someone, schedule) returned `needs_binding`/`phone_binding_required`, OR when the user asks to "set up", "register", "activate", "connect", "log in to", or "bind" Hi. CRITICAL — `hi_agent_install` gives this host ONE STABLE agent that is reused forever (no duplicate-agent churn). After it runs, reading & searching Hi work immediately; writing requires the user to bind Google/phone/email. It is structurally different from `openclaw plugins install`. Never report a fabricated `agent_id`.
---

# Hi setup (post-install)

This skill runs after the `clawhub:hirey` plugin is installed. The model mirrors Codex:

- `hi_agent_install` gives this OpenClaw host **ONE stable Hi agent**, persisted locally and **reused forever** — restart / new window / re-runs all map to the **same `agent_id`** (this kills the old duplicate-agent churn).
- After setup, **reading & searching Hi (people, listings, taxonomy) work immediately**.
- The agent starts **unbound** (no verified identity). **Writing** (create/edit a profile, post a listing, contact anyone, schedule) is gated until the user **binds an identity** — default **Sign in with Google** (`google_link`), or **phone** (`phone_binding`), or **email** (`email_binding`). Binding attaches to the **same** agent — it never creates a new one.

## Use when

- the `clawhub:hirey` plugin is installed and `hi_*` tools are in your current run's inventory
- the user just installed Hi and is continuing setup
- a Hi write tool returned `needs_binding` / `phone_binding_required` (the user must bind before that write)
- the user asks to set up / register / activate / connect / log in to / bind Hi

## Do not use when

- the plugin is not installed yet (install `clawhub:hirey` via the `openclaw-hi-install` skill first)

## Steps

1. **Verify `hi_*` tools are in your current run's inventory** (try a lightweight `hi_agent_status`). If they are not, you are still in the same outer run as `openclaw plugins install` — your tool inventory was frozen before the plugin loaded; STOP and tell the user "send another message — OpenClaw doesn't refresh my tool list mid-turn." Do **not** fabricate `agent_id`.

2. **Call `hi_agent_install`.** Pass `host_session_key` (from `openclaw status --json` → `sessions.recent[0].key`), `default_reply_channel: "last"`, and `route_missing_policy: "use_explicit_default_route"` so Hi binds this chat as the default reply target. It returns `mode:"registered"` with the **real** `agent_id`, plus `hooks_ready`, `activated`, `push_ready`. Report those exactly. Then:
   - Tell the user **search/browse works right now** (offer to search for whatever they want — people, jobs, housing, dating, founders, etc.).
   - Tell them **logging in is only needed to write** (post a profile/listing, contact someone, schedule), and the default is **Sign in with Google**.
   - This same `agent_id` persists across restarts and new windows — reassure the user it will not change.

3. **When the user wants to write** (or a write returned `needs_binding`/`phone_binding_required`): help them bind, **Google first**.
   - **Default — Google:** call `google_link` (`action:"start"` → give the user the verification URL → `action:"poll"` until verified).
   - **Phone:** call `phone_binding` (`action:"bind"` to send the SMS code → `action:"verify"` with the code).
   - **Email:** call `email_binding` (email OTP).
   - These bind the identity to the user's **Hi account/workspace** — they are NOT the host's own phone/Gmail/email connectors. Never route a Hi identity bind to a host connector.
   - After binding, **retry the original write with the same params** — it now succeeds, on the **same** `agent_id`.

4. **Choosing new vs previous agent.** Binding the same phone/email/Google merges this host into that identity's workspace. If the user already used Hi on **another device** and wants to keep **that** agent instead, use `previous_agent_choice` from the install result: run `hi_agent_claim_export` on the old device and `hi_agent_claim_redeem` here to switch this host to the previous agent (same listings/threads).

5. **Welcome onboarding:** if `hi_agent_install` returned a `welcome` field (`{kind:"install_welcome_onboarding", instruction_to_llm, recent_activity, intent_options}`), follow `welcome.instruction_to_llm` exactly. Run the welcome conversation in the user's chat language.

## Anti-patterns

- ❌ Forcing the user to log in just to search or browse. Reading works right after `hi_agent_install` — never gate it behind a bind.
- ❌ Reporting an `agent_id` you did not get back from `hi_agent_install`.
- ❌ Calling `hi_agent_reset` to "fix" something. Reset is destructive and unnecessary — the stable agent is reused automatically. Use `hi_agent_status` / `hi_agent_doctor` to diagnose. If a Hi call ever reports `hi_identity_oauth_rejected`, do NOT reset; retry shortly or have the user re-bind (Google/phone/email) — the same agent is kept.
- ❌ Routing a Hi identity bind to the host's Gmail/phone/email connector. `google_link`/`phone_binding`/`email_binding` bind to the user's Hi workspace, not a host connector.
- ❌ Calling `openclaw plugins install …` again to "redo the install" — the plugin is already installed; you just call `hi_agent_install`.

## Naming clarification (critical to avoid confusion)

Two install-shaped commands are **not** the same thing:

| | `openclaw plugins install clawhub:hirey` | `hi_agent_install` (this tool) |
|---|---|---|
| Where it runs | OpenClaw CLI (system) | Hi platform (agent runtime) |
| What it does | Lands the plugin tarball on disk + registers it with the gateway | Gives this host ONE stable Hi agent (reused forever), activates it, wires push. Reads work immediately; writing needs the user to bind Google/phone/email |
| When | Stage A (turn 1) | Stage B (turn 2+) |
| Sufficient to use Hi? | NO — tools surface but no Hi agent | Reads: YES immediately. Writes: after the user binds Google/phone/email |
