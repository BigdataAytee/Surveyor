/**
 * The console's side of the admin API.
 *
 * Thin on purpose. Every number the console shows is computed on the server,
 * so that two screens cannot disagree about what an acceptance rate is — a
 * monitoring surface that can be argued with is a monitoring surface nobody
 * trusts. This file fetches and types; it does not calculate.
 */

/**
 * Where the console's API lives.
 *
 * Defaulted rather than optional, unlike the app's endpoints: the app has a
 * genuine no-accounts mode and must open without one, and a console with no
 * API has nothing at all to show. A deployment that has not set this gets the
 * conventional path and a clear failure if nothing is there.
 */
const ENDPOINT: string =
  (import.meta.env.VITE_ADMIN_ENDPOINT as string | undefined)?.trim() || '/api/admin';

export type Role = 'surveyor' | 'developer' | 'admin';

export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: Role;
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

export interface SuggestionRow {
  readonly type: string;
  readonly offered: number;
  readonly accepted: number;
  readonly edited: number;
  readonly rejected: number;
  /** Null when nothing has been offered — not the same as a rate of zero. */
  readonly acceptanceRate: number | null;
  readonly editRate: number | null;
}

export interface StageRow {
  readonly stage: string;
  readonly runs: number;
  readonly averageMs: number;
  readonly worstMs: number;
}

export interface TelemetrySummary {
  readonly events: number;
  readonly projects: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly suggestions: readonly SuggestionRow[];
  readonly validationCodes: readonly { readonly code: string; readonly count: number }[];
  readonly stages: readonly StageRow[];
  readonly exports: number;
  readonly exportFailures: number;
  readonly exportFailureRate: number | null;
}

export interface AuditEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly userId: string | null;
  readonly email: string | null;
  readonly role: string | null;
  readonly actorEmail: string | null;
  readonly ip: string | null;
  readonly detail: string | null;
}

export interface ProjectRow {
  readonly projectId: string;
  readonly events: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly validation: string | null;
  readonly exports: number;
  readonly failures: number;
  readonly suggestionsOffered: number;
  readonly suggestionsAccepted: number;
}

export type Answer<T> =
  | { readonly ok: true; readonly data: T }
  /**
   * Not signed in, or signed in without the role.
   *
   * Deliberately not distinguished in the console's own handling beyond the
   * status: the server answers 404 to a signed-in surveyor, because someone
   * who guessed the URL should learn there is nothing at it rather than that
   * there is something they may not see.
   */
  | { readonly ok: false; readonly status: number; readonly error: string };

async function get<T>(action: string, params: Record<string, string> = {}): Promise<Answer<T>> {
  const url = new URL(ENDPOINT, window.location.origin);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  try {
    const response = await fetch(url.toString(), { credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: typeof data.error === 'string' ? data.error : `The console answered ${response.status}.`,
      };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the console API.' };
  }
}

async function post<T>(action: string, body: unknown): Promise<Answer<T>> {
  const url = new URL(ENDPOINT, window.location.origin);
  url.searchParams.set('action', action);

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: typeof data.error === 'string' ? data.error : `The console answered ${response.status}.`,
      };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the console API.' };
  }
}

export const admin = {
  overview: (hours: string) =>
    get<{
      readonly window: { readonly since: string; readonly until: string };
      readonly telemetry: TelemetrySummary;
      readonly accounts: { readonly total: number; readonly admins: number; readonly developers: number };
      readonly auth: {
        readonly logins: number;
        readonly failedLogins: number;
        readonly lockouts: number;
        readonly roleChanges: number;
      };
      readonly reporting: boolean;
    }>('overview', { since: hours }),

  projects: (hours: string) => get<{ readonly projects: readonly ProjectRow[] }>('projects', { since: hours }),

  project: (id: string) =>
    get<{
      readonly projectId: string;
      readonly trace: readonly {
        readonly at: string;
        readonly kind: string;
        readonly detail: Readonly<Record<string, unknown>>;
      }[];
      readonly summary: TelemetrySummary;
    }>('project', { id }),

  suggestions: (hours: string) =>
    get<{ readonly suggestions: readonly SuggestionRow[]; readonly total: number }>('suggestions', {
      since: hours,
    }),

  errors: (hours: string) =>
    get<{
      readonly failures: readonly {
        readonly kind: string;
        readonly reason: string;
        readonly count: number;
        readonly lastSeen: string;
      }[];
      readonly recent: readonly { readonly at: string; readonly kind: string; readonly projectId: string | null }[];
    }>('errors', { since: hours }),

  usage: (hours: string) =>
    get<{
      readonly stages: readonly StageRow[];
      readonly exports: number;
      readonly exportFailures: number;
      readonly exportFailureRate: number | null;
      readonly byDay: readonly { readonly day: string; readonly events: number; readonly exports: number }[];
    }>('usage', { since: hours }),

  audit: (hours: string, kinds?: string) =>
    get<{ readonly events: readonly AuditEvent[] }>('audit', {
      since: hours,
      ...(kinds ? { kinds } : {}),
    }),

  accounts: (query = '') =>
    get<{ readonly users: readonly AdminUser[]; readonly roles: readonly Role[] }>('accounts', {
      ...(query ? { q: query } : {}),
    }),

  setRole: (userId: string, role: Role) => post<{ readonly user: AdminUser }>('set-role', { userId, role }),
};
