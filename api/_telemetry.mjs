/**
 * What the app is allowed to report, and what it must never.
 *
 * The admin console can only show what the app tells it, and the architecture
 * is explicit that this reporting has to happen at the point suggestions are
 * made and accepted rather than be reconstructed afterwards. So the app sends
 * events. The question this file answers is which ones, and containing what.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 *
 * A telemetry event carries *shapes*, never *contents*. Codes, kinds, counts,
 * durations and identifiers — never a coordinate, a bearing, an owner's name,
 * a site address, a note, or any text a surveyor typed.
 *
 * That is not caution for its own sake. The console is a monitoring surface
 * with a wider audience than any one project: whoever can read it can read
 * every deployment's plans at once. A field that leaks one client's parcel
 * into it leaks all of them, and "we only look at it for debugging" is not a
 * control. So this validator is a whitelist, applied on the *server*, and
 * anything it does not recognise is dropped rather than stored.
 *
 * The client is not trusted to obey the rule. It is written to, and then this
 * enforces it anyway — because the client is code anybody can edit, and the
 * store is what has to be safe.
 */

/** Events the console knows how to read. Anything else is discarded. */
export const TELEMETRY_KINDS = [
  /** The assistant proposed something. `detail.suggestion` says what type. */
  'suggestion-offered',
  /** The surveyor took it as offered. */
  'suggestion-accepted',
  /** The surveyor changed it, then kept it — the interesting one. */
  'suggestion-edited',
  /** The surveyor said no. */
  'suggestion-rejected',
  /** A run through the engine finished. `detail.status`, `detail.codes`. */
  'validation',
  /** A plan reached a file. `detail.format`. */
  'export',
  /** An export did not. `detail.reason`. */
  'export-failed',
  /** A photograph or document was read. `detail.confidence`, `detail.fields`. */
  'extraction',
  /** Or was not. `detail.reason`. */
  'extraction-failed',
  /** A stage of the pipeline finished. `detail.stage`, `detail.ms`. */
  'pipeline',
];

/** Suggestion types the console reports acceptance rates for. */
export const SUGGESTION_TYPES = [
  'title',
  'representative-fraction',
  'scale-bar',
  'label-placement',
  'area-mismatch',
  'building',
  'note',
  'boundary-closure',
];

/**
 * Fields a `detail` may contain, and what each must be.
 *
 * A whitelist rather than a denylist, for the same reason `publicUser` builds
 * its result by hand: a denylist lets the next field added leak by default,
 * and the next field added is exactly the one nobody thought about.
 */
const DETAIL_FIELDS = {
  suggestion: (value) => SUGGESTION_TYPES.includes(value),
  // The engine's own words, not a translation of them — a second
  // vocabulary is a second thing to keep in step, and the console would end
  // up reporting a status the app never produces.
  status: (value) => ['ready', 'needs-review', 'error'].includes(value),
  stage: (value) =>
    ['crs', 'cogo', 'validation', 'drawing', 'labeling', 'compose'].includes(value),
  format: (value) => ['pdf', 'dxf', 'svg', 'png'].includes(value),
  reason: (value) => typeof value === 'string' && value.length <= 64 && !/\s/.test(value),
  /** Validation codes, which are a closed set of slugs. */
  codes: (value) =>
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((code) => typeof code === 'string' && code.length <= 40 && !/\s/.test(code)),
  ms: (value) => Number.isFinite(value) && value >= 0 && value < 3_600_000,
  points: (value) => Number.isInteger(value) && value >= 0 && value < 100_000,
  confidence: (value) => Number.isFinite(value) && value >= 0 && value <= 1,
  fields: (value) => Number.isInteger(value) && value >= 0 && value < 10_000,
  closureMm: (value) => Number.isFinite(value) && value >= 0,
};

/**
 * An identifier that identifies a project without describing one.
 *
 * The app's own project ids are opaque strings it generated, which is what is
 * wanted — but the length and character checks are here because "opaque id"
 * is exactly the field somebody eventually puts a site address in.
 */
function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[\w.:-]+$/.test(value);
}

/**
 * Clean one reported event, or return null to drop it.
 *
 * Built field by field into a fresh object. Nothing from the request survives
 * into the stored record unless it was named here and passed its own check —
 * so an extra property invented by a modified client has nowhere to land.
 */
export function sanitiseEvent(raw, { userId = null, role = null, now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (!TELEMETRY_KINDS.includes(raw.kind)) return null;
  if (raw.projectId !== undefined && raw.projectId !== null && !validId(raw.projectId)) return null;

  const detail = {};
  if (raw.detail && typeof raw.detail === 'object') {
    for (const [key, check] of Object.entries(DETAIL_FIELDS)) {
      const value = raw.detail[key];
      if (value === undefined) continue;
      // A field that fails its check drops that field, not the event. The
      // event is still evidence something happened, and that is the part the
      // console cannot reconstruct later.
      if (check(value)) detail[key] = value;
    }
  }

  return {
    at: new Date(now).toISOString(),
    kind: raw.kind,
    projectId: raw.projectId ?? null,
    // Taken from the session, never from the body — otherwise anybody could
    // file events against anybody's account.
    userId,
    role,
    detail,
  };
}

/**
 * Aggregate telemetry into the numbers the console's Overview shows.
 *
 * Done on the server so every view agrees on what an acceptance rate is. Two
 * screens computing the same rate two ways is how a monitoring surface ends up
 * being argued with instead of trusted.
 */
export function summarise(events) {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);

  const suggestions = new Map();
  const validationCodes = new Map();
  const stages = new Map();
  const projects = new Set();
  let exports_ = 0;
  let exportFailures = 0;

  for (const event of events) {
    bump(event.kind);
    if (event.projectId) projects.add(event.projectId);

    const type = event.detail?.suggestion;
    if (type && event.kind.startsWith('suggestion-')) {
      const row = suggestions.get(type) ?? { offered: 0, accepted: 0, edited: 0, rejected: 0 };
      if (event.kind === 'suggestion-offered') row.offered += 1;
      if (event.kind === 'suggestion-accepted') row.accepted += 1;
      if (event.kind === 'suggestion-edited') row.edited += 1;
      if (event.kind === 'suggestion-rejected') row.rejected += 1;
      suggestions.set(type, row);
    }

    if (event.kind === 'validation') {
      for (const code of event.detail?.codes ?? []) {
        validationCodes.set(code, (validationCodes.get(code) ?? 0) + 1);
      }
    }

    if (event.kind === 'pipeline' && event.detail?.stage && Number.isFinite(event.detail.ms)) {
      const row = stages.get(event.detail.stage) ?? { runs: 0, totalMs: 0, worstMs: 0 };
      row.runs += 1;
      row.totalMs += event.detail.ms;
      row.worstMs = Math.max(row.worstMs, event.detail.ms);
      stages.set(event.detail.stage, row);
    }

    if (event.kind === 'export') exports_ += 1;
    if (event.kind === 'export-failed') exportFailures += 1;
  }

  return {
    events: events.length,
    projects: projects.size,
    counts: Object.fromEntries(counts),
    suggestions: [...suggestions.entries()]
      .map(([type, row]) => ({
        type,
        ...row,
        /*
         * Null rather than zero when nothing was offered.
         *
         * A rate of 0% and "no data yet" look identical on a dashboard and
         * mean opposite things — one says the suggestion is wrong, the other
         * says nobody has seen it.
         */
        acceptanceRate: row.offered > 0 ? (row.accepted + row.edited) / row.offered : null,
        editRate: row.offered > 0 ? row.edited / row.offered : null,
      }))
      .sort((a, b) => b.offered - a.offered),
    validationCodes: [...validationCodes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    stages: [...stages.entries()]
      .map(([stage, row]) => ({
        stage,
        runs: row.runs,
        averageMs: row.totalMs / row.runs,
        worstMs: row.worstMs,
      }))
      .sort((a, b) => b.averageMs - a.averageMs),
    exports: exports_,
    exportFailures,
    exportFailureRate:
      exports_ + exportFailures > 0 ? exportFailures / (exports_ + exportFailures) : null,
  };
}
