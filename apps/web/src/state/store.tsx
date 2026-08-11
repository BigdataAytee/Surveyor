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
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';

import type {
  Coordinates,
  LabelSpecification,
  SiteFeature,
  SurveyDataModel,
  SurveyNote,
  SurveyPoint,
} from '@surveyor/contracts';
import { confirm } from '@surveyor/contracts';
import {
  distanceBetween,
  inverse,
  mirror,
  mirrorRing,
  ringFromPointOrder,
  rotate,
  runPipeline,
  scale,
  translate,
  type PipelineResult,
  type Vector,
} from '@surveyor/engine';

import { loadModel, saveModel } from './persistence.js';
import {
  listProjects,
  loadProject,
  newProjectId,
  recordArea,
  saveProject,
} from './library.js';
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
  /** Which saved project this is. Every autosave writes to it. */
  readonly projectId: string;
  readonly model: SurveyDataModel;
  readonly suggestions: readonly Suggestion[];
  /**
   * Everything selected, in the order it was picked.
   *
   * A list rather than one id because every CAD operation worth having works
   * on a set: move three corners, mirror a building and its driveway
   * together, delete a run of fence. `selectedId` remains as the single-object
   * case the properties panel needs, derived from this so the two cannot drift.
   */
  readonly selectedIds: readonly string[];
  readonly selectedId: string | null;
  readonly highlightId: string | null;
  readonly past: readonly SurveyDataModel[];
  readonly future: readonly SurveyDataModel[];
}

export type Action =
  | { type: 'select'; id: string | null }
  /** Add to or remove from the selection — shift-click and box select. */
  | { type: 'select-toggle'; id: string }
  | { type: 'select-many'; ids: readonly string[] }
  /**
   * Move, rotate, scale or mirror everything selected.
   *
   * One action rather than four because they differ only in which engine
   * function computes the new coordinates, and routing them together keeps the
   * "which objects does this touch" logic in one place instead of four.
   */
  | { type: 'transform'; transform: Transform; ids?: readonly string[] }
  | { type: 'delete-selection' }
  /** Copy everything selected by a displacement, leaving the original. */
  | { type: 'duplicate-selection'; by: Vector }
  | { type: 'highlight'; id: string | null }
  | { type: 'add-point'; point: SurveyPoint }
  | { type: 'add-boundary-point'; at: Coordinates }
  | { type: 'add-feature'; feature: SiteFeature }
  /**
   * Place a dimension between two positions on the ground.
   *
   * Positions rather than point ids, because the canvas knows where the user
   * tapped and not what is there. Either end that does not already have a
   * survey point on it gets one, so the dimension measures between things the
   * model knows about and follows them when they are corrected.
   */
  | { type: 'add-dimension'; from: Coordinates; to: Coordinates }
  | { type: 'remove-dimension'; id: string }
  | { type: 'update-feature'; id: string; feature: SiteFeature }
  | { type: 'remove-feature'; id: string }
  | { type: 'update-point'; id: string; point: SurveyPoint }
  | { type: 'remove-point'; id: string }
  /**
   * Renumber every point in boundary order, PT1 upward.
   *
   * Points entered out of sequence, or added after a deletion, end up named in
   * an order that has nothing to do with the shape — and a plan whose corners
   * read PT4, PT1, PT7, PT2 round the boundary is one a reviewer has to work
   * at. Renaming rebuilds every reference, because a rename that left the ring
   * pointing at the old names would silently unmake the boundary.
   */
  | { type: 'renumber-points'; prefix?: string }
  | { type: 'set-model'; model: SurveyDataModel }
  /**
   * Switch to another saved project, or start a fresh one.
   *
   * The history is dropped rather than carried across: undoing past the moment
   * you opened a different survey and finding yourself in the previous one is
   * not a behaviour anybody wants.
   */
  | { type: 'open-project'; id: string; model: SurveyDataModel }
  /**
   * A key set to `undefined` clears it. `Partial` alone cannot say that under
   * `exactOptionalPropertyTypes`, and the difference matters: a site with no
   * address and a site addressed "" are not the same thing to the title block.
   */
  | {
      type: 'set-metadata';
      metadata: {
        [K in keyof SurveyDataModel['metadata']]?: SurveyDataModel['metadata'][K] | undefined;
      };
    }
  | { type: 'suggest'; suggestion: Suggestion }
  | { type: 'accept-suggestion'; id: string; at: string }
  | { type: 'dismiss-suggestion'; id: string }
  | { type: 'undo' }
  | { type: 'redo' };

/**
 * What a CAD transform is, as data.
 *
 * Expressed as intent — "rotate 30° about here" — rather than as a matrix,
 * because the intent is what the surveyor typed and what the status bar has to
 * show. It is also what makes the operation replayable: a matrix that has been
 * multiplied out cannot tell you afterwards that it was a 30° rotation.
 */
export type Transform =
  | { readonly kind: 'move'; readonly by: Vector }
  | { readonly kind: 'rotate'; readonly about: Coordinates; readonly degrees: number }
  | { readonly kind: 'scale'; readonly about: Coordinates; readonly factor: number }
  | { readonly kind: 'mirror'; readonly a: Coordinates; readonly b: Coordinates };

const HISTORY_LIMIT = 40;

/**
 * Apply a transform to a list of vertices.
 *
 * Every case delegates to the engine. Nothing here computes a coordinate: the
 * store decides *what* is being transformed, and `@surveyor/engine` decides
 * where it lands — the same division that keeps the canvas from being able to
 * produce geometry that looks right and computes wrong.
 */
function applyTransform(
  vertices: readonly Coordinates[],
  transform: Transform,
  closed: boolean,
): readonly Coordinates[] {
  switch (transform.kind) {
    case 'move':
      return translate(vertices, transform.by);
    case 'rotate':
      return rotate(vertices, transform.about, transform.degrees);
    case 'scale':
      return scale(vertices, transform.about, transform.factor);
    case 'mirror':
      // A closed shape keeps its winding, so its area stays positive and
      // "outside" keeps meaning outside.
      return closed
        ? mirrorRing(vertices, transform.a, transform.b)
        : mirror(vertices, transform.a, transform.b);
  }
}

/**
 * Transform whichever survey objects the ids name.
 *
 * Points and features are handled together because a selection routinely spans
 * both — mirroring a house and the two boundary corners it was measured from
 * has to move all four, or the relationship the surveyor cares about is lost.
 *
 * Selecting a ring selects its corners: a ring has no geometry of its own,
 * only an order over points, so moving "the boundary" means moving them.
 */
function transformModel(
  model: SurveyDataModel,
  ids: readonly string[],
  transform: Transform,
): SurveyDataModel {
  const targets = new Set(ids);

  // A selected ring stands for every corner in it.
  for (const ring of model.boundary) {
    if (!targets.has(ring.id)) continue;
    for (const segment of ring.segments) targets.add(segment.from);
  }

  const points = model.points.map((point) =>
    targets.has(point.id)
      ? {
          ...point,
          coordinates: applyTransform([point.coordinates], transform, false)[0]!,
          // Moving a measured point makes its position the user's, not the
          // instrument's. Saying so is the whole provenance rule.
          provenance: { ...point.provenance, source: 'user-confirmed' as const },
        }
      : point,
  );

  const siteFeatures = model.siteFeatures.map((feature) => {
    if (!targets.has(feature.id)) return feature;
    const geometry = feature.geometry;

    return {
      ...feature,
      geometry: transformGeometry(geometry, transform),
      provenance: { ...feature.provenance, source: 'user-confirmed' as const },
    };
  });

  return { ...model, points, siteFeatures };
}

/**
 * Transform one feature's geometry, whatever shape it is.
 *
 * The circle and arc cases are why this is a function rather than a line: a
 * circle is stored as a centre and a radius, so scaling it has to scale the
 * radius too. Transforming only the centre would leave a tree canopy the same
 * size on a drawing that had been scaled — the geometry would look plausible
 * and measure wrong, which is the failure this whole layer exists to prevent.
 */
function transformGeometry(
  geometry: SiteFeature['geometry'],
  transform: Transform,
): SiteFeature['geometry'] {
  switch (geometry.kind) {
    case 'point':
      return { ...geometry, at: applyTransform([geometry.at], transform, false)[0]! };

    case 'polygon':
      return { ...geometry, vertices: applyTransform(geometry.vertices, transform, true) };

    case 'polyline':
      return { ...geometry, vertices: applyTransform(geometry.vertices, transform, false) };

    case 'circle':
      return {
        ...geometry,
        centre: applyTransform([geometry.centre], transform, false)[0]!,
        radius:
          transform.kind === 'scale'
            ? geometry.radius * Math.abs(transform.factor)
            : geometry.radius,
      };

    case 'arc':
      return {
        ...geometry,
        centre: applyTransform([geometry.centre], transform, false)[0]!,
        radius:
          transform.kind === 'scale'
            ? geometry.radius * Math.abs(transform.factor)
            : geometry.radius,
        // Rotating an arc turns the bearings it runs between; a mirror
        // reverses the direction it sweeps as well as reflecting them.
        ...(transform.kind === 'rotate'
          ? {
              startBearing: wrapBearing(geometry.startBearing + transform.degrees),
              endBearing: wrapBearing(geometry.endBearing + transform.degrees),
            }
          : {}),
        ...(transform.kind === 'mirror'
          ? {
              startBearing: wrapBearing(-geometry.endBearing),
              endBearing: wrapBearing(-geometry.startBearing),
            }
          : {}),
      };
  }
}

function wrapBearing(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * How close two positions must be to count as the same point, in survey units.
 *
 * A centimetre. Snapping means a tap on a corner lands on it exactly, so this
 * is not really a tolerance for near misses — it is there so that floating
 * point arithmetic on the way through the viewport cannot turn one corner into
 * two points a nanometre apart.
 */
const SAME_POINT_TOLERANCE = 0.01;

/** Next free PTn, so drawing after a deletion does not reuse a name. */
function nextPointId(existing: readonly SurveyPoint[]): string {
  const taken = new Set(existing.map((p) => p.id));
  for (let n = existing.length + 1; ; n += 1) {
    const id = `PT${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * The order corners are joined in: the existing ring's order, with any new
 * points inserted where they fit.
 *
 * The established order is preserved rather than re-derived from the point
 * list, which would silently reshape a boundary whose corners were entered out
 * of sequence. New corners are inserted into the edge they sit closest to
 * instead of being appended: tapping near one side of a parcel and having the
 * corner join on at the far end produces a boundary that crosses itself, which
 * the Validation Engine then — correctly, but unhelpfully — rejects.
 */
function ringOrder(
  model: SurveyDataModel,
  points: readonly SurveyPoint[],
): readonly string[] {
  const ring = model.boundary[0];
  const order = ring ? ring.segments.map((segment) => segment.from) : [];
  const coordinates = new Map(points.map((p) => [p.id, p.coordinates]));
  const added = points.map((p) => p.id).filter((id) => !order.includes(id));

  for (const id of added) {
    const at = coordinates.get(id);
    if (!at || order.length < 3) {
      order.push(id);
      continue;
    }

    // Insert where it lengthens the boundary least — the standard way to add
    // a vertex to a closed shape without folding it over itself.
    let best = { index: order.length, cost: Infinity };
    for (let i = 0; i < order.length; i += 1) {
      const a = coordinates.get(order[i]!);
      const b = coordinates.get(order[(i + 1) % order.length]!);
      if (!a || !b) continue;

      const cost =
        inverse(a, at).distance + inverse(at, b).distance - inverse(a, b).distance;
      if (cost < best.cost) best = { index: i + 1, cost };
    }
    order.splice(best.index, 0, id);
  }

  return order;
}

/**
 * Set the selection, keeping `selectedId` in step.
 *
 * `selectedId` is the single-object case — what the properties panel edits —
 * and is null whenever the selection is empty or holds more than one thing.
 * Deriving it here rather than storing it separately means the two cannot
 * disagree about what is selected.
 */
function selectionOf(state: ProjectState, ids: readonly string[]): ProjectState {
  const unique = [...new Set(ids)];
  return {
    ...state,
    selectedIds: unique,
    selectedId: unique.length === 1 ? unique[0]! : null,
  };
}

/**
 * Copies of the selected objects, displaced.
 *
 * Only features are copied. A boundary corner has no independent existence —
 * it is a member of a ring — so duplicating one would put two corners in the
 * same boundary at slightly different places, which is not a shape anyone
 * meant to draw. Copying the parcel itself is a different operation and is not
 * this one.
 */
function copyOf(
  model: SurveyDataModel,
  ids: readonly string[],
  by: Vector,
): readonly SiteFeature[] {
  const wanted = new Set(ids);
  const stamp = Date.now().toString(36);

  return model.siteFeatures
    .filter((feature) => wanted.has(feature.id))
    .map((feature, index) => {
      const geometry = transformGeometry(feature.geometry, { kind: 'move', by });

      return {
        ...feature,
        id: `${feature.id}_copy_${stamp}_${index}`,
        geometry,
        // A copy is something the user made, whatever the original was.
        provenance: { source: 'user-confirmed' as const },
      };
    });
}

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
      return selectionOf(state, action.id === null ? [] : [action.id]);

    case 'select-toggle':
      return selectionOf(
        state,
        state.selectedIds.includes(action.id)
          ? state.selectedIds.filter((id) => id !== action.id)
          : [...state.selectedIds, action.id],
      );

    case 'select-many':
      return selectionOf(state, action.ids);

    case 'transform': {
      const ids = action.ids ?? state.selectedIds;
      if (ids.length === 0) return state;
      return commit(state, transformModel(state.model, ids, action.transform));
    }

    case 'duplicate-selection': {
      if (state.selectedIds.length === 0) return state;

      // Copies are features rather than boundary corners: duplicating a corner
      // of a parcel would put two corners in one ring, which is not a shape.
      const copies = copyOf(state.model, state.selectedIds, action.by);
      if (copies.length === 0) return state;

      return selectionOf(
        commit(state, {
          ...state.model,
          siteFeatures: [...state.model.siteFeatures, ...copies],
        }),
        copies.map((feature) => feature.id),
      );
    }

    case 'delete-selection': {
      if (state.selectedIds.length === 0) return state;
      const gone = new Set(state.selectedIds);

      const points = state.model.points.filter((point) => !gone.has(point.id));
      const siteFeatures = state.model.siteFeatures.filter(
        (feature) => !gone.has(feature.id),
      );

      // The ring is rebuilt from what survives rather than having segments
      // removed: dropping a segment leaves the two either side pointing at a
      // corner that is not there, which reads downstream as a broken boundary.
      const remaining = ringOrder(state.model, points).filter((id) => !gone.has(id));
      const boundary =
        remaining.length >= 3 ? [ringFromPointOrder('ring_1', remaining)] : [];

      return selectionOf(
        commit(state, { ...state.model, points, boundary, siteFeatures }),
        [],
      );
    }

    case 'open-project':
      return {
        ...state,
        projectId: action.id,
        model: action.model,
        suggestions: [],
        selectedIds: [],
        selectedId: null,
        highlightId: null,
        past: [],
        future: [],
      };

    case 'highlight':
      return { ...state, highlightId: action.id };

    case 'add-point':
      return commit(state, {
        ...state.model,
        points: [...state.model.points, action.point],
      });

    case 'add-boundary-point': {
      // Drawing a corner on the canvas both creates the point and extends the
      // ring, so the boundary appears as soon as three exist rather than
      // waiting for someone to connect them by hand.
      const id = nextPointId(state.model.points);
      const points = [
        ...state.model.points,
        {
          id,
          coordinates: action.at,
          // Tapped by a person, so it is confirmed rather than measured.
          provenance: { source: 'user-confirmed' as const },
        },
      ];
      const order = ringOrder(state.model, points);

      return commit(state, {
        ...state.model,
        points,
        boundary: order.length >= 3 ? [ringFromPointOrder('ring_1', order)] : [],
      });
    }

    case 'add-dimension': {
      // Each end becomes a survey point if there is not one there already.
      // A dimension that measured to a bare coordinate would be a number with
      // nothing behind it: correct a point and the boundary moves, but that
      // dimension would stay where it was, quietly disagreeing with the plan.
      let points = state.model.points;

      const anchor = (at: Coordinates): string => {
        const existing = points.find(
          (point) => distanceBetween(point.coordinates, at) < SAME_POINT_TOLERANCE,
        );
        if (existing) return existing.id;

        const id = nextPointId(points);
        points = [
          ...points,
          {
            id,
            coordinates: at,
            // Tapped by a person, so confirmed rather than measured.
            provenance: { source: 'user-confirmed' as const },
          },
        ];
        return id;
      };

      const from = anchor(action.from);
      const to = anchor(action.to);
      if (from === to) return state;

      return commit(state, {
        ...state.model,
        points,
        dimensions: [
          ...(state.model.dimensions ?? []),
          {
            id: `dim_${Date.now()}`,
            from,
            to,
            provenance: { source: 'user-confirmed' as const },
          },
        ],
      });
    }

    case 'remove-dimension':
      return commit(state, {
        ...state.model,
        dimensions: (state.model.dimensions ?? []).filter((d) => d.id !== action.id),
      });

    case 'add-feature':
      return selectionOf(
        commit(state, {
          ...state.model,
          siteFeatures: [...state.model.siteFeatures, action.feature],
        }),
        [action.feature.id],
      );

    case 'update-feature':
      return commit(state, {
        ...state.model,
        siteFeatures: state.model.siteFeatures.map((f) =>
          f.id === action.id ? action.feature : f,
        ),
      });

    case 'remove-feature':
      return {
        ...commit(state, {
          ...state.model,
          siteFeatures: state.model.siteFeatures.filter((f) => f.id !== action.id),
        }),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };

    case 'update-point':
      return commit(state, {
        ...state.model,
        points: state.model.points.map((p) =>
          p.id === action.id ? action.point : p,
        ),
      });

    case 'renumber-points': {
      const prefix = action.prefix ?? 'PT';
      const order = ringOrder(state.model, state.model.points);
      // Anything not in the ring keeps its place after the corners, so a
      // detail point is not silently promoted to a boundary corner.
      const sequence = [
        ...order,
        ...state.model.points.map((point) => point.id).filter((id) => !order.includes(id)),
      ];

      const renamed = new Map(sequence.map((id, index) => [id, `${prefix}${index + 1}`]));
      const byId = new Map(state.model.points.map((point) => [point.id, point]));

      const points = sequence.flatMap((id) => {
        const point = byId.get(id);
        return point ? [{ ...point, id: renamed.get(id)! }] : [];
      });

      const boundary =
        order.length >= 3
          ? [ringFromPointOrder('ring_1', order.map((id) => renamed.get(id)!))]
          : state.model.boundary;

      return selectionOf(commit(state, { ...state.model, points, boundary }), []);
    }

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

    case 'set-metadata': {
      const metadata: Record<string, unknown> = { ...state.model.metadata };
      for (const [key, value] of Object.entries(action.metadata)) {
        // `jurisdiction` is not optional — it selects the Plan Composer
        // template, and a plan drawn to no template at all is not a state this
        // reducer is allowed to produce.
        if (value === undefined && key !== 'jurisdiction') delete metadata[key];
        else if (value !== undefined) metadata[key] = value;
      }
      return commit(state, {
        ...state.model,
        metadata: metadata as unknown as SurveyDataModel['metadata'],
      });
    }

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

/**
 * What to open on a cold start.
 *
 * The most recently touched project, or the single-slot store this replaced,
 * or the sample. Falling back through all three matters at exactly one moment:
 * the first load after this feature shipped, when a user who had a project
 * would otherwise be shown an empty library and conclude their work was gone.
 */
function restoreLastProject(): { readonly id: string; readonly model: SurveyDataModel } {
  const [latest] = listProjects();
  if (latest) {
    const model = loadProject(latest.id);
    if (model) return { id: latest.id, model };
  }

  const legacy = loadModel();
  const id = newProjectId();
  const model = legacy ?? SAMPLE_PROJECT;
  saveProject(id, model);
  return { id, model };
}

/**
 * Restored work wins over the sample project, which exists only so a first-time
 * visitor has something to judge the tool by.
 */
export function initialState(): ProjectState {
  // The library is the source of truth once there is one; the single-slot
  // store it replaced is still read so an existing user's work survives the
  // upgrade rather than appearing to have been deleted.
  const restored = restoreLastProject();

  return {
    projectId: restored.id,
    model: restored.model,
    suggestions: [],
    selectedIds: [],
    selectedId: null,
    highlightId: null,
    past: [],
    future: [],
  };
}

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
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  // Deriving rather than storing is what keeps the canvas, the validation
  // state, and any export in agreement. The model is small enough that
  // re-running the pipeline per edit is comfortably inside a frame.
  const pipeline = useMemo(() => runPipeline(state.model), [state.model]);

  useEffect(() => {
    saveModel(state.model);
    saveProject(state.projectId, state.model);
  }, [state.model, state.projectId]);

  // The area is what a project card shows, and only the pipeline knows it.
  useEffect(() => {
    recordArea(state.projectId, pipeline.ok ? (pipeline.rings[0]?.area ?? null) : null);
  }, [pipeline, state.projectId]);

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
