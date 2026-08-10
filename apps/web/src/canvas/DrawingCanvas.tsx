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

import type { Coordinates, PlacedLabel, SiteFeature } from '@surveyor/contracts';
import { formatBearing, inverse, type Drawing, type DrawingElement } from '@surveyor/engine';

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
  readonly highlightId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly showLabels?: boolean;
  readonly showGrid?: boolean;
  /** The active tool (B.3). Select hit-tests; Draw adds corners; Measure probes. */
  readonly tool?: CanvasTool;
  readonly onDrawPoint?: (at: Coordinates) => void;
  /** Units for the measurement readout. */
  readonly unit?: string;
}

export type CanvasTool = 'select' | 'draw' | 'measure';

const TAP_SLOP_PX = 8;
const HIT_TOLERANCE_PX = 14;

export function DrawingCanvas({
  drawing,
  labelsForScale,
  previews = [],
  selectedId,
  highlightId,
  onSelect,
  showLabels = true,
  showGrid = true,
  tool = 'select',
  onDrawPoint,
  unit = 'm',
}: CanvasProps) {
  // Measurement is ephemeral: it answers a question and is discarded, so it
  // never touches the Survey Data Model.
  const [measure, setMeasure] = useState<readonly Coordinates[]>([]);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport | null>(null);

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

  const fit = useCallback(() => {
    if (size.width === 0 || size.height === 0) return;
    setViewport(fitTo(drawing.bounds, size));
  }, [drawing.bounds, size]);

  // Fit once the canvas has a size, and again if the survey is replaced with
  // one that would otherwise be off-screen.
  const boundsKey = `${drawing.bounds.min.easting},${drawing.bounds.min.northing},${drawing.bounds.max.easting},${drawing.bounds.max.northing}`;
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    setViewport((current) => (current ? current : fitTo(drawing.bounds, size)));
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
  }>({ moved: false, lastDistance: null, start: { x: 0, y: 0 }, lastTapAt: 0 });

  const localPoint = useCallback((event: React.PointerEvent): ScreenPoint => {
    const rect = hostRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      const point = localPoint(event);
      pointers.current.set(event.pointerId, point);
      event.currentTarget.setPointerCapture(event.pointerId);

      if (pointers.current.size === 1) {
        gesture.current.moved = false;
        gesture.current.start = point;
      }
      gesture.current.lastDistance = null;
    },
    [localPoint],
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
      if (Math.hypot(point.x - gesture.current.start.x, point.y - gesture.current.start.y) > TAP_SLOP_PX) {
        gesture.current.moved = true;
      }
      setViewport((current) => (current ? panBy(current, dx, dy) : current));
    },
    [localPoint, size, viewport],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const point = localPoint(event);
      pointers.current.delete(event.pointerId);
      gesture.current.lastDistance = null;

      if (pointers.current.size > 0 || !viewport) return;

      if (gesture.current.moved) return;

      const world = toWorld(point, viewport, size);

      if (tool === 'draw') {
        onDrawPoint?.(world);
        return;
      }
      if (tool === 'measure') {
        // Two taps make a measurement; a third starts a fresh one.
        setMeasure((current) => (current.length >= 2 ? [world] : [...current, world]));
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

      onSelect(hitTest(point, drawing, viewport, size));
    },
    [drawing, localPoint, onDrawPoint, onSelect, size, tool, viewport],
  );

  // Switching tools abandons a half-finished measurement rather than leaving
  // a stale line floating over the drawing.
  useEffect(() => {
    if (tool !== 'measure') setMeasure([]);
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
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
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
          ? drawing.layers.map((layer) => (
              <g key={layer.id} className={`layer layer--${layer.id}`}>
                {layer.elements.map((element) => (
                  <Element
                    key={element.id}
                    element={element}
                    project={project}
                    selected={element.id === selectedId}
                    highlighted={element.id === highlightId}
                  />
                ))}
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

        {ready && measure.length > 0 ? (
          <Measurement points={measure} project={project} unit={unit} />
        ) : null}
      </svg>

      {tool !== 'select' ? (
        <div className="canvas__hint" role="status">
          {tool === 'draw'
            ? 'Tap to place a corner'
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
  project,
  selected,
  highlighted,
}: {
  readonly element: DrawingElement;
  readonly project: Project;
  readonly selected: boolean;
  readonly highlighted: boolean;
}) {
  const classes = [
    'element',
    `element--${element.kind === 'symbol' ? 'symbol' : element.style}`,
    selected ? 'is-selected' : '',
    highlighted ? 'is-highlighted' : '',
    element.provenance.source === 'ai-suggested' ? 'is-suggested' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (element.kind === 'symbol') {
    const p = project(element.at);
    return (
      <g className={`${classes} element--point`} data-id={element.id}>
        {/* An invisible disc gives the small marker a 44px touch target. */}
        <circle className="element__hit" cx={p.x} cy={p.y} r={22} />
        <circle className="element__marker" cx={p.x} cy={p.y} r={4} />
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
}: {
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
}) {
  return (
    <div className="canvas__zoom">
      <button type="button" onClick={onZoomIn} aria-label="Zoom in">
        +
      </button>
      <button type="button" onClick={onZoomOut} aria-label="Zoom out">
        −
      </button>
      <button type="button" onClick={onFit} aria-label="Fit plan to screen">
        ⤢
      </button>
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
 * Nearest element within the touch tolerance. Points win over lines, and lines
 * over areas, because that is the order a user expects to grab things in.
 */
function hitTest(
  point: ScreenPoint,
  drawing: Drawing,
  viewport: Viewport,
  size: Size,
): string | null {
  let best: { id: string; rank: number; distance: number } | null = null;

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
