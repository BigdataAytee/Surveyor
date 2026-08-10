/**
 * COGO Engine (Architecture A.3) — geometry, area, distance, bearing.
 *
 * Pure and deterministic: every function here is a function of its arguments
 * alone. No AI involvement in the math, no I/O, no clock, no randomness.
 *
 * Coordinate convention throughout: easting is the x axis, northing is the y
 * axis, and azimuths are measured clockwise from north (the +northing axis).
 */

import type {
  BoundaryRing,
  BoundarySegment,
  Coordinates,
  CurveData,
  PointId,
  SurveyPoint,
} from '@surveyor/contracts';

import { DEG_PER_RAD, normalizeAzimuth, RAD_PER_DEG } from './crs.js';

// ---------------------------------------------------------------------------
// Inverse and forward
// ---------------------------------------------------------------------------

export interface Inverse {
  /** Azimuth in decimal degrees, clockwise from north. */
  readonly bearing: number;
  readonly distance: number;
}

/** Bearing and distance from one coordinate to another. */
export function inverse(from: Coordinates, to: Coordinates): Inverse {
  const dE = to.easting - from.easting;
  const dN = to.northing - from.northing;
  return {
    bearing: normalizeAzimuth(Math.atan2(dE, dN) * DEG_PER_RAD),
    distance: Math.hypot(dE, dN),
  };
}

/** The position reached by travelling `distance` along `bearing` from `from`. */
export function forward(
  from: Coordinates,
  bearing: number,
  distance: number,
): Coordinates {
  const rad = bearing * RAD_PER_DEG;
  return {
    easting: from.easting + distance * Math.sin(rad),
    northing: from.northing + distance * Math.cos(rad),
  };
}

export function distanceBetween(a: Coordinates, b: Coordinates): number {
  return Math.hypot(b.easting - a.easting, b.northing - a.northing);
}

export function midpoint(a: Coordinates, b: Coordinates): Coordinates {
  return {
    easting: (a.easting + b.easting) / 2,
    northing: (a.northing + b.northing) / 2,
  };
}

// ---------------------------------------------------------------------------
// Polygon measures
// ---------------------------------------------------------------------------

/**
 * Signed shoelace area. Positive when the vertices run counter-clockwise,
 * which is also how ring orientation is determined for curve corrections.
 */
export function signedArea(vertices: readonly Coordinates[]): number {
  if (vertices.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    sum += a.easting * b.northing - b.easting * a.northing;
  }
  return sum / 2;
}

export function polygonArea(vertices: readonly Coordinates[]): number {
  return Math.abs(signedArea(vertices));
}

export function perimeter(vertices: readonly Coordinates[]): number {
  if (vertices.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    total += distanceBetween(vertices[i]!, vertices[(i + 1) % vertices.length]!);
  }
  return total;
}

export function centroid(vertices: readonly Coordinates[]): Coordinates {
  const area = signedArea(vertices);

  // Degenerate ring (zero area): fall back to the vertex mean so callers such
  // as label placement still get a usable interior-ish point.
  if (Math.abs(area) < 1e-12) {
    const sum = vertices.reduce(
      (acc, v) => ({
        easting: acc.easting + v.easting,
        northing: acc.northing + v.northing,
      }),
      { easting: 0, northing: 0 },
    );
    const n = Math.max(vertices.length, 1);
    return { easting: sum.easting / n, northing: sum.northing / n };
  }

  let e = 0;
  let n = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    const cross = a.easting * b.northing - b.easting * a.northing;
    e += (a.easting + b.easting) * cross;
    n += (a.northing + b.northing) * cross;
  }
  return { easting: e / (6 * area), northing: n / (6 * area) };
}

export function boundsOf(vertices: readonly Coordinates[]): {
  readonly min: Coordinates;
  readonly max: Coordinates;
} {
  let minE = Infinity;
  let minN = Infinity;
  let maxE = -Infinity;
  let maxN = -Infinity;
  for (const v of vertices) {
    minE = Math.min(minE, v.easting);
    minN = Math.min(minN, v.northing);
    maxE = Math.max(maxE, v.easting);
    maxN = Math.max(maxN, v.northing);
  }
  return {
    min: { easting: minE, northing: minN },
    max: { easting: maxE, northing: maxN },
  };
}

export function pointInPolygon(
  point: Coordinates,
  vertices: readonly Coordinates[],
): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const a = vertices[i]!;
    const b = vertices[j]!;
    const straddles = a.northing > point.northing !== b.northing > point.northing;
    if (!straddles) continue;
    const crossingEasting =
      ((b.easting - a.easting) * (point.northing - a.northing)) /
        (b.northing - a.northing) +
      a.easting;
    if (point.easting < crossingEasting) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/**
 * Derive the remaining arc parameters from radius, chord and direction.
 * Returns null when the chord cannot lie on the radius (chord > diameter),
 * which is a data error for the Validation Engine rather than something to clamp.
 */
export function curveFromChord(
  radius: number,
  chordLength: number,
  direction: CurveData['direction'],
): CurveData | null {
  if (radius <= 0 || chordLength <= 0 || chordLength > 2 * radius) return null;
  const delta = 2 * Math.asin(chordLength / (2 * radius)) * DEG_PER_RAD;
  return {
    radius,
    chordLength,
    delta,
    arcLength: radius * delta * RAD_PER_DEG,
    direction,
  };
}

/**
 * Area between an arc and its chord (the circular segment).
 *
 * Used to correct a chord-based polygon area when a boundary follows a curve.
 */
export function circularSegmentArea(curve: CurveData): number {
  const deltaRad = curve.delta * RAD_PER_DEG;
  return (curve.radius * curve.radius * (deltaRad - Math.sin(deltaRad))) / 2;
}

/** Points along an arc, for drawing and for chord-accurate hit testing. */
export function tessellateCurve(
  from: Coordinates,
  to: Coordinates,
  curve: CurveData,
  segments = 24,
): readonly Coordinates[] {
  const chord = inverse(from, to);

  // The centre lies perpendicular to the chord, offset by the apothem.
  const apothem = Math.sqrt(
    Math.max(curve.radius * curve.radius - (chord.distance / 2) ** 2, 0),
  );
  const toCentre =
    curve.direction === 'clockwise'
      ? chord.bearing + 90
      : chord.bearing - 90;
  const centre = forward(midpoint(from, to), toCentre, apothem);

  const startAngle = Math.atan2(
    from.easting - centre.easting,
    from.northing - centre.northing,
  );
  const sweep =
    (curve.direction === 'clockwise' ? 1 : -1) * curve.delta * RAD_PER_DEG;

  const points: Coordinates[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = startAngle + (sweep * i) / segments;
    points.push({
      easting: centre.easting + curve.radius * Math.sin(angle),
      northing: centre.northing + curve.radius * Math.cos(angle),
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Ring computation
// ---------------------------------------------------------------------------

export interface ResolvedSegment {
  readonly from: PointId;
  readonly to: PointId;
  readonly start: Coordinates;
  readonly end: Coordinates;
  readonly bearing: number;
  readonly distance: number;
  readonly curve?: CurveData;
  /** True when the position was computed rather than read from a known point. */
  readonly derivedEndpoint: boolean;
}

export interface ClosureResult {
  /** Linear misclosure in CRS units. */
  readonly misclosure: number;
  /** Perimeter divided by misclosure; Infinity for an exact close. */
  readonly precisionRatio: number;
  readonly departure: number;
  readonly latitude: number;
}

export interface ResolvedRing {
  readonly ringId: string;
  readonly segments: readonly ResolvedSegment[];
  readonly vertices: readonly Coordinates[];
  readonly area: number;
  readonly perimeter: number;
  readonly closure: ClosureResult;
}

export type RingComputation =
  | { readonly ok: true; readonly ring: ResolvedRing }
  | { readonly ok: false; readonly reason: string; readonly subjects: readonly string[] };

/**
 * Walk a ring's segments, filling in whatever was not supplied.
 *
 * Handles both shapes the Survey Data Model allows: corners given as
 * coordinates (bearings and distances are derived by inverse), and a deed-style
 * traverse where only the start point is known and each segment carries an
 * observed bearing and distance (positions are derived by forward computation).
 *
 * Closure is reported in every case, never silently adjusted — A.1 §4.
 */
export function computeRing(
  ring: BoundaryRing,
  points: readonly SurveyPoint[],
): RingComputation {
  if (ring.segments.length < 2) {
    return {
      ok: false,
      reason: 'A boundary needs at least two segments.',
      subjects: [ring.id],
    };
  }

  const byId = new Map<PointId, SurveyPoint>(points.map((p) => [p.id, p]));
  const first = ring.segments[0]!;
  const startPoint = byId.get(first.from);

  if (!startPoint) {
    return {
      ok: false,
      reason: `The boundary starts at "${first.from}", which has no coordinates.`,
      subjects: [first.from],
    };
  }

  const resolved: ResolvedSegment[] = [];
  let cursor: Coordinates = startPoint.coordinates;

  for (const segment of ring.segments) {
    const step = resolveSegment(segment, cursor, byId);
    if (!step.ok) return step;
    resolved.push(step.segment);
    cursor = step.segment.end;
  }

  // Misclosure is the gap between where the traverse ends and where it began.
  const departure = cursor.easting - startPoint.coordinates.easting;
  const latitude = cursor.northing - startPoint.coordinates.northing;
  const misclosure = Math.hypot(departure, latitude);

  const vertices = resolved.map((s) => s.start);
  const ringPerimeter = resolved.reduce(
    (total, s) => total + (s.curve ? s.curve.arcLength : s.distance),
    0,
  );

  return {
    ok: true,
    ring: {
      ringId: ring.id,
      segments: resolved,
      vertices,
      area: ringAreaWithCurves(vertices, resolved),
      perimeter: ringPerimeter,
      closure: {
        misclosure,
        precisionRatio:
          misclosure < 1e-9 ? Infinity : ringPerimeter / misclosure,
        departure,
        latitude,
      },
    },
  };
}

function resolveSegment(
  segment: BoundarySegment,
  cursor: Coordinates,
  byId: ReadonlyMap<PointId, SurveyPoint>,
):
  | { ok: true; segment: ResolvedSegment }
  | { ok: false; reason: string; subjects: readonly string[] } {
  // Observed bearing and distance win over a stored endpoint.
  //
  // The tempting alternative — snap to the known coordinates whenever they
  // exist — quietly destroys the measurement it is meant to check: a traverse
  // that returns to a known start point would then always close exactly,
  // whatever the observations said. Walking the observations is what makes
  // misclosure observable at all (A.1 §4).
  if (segment.bearing !== undefined && segment.distance !== undefined) {
    return {
      ok: true,
      segment: {
        from: segment.from,
        to: segment.to,
        start: cursor,
        end: forward(cursor, segment.bearing, segment.distance),
        bearing: segment.bearing,
        distance: segment.distance,
        ...(segment.curve ? { curve: segment.curve } : {}),
        derivedEndpoint: true,
      },
    };
  }

  const known = byId.get(segment.to);
  if (known) {
    const measured = inverse(cursor, known.coordinates);
    return {
      ok: true,
      segment: {
        from: segment.from,
        to: segment.to,
        start: cursor,
        end: known.coordinates,
        bearing: segment.bearing ?? measured.bearing,
        distance: segment.distance ?? measured.distance,
        ...(segment.curve ? { curve: segment.curve } : {}),
        derivedEndpoint: false,
      },
    };
  }

  return {
    ok: false,
    reason:
      `Segment ${segment.from}→${segment.to} has neither an endpoint with ` +
      `coordinates nor a bearing and distance, so its position is unknown.`,
    subjects: [segment.from, segment.to],
  };
}

/**
 * Chord-polygon area, corrected for any curved segments.
 *
 * An arc bulging away from the interior adds its circular segment; one bulging
 * inward subtracts it. Which is which follows from the ring's orientation:
 *
 * Travelling counter-clockwise around a ring, the interior is on your left, so
 * an arc that turns left (counter-clockwise) curves away from the interior and
 * bulges outward. Concretely, on a counter-clockwise rectangle walked north up
 * its east side, the interior is west and a left-turning arc bulges east.
 * Reverse the ring and both halves of that flip together — hence the equality
 * rather than a fixed direction test.
 */
function ringAreaWithCurves(
  vertices: readonly Coordinates[],
  segments: readonly ResolvedSegment[],
): number {
  const signed = signedArea(vertices);
  const counterClockwise = signed > 0;
  let area = Math.abs(signed);

  for (const segment of segments) {
    if (!segment.curve) continue;
    const bulgesOutward =
      (segment.curve.direction === 'counter-clockwise') === counterClockwise;
    const correction = circularSegmentArea(segment.curve);
    area += bulgesOutward ? correction : -correction;
  }
  return Math.max(area, 0);
}

// ---------------------------------------------------------------------------
// Segment intersection — used by the Validation Engine
// ---------------------------------------------------------------------------

/**
 * True when two open segments cross. Shared endpoints do not count, since
 * consecutive boundary segments legitimately meet at corners.
 */
export function segmentsCross(
  a1: Coordinates,
  a2: Coordinates,
  b1: Coordinates,
  b2: Coordinates,
): boolean {
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);

  const strictlyOpposite =
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));

  return strictlyOpposite;
}

function cross(o: Coordinates, a: Coordinates, b: Coordinates): number {
  return (
    (a.easting - o.easting) * (b.northing - o.northing) -
    (a.northing - o.northing) * (b.easting - o.easting)
  );
}
