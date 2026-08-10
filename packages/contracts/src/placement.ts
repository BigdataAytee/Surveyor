/**
 * Placement results — what the deterministic half of the Labeling Engine
 * returns, and what the canvas hit-tests and highlights against (B.13).
 */

import type { LabelSpecification } from './label-specification.js';

/** A position on the composed sheet, in plan units. Engine-authored only. */
export interface PlanPoint {
  readonly x: number;
  readonly y: number;
}

export interface BoundingBox {
  readonly min: PlanPoint;
  readonly max: PlanPoint;
}

export interface LeaderLine {
  readonly from: PlanPoint;
  readonly to: PlanPoint;
  readonly elbow?: PlanPoint;
}

/**
 * `displaced` and `placed-with-leader` are ordinary drafting outcomes needing
 * no user attention. `dropped` on an optional label is a quiet note; `dropped`
 * on a required label becomes a ValidationIssue.
 */
export type PlacementOutcome =
  | 'placed'
  | 'placed-with-leader'
  | 'displaced'
  | 'dropped';

/**
 * The specification is carried rather than flattened, so the UI can always show
 * intent alongside outcome — and `spec.id` stays the join key between an AI
 * message and the object it highlights on the canvas.
 */
export interface PlacedLabel {
  readonly spec: LabelSpecification;
  /** Final rendered string, produced by the engine from the model. */
  readonly text: string;
  readonly position: PlanPoint;
  /** Degrees, counter-clockwise from horizontal. */
  readonly rotation: number;
  readonly bounds: BoundingBox;
  readonly outcome: PlacementOutcome;
  readonly leader?: LeaderLine;
  /** Required whenever outcome is not "placed". */
  readonly reason?: string;
}

export interface PlacementResult {
  readonly labels: readonly PlacedLabel[];
  /** Subjects that could not be resolved against the Survey Data Model. */
  readonly unresolved: readonly { labelId: string; message: string }[];
}
