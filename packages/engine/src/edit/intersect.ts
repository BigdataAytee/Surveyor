/**
 * Where things meet (CAD editing, part 2).
 *
 * Trim, Extend, Fillet, Chamfer and the intersection snap all reduce to the
 * same question asked slightly differently: where do these two pieces of
 * geometry cross, and is that crossing on the part of them that exists?
 *
 * `segmentsCross` in cogo.ts answers the boolean form of that for the
 * Validation Engine — it only needs to know whether a boundary crosses itself.
 * Editing needs the point, and needs to distinguish a crossing that is on both
 * segments from one that is only on their infinite extensions, because that
 * distinction is exactly what separates Trim from Extend.
 */

import type { Coordinates } from '@surveyor/contracts';

/**
 * Tolerance for treating a parameter as "at the end".
 *
 * Relative to the parameter, which runs 0..1 along a segment, so it means a
 * millionth of the segment's length rather than a fixed ground distance. A
 * fixed tolerance would be wrong at both ends of the scale range this has to
 * work over — a 2 m fence and a 2 km road are both survey geometry.
 */
const PARAMETER_EPSILON = 1e-9;

export interface Intersection {
  readonly at: Coordinates;
  /** Position along the first segment: 0 at its start, 1 at its end. */
  readonly t: number;
  /** Position along the second segment. */
  readonly u: number;
  /** True when the point lies on both segments as drawn. */
  readonly onBoth: boolean;
}

/**
 * Intersect two segments, treating them as infinite lines but reporting where
 * the crossing falls relative to the drawn extent.
 *
 * Returns null for parallel lines, including collinear ones. Collinear
 * segments overlap in infinitely many points and no single one of them is the
 * answer; a caller that means "join these" wants `join`, not this.
 */
export function intersectSegments(
  a1: Coordinates,
  a2: Coordinates,
  b1: Coordinates,
  b2: Coordinates,
): Intersection | null {
  const aE = a2.easting - a1.easting;
  const aN = a2.northing - a1.northing;
  const bE = b2.easting - b1.easting;
  const bN = b2.northing - b1.northing;

  const denominator = aE * bN - aN * bE;
  // Scaled by the segment lengths so the test means "parallel" rather than
  // "short", which a bare magnitude check would conflate.
  const scale = Math.hypot(aE, aN) * Math.hypot(bE, bN);
  if (scale === 0 || Math.abs(denominator) < scale * 1e-12) return null;

  const dE = b1.easting - a1.easting;
  const dN = b1.northing - a1.northing;

  const t = (dE * bN - dN * bE) / denominator;
  const u = (dE * aN - dN * aE) / denominator;

  return {
    at: { easting: a1.easting + t * aE, northing: a1.northing + t * aN },
    t,
    u,
    onBoth: within(t) && within(u),
  };
}

function within(parameter: number): boolean {
  return parameter >= -PARAMETER_EPSILON && parameter <= 1 + PARAMETER_EPSILON;
}

/**
 * The closest point on a segment to a given point, and how far along it is.
 *
 * The workhorse of the nearest and perpendicular snaps, and of hit-testing a
 * click against a line. Clamped to the segment: the caller asking this
 * question is asking about the line that exists, not its extension.
 */
export function closestOnSegment(
  point: Coordinates,
  a: Coordinates,
  b: Coordinates,
): { readonly at: Coordinates; readonly t: number; readonly distance: number } {
  const de = b.easting - a.easting;
  const dn = b.northing - a.northing;
  const lengthSquared = de * de + dn * dn;

  if (lengthSquared < Number.EPSILON) {
    return {
      at: { easting: a.easting, northing: a.northing },
      t: 0,
      distance: Math.hypot(point.easting - a.easting, point.northing - a.northing),
    };
  }

  const raw =
    ((point.easting - a.easting) * de + (point.northing - a.northing) * dn) /
    lengthSquared;
  const t = Math.min(1, Math.max(0, raw));
  const at = { easting: a.easting + t * de, northing: a.northing + t * dn };

  return {
    at,
    t,
    distance: Math.hypot(point.easting - at.easting, point.northing - at.northing),
  };
}

/**
 * The foot of the perpendicular from a point to a line, unclamped.
 *
 * Distinct from `closestOnSegment` on purpose: a perpendicular snap to a short
 * wall should be able to land beyond its end, because that is where the
 * perpendicular actually is. Clamping would silently turn it into an endpoint
 * snap and the drawn line would not be perpendicular to anything.
 */
export function perpendicularFoot(
  point: Coordinates,
  a: Coordinates,
  b: Coordinates,
): Coordinates | null {
  const de = b.easting - a.easting;
  const dn = b.northing - a.northing;
  const lengthSquared = de * de + dn * dn;
  if (lengthSquared < Number.EPSILON) return null;

  const t =
    ((point.easting - a.easting) * de + (point.northing - a.northing) * dn) /
    lengthSquared;
  return { easting: a.easting + t * de, northing: a.northing + t * dn };
}

/** Which side of the directed line a→b the point falls on. */
export function sideOf(a: Coordinates, b: Coordinates, point: Coordinates): number {
  return (
    (b.easting - a.easting) * (point.northing - a.northing) -
    (b.northing - a.northing) * (point.easting - a.easting)
  );
}

/**
 * Every place a polyline crosses another, including itself.
 *
 * Used for the intersection snap and for the self-crossing check that
 * validation already reports — a boundary that crosses itself is a survey
 * error, and here it is also a place a surveyor may legitimately want to trim.
 */
export function polylineIntersections(
  a: readonly Coordinates[],
  b: readonly Coordinates[],
): readonly Coordinates[] {
  const found: Coordinates[] = [];

  for (let i = 0; i + 1 < a.length; i += 1) {
    for (let j = 0; j + 1 < b.length; j += 1) {
      const hit = intersectSegments(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
      if (hit?.onBoth) found.push(hit.at);
    }
  }
  return found;
}
