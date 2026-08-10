/**
 * Provenance — the tag every value on the plan carries.
 *
 * Architecture A.1 §3: "Every label and geometric value carries a source tag."
 * This is a single shared type rather than one per engine, because Part B styles
 * by it (B.13) and the export gate blocks on it (B.7). Two definitions would drift.
 */

/** Who performed a confirmation. Kept opaque here; auth lives outside the contract. */
export interface ActorRef {
  readonly actorId: string;
  readonly displayName?: string;
}

/** ISO-8601 instant, e.g. "2026-08-10T14:03:22Z". */
export type IsoTimestamp = string;

/**
 * Where a value came from.
 *
 * - `measured`       — supplied by survey observation or user data entry.
 * - `calculated`     — derived deterministically by the COGO/CRS engines.
 * - `user-confirmed` — a human explicitly accepted it (the B.7 trust loop).
 * - `ai-suggested`   — proposed by the AI, not yet confirmed. Cannot be exported.
 */
export type ProvenanceSource =
  | 'measured'
  | 'calculated'
  | 'user-confirmed'
  | 'ai-suggested';

export interface Provenance {
  readonly source: ProvenanceSource;
  /** 0–1. Present when the value came from Document AI extraction (A.3). */
  readonly confidence?: number;
  /** Set only on the ai-suggested -> user-confirmed transition. */
  readonly confirmedBy?: ActorRef;
  readonly confirmedAt?: IsoTimestamp;
}

/** True when this value still needs a human before it may reach a finished plan. */
export function requiresConfirmation(p: Provenance): boolean {
  return p.source === 'ai-suggested';
}

/**
 * The only legal provenance transition in the system.
 *
 * `measured` and `calculated` are engine-authored and immutable; there is
 * deliberately no path that promotes a value without a human action, which is
 * what gives the export gate (see label-specification.ts) its meaning.
 */
export function confirm(
  p: Provenance,
  by: ActorRef,
  at: IsoTimestamp,
): Provenance {
  if (p.source !== 'ai-suggested') {
    throw new Error(
      `Only ai-suggested provenance can be confirmed; got "${p.source}".`,
    );
  }
  return { ...p, source: 'user-confirmed', confirmedBy: by, confirmedAt: at };
}
