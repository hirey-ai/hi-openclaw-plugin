// Module-level flag set by register() in src/index.ts after successful
// before_prompt_build hook registration. The daemon (agent-events.ts) reads it to
// decide whether to switch from the old "pass sessionKey to /hooks/agent (causes
// rotation)" path to the new "strip sessionKey + write pending-pushes" path.
//
// Why a module flag and not just env: index.ts performs feature-detection
// (typeof api.on === 'function') at register time. If api.on is missing on an
// older OpenClaw host (<2026.4.21), hook registration is skipped, and the daemon
// must fall back to the old delivery path (otherwise pushes would silently
// disappear—written to pending-pushes that nothing reads).
//
// Env HI_PUSH_INJECTION=off also flips this off explicitly for emergency rollback.
let active = false;

export function setPushInjectionActive(value: boolean): void {
  active = value;
}

export function isPushInjectionActive(): boolean {
  return active;
}
