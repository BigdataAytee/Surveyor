/**
 * Rigid and similarity transforms on survey geometry (CAD editing, part 1).
 *
 * The operations behind Move, Copy, Rotate, Scale and Mirror. They are here
 * rather than in the canvas because of the rule the whole system is built on:
 * a drawing is survey geometry, not a picture of one. Dragging a corner has to
 * move a coordinate that every downstream calculation reads — the area, the
 * dimensions, the closure — and a transform implemented in screen space would
 * produce a drawing that looks right and computes wrong.
 *
 * So everything here works in survey units on `Coordinates`, exactly. No
 * rounding, no snapping to a display grid, no epsilon smoothing of results the
 * caller might depend on. Where a value cannot be produced exactly — a rotation
 * by a non-right angle — it is produced to the precision of the arithmetic and
 * left alone.
 */

import type { Coordinates } from '@surveyor/contracts';

/** Radians per degree, kept explicit because bearings arrive in degrees. */
const RADIANS = Math.PI / 180;

export interface Vector {
  readonly de: number;
  readonly dn: number;
}

// ---------------------------------------------------------------------------
// Move and copy
// ---------------------------------------------------------------------------

export function translatePoint(point: Coordinates, by: Vector): Coordinates {
  return {
    ...point,
    easting: point.easting + by.de,
    northing: point.northing + by.dn,
  };
}

export function translate(
  vertices: readonly Coordinates[],
  by: Vector,
): readonly Coordinates[] {
  return vertices.map((vertex) => translatePoint(vertex, by));
}

/**
 * The displacement a Move or Copy actually applies.
 *
 * Taken from two points rather than a screen delta so that snapping composes:
 * pick the corner of a building, snap to the corner of the boundary, and the
 * building lands exactly there — not within a pixel of there.
 */
export function displacement(from: Coordinates, to: Coordinates): Vector {
  return { de: to.easting - from.easting, dn: to.northing - from.northing };
}

/**
 * Displacement from a bearing and a distance, for typed input.
 *
 * A surveyor moving something by a known amount types the amount. Bearings are
 * clockwise from north, matching the rest of the system.
 */
export function polarDisplacement(bearingDegrees: number, distance: number): Vector {
  const radians = bearingDegrees * RADIANS;
  return { de: distance * Math.sin(radians), dn: distance * Math.cos(radians) };
}

// ---------------------------------------------------------------------------
// Rotate
// ---------------------------------------------------------------------------

/**
 * Rotate about a base point, clockwise, in degrees.
 *
 * Clockwise because survey bearings are: rotating geometry by 90° should send
 * north to east, the same way a bearing of 90° points east. A maths convention
 * here would be correct in isolation and wrong beside every other angle in the
 * app.
 */
export function rotatePoint(
  point: Coordinates,
  about: Coordinates,
  degrees: number,
): Coordinates {
  const radians = degrees * RADIANS;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const de = point.easting - about.easting;
  const dn = point.northing - about.northing;

  return {
    ...point,
    easting: about.easting + de * cos + dn * sin,
    northing: about.northing - de * sin + dn * cos,
  };
}

export function rotate(
  vertices: readonly Coordinates[],
  about: Coordinates,
  degrees: number,
): readonly Coordinates[] {
  return vertices.map((vertex) => rotatePoint(vertex, about, degrees));
}

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

/**
 * Scale about a base point.
 *
 * Uniform only. A non-uniform scale turns a circle into an ellipse and a
 * measured distance into two different measured distances depending on which
 * way it points, which is not a thing that can happen to surveyed ground.
 */
export function scalePoint(
  point: Coordinates,
  about: Coordinates,
  factor: number,
): Coordinates {
  return {
    ...point,
    easting: about.easting + (point.easting - about.easting) * factor,
    northing: about.northing + (point.northing - about.northing) * factor,
    ...(point.elevation === undefined ? {} : { elevation: point.elevation }),
  };
}

export function scale(
  vertices: readonly Coordinates[],
  about: Coordinates,
  factor: number,
): readonly Coordinates[] {
  return vertices.map((vertex) => scalePoint(vertex, about, factor));
}

/**
 * The factor a reference-length scale would apply.
 *
 * AutoCAD's Scale ... Reference: name a distance that should become another
 * distance and let the tool work out the factor. Returns null when the
 * reference is degenerate, rather than dividing by zero and producing Infinity
 * geometry that would then have to be caught downstream.
 */
export function scaleFactorFromReference(
  reference: number,
  target: number,
): number | null {
  if (!Number.isFinite(reference) || !Number.isFinite(target)) return null;
  if (Math.abs(reference) < Number.EPSILON) return null;
  return target / reference;
}

// ---------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------

/**
 * Reflect across the line through two points.
 *
 * Note what this does to winding: a mirrored ring runs the other way round.
 * Callers that care about orientation — the area sign, the side an offset goes
 * — have to reverse the vertex order themselves, and `mirrorRing` does.
 */
export function mirrorPoint(
  point: Coordinates,
  a: Coordinates,
  b: Coordinates,
): Coordinates {
  const axisE = b.easting - a.easting;
  const axisN = b.northing - a.northing;
  const lengthSquared = axisE * axisE + axisN * axisN;

  // A zero-length axis has no direction to reflect across; reflecting through
  // the point itself is the only defensible reading.
  if (lengthSquared < Number.EPSILON) {
    return {
      ...point,
      easting: 2 * a.easting - point.easting,
      northing: 2 * a.northing - point.northing,
    };
  }

  const de = point.easting - a.easting;
  const dn = point.northing - a.northing;
  const projection = (de * axisE + dn * axisN) / lengthSquared;
  const footE = a.easting + projection * axisE;
  const footN = a.northing + projection * axisN;

  return {
    ...point,
    easting: 2 * footE - point.easting,
    northing: 2 * footN - point.northing,
  };
}

export function mirror(
  vertices: readonly Coordinates[],
  a: Coordinates,
  b: Coordinates,
): readonly Coordinates[] {
  return vertices.map((vertex) => mirrorPoint(vertex, a, b));
}

/**
 * Mirror a closed ring, keeping the direction it is wound in.
 *
 * Reflection reverses winding, and the ring's winding decides the sign of its
 * area and which side "outside" is. Reversing the vertices afterwards restores
 * both, so a mirrored parcel still reports a positive area.
 */
export function mirrorRing(
  vertices: readonly Coordinates[],
  a: Coordinates,
  b: Coordinates,
): readonly Coordinates[] {
  return mirror(vertices, a, b).slice().reverse();
}

// ---------------------------------------------------------------------------
// Array
// ---------------------------------------------------------------------------

export interface RectangularArrayOptions {
  readonly rows: number;
  readonly columns: number;
  readonly rowSpacing: number;
  readonly columnSpacing: number;
  /** Rotates the whole grid, so an array can follow a boundary. */
  readonly bearingDegrees?: number;
}

/**
 * Repeat geometry on a grid, returning one vertex list per copy.
 *
 * The original is included as the first copy, which is what makes the result
 * usable as a replacement for the selection rather than an addition to it.
 */
export function rectangularArray(
  vertices: readonly Coordinates[],
  options: RectangularArrayOptions,
): readonly (readonly Coordinates[])[] {
  return arrayDisplacements(options).map((by) => translate(vertices, by));
}

/**
 * Where each copy of an array goes, as displacements from the original.
 *
 * The first is always zero — the original's own place — which is what makes
 * the result usable as a replacement for the selection rather than an addition
 * to it.
 *
 * Separate from `rectangularArray` because not everything being arrayed is a
 * bare vertex list. A site feature carries a kind, a status and a provenance
 * alongside its geometry, and arraying it means copying the whole feature to
 * each position rather than reducing it to points and losing what it was.
 * Both callers share this so the two can never disagree about where the copies
 * land.
 */
export function arrayDisplacements(options: RectangularArrayOptions): readonly Vector[] {
  const rows = Math.max(1, Math.floor(options.rows));
  const columns = Math.max(1, Math.floor(options.columns));
  const bearing = options.bearingDegrees ?? 90;

  // Columns run along the bearing; rows run ninety degrees off it, which with
  // the default bearing of due east puts rows to the north.
  const along = polarDisplacement(bearing, options.columnSpacing);
  const across = polarDisplacement(bearing - 90, options.rowSpacing);

  const displacements: Vector[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      displacements.push({
        de: along.de * column + across.de * row,
        dn: along.dn * column + across.dn * row,
      });
    }
  }
  return displacements;
}
