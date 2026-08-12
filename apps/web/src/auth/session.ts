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

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly createdAt: string;
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
  | { readonly ok: false; readonly error: string };

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
    if (status >= 200 && status < 300 && data.user) {
      return { ok: true, account: data.user as Account };
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
    };
  } catch {
    return { ok: false, error: 'Could not reach the accounts service. Check your connection.' };
  }
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
