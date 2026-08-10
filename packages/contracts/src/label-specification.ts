/**
 * LabelSpecification — the contract between the AI layer and the Label
 * Placement Engine (Architecture A.3), and the object the canvas highlights
 * against (B.13).
 *
 * See docs/contracts/LABEL_SPECIFICATION.md for the rationale. The short
 * version: this object lets the AI express a complete labelling intent while
 * holding zero geometric or numeric authority.
 */

import type { Provenance } from './provenance.js';
import { requiresConfirmation } from './provenance.js';
import type { FeatureId, PointId, RingId } from './survey-data-model.js';

export type LabelId = string;
export type TemplateId = string;

// ---------------------------------------------------------------------------
// Subject — a reference into the Survey Data Model, never coordinates
// ---------------------------------------------------------------------------

/**
 * Invariant I1: there is no coordinate field in this union, so the AI cannot
 * author a position. Resolution against the validated model happens in the
 * placement engine and either succeeds or fails loudly — an unresolved subject
 * has no fallback position to degrade into.
 */
export type LabelSubject =
  | { readonly kind: 'point'; readonly pointId: PointId }
  | { readonly kind: 'segment'; readonly from: PointId; readonly to: PointId }
  | { readonly kind: 'ring'; readonly ringId: RingId }
  | { readonly kind: 'feature'; readonly featureId: FeatureId }
  /** Page-anchored text: notes, legend entries, title-block content. */
  | { readonly kind: 'sheet' };

// ---------------------------------------------------------------------------
// Role and priority
// ---------------------------------------------------------------------------

export type LabelRole =
  | 'point-id'
  | 'dimension'
  | 'bearing'
  | 'road-name'
  | 'access'
  | 'feature-name'
  | 'coordinate'
  | 'area'
  | 'curve-data'
  | 'note';

/** Placement precedence, per A.3. Lower wins contested space. */
export type LabelPriority = 1 | 2 | 3;

/**
 * Default tier for each role. The jurisdiction template may override this —
 * a jurisdiction requiring marginal coordinates promotes `coordinate` out of
 * tier 3 — and the override is recorded so the UI can explain why a label moved.
 */
export const DEFAULT_PRIORITY: Readonly<Record<LabelRole, LabelPriority>> = {
  'point-id': 1,
  dimension: 1,
  bearing: 1,
  'road-name': 2,
  access: 2,
  'feature-name': 2,
  coordinate: 3,
  area: 3,
  'curve-data': 3,
  note: 3,
};

// ---------------------------------------------------------------------------
// Content — derived by default, literal by exception
// ---------------------------------------------------------------------------

/** A pointer into the Survey Data Model. Deliberately not a value. */
export interface ValueRef {
  readonly ref: string;
}

/**
 * Invariant I2: in `derived` mode the AI supplies a template id and references,
 * never a rendered string. The engine reads the model and applies the
 * jurisdiction's format and precision, so the AI cannot mistype a survey value
 * because it never types one.
 *
 * `literal` exists for text with no derivation — a note the user typed, a
 * street name off a deed — and is gated by FREE_TEXT_ROLES plus the export gate.
 */
export type LabelContent =
  | {
      readonly mode: 'derived';
      readonly template: TemplateId;
      readonly bindings: Readonly<Record<string, ValueRef>>;
    }
  | { readonly mode: 'literal'; readonly text: string };

/** Roles where free text is legitimate. Everything else must be derived. */
export const FREE_TEXT_ROLES: ReadonlySet<LabelRole> = new Set<LabelRole>([
  'note',
  'feature-name',
  'road-name',
  'access',
]);

// ---------------------------------------------------------------------------
// Anchoring — preferences, not positions
// ---------------------------------------------------------------------------

export type AnchorRelation =
  /** Along the subject line, rotated to match it. */
  | 'along'
  /** Offset perpendicular from the subject. */
  | 'offset'
  /** Inside a closed subject (ring or polygon feature). */
  | 'inside'
  /** Near a point subject, engine picks the quadrant. */
  | 'near'
  /** Placed in free space with a leader line back to the subject. */
  | 'leader';

export type AnchorSide = 'left' | 'right' | 'above' | 'below' | 'auto';

export interface AnchorSpec {
  readonly relation: AnchorRelation;
  readonly side?: AnchorSide;
  /** Ranked fallbacks the engine tries in order before resorting to a leader. */
  readonly preferredOrder?: readonly AnchorRelation[];
  /** Default true — text never renders upside-down. */
  readonly keepUpright?: boolean;
  /**
   * Offset in style-token units, NOT millimetres or pixels. "Just off the line"
   * must mean the same thing at 1:200 and 1:1000, and only the Plan Composer
   * knows the scale — a physical unit here would leak layout authority back
   * across the boundary.
   */
  readonly offsetSteps?: number;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * - `required`  — must be placed; failure is a validation error, not a silent drop.
 * - `preferred` — place it; a leader line is acceptable.
 * - `optional`  — may be dropped under collision pressure, but the drop is reported.
 */
export type VisibilityPolicy = 'required' | 'preferred' | 'optional';

/** A token into the jurisdiction template. Never a raw font size or colour. */
export interface StyleRef {
  readonly token: string;
}

// ---------------------------------------------------------------------------
// The specification
// ---------------------------------------------------------------------------

export interface LabelSpecification {
  readonly id: LabelId;
  readonly subject: LabelSubject;
  readonly role: LabelRole;
  readonly content: LabelContent;
  readonly anchor: AnchorSpec;
  readonly priority: LabelPriority;
  readonly visibility: VisibilityPolicy;
  readonly style: StyleRef;
  readonly provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export interface ContractViolation {
  readonly labelId: LabelId;
  readonly rule: string;
  readonly message: string;
}

/**
 * Structural check applied to every specification before placement runs.
 * Catches the two ways an AI layer can overstep: free text where a survey value
 * belongs, and a literal binding that should have been derived.
 */
export function checkSpecification(
  spec: LabelSpecification,
): readonly ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (spec.content.mode === 'literal' && !FREE_TEXT_ROLES.has(spec.role)) {
    violations.push({
      labelId: spec.id,
      rule: 'literal-text-role',
      message:
        `Role "${spec.role}" carries a survey value and must use derived ` +
        `content; literal text is only permitted for ` +
        `${[...FREE_TEXT_ROLES].join(', ')}.`,
    });
  }

  if (
    spec.content.mode === 'derived' &&
    Object.keys(spec.content.bindings).length === 0
  ) {
    violations.push({
      labelId: spec.id,
      rule: 'empty-bindings',
      message:
        `Derived content for template "${spec.content.template}" has no ` +
        `bindings, so it cannot be rendered from the Survey Data Model.`,
    });
  }

  return violations;
}

/**
 * The export gate (B.7): no AI-suggested label reaches a finished plan.
 *
 * Returns the labels blocking export so ExportDialog can route the user
 * straight into the trust loop rather than showing a dead end. This is the one
 * place a Part A engine hard-blocks on a Part B interaction, and it is deliberate.
 */
export function labelsBlockingExport(
  specs: readonly LabelSpecification[],
): readonly LabelSpecification[] {
  return specs.filter((s) => requiresConfirmation(s.provenance));
}
