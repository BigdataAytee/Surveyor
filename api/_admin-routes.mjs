/**
 * The admin console's API.
 *
 * Every route in this file begins by asking the store what role the session's
 * account actually has. Not what the request says, not what a header claims,
 * not whether the client bothered to hide the link — the stored role, read
 * server-side, on every single request. Client-side route guarding is a
 * convenience for the person using the app; this is the boundary.
 *
 * ---------------------------------------------------------------------------
 * What this surface is
 * ---------------------------------------------------------------------------
 *
 * Read-mostly. It reports on the system: pipeline health, what the assistant
 * suggested and what surveyors did with it, failures, load. There is exactly
 * one route here that changes anything — `set-role` — and it writes an audit
 * event naming who did it, to whom, and when.
 *
 * There is deliberately no route that edits a plan. Not "no button for it" —
 * no route. An admin who could quietly alter a surveyor's confirmed bearing
 * would make every plan in the system arguable, and the app's whole provenance
 * model rests on confirmation happening in the surveyor's hands. If a stuck
 * project ever needs unsticking, the fix belongs in the pipeline, not in a
 * back door.
 */

import { requireAdmin, sessionUser, setRole, ROLES } from './_auth-core.mjs';
import { sanitiseEvent, summarise, TELEMETRY_KINDS } from './_telemetry.mjs';

/** How far back the console looks when nothing says otherwise. */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Handle one admin request.
 *
 * Returns `{ status, body }`. The caller writes it, exactly as with the auth
 * routes, so the two cannot disagree about headers or caching.
 */
export async function handleAdmin(action, context) {
  const { store, body = {}, token, query = {} } = context;

  const gate = await requireAdmin(store, token);
  if (!gate.ok) return { status: gate.status, body: { error: gate.error } };
  const actor = gate.user;

  const since = windowStart(query.since);
  const limit = boundedLimit(query.limit);

  switch (action) {
    /*
     * Everything at a glance.
     *
     * One request rather than six, because the first thing anybody does on
     * opening a console is look at all of it, and six round trips to draw one
     * screen is how a monitoring page becomes slower than the thing it
     * monitors.
     */
    case 'overview': {
      const telemetry = await store.listTelemetry({ limit: 5000, since });
      const events = await store.listEvents({ limit: 500, since });

      const failedLogins = events.filter((event) => event.kind === 'login-failed').length;
      const logins = events.filter((event) => event.kind === 'login').length;

      return {
        status: 200,
        body: {
          window: { since: new Date(since).toISOString(), until: new Date().toISOString() },
          telemetry: summarise(telemetry),
          accounts: {
            total: (await store.listUsers({ limit: 1000 })).length,
            admins: await store.countByRole('admin'),
            developers: await store.countByRole('developer'),
          },
          auth: {
            logins,
            failedLogins,
            lockouts: events.filter((event) => event.kind === 'lockout').length,
            roleChanges: events.filter((event) => event.kind === 'role-changed').length,
          },
          /*
           * Whether anything is reporting at all.
           *
           * An empty console looks identical whether the deployment is quiet
           * or the reporting path is broken, and those need opposite
           * responses. This says which.
           */
          reporting: telemetry.length > 0,
        },
      };
    }

    /* Projects, assembled from what has been reported about them. */
    case 'projects': {
      const telemetry = await store.listTelemetry({ limit: 5000, since });
      const projects = new Map();

      for (const event of telemetry) {
        if (!event.projectId) continue;
        const row = projects.get(event.projectId) ?? {
          projectId: event.projectId,
          events: 0,
          firstSeen: event.at,
          lastSeen: event.at,
          validation: null,
          exports: 0,
          failures: 0,
          suggestionsOffered: 0,
          suggestionsAccepted: 0,
        };

        row.events += 1;
        // The list arrives newest first, so the earliest thing seen is the
        // last one to be looked at.
        if (event.at < row.firstSeen) row.firstSeen = event.at;
        if (event.at > row.lastSeen) row.lastSeen = event.at;
        // The newest validation wins, which is the one that arrived first.
        if (event.kind === 'validation' && row.validation === null) {
          row.validation = event.detail?.status ?? null;
        }
        if (event.kind === 'export') row.exports += 1;
        if (event.kind === 'export-failed' || event.kind === 'extraction-failed') {
          row.failures += 1;
        }
        if (event.kind === 'suggestion-offered') row.suggestionsOffered += 1;
        if (event.kind === 'suggestion-accepted' || event.kind === 'suggestion-edited') {
          row.suggestionsAccepted += 1;
        }

        projects.set(event.projectId, row);
      }

      return {
        status: 200,
        body: {
          projects: [...projects.values()]
            .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
            .slice(0, limit),
        },
      };
    }

    /* One project's full trace, in the order it happened. */
    case 'project': {
      const projectId = String(query.id ?? body.id ?? '');
      if (projectId.length === 0) return { status: 400, body: { error: 'Which project?' } };

      const events = await store.listTelemetry({ limit: 1000, projectId });
      return {
        status: 200,
        body: {
          projectId,
          // Oldest first here, because a trace is read forwards.
          trace: events.slice().reverse(),
          summary: summarise(events),
        },
      };
    }

    /* Acceptance analytics — the view the architecture calls the important one. */
    case 'suggestions': {
      const telemetry = await store.listTelemetry({
        limit: 5000,
        since,
        kinds: TELEMETRY_KINDS.filter((kind) => kind.startsWith('suggestion-')),
      });
      const summary = summarise(telemetry);
      return {
        status: 200,
        body: { suggestions: summary.suggestions, total: telemetry.length },
      };
    }

    /* Everything that went wrong, most frequent first. */
    case 'errors': {
      const telemetry = await store.listTelemetry({
        limit: 2000,
        since,
        kinds: ['export-failed', 'extraction-failed', 'validation'],
      });

      const reasons = new Map();
      for (const event of telemetry) {
        if (event.kind === 'validation' && event.detail?.status !== 'error') continue;
        const key = `${event.kind}:${event.detail?.reason ?? event.detail?.codes?.[0] ?? 'unknown'}`;
        const row = reasons.get(key) ?? {
          kind: event.kind,
          reason: event.detail?.reason ?? event.detail?.codes?.[0] ?? 'unknown',
          count: 0,
          lastSeen: event.at,
        };
        row.count += 1;
        if (event.at > row.lastSeen) row.lastSeen = event.at;
        reasons.set(key, row);
      }

      return {
        status: 200,
        body: {
          failures: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, limit),
          recent: telemetry.slice(0, 50),
        },
      };
    }

    /* Load and latency. */
    case 'usage': {
      const telemetry = await store.listTelemetry({ limit: 5000, since });
      const summary = summarise(telemetry);

      const byDay = new Map();
      for (const event of telemetry) {
        const day = event.at.slice(0, 10);
        const row = byDay.get(day) ?? { day, events: 0, exports: 0 };
        row.events += 1;
        if (event.kind === 'export') row.exports += 1;
        byDay.set(day, row);
      }

      return {
        status: 200,
        body: {
          stages: summary.stages,
          exports: summary.exports,
          exportFailures: summary.exportFailures,
          exportFailureRate: summary.exportFailureRate,
          byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        },
      };
    }

    /* The audit trail. */
    case 'audit': {
      const kinds =
        typeof query.kinds === 'string' && query.kinds.length > 0
          ? query.kinds.split(',').map((kind) => kind.trim())
          : null;
      const events = await store.listEvents({ limit, since, kinds });
      return { status: 200, body: { events } };
    }

    /* Accounts, and the one thing here that writes. */
    case 'accounts': {
      const users = await store.listUsers({
        limit,
        query: typeof query.q === 'string' ? query.q : '',
      });
      return { status: 200, body: { users, roles: ROLES } };
    }

    case 'set-role': {
      const result = await setRole(store, {
        actor,
        userId: String(body.userId ?? ''),
        role: String(body.role ?? ''),
      });
      if (!result.ok) return { status: result.status, body: { error: result.error } };
      return { status: 200, body: { user: result.user } };
    }

    /*
     * Jurisdiction templates are not served from here, on purpose.
     *
     * They are compiled into the engine, and the engine runs in the browser —
     * so the console reads them from the same module the composer draws with,
     * rather than from a copy this endpoint would have to keep in step. A
     * monitoring surface reporting its own version of the configuration is the
     * one thing worse than no monitoring surface.
     */
    default:
      return { status: 404, body: { error: 'No such view.' } };
  }
}

function windowStart(value) {
  const hours = Number(value);
  if (Number.isFinite(hours) && hours > 0 && hours <= 24 * 90) {
    return Date.now() - hours * 60 * 60 * 1000;
  }
  return Date.now() - DEFAULT_WINDOW_MS;
}

function boundedLimit(value) {
  const limit = Number(value);
  if (Number.isFinite(limit) && limit > 0) return Math.min(Math.floor(limit), 500);
  return 200;
}

/**
 * Take one reported event.
 *
 * Separate from `handleAdmin` because it is the opposite kind of route: any
 * signed-in surveyor may report, and only an admin may read. Keeping them in
 * one switch would put a route anybody can call behind a gate that says
 * `requireAdmin`, which is the sort of arrangement that survives right up
 * until somebody reorders the cases.
 */
export async function handleReport(context) {
  const { store, token, events, now = Date.now() } = context;

  /*
   * A signed-in session is required, and the identity comes from it.
   *
   * Not because the data is precious — it is deliberately shapes rather than
   * contents — but because an open ingest endpoint is a free way to fill
   * somebody's store, and because an event attributed to whoever the *body*
   * claimed would make the console's account column fiction.
   */
  const user = await sessionUser(store, token);
  if (!user) return { status: 401, body: { error: 'Sign in to continue.' } };

  if (!Array.isArray(events)) return { status: 400, body: { error: 'Send an array of events.' } };

  let stored = 0;
  // A cap, so one client cannot fill the log in a single request.
  for (const raw of events.slice(0, 50)) {
    const event = sanitiseEvent(raw, { userId: user.id, role: user.role, now });
    if (!event) continue;
    await store.recordTelemetry({
      id: `${now}-${stored}-${Math.random().toString(36).slice(2, 8)}`,
      ...event,
    });
    stored += 1;
  }

  // 202: taken, and the caller should not wait to find out what became of it.
  // Reporting must never be something the app can be blocked by.
  return { status: 202, body: { stored } };
}
