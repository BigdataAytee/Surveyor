/**
 * Project state.
 *
 * Holds the confirmed Survey Data Model, the AI's pending suggestions, and the
 * selection. Two rules shape the design:
 *
 * 1. Suggestions live *outside* the model. Nothing the AI proposes becomes
 *    survey data until a human accepts it (B.7), so keeping them in a separate
 *    list makes the boundary structural rather than a flag to remember.
 * 2. The pipeline is derived, never stored. Every edit re-runs the engines, so
 *    what the canvas shows and what an export would produce cannot drift.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';

import type {
  LabelSpecification,
  SiteFeature,
  SurveyDataModel,
  SurveyNote,
  SurveyPoint,
} from '@surveyor/contracts';
import { confirm } from '@surveyor/contracts';
import {
  ringFromPointOrder,
  runPipeline,
  type PipelineResult,
} from '@surveyor/engine';

import { SAMPLE_PROJECT } from './sample.js';

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * A proposal from the AI layer, awaiting the trust loop. `summary` is the copy
 * shown beside the preview, e.g. "AI suggestion — 6m × 4m".
 */
export type Suggestion =
  | {
      readonly id: string;
      readonly kind: 'feature';
      readonly summary: string;
      readonly feature: SiteFeature;
    }
  | {
      readonly id: string;
      readonly kind: 'label';
      readonly summary: string;
      readonly spec: LabelSpecification;
    }
  | {
      readonly id: string;
      readonly kind: 'note';
      readonly summary: string;
      readonly note: SurveyNote;
    };

export interface ProjectState {
  readonly model: SurveyDataModel;
  readonly suggestions: readonly Suggestion[];
  readonly selectedId: string | null;
  readonly highlightId: string | null;
  readonly past: readonly SurveyDataModel[];
  readonly future: readonly SurveyDataModel[];
}

export type Action =
  | { type: 'select'; id: string | null }
  | { type: 'highlight'; id: string | null }
  | { type: 'add-point'; point: SurveyPoint }
  | { type: 'update-point'; id: string; point: SurveyPoint }
  | { type: 'remove-point'; id: string }
  | { type: 'set-model'; model: SurveyDataModel }
  | { type: 'set-metadata'; metadata: Partial<SurveyDataModel['metadata']> }
  | { type: 'suggest'; suggestion: Suggestion }
  | { type: 'accept-suggestion'; id: string; at: string }
  | { type: 'dismiss-suggestion'; id: string }
  | { type: 'undo' }
  | { type: 'redo' };

const HISTORY_LIMIT = 40;

/** Records the previous model so the change can be undone. */
function commit(state: ProjectState, model: SurveyDataModel): ProjectState {
  return {
    ...state,
    model,
    past: [...state.past, state.model].slice(-HISTORY_LIMIT),
    future: [],
  };
}

export function reducer(state: ProjectState, action: Action): ProjectState {
  switch (action.type) {
    case 'select':
      return { ...state, selectedId: action.id };

    case 'highlight':
      return { ...state, highlightId: action.id };

    case 'add-point':
      return commit(state, {
        ...state.model,
        points: [...state.model.points, action.point],
      });

    case 'update-point':
      return commit(state, {
        ...state.model,
        points: state.model.points.map((p) =>
          p.id === action.id ? action.point : p,
        ),
      });

    case 'remove-point': {
      // The ring is rebuilt from the corners that remain, in order. Simply
      // dropping the segments that mentioned the point leaves a boundary with
      // a hole in it — two disconnected lines that no longer enclose anything.
      const boundary = state.model.boundary.flatMap((ring) => {
        const order = ring.segments
          .map((segment) => segment.from)
          .filter((id) => id !== action.id);
        return order.length >= 3 ? [ringFromPointOrder(ring.id, order)] : [];
      });

      return commit(state, {
        ...state.model,
        points: state.model.points.filter((p) => p.id !== action.id),
        boundary,
      });
    }

    case 'set-model':
      return commit(state, action.model);

    case 'set-metadata':
      return commit(state, {
        ...state.model,
        metadata: { ...state.model.metadata, ...action.metadata },
      });

    case 'suggest':
      return { ...state, suggestions: [...state.suggestions, action.suggestion] };

    case 'accept-suggestion': {
      const suggestion = state.suggestions.find((s) => s.id === action.id);
      if (!suggestion) return state;

      const remaining = state.suggestions.filter((s) => s.id !== action.id);
      const actor = { actorId: 'local-user' };

      // Provenance flips exactly once, here, and only because a human acted.
      switch (suggestion.kind) {
        case 'feature':
          return {
            ...commit(state, {
              ...state.model,
              siteFeatures: [
                ...state.model.siteFeatures,
                {
                  ...suggestion.feature,
                  provenance: confirm(suggestion.feature.provenance, actor, action.at),
                },
              ],
            }),
            suggestions: remaining,
          };
        case 'note':
          return {
            ...commit(state, {
              ...state.model,
              notes: [
                ...state.model.notes,
                {
                  ...suggestion.note,
                  provenance: confirm(suggestion.note.provenance, actor, action.at),
                },
              ],
            }),
            suggestions: remaining,
          };
        case 'label':
          // A label suggestion carries no survey data of its own, so accepting
          // it only clears the export gate.
          return { ...state, suggestions: remaining };
      }
      return state;
    }

    case 'dismiss-suggestion':
      return {
        ...state,
        suggestions: state.suggestions.filter((s) => s.id !== action.id),
      };

    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...state,
        model: previous,
        past: state.past.slice(0, -1),
        future: [state.model, ...state.future],
      };
    }

    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return {
        ...state,
        model: next,
        past: [...state.past, state.model],
        future: rest,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const INITIAL_STATE: ProjectState = {
  model: SAMPLE_PROJECT,
  suggestions: [],
  selectedId: null,
  highlightId: null,
  past: [],
  future: [],
};

/** The empty project, for the "start from scratch" path. */
export const EMPTY_MODEL: SurveyDataModel = {
  metadata: { jurisdiction: 'uk-land-registry' },
  crs: SAMPLE_PROJECT.crs,
  points: [],
  boundary: [],
  siteFeatures: [],
  notes: [],
};

interface Store {
  readonly state: ProjectState;
  readonly dispatch: Dispatch<Action>;
  /** The engine result for the current model. Recomputed on every edit. */
  readonly pipeline: PipelineResult;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

const StoreContext = createContext<Store | null>(null);

export function ProjectProvider({ children }: { readonly children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // Deriving rather than storing is what keeps the canvas, the validation
  // state, and any export in agreement. The model is small enough that
  // re-running the pipeline per edit is comfortably inside a frame.
  const pipeline = useMemo(() => runPipeline(state.model), [state.model]);

  const value = useMemo<Store>(
    () => ({
      state,
      dispatch,
      pipeline,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
    }),
    [state, pipeline],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useProject(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useProject must be used inside a ProjectProvider');
  return store;
}

/** Convenience for the many components that only dispatch. */
export function useDispatch(): Dispatch<Action> {
  return useProject().dispatch;
}

export function useHighlight(): (id: string | null) => void {
  const dispatch = useDispatch();
  return useCallback((id: string | null) => dispatch({ type: 'highlight', id }), [dispatch]);
}
