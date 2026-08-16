/**
 * DrawingCanvas (Architecture B.9, B.13).
 *
 * The centre of the application. Renders the Drawing Engine's output plus the
 * placed labels, with pan, pinch-zoom, double-tap zoom, selection, and
 * provenance-distinct styling for anything the AI has proposed.
 *
 * It renders SVG rather than <canvas>: the drawing is a few hundred vector
 * elements, and SVG gives hit-testing, crisp text at any zoom, and real
 * accessibility for free. The engine's geometry is used directly — this
 * component decides nothing about where things go.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  Coordinates,
  FreeTextBox,
  PlacedLabel,
  SiteFeature,
  TitleBlockPart,
  TitleScaleBlock,
} from '@surveyor/contracts';
import {
  formatBearing,
  inverse,
  snap as findSnap,
  type Drawing,
  type DrawingElement,
  type LayerId,
  type SnapResult,
} from '@surveyor/engine';

import {
  distanceToSegment,
  fitTo,
  gridSpacing,
  panBy,
  toScreen,
  toWorld,
  zoomAbout,
  type ScreenPoint,
  type Size,
  type Viewport,
} from './viewport.js';
import { SNAP_RADIUS_PX, snapTargetsFrom, snapTolerance, targetsNear } from './snapping.js';
import { TextBoxMark, TitleBlockMark } from './Annotations.js';
import './canvas.css';

export interface CanvasProps {
  readonly drawing: Drawing;
  /**
   * Labels placed for a given on-screen text size, expressed as survey units
   * per pixel.
   *
   * The canvas cannot reuse the sheet's placement: labels are laid out for text
   * of a fixed physical size on paper, and drawing that same layout at a fixed
   * pixel size on screen makes labels collide that were comfortably apart on
   * the plan. Re-placing for the current zoom is what keeps the canvas an
   * honest preview rather than an approximation of one.
   */
  readonly labelsForScale: (worldPerPixel: number) => readonly PlacedLabel[];
  /** Unconfirmed AI proposals, drawn as previews (B.7). */
  readonly previews?: readonly SiteFeature[];
  readonly selectedId: string | null;
  /** Everything selected, so a set can be drawn and dragged as one. */
  readonly selectedIds?: readonly string[];
  readonly highlightId: string | null;
  readonly onSelect: (id: string | null) => void;
  /** Shift-click and box select, which add to the selection rather than replace it. */
  readonly onSelectMany?: (ids: readonly string[], additive: boolean) => void;
  /** Object snapping, on by default — see canvas/snapping.ts for why it matters. */
  readonly snapping?: boolean;
  /** Grid spacing in survey units, for the grid snap. */
  readonly gridSpacing?: number;
  readonly showLabels?: boolean;
  readonly showGrid?: boolean;
  /** The active tool (B.3). Select hit-tests; Draw adds corners; Measure probes. */
  readonly tool?: CanvasTool;
  readonly onDrawPoint?: (at: Coordinates) => void;
  /** Units for the measurement readout. */
  readonly unit?: string;
  /**
   * Layers the user has turned off. Not drawn, not hit-tested, not snapped to:
   * a hidden layer that still catches clicks is worse than one that is visible,
   * because the thing being grabbed cannot be seen.
   */
  /**
   * Open the map view.
   *
   * Passed in rather than opened here: the canvas draws, it does not know what
   * panels exist. Absent means no button, which is what a build with nowhere
   * to send it should show.
   */
  readonly onOpenMap?: () => void;
  /**
   * The annotation layer: the title/scale block and free text boxes.
   *
   * Passed in rather than read from the model, because the canvas is given a
   * `Drawing` and knows nothing about surveys. Absent means a plan that has
   * none, which is most of them.
   */
  readonly annotations?: {
    readonly titleBlock?: TitleScaleBlock | undefined;
    readonly textBoxes?: readonly FreeTextBox[] | undefined;
    /** What the block prints when it does not override the title. */
    readonly title: string;
    /** The scale the plan is at, when the block does not state one. */
    readonly denominator: number;
    /** The coordinate system, as the heading should state it. */
    readonly origin: string;
    /** The computed area, already worded. Null when there is no closed ring. */
    readonly area: string | null;
  };
  readonly hiddenLayers?: readonly LayerId[];
  /**
   * Layers the user has locked. Drawn, and snapped to — that is most of what
   * locking is for — but not selectable and not draggable, so a reference layer
   * can be worked against without being disturbed.
   */
  readonly lockedLayers?: readonly LayerId[];
  /**
   * Commit a drag. Called once, on release, with the total displacement — not
   * per frame, so the move is one undo step rather than a hundred.
   */
  readonly onMoveBy?: (by: { readonly de: number; readonly dn: number }) => void;
  /**
   * Place a dimension between two ground positions.
   *
   * Coordinates rather than point ids, because the second end is often
   * somewhere with no survey point on it yet — a house corner, the edge of a
   * drive. Turning a position into a point is the store's job, since only it
   * knows which points already exist there.
   */
  readonly onPlaceDimension?: (from: Coordinates, to: Coordinates) => void;
  /**
   * Right-click, or a long press on touch.
   *
   * Reports the object under the pointer along with where to put the menu, so
   * the caller can offer actions for that object rather than a generic list.
   * Page coordinates, because the menu is not drawn inside the SVG.
   */
  readonly onContextMenu?: (at: { readonly x: number; readonly y: number }, id: string | null) => void;
}

export type CanvasTool = 'select' | 'draw' | 'measure' | 'dimension';

/** What each snap is called, for the hint under the drawing. */
const SNAP_LABEL: Readonly<Record<SnapResult['kind'], string>> = {
  endpoint: 'a corner',
  midpoint: 'the middle of a line',
  centre: 'the centre',
  intersection: 'a crossing',
  perpendicular: 'a perpendicular',
  nearest: 'the nearest line',
  grid: 'the grid',
};

const TAP_SLOP_PX = 8;
const HIT_TOLERANCE_PX = 14;
/** Long enough not to fire on a deliberate tap, short enough to feel intended. */
const LONG_PRESS_MS = 500;

export function DrawingCanvas({
  drawing,
  labelsForScale,
  previews = [],
  selectedId,
  selectedIds = [],
  highlightId,
  onSelect,
  onSelectMany,
  snapping = true,
  gridSpacing,
  showLabels = true,
  showGrid = true,
  tool = 'select',
  onDrawPoint,
  unit = 'm',
  onOpenMap,
  annotations,
  hiddenLayers = [],
  lockedLayers = [],
  onMoveBy,
  onPlaceDimension,
  onContextMenu,
}: CanvasProps) {
  // Measurement is ephemeral: it answers a question and is discarded, so it
  // never touches the Survey Data Model.
  const [measure, setMeasure] = useState<readonly Coordinates[]>([]);
  /**
   * Where the cursor would actually commit, and what it latched onto.
   *
   * Held in state rather than computed at click time so the indicator can be
   * drawn: a snap the surveyor cannot see is a snap they cannot trust, and one
   * they cannot trust they will work around by zooming in and clicking
   * carefully, which is the behaviour snapping exists to remove.
   */
  const [snapHint, setSnapHint] = useState<SnapResult | null>(null);
  /** The rubber band, in screen space, while a box select is being dragged. */
  const [band, setBand] = useState<{ readonly from: ScreenPoint; readonly to: ScreenPoint } | null>(
    null,
  );
  /**
   * The live displacement of a drag, in survey units.
   *
   * The selection is drawn shifted by this while the finger is down and the
   * model is left alone until release. Dispatching per frame would work, but it
   * would write a hundred entries into the undo history for one gesture, and
   * "undo that move" would then mean pressing undo a hundred times.
   */
  const [drag, setDrag] = useState<{ readonly de: number; readonly dn: number } | null>(null);
  /** Where the cursor is on the ground, for the readout. Null on touch. */
  const [cursor, setCursor] = useState<Coordinates | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport | null>(null);

  const hidden = useMemo(() => new Set(hiddenLayers), [hiddenLayers]);
  const locked = useMemo(() => new Set(lockedLayers), [lockedLayers]);

  /** What is on screen: everything the user has not turned off. */
  const visible = useMemo(
    () =>
      hidden.size === 0
        ? drawing
        : { ...drawing, layers: drawing.layers.filter((layer) => !hidden.has(layer.id)) },
    [drawing, hidden],
  );

  /**
   * What can be picked up: visible and unlocked.
   *
   * Kept separate from what is drawn, because locking is exactly the ability to
   * see something and still not be able to move it by accident.
   */
  const reachable = useMemo(
    () =>
      locked.size === 0
        ? visible
        : { ...visible, layers: visible.layers.filter((layer) => !locked.has(layer.id)) },
    [locked, visible],
  );

  // --- Sizing --------------------------------------------------------------

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  /**
   * The extent worth fitting: the drawing *and* whatever is written on it.
   *
   * Fitting the drawing alone put the heading off the top of the screen, so
   * adding a title looked like it had done nothing. An annotation is part of
   * what the sheet says, and "fit the plan on screen" has to mean the plan.
   *
   * The heading's *anchor* is what is included, because its height is pixels
   * rather than ground — `fitPaddingPx` below is what leaves room for that.
   */
  const fitBounds = useMemo(() => {
    const points: Coordinates[] = [drawing.bounds.min, drawing.bounds.max];
    if (annotations?.titleBlock) points.push(annotations.titleBlock.at);
    for (const box of annotations?.textBoxes ?? []) points.push(box.at);

    return {
      min: {
        easting: Math.min(...points.map((p) => p.easting)),
        northing: Math.min(...points.map((p) => p.northing)),
      },
      max: {
        easting: Math.max(...points.map((p) => p.easting)),
        northing: Math.max(...points.map((p) => p.northing)),
      },
    };
  }, [drawing.bounds, annotations]);

  /*
   * Extra room when there is a heading, because it is drawn in pixels above
   * its anchor and no amount of survey-unit padding knows how tall it is.
   * Five lines and a bar is about 130px; 150 leaves it breathing space.
   */
  const fitPaddingPx = annotations?.titleBlock ? 150 : 56;

  const fit = useCallback(() => {
    if (size.width === 0 || size.height === 0) return;
    setViewport(fitTo(fitBounds, size, fitPaddingPx));
  }, [fitBounds, fitPaddingPx, size]);

  // Fit once the canvas has a size, and again if the survey is replaced with
  // one that would otherwise be off-screen.
  const boundsKey = `${fitBounds.min.easting},${fitBounds.min.northing},${fitBounds.max.easting},${fitBounds.max.northing}`;
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    setViewport((current) => (current ? current : fitTo(fitBounds, size, fitPaddingPx)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  const previousBounds = useRef(boundsKey);
  useEffect(() => {
    if (previousBounds.current !== boundsKey) {
      previousBounds.current = boundsKey;
      fit();
    }
  }, [boundsKey, fit]);

  // --- Pointer handling ----------------------------------------------------

  const pointers = useRef(new Map<number, ScreenPoint>());
  const gesture = useRef<{
    moved: boolean;
    lastDistance: number | null;
    start: ScreenPoint;
    lastTapAt: number;
    /** True while a drag that began on empty canvas is drawing a selection box. */
    banding: boolean;
  }>({
    moved: false,
    lastDistance: null,
    start: { x: 0, y: 0 },
    lastTapAt: 0,
    banding: false,
  });

  const localPoint = useCallback(
    (event: { readonly clientX: number; readonly clientY: number }): ScreenPoint => {
      const rect = hostRef.current?.getBoundingClientRect();
      return {
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      };
    },
    [],
  );

  const targets = useMemo(() => snapTargetsFrom(visible), [visible]);

  /** Everything currently selected, as a set, for "is this being dragged?". */
  const moving = useMemo(
    () => new Set(selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : []),
    [selectedId, selectedIds],
  );

  /**
   * Annotation anchors, for hit-testing. Empty on a plan that has none.
   *
   * The heading contributes one target *per visible part*, because each part
   * is a separate thing to tap and drag — a plan's title, its stated scale and
   * its scale bar are separate statements, not one object. `dy` is where the
   * part sits below the heading's anchor, in screen pixels, which is how the
   * renderer stacks them.
   */
  const annotationTargets = useMemo(() => {
    const block = annotations?.titleBlock;
    const targets: AnnotationTarget[] = [];

    if (block) {
      /*
       * The same stack the renderer builds, and it has to stay the same.
       *
       * Two descriptions of one layout is a bug waiting to happen — the
       * version that has already happened is a target sitting where a line
       * used to be. It is duplicated rather than shared because the renderer
       * needs it in JSX and this needs it as data; the heights below are the
       * ones in `Annotations.tsx`, and changing either without the other puts
       * every hit target on the wrong line.
       */
      const rows: { readonly part: string; readonly height: number }[] = [];
      if (block.showTitle) rows.push({ part: 'title', height: block.subtitle ? 36 : 20 });
      if (block.showRepresentativeFraction) rows.push({ part: 'fraction', height: 20 });
      if (block.showScaleBar) rows.push({ part: 'bar', height: 30 });
      if (block.showOrigin) rows.push({ part: 'origin', height: 20 });
      if (block.showArea && annotations.area) rows.push({ part: 'area', height: 20 });

      // The heading grows upward from its anchor so it can never overrun the
      // drawing — see `TitleBlockMark`. The targets have to be lifted with it.
      const HEADING_GAP_PX = 22;
      const lift = rows.reduce((total, row) => total + row.height, 0) + HEADING_GAP_PX;

      let cursor = 0;
      for (const row of rows) {
        const own = block.offsets?.[row.part as keyof NonNullable<typeof block.offsets>];
        targets.push({
          id: `${block.id}:${row.part}`,
          at: own
            ? { easting: block.at.easting + own.de, northing: block.at.northing + own.dn }
            : block.at,
          dy: cursor - lift,
          // Centred rather than starting at the anchor, unlike a text box.
          wide: true,
        });
        cursor += row.height;
      }
    }

    for (const box of annotations?.textBoxes ?? []) targets.push({ id: box.id, at: box.at });
    return targets;
  }, [annotations]);

  /**
   * Snap targets with everything the move disturbs taken out.
   *
   * The obvious exclusion is the selection itself: left in, the grabbed corner
   * is always exactly on itself and the selection sticks to its start however
   * far the finger travels.
   *
   * The one that is easy to miss is geometry that merely *shares* a coordinate
   * with it. Dragging survey point PT1 moves the boundary corner at PT1 too —
   * the ring is defined by the point, not by a copy of it — so the boundary's
   * corner is not a fixed thing to snap to, it is the same thing under another
   * name. Snapping to it pins every drag at zero, which is exactly the bug this
   * exists to prevent. An element sharing a vertex with the selection is
   * therefore dropped whole: if one of its corners is moving, its midpoints and
   * edges are moving too, and none of them is a landmark.
   */
  const staticTargets = useMemo(() => {
    if (moving.size === 0) return targets;

    const carried = new Set<string>();
    for (const layer of visible.layers) {
      for (const element of layer.elements) {
        if (!moving.has(element.id)) continue;
        for (const point of element.kind === 'symbol' ? [element.at] : element.points) {
          carried.add(coordinateKey(point));
        }
      }
    }

    return snapTargetsFrom({
      ...visible,
      layers: visible.layers.map((layer) => ({
        ...layer,
        elements: layer.elements.filter(
          (element) =>
            !moving.has(element.id) &&
            !(element.kind === 'symbol' ? [element.at] : element.points).some((point) =>
              carried.has(coordinateKey(point)),
            ),
        ),
      })),
    });
  }, [moving, targets, visible]);

  /**
   * Where a click at this screen point should actually land.
   *
   * Returns the snap when there is one and the raw world point when there is
   * not, and reports which it was — the caller needs that distinction, because
   * a corner placed on a snap shares a coordinate exactly and one placed on a
   * click merely looks like it does.
   */
  const resolve = useCallback(
    (point: ScreenPoint): { readonly at: Coordinates; readonly snapped: SnapResult | null } => {
      if (!viewport) return { at: { easting: 0, northing: 0 }, snapped: null };
      const world = toWorld(point, viewport, size);
      if (!snapping) return { at: world, snapped: null };

      const tolerance = snapTolerance(viewport.scale, SNAP_RADIUS_PX);
      const hit = findSnap(world, targetsNear(targets, world, tolerance * 4), {
        tolerance,
        ...(gridSpacing ? { gridSpacing } : {}),
      });
      return { at: hit ? hit.at : world, snapped: hit };
    },
    [gridSpacing, size, snapping, targets, viewport],
  );

  /**
   * The corner the drag is carrying, in survey units.
   *
   * A drag needs a point of its own to snap: without one, the only thing that
   * could latch is the cursor, and a corner that lands "somewhere near" a
   * neighbouring corner is exactly the sliver a closure check later fails on.
   * The nearest vertex to the grab is what the user is reaching for.
   */
  const dragAnchor = useRef<Coordinates | null>(null);

  /**
   * The menu, from a right-click or from holding a finger down.
   *
   * Long press is the touch equivalent and there is no other way to reach
   * these actions on a phone, so it is not a nicety. It is cancelled by any
   * movement past the tap slop, which is what stops a pan from turning into a
   * menu halfway across the drawing.
   */
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  const raiseMenu = useCallback(
    (client: { readonly x: number; readonly y: number }, point: ScreenPoint) => {
      if (!onContextMenu || !viewport) return;
      onContextMenu(client, hitTest(point, reachable, viewport, size, annotationTargets));
    },
    [onContextMenu, reachable, size, viewport],
  );

  const cancelLongPress = useCallback(() => {
    if (longPress.current === null) return;
    clearTimeout(longPress.current);
    longPress.current = null;
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      const point = localPoint(event);
      pointers.current.set(event.pointerId, point);
      event.currentTarget.setPointerCapture(event.pointerId);

      cancelLongPress();
      if (pointers.current.size === 1) {
        gesture.current.moved = false;
        gesture.current.start = point;
        dragAnchor.current = null;
        gesture.current.banding = false;

        if (event.pointerType === 'touch' && onContextMenu) {
          const client = { x: event.clientX, y: event.clientY };
          longPress.current = setTimeout(() => {
            longPress.current = null;
            // Only if the finger has not travelled: a press that became a pan
            // is a pan, and interrupting it with a menu would be maddening.
            if (!gesture.current.moved) raiseMenu(client, point);
          }, LONG_PRESS_MS);
        }

        const hit =
          tool === 'select' && viewport
            ? hitTest(point, reachable, viewport, size, annotationTargets)
            : null;

        // Something already selected is picked up; anything else is not. A drag
        // that grabbed whatever happened to be under the finger would move
        // objects the user had not chosen, which on a survey is a silent edit.
        if (hit !== null && moving.has(hit) && onMoveBy) {
          dragAnchor.current = nearestVertex(
            toWorld(point, viewport!, size),
            reachable,
            moving,
          );
        } else if (
          hit === null &&
          tool === 'select' &&
          onSelectMany &&
          viewport &&
          // Shift, and only shift.
          //
          // A plain drag pans, because moving about the drawing is the gesture
          // people make constantly and a touch screen has nothing else to make
          // it with. Box select briefly took the plain drag and panning stopped
          // working — the drawing appeared to be nailed down, and dragging it
          // drew a selection rectangle instead. Shift is already this app's
          // "and also" modifier for clicking, so extending it to dragging
          // keeps one idea rather than adding a second.
          event.shiftKey
        ) {
          gesture.current.banding = true;
        }
      }
      gesture.current.lastDistance = null;
    },
    [
      cancelLongPress,
      localPoint,
      moving,
      onContextMenu,
      onMoveBy,
      onSelectMany,
      raiseMenu,
      reachable,
      size,
      tool,
      viewport,
    ],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!pointers.current.has(event.pointerId) || !viewport) return;

      const point = localPoint(event);
      const previous = pointers.current.get(event.pointerId)!;
      pointers.current.set(event.pointerId, point);

      const active = [...pointers.current.values()];

      if (active.length >= 2) {
        // Pinch: scale about the midpoint between the two fingers.
        const [a, b] = active as [ScreenPoint, ScreenPoint];
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

        if (gesture.current.lastDistance !== null && gesture.current.lastDistance > 0) {
          const factor = distance / gesture.current.lastDistance;
          setViewport((current) =>
            current ? zoomAbout(current, size, midpoint, factor) : current,
          );
        }
        gesture.current.lastDistance = distance;
        gesture.current.moved = true;
        return;
      }

      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      const dragged =
        Math.hypot(point.x - gesture.current.start.x, point.y - gesture.current.start.y) >
        TAP_SLOP_PX;
      if (dragged) {
        gesture.current.moved = true;
        cancelLongPress();
      }

      // A shift-drag on empty canvas is a selection box. Every other drag
      // pans.
      if (gesture.current.banding) {
        if (dragged) setBand({ from: gesture.current.start, to: point });
        return;
      }

      // Carrying the selection. The displacement is measured on the ground
      // rather than in pixels so it survives a zoom mid-drag.
      const anchor = dragAnchor.current;
      if (anchor) {
        if (!dragged) return;
        const from = toWorld(gesture.current.start, viewport, size);
        const to = toWorld(point, viewport, size);
        let by = { de: to.easting - from.easting, dn: to.northing - from.northing };

        if (snapping) {
          const landing = {
            easting: anchor.easting + by.de,
            northing: anchor.northing + by.dn,
          };
          const tolerance = snapTolerance(viewport.scale, SNAP_RADIUS_PX);
          const hit = findSnap(landing, targetsNear(staticTargets, landing, tolerance * 4), {
            tolerance,
            ...(gridSpacing ? { gridSpacing } : {}),
          });
          setSnapHint(hit);
          if (hit) {
            by = {
              de: hit.at.easting - anchor.easting,
              dn: hit.at.northing - anchor.northing,
            };
          }
        }

        setDrag(by);
        return;
      }

      setViewport((current) => (current ? panBy(current, dx, dy) : current));
    },
    [gridSpacing, localPoint, size, snapping, staticTargets, viewport],
  );

  const onPointerHover = useCallback(
    (event: React.PointerEvent) => {
      // Touch has no hover, and showing a stale indicator after a tap is worse
      // than showing none.
      if (event.pointerType === 'touch' || pointers.current.size > 0) return;
      if (!viewport) return;

      const point = localPoint(event);
      // The readout is live whatever the tool: "where is that corner?" is a
      // question a surveyor asks constantly, and answering it should not
      // require switching to Measure and back.
      setCursor(toWorld(point, viewport, size));
      if (tool === 'select') return;
      setSnapHint(resolve(point).snapped);
    },
    [localPoint, resolve, size, tool, viewport],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const point = localPoint(event);
      pointers.current.delete(event.pointerId);
      gesture.current.lastDistance = null;
      cancelLongPress();

      if (pointers.current.size > 0 || !viewport) return;

      // A finished drag becomes one move, and one undo step.
      if (dragAnchor.current) {
        const by = drag;
        dragAnchor.current = null;
        setDrag(null);
        setSnapHint(null);
        // A drag of nothing is a tap, and falls through to selection below.
        if (by && (by.de !== 0 || by.dn !== 0)) {
          onMoveBy?.(by);
          return;
        }
      }

      // A finished selection box takes everything it encloses.
      if (gesture.current.banding) {
        const rubber = band;
        gesture.current.banding = false;
        setBand(null);
        if (rubber && gesture.current.moved) {
          onSelectMany?.(
            enclosedBy(rubber.from, rubber.to, reachable, viewport, size),
            event.shiftKey,
          );
          return;
        }
      }

      if (gesture.current.moved) return;

      const { at: world, snapped } = resolve(point);
      setSnapHint(null);

      if (tool === 'draw') {
        onDrawPoint?.(world);
        return;
      }
      if (tool === 'measure') {
        void snapped;
        // Two taps make a measurement; a third starts a fresh one.
        setMeasure((current) => (current.length >= 2 ? [world] : [...current, world]));
        return;
      }
      if (tool === 'dimension') {
        // The same two taps as Measure, but the result stays on the plan. The
        // in-progress line reuses `measure` so the user sees the same rubber
        // band while placing it — one behaviour, not two that look alike.
        setMeasure((current) => {
          if (current.length === 0) return [world];
          const first = current[0]!;
          onPlaceDimension?.(first, world);
          return [];
        });
        return;
      }

      // Double tap zooms in about the tap, matching the pinch anchor rule.
      //
      // Only in select mode: placing two corners in quick succession is the
      // normal way to draw, and it must not be mistaken for a zoom gesture.
      const now = Date.now();
      if (now - gesture.current.lastTapAt < 300) {
        gesture.current.lastTapAt = 0;
        setViewport((current) => (current ? zoomAbout(current, size, point, 1.9) : current));
        return;
      }
      gesture.current.lastTapAt = now;

      const hit = hitTest(point, reachable, viewport, size, annotationTargets);
      if (event.shiftKey && hit && onSelectMany) {
        onSelectMany([hit], true);
        return;
      }
      onSelect(hit);
    },
    [
      band,
      cancelLongPress,
      drag,
      localPoint,
      onDrawPoint,
      onMoveBy,
      onPlaceDimension,
      onSelect,
      onSelectMany,
      reachable,
      resolve,
      size,
      tool,
      viewport,
    ],
  );

  // Switching tools abandons a half-finished measurement rather than leaving
  // a stale line floating over the drawing.
  useEffect(() => {
    if (tool !== 'measure' && tool !== 'dimension') setMeasure([]);
  }, [tool]);

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!viewport) return;
      const rect = hostRef.current?.getBoundingClientRect();
      const anchor = {
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      };
      const factor = Math.exp(-event.deltaY * 0.0016);
      setViewport((current) => (current ? zoomAbout(current, size, anchor, factor) : current));
    },
    [size, viewport],
  );

  // --- Rendering -----------------------------------------------------------

  const project = useCallback(
    (world: Coordinates) => (viewport ? toScreen(world, viewport, size) : { x: 0, y: 0 }),
    [size, viewport],
  );

  const grid = useMemo(() => {
    if (!viewport || !showGrid || size.width === 0) return null;
    return buildGrid(viewport, size);
  }, [showGrid, size, viewport]);

  /**
   * The ground the screen is showing, with a little margin for stroke width.
   *
   * Elements whose extent misses it entirely are skipped. On a small site this
   * saves nothing; on an estate zoomed in on one plot it is the difference
   * between a canvas that tracks the finger and one that stutters, and the cost
   * when it does not help is one rectangle comparison per element.
   *
   * Overlap is tested against each element's own extent rather than its
   * vertices, so a boundary line running clear across the view is kept even
   * though both of its ends are off screen.
   */
  const view = useMemo(() => {
    if (!viewport || size.width === 0) return null;
    const padding = 24 / viewport.scale;
    const halfWidth = size.width / 2 / viewport.scale + padding;
    const halfHeight = size.height / 2 / viewport.scale + padding;
    return {
      minE: viewport.centre.easting - halfWidth,
      maxE: viewport.centre.easting + halfWidth,
      minN: viewport.centre.northing - halfHeight,
      maxN: viewport.centre.northing + halfHeight,
    };
  }, [size, viewport]);

  // Quantised to steps of about 26% so a pinch does not re-run placement on
  // every frame; labels settle to the new zoom rather than shuffling
  // continuously. Dividing by the same factor is what keeps this a rounding of
  // the scale rather than a wild multiple of it.
  const quantisedScale = viewport
    ? 2 ** (Math.round(Math.log2(viewport.scale) * 3) / 3)
    : null;

  const labels = useMemo(
    () => (quantisedScale ? labelsForScale(1 / quantisedScale) : []),
    [labelsForScale, quantisedScale],
  );

  const ready = viewport !== null && size.width > 0;

  return (
    <div className="canvas" ref={hostRef}>
      <svg
        className="canvas__svg"
        width={size.width}
        height={size.height}
        role="img"
        aria-label="Site plan drawing"
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          onPointerMove(event);
          onPointerHover(event);
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          setSnapHint(null);
          setCursor(null);
        }}
        onWheel={onWheel}
        onContextMenu={(event) => {
          if (!onContextMenu) return;
          // The browser's own menu offers "Save image as…" over a drawing the
          // user is editing, which is never what they wanted here.
          event.preventDefault();
          raiseMenu({ x: event.clientX, y: event.clientY }, localPoint(event));
        }}
      >
        {grid ? (
          <g className="canvas__grid" aria-hidden="true">
            {grid.vertical.map((x) => (
              <line key={`v${x}`} x1={x} y1={0} x2={x} y2={size.height} />
            ))}
            {grid.horizontal.map((y) => (
              <line key={`h${y}`} x1={0} y1={y} x2={size.width} y2={y} />
            ))}
          </g>
        ) : null}

        {ready
          ? visible.layers.map((layer) => (
              <g
                key={layer.id}
                className={`layer layer--${layer.id}${locked.has(layer.id) ? ' is-locked' : ''}`}
              >
                {layer.elements.map((element) =>
                  onScreen(element, view) ? (
                    <Element
                      key={element.id}
                      element={element}
                      project={project}
                      selected={element.id === selectedId || selectedIds.includes(element.id)}
                      highlighted={element.id === highlightId}
                      {...(drag && moving.has(element.id) ? { offset: drag } : {})}
                    />
                  ) : null,
                )}
              </g>
            ))
          : null}

        {ready
          ? previews.map((feature) => (
              <Preview key={feature.id} feature={feature} project={project} />
            ))
          : null}

        {ready && showLabels ? (
          <g className="layer layer--labels">
            {labels.map((label) => (
              <Label key={label.spec.id} label={label} project={project} />
            ))}
          </g>
        ) : null}

        {/*
          Annotations, above everything they annotate.

          Last in the document is on top in SVG, which is what a note on a
          drawing has to be — one drawn under a boundary line is a note nobody
          can read.
        */}
        {ready && annotations ? (
          <g className="layer layer--annotations">
            {annotations.titleBlock ? (
              <TitleBlockMark
                block={annotations.titleBlock}
                project={project}
                selectedIds={[...moving]}
                title={annotations.title}
                denominator={annotations.denominator}
                origin={annotations.origin}
                area={annotations.area}
                unit={unit}
                worldPerPixel={viewport ? 1 / viewport.scale : 1}
                {...(drag && headingPart(annotations.titleBlock.id, moving)
                  ? { offset: drag, moving: true, movingPart: headingPart(annotations.titleBlock.id, moving) }
                  : {})}
              />
            ) : null}
            {(annotations.textBoxes ?? []).map((box) => (
              <TextBoxMark
                key={box.id}
                box={box}
                project={project}
                selectedIds={[...moving]}
                {...(drag && moving.has(box.id) ? { offset: drag, moving: true } : {})}
              />
            ))}
          </g>
        ) : null}

        {ready && measure.length > 0 ? (
          <Measurement points={measure} project={project} unit={unit} />
        ) : null}

        {/*
          The snap marker. Shown as a square on an exact feature of the
          geometry and a circle on a merely-nearest point, so the surveyor can
          tell at a glance whether the click will share a coordinate or only
          look like it does.
        */}
        {ready && snapHint ? (
          <g className={`snap snap--${snapHint.kind}`} aria-hidden="true">
            {snapHint.kind === 'nearest' || snapHint.kind === 'grid' ? (
              <circle
                cx={project(snapHint.at).x}
                cy={project(snapHint.at).y}
                r={6}
                className="snap__mark"
              />
            ) : (
              <rect
                x={project(snapHint.at).x - 6}
                y={project(snapHint.at).y - 6}
                width={12}
                height={12}
                className="snap__mark"
              />
            )}
          </g>
        ) : null}

        {band ? (
          <rect
            className="canvas__band"
            x={Math.min(band.from.x, band.to.x)}
            y={Math.min(band.from.y, band.to.y)}
            width={Math.abs(band.to.x - band.from.x)}
            height={Math.abs(band.to.y - band.from.y)}
            aria-hidden="true"
          />
        ) : null}
      </svg>

      {selectedIds.length > 1 ? (
        <div className="canvas__hint canvas__hint--count" role="status">
          {selectedIds.length} selected
        </div>
      ) : null}

      {/*
        Where the cursor is and how far the drag has gone — the readout a CAD
        user glances at without taking their eyes off the drawing. It reports
        the ground position, not the screen one, because that is the number
        that goes on the plan.
      */}
      {ready && (cursor || drag) ? (
        <div className="canvas__readout numeric" role="status">
          {drag ? (
            <>
              <span>
                Δ {drag.de >= 0 ? '+' : '−'}
                {Math.abs(drag.de).toFixed(2)} E, {drag.dn >= 0 ? '+' : '−'}
                {Math.abs(drag.dn).toFixed(2)} N {unit}
              </span>
              {snapHint ? <span>· {SNAP_LABEL[snapHint.kind]}</span> : null}
            </>
          ) : cursor ? (
            <span>
              {cursor.easting.toFixed(2)} E · {cursor.northing.toFixed(2)} N
            </span>
          ) : null}
        </div>
      ) : null}

      {tool !== 'select' ? (
        <div className="canvas__hint" role="status">
          {tool === 'draw'
            ? snapHint
              ? `Snapped to ${SNAP_LABEL[snapHint.kind]}`
              : 'Tap to place a corner'
            : tool === 'dimension'
              ? measure.length === 0
                ? 'Tap what to measure from'
                : 'Tap what to measure to'
              : measure.length === 0
                ? 'Tap the first point'
                : measure.length === 1
                  ? 'Tap the second point'
                  : 'Tap to start a new measurement'}
        </div>
      ) : null}

      {ready ? (
        <>
          <ZoomControls
            onZoomIn={() =>
              setViewport((current) =>
                current
                  ? zoomAbout(current, size, { x: size.width / 2, y: size.height / 2 }, 1.35)
                  : current,
              )
            }
            onZoomOut={() =>
              setViewport((current) =>
                current
                  ? zoomAbout(current, size, { x: size.width / 2, y: size.height / 2 }, 1 / 1.35)
                  : current,
              )
            }
            onFit={fit}
            onOpenMap={onOpenMap}
          />
          <NorthArrow />
          <ScaleBar viewport={viewport} />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

type Project = (world: Coordinates) => ScreenPoint;

function Element({
  element,
  project: projectAt,
  selected,
  highlighted,
  offset,
}: {
  readonly element: DrawingElement;
  readonly project: Project;
  readonly selected: boolean;
  readonly highlighted: boolean;
  /** Live drag displacement, in survey units. Absent unless being carried. */
  readonly offset?: { readonly de: number; readonly dn: number };
}) {
  // Shifted on the ground rather than by an SVG transform, so a dragged object
  // is drawn where it would actually land — the same coordinates the move will
  // commit — rather than somewhere that merely looks right on screen.
  const project: Project = offset
    ? (world) =>
        projectAt({ easting: world.easting + offset.de, northing: world.northing + offset.dn })
    : projectAt;

  const classes = [
    'element',
    `element--${element.kind === 'symbol' ? 'symbol' : element.style}`,
    selected ? 'is-selected' : '',
    highlighted ? 'is-highlighted' : '',
    offset ? 'is-dragging' : '',
    element.provenance.source === 'ai-suggested' ? 'is-suggested' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (element.kind === 'symbol') {
    const p = project(element.at);
    // A level is a cross because a cross has an unambiguous centre — the level
    // is at that point, and a dot big enough to see would cover it. The same
    // symbology the exported sheet uses, so screen and paper agree.
    const cross = element.symbol === 'level' || element.symbol === 'benchmark';

    return (
      <g
        className={`${classes} element--point element--${element.symbol}`}
        data-id={element.id}
      >
        {/* An invisible disc gives the small marker a 44px touch target. */}
        <circle className="element__hit" cx={p.x} cy={p.y} r={22} />
        {cross ? (
          <>
            <path
              className="element__marker-cross"
              d={`M ${p.x - 6} ${p.y} L ${p.x + 6} ${p.y} M ${p.x} ${p.y - 6} L ${p.x} ${p.y + 6}`}
            />
            {element.symbol === 'benchmark' ? (
              <circle className="element__marker-ring" cx={p.x} cy={p.y} r={9} />
            ) : null}
          </>
        ) : (
          <circle className="element__marker" cx={p.x} cy={p.y} r={4} />
        )}
      </g>
    );
  }

  const points = element.points.map(project).map((p) => `${p.x},${p.y}`).join(' ');

  return element.kind === 'polygon' ? (
    <g className={classes} data-id={element.id}>
      <polygon className="element__hit-line" points={points} />
      <polygon className="element__shape" points={points} />
    </g>
  ) : (
    <g className={classes} data-id={element.id}>
      <polyline className="element__hit-line" points={points} />
      <polyline className="element__shape" points={points} />
    </g>
  );
}

/**
 * A proposed object, before the user has accepted it (B.7). Rendered
 * unmistakably differently from measured geometry — this is the trust
 * mechanism made visible, not decoration.
 */
function Preview({
  feature,
  project,
}: {
  readonly feature: SiteFeature;
  readonly project: Project;
}) {
  if (feature.geometry.kind !== 'polygon') return null;
  const points = feature.geometry.vertices.map(project).map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <g className="preview">
      <polygon className="preview__shape" points={points} />
    </g>
  );
}

function Label({
  label,
  project,
}: {
  readonly label: PlacedLabel;
  readonly project: Project;
}) {
  if (label.outcome === 'dropped') return null;

  const p = project({ easting: label.position.x, northing: label.position.y });
  const suggested = label.spec.provenance.source === 'ai-suggested';

  return (
    <g className={`label label--${label.spec.role} ${suggested ? 'is-suggested' : ''}`}>
      {label.leader ? (
        <line
          className="label__leader"
          x1={project({ easting: label.leader.from.x, northing: label.leader.from.y }).x}
          y1={project({ easting: label.leader.from.x, northing: label.leader.from.y }).y}
          x2={p.x}
          y2={p.y}
        />
      ) : null}
      <text
        className="label__text"
        x={p.x}
        y={p.y}
        textAnchor="middle"
        dominantBaseline="central"
        transform={
          Math.abs(label.rotation) > 0.01
            ? `rotate(${-label.rotation} ${p.x} ${p.y})`
            : undefined
        }
      >
        {label.text}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/**
 * The measure tool's readout. Bearing and distance come from the COGO engine,
 * the same call the plan's dimensions use — a measurement the user takes and a
 * dimension printed on the sheet must never disagree.
 */
function Measurement({
  points,
  project,
  unit,
}: {
  readonly points: readonly Coordinates[];
  readonly project: Project;
  readonly unit: string;
}) {
  const [from, to] = points;
  if (!from) return null;

  const a = project(from);
  const b = to ? project(to) : null;
  const reading = to ? inverse(from, to) : null;

  return (
    <g className="measure">
      <circle className="measure__node" cx={a.x} cy={a.y} r={5} />
      {b && reading ? (
        <>
          <line className="measure__line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          <circle className="measure__node" cx={b.x} cy={b.y} r={5} />
          <text
            className="measure__readout"
            x={(a.x + b.x) / 2}
            y={(a.y + b.y) / 2 - 12}
            textAnchor="middle"
          >
            {formatBearing(reading.bearing, 'quadrant')} · {reading.distance.toFixed(2)} {unit}
          </text>
        </>
      ) : null}
    </g>
  );
}

function ZoomControls({
  onZoomIn,
  onZoomOut,
  onFit,
  onOpenMap,
}: {
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
  /** Absent on a survey that cannot be mapped — see `Workspace`. */
  readonly onOpenMap?: (() => void) | undefined;
}) {
  return (
    <div className="canvas__zoom">
      <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">
        +
      </button>
      <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">
        −
      </button>
      <button type="button" onClick={onFit} aria-label="Fit plan to screen" title="Fit the whole plan on screen">
        ⤢
      </button>
      {/*
        The map, one tap from the drawing rather than three through a menu.

        It sits with the view controls because that is what it is — another way
        of looking at the same plan — and it is the same size as the rest so a
        thumb reaching for it does not have to aim. Whichever basemap was last
        chosen is the one it opens on.
      */}
      {onOpenMap ? (
        <button
          type="button"
          onClick={onOpenMap}
          aria-label="Show on a map, and switch between streets and satellite"
          title="Map — streets or satellite"
        >
          ◈
        </button>
      ) : null}
    </div>
  );
}

function NorthArrow() {
  return (
    <div className="canvas__north" aria-hidden="true">
      <svg viewBox="0 0 24 32" width="18" height="24">
        <path d="M12 1 L18 30 L12 24 L6 30 Z" />
      </svg>
      <span>N</span>
    </div>
  );
}

function ScaleBar({ viewport }: { readonly viewport: Viewport }) {
  const target = 96 / viewport.scale;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(target, 1e-6)));
  const step = [1, 2, 5, 10].find((s) => magnitude * s >= target) ?? 10;
  const worldLength = magnitude * step;

  return (
    <div className="canvas__scale" aria-hidden="true">
      <div className="canvas__scale-bar" style={{ width: worldLength * viewport.scale }} />
      <span className="numeric">{formatLength(worldLength)}</span>
    </div>
  );
}

function formatLength(metres: number): string {
  if (metres >= 1000) return `${metres / 1000} km`;
  if (metres >= 1) return `${metres} m`;
  return `${metres * 100} cm`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGrid(
  viewport: Viewport,
  size: Size,
): { readonly vertical: number[]; readonly horizontal: number[] } {
  const spacing = gridSpacing(viewport.scale);
  const halfWidthWorld = size.width / 2 / viewport.scale;
  const halfHeightWorld = size.height / 2 / viewport.scale;

  const vertical: number[] = [];
  const horizontal: number[] = [];

  const startE = Math.floor((viewport.centre.easting - halfWidthWorld) / spacing) * spacing;
  for (let e = startE; e < viewport.centre.easting + halfWidthWorld; e += spacing) {
    vertical.push(
      Math.round(toScreen({ easting: e, northing: 0 }, viewport, size).x) + 0.5,
    );
  }

  const startN = Math.floor((viewport.centre.northing - halfHeightWorld) / spacing) * spacing;
  for (let n = startN; n < viewport.centre.northing + halfHeightWorld; n += spacing) {
    horizontal.push(
      Math.round(toScreen({ easting: 0, northing: n }, viewport, size).y) + 0.5,
    );
  }

  return { vertical, horizontal };
}

/**
 * A coordinate as a key, to the millimetre.
 *
 * Survey coordinates that describe the same corner are equal to far better
 * than a millimetre — they are usually the same number — so this is an
 * identity test rather than a tolerance, and a millimetre is well below
 * anything a plan distinguishes.
 */
function coordinateKey(at: Coordinates): string {
  return `${at.easting.toFixed(3)},${at.northing.toFixed(3)}`;
}

interface WorldRect {
  readonly minE: number;
  readonly maxE: number;
  readonly minN: number;
  readonly maxN: number;
}

/** Whether any part of this element could fall inside the view. */
function onScreen(element: DrawingElement, view: WorldRect | null): boolean {
  if (!view) return true;

  const points = element.kind === 'symbol' ? [element.at] : element.points;
  if (points.length === 0) return false;

  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const point of points) {
    if (point.easting < minE) minE = point.easting;
    if (point.easting > maxE) maxE = point.easting;
    if (point.northing < minN) minN = point.northing;
    if (point.northing > maxN) maxN = point.northing;
  }

  return !(maxE < view.minE || minE > view.maxE || maxN < view.minN || minN > view.maxN);
}

/**
 * The corner of the selection nearest the grab.
 *
 * Falls back to the grab point itself when the selection has no vertices to
 * offer, which keeps the drag working — unsnapped — rather than refusing it.
 */
function nearestVertex(
  grab: Coordinates,
  drawing: Drawing,
  ids: ReadonlySet<string>,
): Coordinates {
  let best: Coordinates | null = null;
  let bestDistance = Infinity;

  for (const layer of drawing.layers) {
    for (const element of layer.elements) {
      if (!ids.has(element.id)) continue;
      for (const point of element.kind === 'symbol' ? [element.at] : element.points) {
        const distance = Math.hypot(
          point.easting - grab.easting,
          point.northing - grab.northing,
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          best = point;
        }
      }
    }
  }

  return best ?? grab;
}

/**
 * Everything a selection box encloses.
 *
 * Fully enclosed, not merely touched. AutoCAD offers both — a window takes
 * what is inside, a crossing takes what it touches — and the window is the one
 * that behaves predictably on a drawing where a boundary runs the whole width
 * of the screen. A crossing selection there would take the parcel every time
 * the box was dragged anywhere, which is not a selection.
 */
function enclosedBy(
  from: ScreenPoint,
  to: ScreenPoint,
  drawing: Drawing,
  viewport: Viewport,
  size: Size,
): readonly string[] {
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);

  const inside = (at: Coordinates): boolean => {
    const screen = toScreen(at, viewport, size);
    return screen.x >= left && screen.x <= right && screen.y >= top && screen.y <= bottom;
  };

  const ids: string[] = [];
  for (const layer of drawing.layers) {
    for (const element of layer.elements) {
      const points = element.kind === 'symbol' ? [element.at] : element.points;
      if (points.length > 0 && points.every(inside)) ids.push(element.id);
    }
  }
  return ids;
}

/**
 * One tappable thing in the annotation layer.
 *
 * A heading contributes one of these per visible line rather than one for the
 * whole thing, because on a survey plan the title, the stated scale, the bar,
 * the origin and the area are separate statements that a surveyor positions
 * and shows separately.
 */
interface AnnotationTarget {
  readonly id: string;
  readonly at: Coordinates;
  /** Screen pixels below the anchor, for a line stacked under a heading. */
  readonly dy?: number | undefined;
  /** Centred on the anchor rather than running right from it. */
  readonly wide?: boolean | undefined;
}

/**
 * Which part of the heading is being dragged, if any.
 *
 * The selection holds ids like `title_x9:bar`, so the part is the suffix. Read
 * from the selection rather than stored beside it, because the selection is
 * the single record of what is being moved and a second copy is a second thing
 * to get wrong.
 */
function headingPart(
  blockId: string,
  selected: ReadonlySet<string>,
): TitleBlockPart | undefined {
  for (const id of selected) {
    if (!id.startsWith(`${blockId}:`)) continue;
    const part = id.slice(blockId.length + 1);
    if (
      part === 'title' ||
      part === 'fraction' ||
      part === 'bar' ||
      part === 'origin' ||
      part === 'area'
    ) {
      return part;
    }
  }
  return undefined;
}

/**
 * Nearest element within the touch tolerance. Points win over lines, and lines
 * over areas, because that is the order a user expects to grab things in.
 */
function hitTest(
  point: ScreenPoint,
  drawing: Drawing,
  viewport: Viewport,
  size: Size,
  /**
   * Annotations, tested first and won by whoever is on top.
   *
   * They sit above the drawing, so a tap that lands on both is a tap on the
   * annotation — anything else means a note over a boundary can be seen and
   * not touched.
   */
  annotations: readonly AnnotationTarget[] = [],
): string | null {
  let best: { id: string; rank: number; distance: number } | null = null;

  for (const annotation of annotations) {
    const projected = toScreen(annotation.at, viewport, size);
    const p = { x: projected.x, y: projected.y + (annotation.dy ?? 0) };
    /*
     * A box round the anchor rather than the drawn extent. The renderer knows
     * how wide the text is and this does not, and the two agreeing exactly
     * matters less than the target being reachable: a generous box that is
     * slightly wrong is a control that works, and an exact one that needs
     * aiming is not.
     *
     * Heading lines are centred on their anchor and text boxes run right from
     * theirs, so the box is drawn to match — a centred target measured from
     * one corner would sit half off the thing it is for.
     */
    const left = annotation.wide ? p.x - 110 : p.x - 20;
    const right = annotation.wide ? p.x + 110 : p.x + 180;
    const top = annotation.wide ? p.y - 16 : p.y - 22;
    const bottom = annotation.wide ? p.y + 18 : p.y + 60;

    if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) {
      // Rank below zero so an annotation beats every element under it.
      consider({ id: annotation.id, rank: -1, distance: Math.hypot(p.x - point.x, p.y - point.y) });
    }
  }

  for (const layer of drawing.layers) {
    for (const element of layer.elements) {
      if (element.kind === 'symbol') {
        const p = toScreen(element.at, viewport, size);
        const distance = Math.hypot(p.x - point.x, p.y - point.y);
        if (distance <= HIT_TOLERANCE_PX + 8) {
          consider({ id: element.id, rank: 0, distance });
        }
        continue;
      }

      const screen = element.points.map((c) => toScreen(c, viewport, size));
      let closest = Infinity;
      for (let i = 0; i < screen.length - 1; i += 1) {
        closest = Math.min(closest, distanceToSegment(point, screen[i]!, screen[i + 1]!));
      }
      if (element.kind === 'polygon' && screen.length > 1) {
        closest = Math.min(
          closest,
          distanceToSegment(point, screen[screen.length - 1]!, screen[0]!),
        );
      }

      if (closest <= HIT_TOLERANCE_PX) {
        consider({ id: element.id, rank: 1, distance: closest });
      } else if (element.kind === 'polygon' && pointInScreenPolygon(point, screen)) {
        consider({ id: element.id, rank: 2, distance: closest });
      }
    }
  }

  function consider(candidate: { id: string; rank: number; distance: number }): void {
    if (
      !best ||
      candidate.rank < best.rank ||
      (candidate.rank === best.rank && candidate.distance < best.distance)
    ) {
      best = candidate;
    }
  }

  return best === null ? null : (best as { id: string }).id;
}

function pointInScreenPolygon(p: ScreenPoint, polygon: readonly ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}
