/**
 * Operations that change a shape rather than move it (CAD editing, part 3).
 *
 * Offset, Trim, Extend, Fillet, Chamfer, Join and Split. These are the ones
 * that earn a drafting tool its keep — the difference between drawing a
 * building 3 m inside a boundary by eye and drawing it exactly 3 m inside.
 *
 * Two rules run through all of them. They return `null` rather than guessing
 * when the operation is not defined for the input, because a fillet that
 * silently does nothing is a fillet the surveyor believes happened. And they
 * never mutate: every result is fresh geometry, so undo is a matter of keeping
 * the old array rather than of replaying an inverse operation.
 */

import type { Coordinates } from '@surveyor/contracts';

import { distanceBetween, signedArea } from '../cogo.js';
import { intersectSegments, sideOf } from './intersect.js';

/** Below this a segment has no direction and most operations are undefined. */
const DEGENERATE = 1e-9;

// ---------------------------------------------------------------------------
// Offset
// ---------------------------------------------------------------------------

/**
 * Offset an open polyline by a distance, positive to the left of travel.
 *
 * Corners are mitred — the offset segments are extended to meet — which is
 * what a setback line does and what a wall's other face does. A round join
 * would be wrong for both: the offset of a straight boundary is a straight
 * line, not an arc, and a surveyor reading a 3 m setback expects to be able to
 * measure 3 m perpendicular anywhere along it.
 *
 * A miter is capped: at a very sharp corner the exact miter shoots off to
 * infinity, and a spike thousands of metres long is worse than a cut corner.
 */
export function offsetPolyline(
  vertices: readonly Coordinates[],
  distance: number,
  miterLimit = 8,
): readonly Coordinates[] | null {
  const clean = withoutRepeats(vertices);
  if (clean.length < 2) return null;
  if (Math.abs(distance) < DEGENERATE) return clean;

  const shifted = clean
    .slice(0, -1)
    .map((from, index) => shiftSegment(from, clean[index + 1]!, distance));

  const result: Coordinates[] = [shifted[0]!.from];

  for (let i = 0; i + 1 < shifted.length; i += 1) {
    const current = shifted[i]!;
    const next = shifted[i + 1]!;
    const hit = intersectSegments(current.from, current.to, next.from, next.to);

    if (hit === null) {
      // Parallel: the two segments were collinear, so the corner is not one.
      result.push(current.to);
      continue;
    }

    const corner = clean[i + 1]!;
    if (distanceBetween(corner, hit.at) > Math.abs(distance) * miterLimit) {
      // Beyond the limit, cut the corner off rather than growing a spike.
      result.push(current.to, next.from);
      continue;
    }
    result.push(hit.at);
  }

  result.push(shifted[shifted.length - 1]!.to);
  return result;
}

/**
 * Offset a closed ring, positive outward.
 *
 * Outward rather than left, because "outward" is what a surveyor means by a
 * positive offset on a parcel and the ring's winding is an implementation
 * detail they should not have to know. The winding is read from the signed
 * area and the sign adjusted to suit.
 */
export function offsetRing(
  vertices: readonly Coordinates[],
  distance: number,
  miterLimit = 8,
): readonly Coordinates[] | null {
  const clean = withoutRepeats(closeRing(vertices));
  if (clean.length < 4) return null;

  const counterClockwise = signedArea(clean) > 0;
  const signed = counterClockwise ? -distance : distance;

  const offset = offsetPolyline([...clean, clean[1]!], signed, miterLimit);
  if (offset === null) return null;

  // The ring was walked with one extra segment so the first corner is mitred
  // like every other; drop the duplicated tail it produced.
  const ring = offset.slice(1, -1);
  return ring.length >= 3 ? ring : null;
}

function shiftSegment(
  from: Coordinates,
  to: Coordinates,
  distance: number,
): { readonly from: Coordinates; readonly to: Coordinates } {
  const de = to.easting - from.easting;
  const dn = to.northing - from.northing;
  const length = Math.hypot(de, dn);
  // Left of travel: rotate the direction 90° anticlockwise.
  const normalE = -dn / length;
  const normalN = de / length;

  return {
    from: {
      easting: from.easting + normalE * distance,
      northing: from.northing + normalN * distance,
    },
    to: {
      easting: to.easting + normalE * distance,
      northing: to.northing + normalN * distance,
    },
  };
}

// ---------------------------------------------------------------------------
// Trim and extend
// ---------------------------------------------------------------------------

export type SegmentEnd = 'start' | 'end';

/**
 * Cut a segment back to where it meets a boundary segment.
 *
 * `keep` names the end to keep, which is how the tool reads in use: the
 * surveyor clicks the part they want gone, and the caller passes the other
 * end. Returns null when the two do not actually cross — trimming to something
 * a line misses is not a thing that can be done, and reporting that is more
 * use than returning the line unchanged.
 */
export function trimSegment(
  from: Coordinates,
  to: Coordinates,
  cutterA: Coordinates,
  cutterB: Coordinates,
  keep: SegmentEnd = 'start',
): { readonly from: Coordinates; readonly to: Coordinates } | null {
  const hit = intersectSegments(from, to, cutterA, cutterB);
  if (hit === null || !hit.onBoth) return null;
  if (hit.t < DEGENERATE || hit.t > 1 - DEGENERATE) return null;

  return keep === 'start' ? { from, to: hit.at } : { from: hit.at, to };
}

/**
 * Lengthen a segment until it reaches a boundary.
 *
 * The mirror image of trim, and it takes the same care: the crossing has to be
 * on the boundary as drawn, and beyond the end being extended. Extending to a
 * crossing that is behind the line would shorten it, which is not what the
 * surveyor asked for however defensible the arithmetic.
 */
export function extendSegment(
  from: Coordinates,
  to: Coordinates,
  targetA: Coordinates,
  targetB: Coordinates,
  end: SegmentEnd = 'end',
): { readonly from: Coordinates; readonly to: Coordinates } | null {
  const hit = intersectSegments(from, to, targetA, targetB);
  if (hit === null) return null;

  // The crossing must lie on the target as drawn — you cannot extend to the
  // imaginary continuation of a wall.
  if (hit.u < -DEGENERATE || hit.u > 1 + DEGENERATE) return null;

  if (end === 'end') {
    if (hit.t <= 1 + DEGENERATE) return null;
    return { from, to: hit.at };
  }
  if (hit.t >= -DEGENERATE) return null;
  return { from: hit.at, to };
}

// ---------------------------------------------------------------------------
// Fillet and chamfer
// ---------------------------------------------------------------------------

/**
 * Cut a corner off with a straight chamfer of the given setbacks.
 *
 * Returns the two points the chamfer runs between, or null when either setback
 * is longer than the leg it is measured along — a chamfer that eats past the
 * next corner is not a chamfer, and cutting it short to fit would produce a
 * dimension the surveyor did not ask for.
 */
export function chamferCorner(
  before: Coordinates,
  corner: Coordinates,
  after: Coordinates,
  setbackBefore: number,
  setbackAfter = setbackBefore,
): readonly [Coordinates, Coordinates] | null {
  const lengthBefore = distanceBetween(corner, before);
  const lengthAfter = distanceBetween(corner, after);

  if (setbackBefore <= 0 || setbackAfter <= 0) return null;
  if (setbackBefore >= lengthBefore || setbackAfter >= lengthAfter) return null;

  return [
    along(corner, before, setbackBefore),
    along(corner, after, setbackAfter),
  ];
}

export interface Fillet {
  /** Where the arc leaves the incoming leg. */
  readonly start: Coordinates;
  /** Where it rejoins the outgoing leg. */
  readonly end: Coordinates;
  readonly centre: Coordinates;
  readonly radius: number;
  /** True when the arc turns anticlockwise from start to end. */
  readonly counterClockwise: boolean;
}

/**
 * Round a corner with an arc of the given radius.
 *
 * The tangent length is `radius / tan(θ/2)`, which grows without bound as the
 * corner straightens — so a fillet on a nearly-straight corner needs a tangent
 * longer than the legs and is refused rather than approximated. The centre sits
 * on the bisector at `radius / sin(θ/2)`, on whichever side the corner turns.
 */
export function filletCorner(
  before: Coordinates,
  corner: Coordinates,
  after: Coordinates,
  radius: number,
): Fillet | null {
  if (radius <= 0) return null;

  const lengthBefore = distanceBetween(corner, before);
  const lengthAfter = distanceBetween(corner, after);
  if (lengthBefore < DEGENERATE || lengthAfter < DEGENERATE) return null;

  const inE = (before.easting - corner.easting) / lengthBefore;
  const inN = (before.northing - corner.northing) / lengthBefore;
  const outE = (after.easting - corner.easting) / lengthAfter;
  const outN = (after.northing - corner.northing) / lengthAfter;

  // The angle at the corner, between the two legs.
  const cosine = Math.min(1, Math.max(-1, inE * outE + inN * outN));
  const angle = Math.acos(cosine);
  if (angle < DEGENERATE || Math.PI - angle < DEGENERATE) return null;

  const tangent = radius / Math.tan(angle / 2);
  if (tangent >= lengthBefore || tangent >= lengthAfter) return null;

  const start = along(corner, before, tangent);
  const end = along(corner, after, tangent);

  // The bisector points into the corner; the centre is along it.
  const bisectorE = inE + outE;
  const bisectorN = inN + outN;
  const bisectorLength = Math.hypot(bisectorE, bisectorN);
  if (bisectorLength < DEGENERATE) return null;

  const toCentre = radius / Math.sin(angle / 2);
  const centre = {
    easting: corner.easting + (bisectorE / bisectorLength) * toCentre,
    northing: corner.northing + (bisectorN / bisectorLength) * toCentre,
  };

  return {
    start,
    end,
    centre,
    radius,
    counterClockwise: sideOf(before, corner, after) > 0,
  };
}

function along(from: Coordinates, towards: Coordinates, distance: number): Coordinates {
  const length = distanceBetween(from, towards);
  const fraction = distance / length;
  return {
    easting: from.easting + (towards.easting - from.easting) * fraction,
    northing: from.northing + (towards.northing - from.northing) * fraction,
  };
}

// ---------------------------------------------------------------------------
// Join and split
// ---------------------------------------------------------------------------

/**
 * Join two polylines that share an end.
 *
 * Either may need reversing to make the ends meet; all four pairings are
 * tried, nearest first. Returns null when no pair of ends is within tolerance,
 * because joining lines that do not meet would invent a segment between them
 * and that segment would be indistinguishable from a measured one.
 */
export function joinPolylines(
  a: readonly Coordinates[],
  b: readonly Coordinates[],
  tolerance = 1e-6,
): readonly Coordinates[] | null {
  if (a.length < 2 || b.length < 2) return null;

  const aStart = a[0]!;
  const aEnd = a[a.length - 1]!;
  const bStart = b[0]!;
  const bEnd = b[b.length - 1]!;

  const pairings: readonly {
    readonly gap: number;
    readonly build: () => readonly Coordinates[];
  }[] = [
    { gap: distanceBetween(aEnd, bStart), build: () => [...a, ...b.slice(1)] },
    { gap: distanceBetween(aEnd, bEnd), build: () => [...a, ...[...b].reverse().slice(1)] },
    { gap: distanceBetween(aStart, bEnd), build: () => [...b, ...a.slice(1)] },
    {
      gap: distanceBetween(aStart, bStart),
      build: () => [...[...b].reverse(), ...a.slice(1)],
    },
  ];

  const best = pairings.reduce((lowest, pairing) =>
    pairing.gap < lowest.gap ? pairing : lowest,
  );
  return best.gap <= tolerance ? best.build() : null;
}

/**
 * Split a polyline at a point on it, returning the two halves.
 *
 * The point is projected onto the nearest segment, so a click that is a
 * fraction off the line still splits it at the place the surveyor meant.
 * Splitting exactly at an existing vertex is allowed; splitting at either end
 * is not, since one half would be empty.
 */
export function splitPolyline(
  vertices: readonly Coordinates[],
  at: Coordinates,
  tolerance = 1e-6,
): readonly [readonly Coordinates[], readonly Coordinates[]] | null {
  if (vertices.length < 2) return null;

  for (let i = 0; i + 1 < vertices.length; i += 1) {
    const from = vertices[i]!;
    const to = vertices[i + 1]!;
    const projected = project(at, from, to);
    if (projected === null || projected.distance > tolerance) continue;

    const head = [...vertices.slice(0, i + 1), projected.at];
    const tail = [projected.at, ...vertices.slice(i + 1)];
    if (head.length < 2 || tail.length < 2) return null;
    return [head, tail];
  }
  return null;
}

function project(
  point: Coordinates,
  a: Coordinates,
  b: Coordinates,
): { readonly at: Coordinates; readonly distance: number } | null {
  const de = b.easting - a.easting;
  const dn = b.northing - a.northing;
  const lengthSquared = de * de + dn * dn;
  if (lengthSquared < Number.EPSILON) return null;

  const t =
    ((point.easting - a.easting) * de + (point.northing - a.northing) * dn) /
    lengthSquared;
  if (t < 0 || t > 1) return null;

  const at = { easting: a.easting + t * de, northing: a.northing + t * dn };
  return {
    at,
    distance: Math.hypot(point.easting - at.easting, point.northing - at.northing),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drop consecutive duplicates, which break every direction calculation. */
export function withoutRepeats(
  vertices: readonly Coordinates[],
  tolerance = 1e-9,
): readonly Coordinates[] {
  return vertices.filter(
    (vertex, index) =>
      index === 0 || distanceBetween(vertex, vertices[index - 1]!) > tolerance,
  );
}

/** Repeat the first vertex at the end, if it is not there already. */
export function closeRing(vertices: readonly Coordinates[]): readonly Coordinates[] {
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  if (!first || !last) return vertices;
  return distanceBetween(first, last) < 1e-9 ? vertices : [...vertices, first];
}
