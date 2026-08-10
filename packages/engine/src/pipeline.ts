/**
 * The pipeline of A.2, run end to end.
 *
 * This is the function the UI calls. It emits a StageEvent as each engine
 * starts and finishes, which is what makes the AIProgress step list in B.8 an
 * honest reflection of progress rather than an animation on a timer.
 *
 * The stages run in the fixed order the architecture sets out, and a stage that
 * cannot proceed stops the run rather than passing degraded data downstream.
 */

import type {
  PipelineStage,
  StageEvent,
  SurveyDataModel,
  ValidationIssue,
  ValidationReport,
} from '@surveyor/contracts';
import { statusFor, STAGE_ACTIVE_COPY } from '@surveyor/contracts';

import { computeRing, type ResolvedRing } from './cogo.js';
import { resolveCrs, type CrsResolution } from './crs.js';
import { buildDrawing, type Drawing } from './drawing.js';
import { generateBaseLabels, type LabelPreferences } from './labeling/semantic.js';
import { droppedRequiredLabels } from './labeling/placement.js';
import { validate, type ClosureTolerance } from './validation.js';
import { templateFor } from './compose/jurisdiction.js';
import {
  composePlan,
  type ComposedPlan,
  type ComposeResult,
} from './compose/composer.js';
import type { LabelSpecification } from '@surveyor/contracts';

export type StageListener = (event: StageEvent) => void;

export interface PipelineOptions {
  readonly onStage?: StageListener;
  readonly preferences?: Partial<LabelPreferences>;
  readonly tolerance?: ClosureTolerance;
  /** Extra specifications from the AI layer, merged with the base set. */
  readonly extraLabels?: readonly LabelSpecification[];
  readonly scaleDenominator?: number;
  readonly plotDate?: string;
}

export type PipelineResult =
  | {
      readonly ok: true;
      readonly rings: readonly ResolvedRing[];
      readonly validation: ValidationReport;
      readonly drawing: Drawing;
      readonly specs: readonly LabelSpecification[];
      readonly plan: ComposedPlan;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failedAt: PipelineStage;
      readonly message: string;
      /** Populated whenever the stop is something the user can act on. */
      readonly validation?: ValidationReport;
      readonly crs?: Extract<CrsResolution, { kind: 'halt' }>;
      readonly blocking?: readonly LabelSpecification[];
      readonly rings?: readonly ResolvedRing[];
      readonly drawing?: Drawing;
    };

export function runPipeline(
  model: SurveyDataModel,
  options: PipelineOptions = {},
): PipelineResult {
  const emit = (stage: PipelineStage, state: StageEvent['state']): void => {
    options.onStage?.({ stage, state, message: STAGE_ACTIVE_COPY[stage] });
  };

  // --- CRS -----------------------------------------------------------------
  emit('crs', 'active');
  const crs = resolveCrs(model.crs);
  if (crs.kind === 'halt') {
    emit('crs', 'failed');
    return { ok: false, failedAt: 'crs', message: crs.question, crs };
  }
  emit('crs', 'complete');

  // --- COGO ----------------------------------------------------------------
  emit('cogo', 'active');
  const rings: ResolvedRing[] = [];
  for (const ring of model.boundary) {
    const computed = computeRing(ring, model.points);
    if (!computed.ok) {
      emit('cogo', 'failed');
      return { ok: false, failedAt: 'cogo', message: computed.reason };
    }
    rings.push(computed.ring);
  }
  emit('cogo', 'complete');

  // --- Validation ----------------------------------------------------------
  emit('validation', 'active');
  const tolerance =
    options.tolerance ?? templateFor(model.metadata.jurisdiction).template.closureTolerance;
  const validation = validate({ model, rings, tolerance });

  if (validation.status === 'error') {
    // Stop and flag, never auto-correct (A.3 Validation Engine).
    emit('validation', 'failed');
    const drawing = buildDrawing({ model, rings });
    return {
      ok: false,
      failedAt: 'validation',
      message:
        'The drawing has problems that need your decision before it can be finished.',
      validation,
      rings,
      drawing,
    };
  }
  emit('validation', 'complete');

  // --- Drawing -------------------------------------------------------------
  emit('drawing', 'active');
  const drawing = buildDrawing({ model, rings });
  emit('drawing', 'complete');

  // --- Labelling -----------------------------------------------------------
  emit('labeling', 'active');
  const specs = [
    ...generateBaseLabels({
      model,
      rings,
      ...(options.preferences ? { preferences: options.preferences } : {}),
    }),
    ...(options.extraLabels ?? []),
  ];
  emit('labeling', 'complete');

  // --- Composition ---------------------------------------------------------
  emit('composition', 'active');
  const composed: ComposeResult = composePlan({
    model,
    rings,
    drawing,
    specs,
    validation,
    ...(options.scaleDenominator === undefined
      ? {}
      : { scaleDenominator: options.scaleDenominator }),
    ...(options.plotDate === undefined ? {} : { plotDate: options.plotDate }),
  });

  if (!composed.ok) {
    emit('composition', 'failed');
    return {
      ok: false,
      failedAt: 'composition',
      message: composed.message,
      blocking: composed.blocking,
      validation,
      rings,
      drawing,
    };
  }
  emit('composition', 'complete');

  // A label the sheet had no room for is a review item, not a silent loss.
  const dropped = droppedRequiredLabels({
    labels: composed.plan.labels,
    unresolved: [],
  });
  const warnings = [...composed.warnings];
  const extraIssues: ValidationIssue[] = dropped.map((label) => ({
    code: 'required-label-dropped' as const,
    severity: 'needs-review' as const,
    message:
      `There was no room for "${label.text}" on the sheet. Try a larger sheet ` +
      `or a smaller scale.`,
    subjects: [label.spec.id],
    options: ['accept' as const, 'adjust' as const],
  }));

  const finalValidation: ValidationReport =
    extraIssues.length === 0
      ? validation
      : {
          ...validation,
          issues: [...validation.issues, ...extraIssues],
          status: statusFor([...validation.issues, ...extraIssues]),
        };

  return {
    ok: true,
    rings,
    validation: finalValidation,
    drawing,
    specs,
    plan: composed.plan,
    warnings,
  };
}

/** The stages a UI should show, in order, for a run from stored survey data. */
export const UI_STAGES: readonly PipelineStage[] = [
  'crs',
  'cogo',
  'validation',
  'drawing',
  'labeling',
  'composition',
];
