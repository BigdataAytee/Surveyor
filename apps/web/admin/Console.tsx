/**
 * The admin console.
 *
 * A separate surface, not a hidden tab. It is built and served as its own page,
 * it shares no navigation with the app, and — the part that actually matters —
 * every request it makes is authorised on the server against the role stored
 * for the session. What this file does with roles is decide what to draw. It
 * decides nothing about access, and could not: a person who edits their way
 * past everything here gets the same 404s from the API.
 *
 * It is read-mostly by design. Exactly one control changes anything — granting
 * a role — and that writes an audit event naming who did it. There is no route
 * to edit a plan, so there is no screen for one: an admin who could quietly
 * alter a confirmed bearing would make every plan in the system arguable, and
 * the app's whole provenance model rests on confirmation happening in the
 * surveyor's own hands.
 */

import { useCallback, useEffect, useState } from 'react';

import { JURISDICTIONS } from '@surveyor/engine';

import {
  admin,
  type AdminUser,
  type Answer,
  type AuditEvent,
  type ProjectRow,
  type Role,
  type StageRow,
  type SuggestionRow,
} from './api.js';
import './admin.css';

type View =
  | 'overview'
  | 'projects'
  | 'suggestions'
  | 'errors'
  | 'jurisdictions'
  | 'usage'
  | 'accounts'
  | 'audit';

const VIEWS: readonly { readonly id: View; readonly label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'projects', label: 'Projects' },
  { id: 'suggestions', label: 'AI suggestions' },
  { id: 'errors', label: 'Errors' },
  { id: 'usage', label: 'Usage' },
  { id: 'jurisdictions', label: 'Jurisdictions' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'audit', label: 'Audit' },
];

/** Windows worth looking at, in hours. */
const WINDOWS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '1', label: 'Last hour' },
  { value: '24', label: 'Last 24 hours' },
  { value: '168', label: 'Last 7 days' },
  { value: '720', label: 'Last 30 days' },
];

export function Console() {
  const [view, setView] = useState<View>('overview');
  const [window_, setWindow] = useState('168');
  /** Set when any request comes back unauthorised, which ends the session here. */
  const [locked, setLocked] = useState<{ readonly status: number; readonly error: string } | null>(
    null,
  );

  /*
   * One place that notices a refusal.
   *
   * The console's session is deliberately short — an hour — so being turned
   * away mid-session is normal rather than exceptional, and every view has to
   * handle it. Handling it in each one separately is how three of them end up
   * showing a blank table instead.
   */
  const guard = useCallback(<T,>(answer: Answer<T>): Answer<T> => {
    if (!answer.ok && (answer.status === 401 || answer.status === 404)) {
      setLocked({ status: answer.status, error: answer.error });
    }
    return answer;
  }, []);

  if (locked) return <Locked status={locked.status} />;

  return (
    <div className="console">
      <nav className="nav">
        <div className="nav__brand">
          <h1 className="nav__title">Surveyor Console</h1>
          <p className="nav__who">Monitoring and diagnostics</p>
        </div>

        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`nav__item${view === entry.id ? ' is-active' : ''}`}
            aria-current={view === entry.id ? 'page' : undefined}
            onClick={() => setView(entry.id)}
          >
            {entry.label}
          </button>
        ))}

        <div className="nav__spacer" />
        <div className="nav__foot">
          <p>
            Read-only, except for granting roles. Nothing here can change a
            surveyor’s plan.
          </p>
        </div>
      </nav>

      <main className="main">
        <div className="main__head">
          <div>
            <h2 className="main__title">{VIEWS.find((entry) => entry.id === view)?.label}</h2>
            <p className="main__sub">{SUBTITLES[view]}</p>
          </div>
          {view === 'accounts' || view === 'jurisdictions' ? null : (
            <label>
              <span className="dim">Window </span>
              <select
                value={window_}
                aria-label="Time window"
                onChange={(event) => setWindow(event.target.value)}
              >
                {WINDOWS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {view === 'overview' ? <Overview hours={window_} guard={guard} /> : null}
        {view === 'projects' ? <Projects hours={window_} guard={guard} /> : null}
        {view === 'suggestions' ? <Suggestions hours={window_} guard={guard} /> : null}
        {view === 'errors' ? <Errors hours={window_} guard={guard} /> : null}
        {view === 'usage' ? <Usage hours={window_} guard={guard} /> : null}
        {view === 'jurisdictions' ? <Jurisdictions /> : null}
        {view === 'accounts' ? <Accounts guard={guard} /> : null}
        {view === 'audit' ? <Audit hours={window_} guard={guard} /> : null}
      </main>
    </div>
  );
}

const SUBTITLES: Readonly<Record<View, string>> = {
  overview: 'Pipeline health, error rates and activity at a glance.',
  projects: 'Every project that has reported, and what happened to it.',
  suggestions: 'What the assistant proposed against what surveyors kept.',
  errors: 'Extraction, validation and export failures, most frequent first.',
  usage: 'Load and latency, by stage and by day.',
  jurisdictions: 'The plan templates and compliance rules this build draws to.',
  accounts: 'Who has an account, and what role they hold.',
  audit: 'Every sign-in, failure, lockout and role change, as it happened.',
};

/** The gate's own screen, for a session the server will not answer. */
function Locked({ status }: { readonly status: number }) {
  return (
    <div className="gate">
      <div className="gate__card">
        <h1>{status === 401 ? 'Sign in to continue' : 'Nothing here'}</h1>
        <p>
          {status === 401
            ? 'The console needs a signed-in account with a developer or administrator role. ' +
              'Console sessions are deliberately short and end sooner than the app’s.'
            : 'This account cannot see the console. If that is wrong, an administrator can ' +
              'grant the role.'}
        </p>
        <p>
          <a href="/">Back to Surveyor</a>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading one view's data
// ---------------------------------------------------------------------------

type Guard = <T>(answer: Answer<T>) => Answer<T>;

/**
 * Fetch, with the three states a screen actually has.
 *
 * Loading, failed and loaded are kept apart on purpose: a console that renders
 * an empty table while it is still fetching says "nothing is happening", which
 * is the single most misleading thing a monitoring surface can say.
 */
function useAnswer<T>(load: () => Promise<Answer<T>>, deps: readonly unknown[]) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'failed'; error: string } | { kind: 'loaded'; data: T }
  >({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    void load().then((answer) => {
      if (!live) return;
      setState(answer.ok ? { kind: 'loaded', data: answer.data } : { kind: 'failed', error: answer.error });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

function Frame<T>({
  state,
  children,
}: {
  readonly state: { kind: 'loading' } | { kind: 'failed'; error: string } | { kind: 'loaded'; data: T };
  readonly children: (data: T) => React.ReactNode;
}) {
  if (state.kind === 'loading') return <p className="dim">Loading…</p>;
  if (state.kind === 'failed') return <p className="notice">{state.error}</p>;
  return <>{children(state.data)}</>;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function Overview({ hours, guard }: { readonly hours: string; readonly guard: Guard }) {
  const state = useAnswer(() => admin.overview(hours).then(guard), [hours]);

  return (
    <Frame state={state}>
      {(data) => (
        <>
          {!data.reporting ? (
            /*
             * The difference between quiet and broken.
             *
             * An empty console looks identical either way and the two need
             * opposite responses, so it is said rather than left to be
             * guessed at from a screen full of zeroes.
             */
            <div className="notice">
              <strong>Nothing has reported in this window.</strong> Either the deployment is
              quiet, or the app is built without <code>VITE_ADMIN_ENDPOINT</code> and is not
              reporting at all.
            </div>
          ) : null}

          <div className="tiles">
            <Tile label="Projects" value={data.telemetry.projects} />
            <Tile label="Events" value={data.telemetry.events} />
            <Tile label="Exports" value={data.telemetry.exports} />
            <Tile
              label="Export failures"
              value={data.telemetry.exportFailures}
              tone={data.telemetry.exportFailures > 0 ? 'bad' : 'good'}
              note={percent(data.telemetry.exportFailureRate) ?? undefined}
            />
            <Tile label="Accounts" value={data.accounts.total} note={`${data.accounts.admins} admin, ${data.accounts.developers} developer`} />
            <Tile label="Sign-ins" value={data.auth.logins} />
            <Tile
              label="Failed sign-ins"
              value={data.auth.failedLogins}
              tone={data.auth.failedLogins > data.auth.logins ? 'bad' : undefined}
              note={data.auth.lockouts > 0 ? `${data.auth.lockouts} lockouts` : undefined}
            />
            <Tile label="Role changes" value={data.auth.roleChanges} />
          </div>

          <section className="section">
            <h3 className="section__title">Validation, across all projects</h3>
            {data.telemetry.validationCodes.length === 0 ? (
              <p className="dim">Nothing has failed validation in this window.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th className="num">Occurrences</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.telemetry.validationCodes.map((row) => (
                      <tr key={row.code}>
                        <td className="mono">{row.code}</td>
                        <td className="num">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="dim" style={{ marginTop: 6 }}>
              A code that dominates this table across many projects is usually a bug in the
              system rather than many bad surveys — a unit conversion, or a tolerance set wrong.
            </p>
          </section>

          <SuggestionTable rows={data.telemetry.suggestions} />
        </>
      )}
    </Frame>
  );
}

function Projects({ hours, guard }: { readonly hours: string; readonly guard: Guard }) {
  const [open, setOpen] = useState<string | null>(null);
  const state = useAnswer(() => admin.projects(hours).then(guard), [hours]);

  if (open) return <ProjectDetail id={open} guard={guard} onBack={() => setOpen(null)} />;

  return (
    <Frame state={state}>
      {(data) =>
        data.projects.length === 0 ? (
          <p className="dim">No project has reported in this window.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Validation</th>
                  <th className="num">Events</th>
                  <th className="num">Suggested</th>
                  <th className="num">Kept</th>
                  <th className="num">Exports</th>
                  <th className="num">Failures</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((row: ProjectRow) => (
                  <tr key={row.projectId}>
                    <td>
                      <button type="button" className="link mono" onClick={() => setOpen(row.projectId)}>
                        {row.projectId}
                      </button>
                    </td>
                    <td>
                      <Status value={row.validation} />
                    </td>
                    <td className="num">{row.events}</td>
                    <td className="num">{row.suggestionsOffered}</td>
                    <td className="num">{row.suggestionsAccepted}</td>
                    <td className="num">{row.exports}</td>
                    <td className="num">{row.failures || ''}</td>
                    <td className="dim">{when(row.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </Frame>
  );
}

function ProjectDetail({
  id,
  guard,
  onBack,
}: {
  readonly id: string;
  readonly guard: Guard;
  readonly onBack: () => void;
}) {
  const state = useAnswer(() => admin.project(id).then(guard), [id]);

  return (
    <>
      <p>
        <button type="button" className="link" onClick={onBack}>
          ← All projects
        </button>
      </p>
      <Frame state={state}>
        {(data) => (
          <>
            <p className="dim">
              <span className="mono">{data.projectId}</span> — {data.trace.length} events. This is
              everything the app reported about it, oldest first.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Event</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trace.map((event, index) => (
                    <tr key={`${event.at}-${index}`}>
                      <td className="dim mono">{event.at.replace('T', ' ').slice(0, 19)}</td>
                      <td>{event.kind}</td>
                      <td className="mono dim">{describe(event.detail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="dim" style={{ marginTop: 8 }}>
              Only shapes are reported — codes, counts, timings. No coordinate, name or note from
              the plan itself ever reaches this console.
            </p>
          </>
        )}
      </Frame>
    </>
  );
}

function Suggestions({ hours, guard }: { readonly hours: string; readonly guard: Guard }) {
  const state = useAnswer(() => admin.suggestions(hours).then(guard), [hours]);
  return (
    <Frame state={state}>
      {(data) => (
        <>
          <SuggestionTable rows={data.suggestions} />
          <p className="dim">
            A type being edited often is a different problem from one being refused: edited means
            nearly right and worth tuning, refused means unwanted.
          </p>
        </>
      )}
    </Frame>
  );
}

function SuggestionTable({ rows }: { readonly rows: readonly SuggestionRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="section">
        <h3 className="section__title">AI suggestions</h3>
        <p className="dim">Nothing has been suggested in this window.</p>
      </section>
    );
  }

  return (
    <section className="section">
      <h3 className="section__title">AI suggestions</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th className="num">Offered</th>
              <th className="num">Accepted</th>
              <th className="num">Edited</th>
              <th className="num">Rejected</th>
              <th className="num">Kept</th>
              <th className="num">Edited rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.type}>
                <td className="mono">{row.type}</td>
                <td className="num">{row.offered}</td>
                <td className="num">{row.accepted}</td>
                <td className="num">{row.edited}</td>
                <td className="num">{row.rejected}</td>
                <td className="num">{percent(row.acceptanceRate) ?? <span className="dim">—</span>}</td>
                <td className="num">{percent(row.editRate) ?? <span className="dim">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Errors({ hours, guard }: { readonly hours: string; readonly guard: Guard }) {
  const state = useAnswer(() => admin.errors(hours).then(guard), [hours]);

  return (
    <Frame state={state}>
      {(data) =>
        data.failures.length === 0 ? (
          <p className="dim">Nothing has failed in this window.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Reason</th>
                  <th className="num">Count</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.failures.map((row) => (
                  <tr key={`${row.kind}:${row.reason}`}>
                    <td>{row.kind}</td>
                    <td className="mono">{row.reason}</td>
                    <td className="num">{row.count}</td>
                    <td className="dim">{when(row.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </Frame>
  );
}

function Usage({ hours, guard }: { readonly hours: string; readonly guard: Guard }) {
  const state = useAnswer(() => admin.usage(hours).then(guard), [hours]);

  return (
    <Frame state={state}>
      {(data) => (
        <>
          <div className="tiles">
            <Tile label="Exports" value={data.exports} />
            <Tile
              label="Export failure rate"
              value={percent(data.exportFailureRate) ?? '—'}
              tone={(data.exportFailureRate ?? 0) > 0.05 ? 'bad' : undefined}
            />
          </div>

          <section className="section">
            <h3 className="section__title">Pipeline stages</h3>
            {data.stages.length === 0 ? (
              <p className="dim">No stage timings reported.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th className="num">Runs</th>
                      <th className="num">Average</th>
                      <th className="num">Worst</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stages.map((row: StageRow) => (
                      <tr key={row.stage}>
                        <td className="mono">{row.stage}</td>
                        <td className="num">{row.runs}</td>
                        <td className="num">{row.averageMs.toFixed(1)} ms</td>
                        <td className="num">{row.worstMs.toFixed(1)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="dim" style={{ marginTop: 6 }}>
              The worst case is shown beside the average because the average hides the one run
              somebody was sitting in front of.
            </p>
          </section>

          <section className="section">
            <h3 className="section__title">By day</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Events</th>
                    <th className="num">Exports</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byDay.map((row) => (
                    <tr key={row.day}>
                      <td className="mono">{row.day}</td>
                      <td className="num">{row.events}</td>
                      <td className="num">{row.exports}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </Frame>
  );
}

/**
 * The jurisdiction templates, read from the engine this page bundles.
 *
 * Not fetched from the API, because the engine runs in the browser: this
 * module *is* the one the composer draws with, so what is shown here cannot
 * drift from what plans are actually made to. An endpoint would only be a
 * second copy to keep in step.
 *
 * Read-only, and that is a real limitation rather than an unfinished screen —
 * see the note the page itself carries.
 */
function Jurisdictions() {
  const templates = [...JURISDICTIONS.values()];

  return (
    <>
      <div className="notice">
        <strong>These are compiled into the build.</strong> Changing one is a code change and a
        deploy, deliberately: they govern legal compliance for every plan drawn under them, and a
        rule that could be edited at runtime would change under plans already in progress with no
        review and no version anybody could point at afterwards.
      </div>

      {templates.map((template) => (
        <section className="section" key={template.id}>
          <h3 className="section__title">
            {template.name} <span className="dim mono">{template.id}</span>
          </h3>
          <div className="table-wrap">
            <table>
              <tbody>
                <tr>
                  <th>Sheets</th>
                  <td>
                    {template.preferredSheets.join(', ')} · {template.defaultOrientation}
                  </td>
                </tr>
                <tr>
                  <th>Bearings</th>
                  <td>{template.bearingConvention}</td>
                </tr>
                <tr>
                  <th>Closure tolerance</th>
                  <td className="mono">
                    1:{template.closureTolerance.minimumRatio} · max{' '}
                    {template.closureTolerance.maximumMisclosure} m
                  </td>
                </tr>
                <tr>
                  <th>Minimum label height</th>
                  <td className="mono">{template.minimumLabelHeightMm} mm</td>
                </tr>
                <tr>
                  <th>Legend</th>
                  <td>{template.legendRequired ? 'required' : 'optional'}</td>
                </tr>
                <tr>
                  <th>Title block</th>
                  <td style={{ whiteSpace: 'normal' }}>
                    {template.titleBlock
                      .map((field) => `${field.label}${field.required ? '' : ' (optional)'}`)
                      .join(' · ')}
                  </td>
                </tr>
                <tr>
                  <th>Required notes</th>
                  <td style={{ whiteSpace: 'normal' }}>
                    {template.requiredNotes.length === 0 ? (
                      <span className="dim">none</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 16 }}>
                        {template.requiredNotes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

function Accounts({ guard }: { readonly guard: Guard }) {
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const state = useAnswer(() => admin.accounts(query).then(guard), [query, version]);

  async function grant(user: AdminUser, role: Role): Promise<void> {
    setError(null);
    const answer = await admin.setRole(user.id, role);
    if (!answer.ok) {
      setError(answer.error);
      return;
    }
    setVersion((n) => n + 1);
  }

  return (
    <>
      <div className="notice">
        Changing a role signs that person out everywhere and is written to the audit trail with
        your address against it. Only an administrator can do it — a developer can read this page
        and not act on it.
      </div>

      <p>
        <input
          type="search"
          aria-label="Search accounts by email"
          placeholder="Search by email"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </p>

      {error ? <p className="notice">{error}</p> : null}

      <Frame state={state}>
        {(data) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Confirmed</th>
                  <th>Created</th>
                  <th>Last signed in</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr key={user.id}>
                    <td className="mono">{user.email}</td>
                    <td>{user.name ?? <span className="dim">—</span>}</td>
                    <td>
                      <select
                        value={user.role}
                        aria-label={`Role for ${user.email}`}
                        onChange={(event) => void grant(user, event.target.value as Role)}
                      >
                        {data.roles.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className={`badge badge--${user.emailVerified ? 'good' : 'warn'}`}>
                        {user.emailVerified ? 'yes' : 'no'}
                      </span>
                    </td>
                    <td className="dim">{when(user.createdAt)}</td>
                    <td className="dim">
                      {user.lastLoginAt ? when(user.lastLoginAt) : <span className="dim">never</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Frame>
    </>
  );
}

function Audit({ hours, guard }: { readonly hours: string; readonly guard: Guard }) {
  const [kinds, setKinds] = useState('');
  const state = useAnswer(() => admin.audit(hours, kinds || undefined).then(guard), [hours, kinds]);

  return (
    <>
      <p>
        <label>
          <span className="dim">Show </span>
          <select value={kinds} aria-label="Event kinds" onChange={(event) => setKinds(event.target.value)}>
            <option value="">Everything</option>
            <option value="login,logout">Sign-ins</option>
            <option value="login-failed,lockout,login-blocked">Failures and lockouts</option>
            <option value="role-changed">Role changes</option>
            <option value="signup,email-verified">New accounts</option>
            <option value="password-changed,password-reset,password-reset-requested">Passwords</option>
          </select>
        </label>
      </p>

      <Frame state={state}>
        {(data) =>
          data.events.length === 0 ? (
            <p className="dim">Nothing in this window.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Event</th>
                    <th>Account</th>
                    <th>By</th>
                    <th>Detail</th>
                    <th>From</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((event: AuditEvent) => (
                    <tr key={event.id}>
                      <td className="dim mono">{event.at.replace('T', ' ').slice(0, 19)}</td>
                      <td>
                        <span className={`badge badge--${auditTone(event.kind)}`}>{event.kind}</span>
                      </td>
                      <td className="mono">{event.email ?? <span className="dim">—</span>}</td>
                      <td className="mono dim">{event.actorEmail ?? ''}</td>
                      <td className="dim">{event.detail ?? ''}</td>
                      <td className="dim mono">{event.ip ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Frame>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Tile({
  label,
  value,
  note,
  tone,
}: {
  readonly label: string;
  readonly value: number | string;
  readonly note?: string | undefined;
  readonly tone?: 'good' | 'bad' | undefined;
}) {
  return (
    <div className="tile">
      <div className="tile__label">{label}</div>
      <div className={`tile__value${tone ? ` is-${tone}` : ''}`}>{value}</div>
      {note ? <div className="tile__note">{note}</div> : null}
    </div>
  );
}

function Status({ value }: { readonly value: string | null }) {
  if (!value) return <span className="dim">—</span>;
  return <span className={`badge badge--${value}`}>{value}</span>;
}

function auditTone(kind: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (kind === 'login' || kind === 'signup' || kind === 'email-verified') return 'good';
  if (kind === 'login-failed' || kind === 'login-blocked') return 'warn';
  if (kind === 'lockout' || kind === 'role-changed') return 'bad';
  return 'muted';
}

/** A percentage, or null when there is no data — which is not the same as 0%. */
function percent(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return `${(value * 100).toFixed(0)}%`;
}

function when(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;

  const ago = Date.now() - at;
  const minutes = Math.round(ago / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return iso.slice(0, 10);
}

/** A detail object as one readable line. Values only, because that is all there is. */
function describe(detail: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(detail).map(([key, value]) =>
    `${key}=${Array.isArray(value) ? value.join('|') : String(value)}`,
  );
  return parts.join('  ') || '—';
}
