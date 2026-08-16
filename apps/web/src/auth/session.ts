/**
 * The browser's half of signing in.
 *
 * This holds no authority. It asks the server who is signed in and shows the
 * answer; the session itself is an HttpOnly cookie this code cannot read, and
 * that is deliberate — a token JavaScript can read is a token any injected
 * script can steal.
 *
 * The app runs without an account when no endpoint is configured. That is not
 * a fallback for a broken deployment, it is the mode this app was built in:
 * a surveyor on a site with no signal needs the drawing tools to work, and
 * gating them behind a network round trip would make the app useless exactly
 * where it is most needed.
 */

import { connectedFetch } from '../state/connectivity.js';

export type Role = 'surveyor' | 'developer' | 'admin';

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  /**
   * What the server says this account is.
   *
   * Shown, and used to decide whether to offer the console — and that is all
   * it is for. It is not a permission: the server re-reads its own copy on
   * every admin request, so editing this in a debugger changes what the menu
   * looks like and nothing else.
   */
  readonly role: Role;
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

export function isAdmin(account: Account | null): boolean {
  return account?.role === 'admin' || account?.role === 'developer';
}

export type AuthState =
  /** No endpoint configured. The app works locally and never asks anyone to sign in. */
  | { readonly kind: 'disabled' }
  /** Asking the server who this is. */
  | { readonly kind: 'checking' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'signed-in'; readonly account: Account }
  /**
   * Accounts are configured but the server cannot be reached.
   *
   * Its own state rather than "signed out", because the two call for opposite
   * things: signed out means sign in, unreachable means wait or work offline,
   * and telling someone to sign in when the server is down sends them round a
   * loop they cannot exit.
   */
  | { readonly kind: 'unreachable'; readonly reason: string };

/** Where the auth API lives, or null when this build has no accounts. */
export const AUTH_ENDPOINT: string | null =
  (import.meta.env.VITE_AUTH_ENDPOINT as string | undefined)?.trim() || null;

export const accountsEnabled = AUTH_ENDPOINT !== null;

async function call(
  action: string,
  options: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {},
): Promise<{
  readonly status: number;
  readonly data: Record<string, unknown>;
  /** Whether the body was JSON at all. A page of HTML is not an answer. */
  readonly json: boolean;
}> {
  if (!AUTH_ENDPOINT) throw new Error('Accounts are not configured in this build.');

  // `connectedFetch`, so that a sign-in attempt on a dead network teaches the
  // rest of the app it is offline instead of each part finding out separately.
  const response = await connectedFetch(`${AUTH_ENDPOINT}?action=${encodeURIComponent(action)}`, {
    method: options.method ?? 'POST',
    // The session is a cookie, and a cross-origin fetch drops cookies unless
    // asked to carry them. Without this every request looks signed out.
    credentials: 'include',
    ...(options.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
  });

  let data: Record<string, unknown> = {};
  let json = false;
  try {
    data = (await response.json()) as Record<string, unknown>;
    json = true;
  } catch {
    // A response that is not JSON is a server or proxy problem, not an auth
    // answer — a static host's SPA fallback will happily return a page of HTML
    // with a 200 on it. Reported as "not an answer" rather than as an empty one.
  }

  return { status: response.status, data, json };
}

export async function whoAmI(): Promise<AuthState> {
  if (!accountsEnabled) return { kind: 'disabled' };

  try {
    const { status, data, json } = await call('me', { method: 'GET' });

    if (!json) {
      return {
        kind: 'unreachable',
        reason:
          'The accounts service is not answering at that address. It may not be ' +
          'deployed yet.',
      };
    }

    /*
     * Only a 2xx is an answer about who you are. Anything else is the service
     * failing to answer at all, and the difference is the whole behaviour:
     * "signed out" means show a sign-in form, and a form that submits into a
     * 404 or a 503 can never succeed. A build pointed at an endpoint that is
     * not deployed, or a deployment with no account store attached, used to
     * present exactly that — a locked front door with no key cut.
     */
    if (status < 200 || status >= 300) {
      return {
        kind: 'unreachable',
        reason:
          typeof data.error === 'string' && data.error.length > 0
            ? data.error
            : `The accounts service answered ${status}.`,
      };
    }

    const account = data.user as Account | null | undefined;
    return account ? { kind: 'signed-in', account } : { kind: 'signed-out' };
  } catch {
    return {
      kind: 'unreachable',
      reason: 'Could not reach the accounts service. Check your connection.',
    };
  }
}

export type AuthResult =
  | { readonly ok: true; readonly account: Account }
  /**
   * Registered, and not signed in — the deployment wants the address
   * confirmed first. Its own outcome rather than an error, because nothing
   * went wrong and the next step is in an inbox rather than on this screen.
   */
  | { readonly ok: true; readonly awaitingVerification: true; readonly message: string }
  | {
      readonly ok: false;
      readonly error: string;
      /**
       * Only set for states the screen can offer something about.
       *
       * `unverified` gets a resend button. A wrong password gets nothing,
       * because there is nothing to offer — and a code distinguishing it from
       * an unknown address would hand a guesser the thing the single generic
       * message exists to withhold.
       */
      readonly reason?: 'unverified';
    };

export async function signIn(
  email: string,
  password: string,
  remember: boolean,
): Promise<AuthResult> {
  return submit('login', { email, password, remember });
}

export async function createAccount(
  email: string,
  password: string,
  name: string,
  remember: boolean,
): Promise<AuthResult> {
  return submit('register', { email, password, name, remember });
}

async function submit(action: string, body: unknown): Promise<AuthResult> {
  try {
    const { status, data } = await call(action, { body });

    if (status >= 200 && status < 300) {
      if (data.verificationRequired === true) {
        return {
          ok: true,
          awaitingVerification: true,
          message:
            typeof data.message === 'string'
              ? data.message
              : 'Check your email for a link to confirm your address.',
        };
      }
      if (data.user) return { ok: true, account: data.user as Account };
    }

    return {
      ok: false,
      // The server's wording is used as-is: it is written to be read by the
      // person, and rewriting it here would be a second set of messages to
      // keep true.
      error:
        typeof data.error === 'string' && data.error.length > 0
          ? data.error
          : 'That did not work. Try again.',
      ...(data.reason === 'unverified' ? { reason: 'unverified' as const } : {}),
    };
  } catch {
    return { ok: false, error: 'Could not reach the accounts service. Check your connection.' };
  }
}

/**
 * The three routes that speak through somebody's inbox.
 *
 * All of them answer the same way whatever the address is, on purpose, so none
 * of them can be used to ask who has an account here. The message they return
 * is the server's own and is deliberately conditional — "if an account
 * exists…" — because that is the only wording that is true in both cases.
 */
export async function resendVerification(email: string): Promise<string> {
  return say('resend-verification', { email }, 'If that address needs confirming, we have sent the link again.');
}

export async function requestPasswordReset(email: string): Promise<string> {
  return say('request-reset', { email }, 'If an account exists for that address, a reset link is on its way.');
}

async function say(action: string, body: unknown, fallback: string): Promise<string> {
  try {
    const { data } = await call(action, { body });
    return typeof data.message === 'string' ? data.message : fallback;
  } catch {
    return 'Could not reach the accounts service. Check your connection.';
  }
}

export type LinkResult =
  | { readonly ok: true; readonly message: string }
  /** A link that failed but can be retried, with the replacement to retry with. */
  | { readonly ok: false; readonly error: string; readonly token?: string };

/** Confirm an address from the link in an email. */
export async function confirmEmail(token: string): Promise<LinkResult> {
  try {
    const { status, data } = await call('verify', { body: { token } });
    if (status >= 200 && status < 300) {
      return { ok: true, message: 'Your email address is confirmed. Sign in to continue.' };
    }
    return { ok: false, error: typeof data.error === 'string' ? data.error : 'That link is not valid.' };
  } catch {
    return { ok: false, error: 'Could not reach the accounts service. Check your connection.' };
  }
}

/** Set a new password from the link in an email. */
export async function resetPassword(token: string, password: string): Promise<LinkResult> {
  try {
    const { status, data } = await call('reset', { body: { token, password } });
    if (status >= 200 && status < 300) {
      return {
        ok: true,
        message:
          typeof data.message === 'string'
            ? data.message
            : 'Your password has been changed. Sign in with it.',
      };
    }
    return {
      ok: false,
      error: typeof data.error === 'string' ? data.error : 'That did not work.',
      // A rejected password gets the link back, so a typo does not send
      // someone to their inbox for another one.
      ...(typeof data.token === 'string' ? { token: data.token } : {}),
    };
  } catch {
    return { ok: false, error: 'Could not reach the accounts service. Check your connection.' };
  }
}

/**
 * A link somebody arrived on, taken out of the address bar.
 *
 * Removed from the URL as soon as it is read. A one-time token sitting in
 * `location.href` ends up in browser history, in a shared screenshot, and in
 * the `Referer` header of the next request the page makes.
 */
export function linkFromUrl(): { readonly kind: 'verify' | 'reset'; readonly token: string } | null {
  if (typeof window === 'undefined') return null;

  const url = new URL(window.location.href);
  for (const kind of ['verify', 'reset'] as const) {
    const token = url.searchParams.get(kind);
    if (token) {
      url.searchParams.delete(kind);
      window.history.replaceState({}, '', url.toString());
      return { kind, token };
    }
  }
  return null;
}

export async function signOut(): Promise<void> {
  if (!accountsEnabled) return;
  try {
    await call('logout');
  } catch {
    // The cookie may survive a failed request. The caller still moves the UI
    // to signed-out, because a sign-out that appears not to have happened is
    // one people repeat rather than trust.
  }
}

export async function changePassword(
  current: string,
  next: string,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  try {
    const { status, data } = await call('password', { body: { current, next } });
    if (status >= 200 && status < 300) return { ok: true };
    return {
      ok: false,
      error: typeof data.error === 'string' ? data.error : 'That did not work.',
    };
  } catch {
    return { ok: false, error: 'Could not reach the accounts service.' };
  }
}
