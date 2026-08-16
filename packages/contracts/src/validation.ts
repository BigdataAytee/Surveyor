/**
 * Validation contract — Part A's Validation Engine output, and the exact shape
 * the ValidationSheet renders (Part C mapping row 2).
 *
 * A.1 §4: errors are surfaced, not hidden. Nothing here is auto-corrected, so
 * every issue carries the plain-language text the UI shows a novice.
 */

/** Maps to the three UI states in B.11: ✓ Ready / ⚠ Needs review / ✕ Error. */
export type ValidationStatus = 'ready' | 'needs-review' | 'error';

export type ValidationCode =
  | 'closure-out-of-tolerance'
  | 'crs-undetermined'
  | 'crs-inconsistent'
  | 'self-intersection'
  | 'duplicate-point'
  | 'zero-length-segment'
  | 'required-label-dropped'
  | 'label-subject-unresolved'
  | 'low-confidence-extraction'
  /**
   * A stated area and the computed one disagree.
   *
   * Reported, never resolved. Which of the two is right is a question about
   * the deed, the fence and the ground — not about arithmetic — and an app
   * that picked one would be answering a question it cannot see.
   */
  | 'area-mismatch';

/**
 * What the user may do about an issue. The Validation Engine never picks for
 * them — "accept/adjust/reject options" per A.1 §4.
 */
export type ResolutionOption = 'accept' | 'adjust' | 'reject' | 'confirm';

export interface ValidationIssue {
  readonly code: ValidationCode;
  readonly severity: Exclude<ValidationStatus, 'ready'>;
  /** Plain language, novice-readable. This is rendered verbatim (B.10). */
  readonly message: string;
  /** Ids of the points, segments, features, or labels involved. */
  readonly subjects: readonly string[];
  readonly options: readonly ResolutionOption[];
  /** Engine detail for the expandable technical view. */
  readonly detail?: string;
}

/** Traverse closure, reported whether or not it passes. */
export interface ClosureReport {
  readonly ringId: string;
  /** Linear misclosure in CRS units. */
  readonly misclosure: number;
  /** Denominator of the precision ratio, e.g. 8500 for 1:8500. */
  readonly precisionRatio: number;
  /** The configured tolerance this was tested against. */
  readonly tolerance: number;
  readonly withinTolerance: boolean;
}

export interface ValidationReport {
  readonly status: ValidationStatus;
  readonly issues: readonly ValidationIssue[];
  readonly closure: readonly ClosureReport[];
}

/** Status is driven by the worst issue present — never set independently. */
export function statusFor(
  issues: readonly ValidationIssue[],
): ValidationStatus {
  if (issues.some((i) => i.severity === 'error')) return 'error';
  if (issues.length > 0) return 'needs-review';
  return 'ready';
}
