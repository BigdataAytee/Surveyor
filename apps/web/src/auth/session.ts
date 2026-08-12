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
): Promise<{ readonly status: number; readonly data: Record<string, unknown> }> {
  if (!AUTH_ENDPOINT) throw new Error('Accounts are not configured in this build.');

  const response = await fetch(`${AUTH_ENDPOINT}?action=${encodeURIComponent(action)}`, {
    method: options.method ?? 'POST',
    // The session is a cookie, and a cross-origin fetch drops cookies unless
    // asked to carry them. Without this every request looks signed out.
    credentials: 'include',
    ...(options.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
  });

  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // A response that is not JSON is a server or proxy problem, not an auth
    // answer. Left empty so the caller reports it as one.
  }

  return { status: response.status, data };
}

export async function whoAmI(): Promise<AuthState> {
  if (!accountsEnabled) return { kind: 'disabled' };

  try {
    const { data } = await call('me', { method: 'GET' });
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
