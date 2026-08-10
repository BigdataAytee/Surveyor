/**
 * Pipeline stage events — Part A's progress, Part B's AIProgress step list.
 *
 * B.8 calls for "a direct, honest reflection of pipeline progress, not a fake
 * progress bar", which only works if the UI's steps are these stages rather
 * than a parallel list that can drift out of sync with the engines.
 */

/** The stages of A.2, in execution order. */
export type PipelineStage =
  | 'input'
  | 'document-ai'
  | 'crs'
  | 'cogo'
  | 'validation'
  | 'drawing'
  | 'labeling'
  | 'composition'
  | 'export';

/** Maps to the ○ / ● / ✓ glyphs in B.8 and B.12. */
export type StageState = 'pending' | 'active' | 'complete' | 'failed';

export interface StageEvent {
  readonly stage: PipelineStage;
  readonly state: StageState;
  /** Contextual copy, e.g. "Finding the best label positions..." (B.8). */
  readonly message: string;
}

/**
 * Novice-facing copy for the active state of each stage. Kept beside the stage
 * enum so a new stage cannot ship without the text the user sees.
 */
export const STAGE_ACTIVE_COPY: Readonly<Record<PipelineStage, string>> = {
  input: 'Reading survey information',
  'document-ai': 'Extracting data from your document',
  crs: 'Checking the coordinate system',
  cogo: 'Calculating boundary',
  validation: 'Checking the drawing',
  drawing: 'Drawing your plan',
  labeling: 'Positioning labels',
  composition: 'Preparing layout',
  export: 'Generating your plan',
};
