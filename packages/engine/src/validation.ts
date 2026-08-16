/**
 * Validation Engine (Architecture A.3) — runs after COGO, before drawing.
 *
 * A.1 §4 governs this whole file: every problem is reported in plain language
 * with options, and nothing is silently corrected. There is deliberately no
 * "fix" function here — adjusting a traverse is the user's decision, made in
 * the ValidationSheet, not the engine's.
 */

import type {
  Crs,
  SurveyDataModel,
  ValidationIssue,
  ValidationReport,
  ClosureReport,
} from '@surveyor/contracts';
import { statusFor } from '@surveyor/contracts';

import { distanceBetween, segmentsCross, type ResolvedRing } from './cogo.js';
import { UNIT_ABBREVIATION } from './crs.js';

/**
 * Closure tolerance. `minimumRatio` is the denominator of the acceptable
 * precision ratio — 1:5000 is a common suburban boundary standard, and the
 * jurisdiction template overrides it.
 */
export interface ClosureTolerance {
  readonly minimumRatio: number;
  /** Absolute cap in CRS units, applied alongside the ratio. */
  readonly maximumMisclosure: number;
}

export const DEFAULT_CLOSURE_TOLERANCE: ClosureTolerance = {
  minimumRatio: 5000,
  maximumMisclosure: 0.05,
};

/** Below this, two points are the same point rather than two close ones. */
const DUPLICATE_POINT_EPSILON = 1e-6;
const ZERO_LENGTH_EPSILON = 1e-6;
/** Document AI extractions below this need confirming before they are used. */
const LOW_CONFIDENCE_THRESHOLD = 0.85;

export interface ValidationInput {
  readonly model: SurveyDataModel;
  readonly rings: readonly ResolvedRing[];
  readonly tolerance?: ClosureTolerance;
  /** Proportional tolerance for a stated area against the computed one. */
  readonly areaTolerance?: number;
}

export function validate(input: ValidationInput): ValidationReport {
  const tolerance = input.tolerance ?? DEFAULT_CLOSURE_TOLERANCE;
  const unit = UNIT_ABBREVIATION[input.model.crs.units];

  const closure = input.rings.map((ring) => closureReport(ring, tolerance));
  const issues: ValidationIssue[] = [
    ...closureIssues(input.rings, closure, tolerance, unit),
    ...crsIssues(input.model.crs),
    ...duplicatePointIssues(input.model),
    ...zeroLengthIssues(input.rings, unit),
    ...selfIntersectionIssues(input.rings),
    ...confidenceIssues(input.model),
    ...areaIssues(input.model, input.rings, unit, input.areaTolerance ?? AREA_MISMATCH_TOLERANCE),
  ];

  return { status: statusFor(issues), issues, closure };
}

// ---------------------------------------------------------------------------
// Closure
// ---------------------------------------------------------------------------

function closureReport(
  ring: ResolvedRing,
  tolerance: ClosureTolerance,
): ClosureReport {
  const { misclosure, precisionRatio } = ring.closure;
  const withinTolerance =
    misclosure <= tolerance.maximumMisclosure &&
    precisionRatio >= tolerance.minimumRatio;

  return {
    ringId: ring.ringId,
    misclosure,
    precisionRatio,
    tolerance: tolerance.maximumMisclosure,
    withinTolerance,
  };
}

function closureIssues(
  rings: readonly ResolvedRing[],
  reports: readonly ClosureReport[],
  tolerance: ClosureTolerance,
  unit: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const report of reports) {
    if (report.withinTolerance) continue;
    const ring = rings.find((r) => r.ringId === report.ringId);

    issues.push({
      code: 'closure-out-of-tolerance',
      severity: 'error',
      message:
        `This boundary does not close. Walking the bearings and distances ` +
        `around it leaves a gap of ${report.misclosure.toFixed(3)} ${unit}, ` +
        `which is more than the ${report.tolerance} ${unit} allowed. ` +
        `Check the measurements before drawing the plan.`,
      subjects: [report.ringId],
      options: ['adjust', 'reject'],
      detail:
        `Misclosure ${report.misclosure.toFixed(4)} ${unit} ` +
        `(departure ${ring?.closure.departure.toFixed(4) ?? '?'}, ` +
        `latitude ${ring?.closure.latitude.toFixed(4) ?? '?'}); ` +
        `precision 1:${formatRatio(report.precisionRatio)}, ` +
        `required 1:${formatRatio(tolerance.minimumRatio)} or better.`,
    });
  }
  return issues;
}

function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return '∞';
  return Math.round(ratio).toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// CRS consistency
// ---------------------------------------------------------------------------

function crsIssues(crs: Crs): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!crs.datum || !crs.name) {
    issues.push({
      code: 'crs-undetermined',
      severity: 'error',
      message:
        'The coordinate system for this survey is incomplete, so positions ' +
        'cannot be placed reliably.',
      subjects: ['crs'],
      options: ['adjust'],
    });
  }

  // A scale factor this far from unity is almost always a data-entry slip
  // (a ratio typed as a percentage, say) rather than a real projection.
  if (
    crs.combinedScaleFactor !== undefined &&
    (crs.combinedScaleFactor < 0.99 || crs.combinedScaleFactor > 1.01)
  ) {
    issues.push({
      code: 'crs-inconsistent',
      severity: 'needs-review',
      message:
        `The grid-to-ground scale factor is ${crs.combinedScaleFactor}, which ` +
        `is unusually far from 1. Distances on the plan will differ noticeably ` +
        `from measured distances — is that right?`,
      subjects: ['crs'],
      options: ['confirm', 'adjust'],
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Geometric sanity
// ---------------------------------------------------------------------------

function duplicatePointIssues(model: SurveyDataModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen: { id: string; coords: SurveyDataModel['points'][number]['coordinates'] }[] = [];

  for (const point of model.points) {
    const duplicate = seen.find(
      (s) => distanceBetween(s.coords, point.coordinates) < DUPLICATE_POINT_EPSILON,
    );
    if (duplicate) {
      issues.push({
        code: 'duplicate-point',
        severity: 'needs-review',
        message:
          `${point.id} and ${duplicate.id} are at the same position. One of ` +
          `them is probably a repeated entry.`,
        subjects: [point.id, duplicate.id],
        options: ['confirm', 'adjust', 'reject'],
      });
    } else {
      seen.push({ id: point.id, coords: point.coordinates });
    }
  }
  return issues;
}

function zeroLengthIssues(
  rings: readonly ResolvedRing[],
  unit: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const ring of rings) {
    for (const segment of ring.segments) {
      if (segment.distance >= ZERO_LENGTH_EPSILON) continue;
      issues.push({
        code: 'zero-length-segment',
        severity: 'error',
        message:
          `The boundary line from ${segment.from} to ${segment.to} has no ` +
          `length, so it cannot be drawn.`,
        subjects: [ring.ringId, segment.from, segment.to],
        options: ['adjust', 'reject'],
        detail: `Computed length ${segment.distance} ${unit}.`,
      });
    }
  }
  return issues;
}

function selfIntersectionIssues(
  rings: readonly ResolvedRing[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const ring of rings) {
    const segments = ring.segments;
    for (let i = 0; i < segments.length; i += 1) {
      for (let j = i + 1; j < segments.length; j += 1) {
        const a = segments[i]!;
        const b = segments[j]!;
        if (a.to === b.from || b.to === a.from) continue; // adjacent corners
        if (!segmentsCross(a.start, a.end, b.start, b.end)) continue;

        issues.push({
          code: 'self-intersection',
          severity: 'error',
          message:
            `The boundary crosses over itself between ${a.from}–${a.to} and ` +
            `${b.from}–${b.to}. Two of the corners may be in the wrong order.`,
          subjects: [ring.ringId, a.from, a.to, b.from, b.to],
          options: ['adjust', 'reject'],
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Extraction confidence (Part C row 6)
// ---------------------------------------------------------------------------

function confidenceIssues(model: SurveyDataModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const point of model.points) {
    const confidence = point.provenance.confidence;
    if (confidence === undefined || confidence >= LOW_CONFIDENCE_THRESHOLD) {
      continue;
    }
    issues.push({
      code: 'low-confidence-extraction',
      severity: 'needs-review',
      message:
        `${point.id} was read from your document but is hard to make out. ` +
        `Please check its coordinates before we use them.`,
      subjects: [point.id],
      options: ['confirm', 'adjust'],
      detail: `Extraction confidence ${(confidence * 100).toFixed(0)}%.`,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Stated area against computed area
// ---------------------------------------------------------------------------

/**
 * How far apart a stated and a computed area may be before it is worth saying.
 *
 * Proportional rather than absolute, because a square metre on a house plot is
 * a real discrepancy and on a farm is a rounding difference. One per cent is
 * about where a difference stops being explicable by the rounding on a deed
 * and starts suggesting the parcel is not the one described.
 */
export const AREA_MISMATCH_TOLERANCE = 0.01;

export interface AreaComparison {
  readonly stated: number;
  readonly computed: number;
  /** Signed: positive when the computed area is the larger. */
  readonly difference: number;
  /** As a fraction of the stated area. */
  readonly proportion: number;
  readonly withinTolerance: boolean;
}

/**
 * Compare what the deed says with what the geometry gives.
 *
 * Returns null when there is nothing to compare — no stated area, or no closed
 * boundary to compute one from. That is not a problem and is not reported as
 * one; most plans have only the computed figure.
 */
export function compareAreas(
  model: SurveyDataModel,
  rings: readonly ResolvedRing[],
  tolerance = AREA_MISMATCH_TOLERANCE,
): AreaComparison | null {
  const stated = model.metadata.statedArea;
  if (stated === undefined || !Number.isFinite(stated) || stated <= 0) return null;

  const computed = rings[0]?.area;
  if (computed === undefined || !Number.isFinite(computed) || computed <= 0) return null;

  const difference = computed - stated;
  const proportion = Math.abs(difference) / stated;

  return {
    stated,
    computed,
    difference,
    proportion,
    withinTolerance: proportion <= tolerance,
  };
}

function areaIssues(
  model: SurveyDataModel,
  rings: readonly ResolvedRing[],
  unit: string,
  tolerance: number,
): readonly ValidationIssue[] {
  const comparison = compareAreas(model, rings, tolerance);
  if (!comparison || comparison.withinTolerance) return [];

  const percent = (comparison.proportion * 100).toFixed(1);
  const larger = comparison.difference > 0 ? 'larger' : 'smaller';

  return [
    {
      code: 'area-mismatch',
      // Needs review rather than an error: a difference is a question, and
      // plenty of them have good answers — a deed rounded to the nearest
      // hundred, an occupation line that is not the title line. What it must
      // never be is invisible.
      severity: 'needs-review',
      message:
        `The area from your survey is ${percent}% ${larger} than the ` +
        `${format(comparison.stated, unit)} on record. Check which one this ` +
        'plan should state before you issue it.',
      subjects: rings[0] ? [rings[0].ringId] : [],
      options: ['confirm', 'adjust'],
      detail:
        `stated ${format(comparison.stated, unit)}, ` +
        `computed ${format(comparison.computed, unit)}, ` +
        `difference ${format(Math.abs(comparison.difference), unit)}`,
    },
  ];
}

function format(area: number, unit: string): string {
  return `${area.toFixed(area < 100 ? 2 : 0)} ${unit}²`;
}
