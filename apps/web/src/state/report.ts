/**
 * Telling the system what happened.
 *
 * The Admin Console architecture is explicit that this has to happen where the
 * thing happens — at the moment a suggestion is offered and at the moment it
 * is accepted or refused — rather than be reconstructed afterwards from
 * whatever is left behind. Reconstruction is guessing, and an audit trail that
 * is a guess is worse than none, because it looks like evidence.
 *
 * ---------------------------------------------------------------------------
 * What goes in one
 * ---------------------------------------------------------------------------
 *
 * Shapes, never contents. A kind, a suggestion type, a validation code, a
 * count, a duration, an opaque project id — and no coordinate, no bearing, no
 * name, no address, no note anybody typed. The server enforces this with a
 * whitelist as well; it is written here because the first place to not send
 * somebody's parcel is the place that would have sent it.
 *
 * ---------------------------------------------------------------------------
 * What it must never do
 * ---------------------------------------------------------------------------
 *
 * Cost the app anything. Reporting is fire-and-forget over `sendBeacon` where
 * that exists and a background `fetch` otherwise; nothing awaits it, nothing
 * retries it forever, and a deployment with no endpoint at all simply drops
 * every event on the floor. A surveyor on a site with no signal must not
 * notice that this exists.
 */

/*
 * Read defensively, because this module is imported by the unit tests.
 *
 * `import.meta.env` is Vite's, and does not exist when the compiled output is
 * run under plain Node — so `import.meta.env.X` throws on the *object* rather
 * than yielding undefined, and takes down every test that transitively imports
 * this. The optional chain costs nothing and keeps the store's tests able to
 * import the store.
 */
const ADMIN_ENDPOINT: string | null =
  (import.meta.env?.VITE_ADMIN_ENDPOINT as string | undefined)?.trim() || null;

export type ReportKind =
  | 'suggestion-offered'
  | 'suggestion-accepted'
  | 'suggestion-edited'
  | 'suggestion-rejected'
  | 'validation'
  | 'export'
  | 'export-failed'
  | 'extraction'
  | 'extraction-failed'
  | 'pipeline';

export type SuggestionType =
  | 'title'
  | 'representative-fraction'
  | 'scale-bar'
  | 'label-placement'
  | 'area-mismatch'
  | 'building'
  | 'note'
  | 'boundary-closure';

/**
 * The only fields an event may carry.
 *
 * Spelled out as a type rather than `Record<string, unknown>`, so that adding
 * a field to a call site is a compile error rather than a silent leak that
 * the server quietly drops and nobody notices until the console is missing
 * the thing it was supposed to show.
 */
export interface ReportDetail {
  readonly suggestion?: SuggestionType;
  readonly status?: 'ready' | 'needs-review' | 'error';
  readonly stage?: 'crs' | 'cogo' | 'validation' | 'drawing' | 'labeling' | 'compose';
  readonly format?: 'pdf' | 'dxf' | 'svg' | 'png';
  /** A slug. Never a message, and never a path. */
  readonly reason?: string;
  readonly codes?: readonly string[];
  readonly ms?: number;
  readonly points?: number;
  readonly confidence?: number;
  readonly fields?: number;
  readonly closureMm?: number;
}

interface Pending {
  readonly kind: ReportKind;
  readonly projectId: string | null;
  readonly detail: ReportDetail;
}

/*
 * Batched, and sent on a timer.
 *
 * A request per event would mean a request per keystroke-shaped interaction,
 * which is both wasteful and a good way to be rate limited by somebody's
 * proxy. The delay is short enough that the console is close to live and long
 * enough that a burst — a plan validating, then drawing, then labelling —
 * leaves as one.
 */
const queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_AFTER_MS = 4000;
const MAX_QUEUE = 100;

export function report(kind: ReportKind, projectId: string | null, detail: ReportDetail = {}): void {
  if (!ADMIN_ENDPOINT) return;

  /*
   * A ceiling, so a loop that reports cannot grow without bound.
   *
   * The newest are kept rather than the oldest: if something is going wrong
   * right now, the events describing it are the ones worth having.
   */
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ kind, projectId, detail });

  timer ??= setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_AFTER_MS);
}

/**
 * Send whatever is waiting.
 *
 * Exported because a page being closed is exactly when the last few events
 * matter and exactly when a timer will never fire.
 */
export function flush(): void {
  if (!ADMIN_ENDPOINT || queue.length === 0) return;

  const events = queue.splice(0, queue.length);
  const body = JSON.stringify({ events });
  const url = `${ADMIN_ENDPOINT}?action=report`;

  /*
   * `sendBeacon` first, because it is the only one the browser promises to
   * finish after the page is gone. It carries cookies, which is what
   * identifies the account — and it cannot set a content type other than a
   * few, so the server reads the body rather than trusting the header.
   */
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const sent = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    if (sent) return;
  }

  void fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body,
    // Dropped on failure. A retry queue for telemetry is a way to spend a
    // surveyor's data allowance on something that is not their survey.
    keepalive: true,
  }).catch(() => {
    /* see above */
  });
}

if (typeof window !== 'undefined' && ADMIN_ENDPOINT) {
  // `pagehide` rather than `unload`, which is not fired at all on mobile
  // Safari and is the reason "we send on unload" quietly loses phone traffic.
  window.addEventListener('pagehide', flush);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/** Whether this build reports at all. Used to say so in the console. */
export const reportingEnabled = ADMIN_ENDPOINT !== null;
