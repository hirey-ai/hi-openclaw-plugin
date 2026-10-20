// A pending (never signed-in) Agent only ever gets an anonymous `hi_ai_` token,
// and the gateway answers its event claims with 401 agent_sign_in_required.
// Retrying cannot succeed until the user signs in, so the event services stop
// claiming and wait here instead (BUG-001373: seven such installs retried about
// once a minute each, forever).
//
// The wait ends as soon as this process sees a signed-in token (any tool call
// after the user signs in goes through buildAuthorizedClients), or after a
// backoff that grows from 5 minutes to 6 hours, in case the user signed in
// somewhere this process cannot see. Each wake costs one token exchange, never a claim.

export const SIGN_IN_WAIT_MIN_MS = 5 * 60_000;
export const SIGN_IN_WAIT_MAX_MS = 6 * 60 * 60_000;

export function isAnonymousAccessToken(token: string): boolean {
  return token.startsWith('hi_ai_');
}

const waiters = new Set<() => void>();
// Counts signed-in tokens seen by this process. A caller reads it before its own
// token check, so a sign-in that lands during that check is never missed.
let signedInCount = 0;

export function signInGeneration(): number {
  return signedInCount;
}

export function notifySignedIn(): void {
  signedInCount++;
  for (const wake of [...waiters]) wake();
}

export function nextSignInWaitMs(previousMs: number): number {
  if (previousMs <= 0) return SIGN_IN_WAIT_MIN_MS;
  return Math.min(previousMs * 2, SIGN_IN_WAIT_MAX_MS);
}

// Resolves after `ms`, on notifySignedIn(), or when `signal` aborts. With
// `sinceGeneration`, it resolves at once if a sign-in was seen after that point.
export function waitForSignIn(ms: number, signal?: AbortSignal, sinceGeneration?: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    if (sinceGeneration !== undefined && signedInCount > sinceGeneration) return resolve();
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    waiters.add(done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export const SIGN_IN_REQUIRED_LOG =
  '[hi-openclaw-plugin] this Agent is not signed in; Hi events are paused. '
  + 'Ask the user to sign in to HiRey (Google, phone or email) from this Agent; events resume after that.';
