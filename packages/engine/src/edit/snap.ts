/**
 * Object snapping (CAD editing, part 4).
 *
 * The feature that decides whether a drawing is geometry or a picture. Without
 * it a surveyor clicking "on" a boundary corner lands a fraction of a metre
 * off, the area comes out wrong in the third decimal, and nothing on screen
 * shows why. With it, the click lands on the corner exactly — the same
 * `Coordinates` object's values, not a rounded version of them.
 *
 * Snaps are ranked, not merely nearest. An endpoint inside the tolerance beats
 * a nearest-on-edge even when the edge is closer to the cursor, because a
 * surveyor reaching for a line near its end almost always means the end. This
 * is the same precedence AutoCAD settled on, and it is worth matching:
 * muscle memory is a real part of a drafting tool.
 */

import type { Coordinates } from '@surveyor/contracts';

import { distanceBetween, midpoint } from '../cogo.js';
import { closestOnSegment, intersectSegments, perpendicularFoot } from './intersect.js';

export type SnapKind =
  | 'endpoint'
  | 'midpoint'
  | 'centre'
  | 'intersection'
  | 'perpendicular'
  | 'nearest'
  | 'grid';

/**
 * Precedence when several snaps are in range. Lower wins.
 *
 * Endpoints and intersections are exact features of the geometry — a corner is
 * *there*, and landing on it makes two objects share a coordinate. Nearest and
 * grid are conveniences, and losing to a real feature is the behaviour that
 * makes snapping trustworthy rather than surprising.
 */
export const SNAP_PRIORITY: Readonly<Record<SnapKind, number>> = {
  endpoint: 0,
  intersection: 1,
  centre: 2,
  midpoint: 3,
  perpendicular: 4,
  nearest: 5,
  grid: 6,
};

export interface SnapCandidate {
  readonly kind: SnapKind;
  readonly at: Coordinates;
  /** What it snapped to, so the canvas can say so. */
  readonly ownerId?: string;
}

export interface SnapResult extends SnapCandidate {
  /** Ground distance from the cursor, for the indicator. */
  readonly distance: number;
}

/** Geometry the snapper searches, in the shape the drawing already has. */
export interface SnapTarget {
  readonly id: string;
  readonly vertices: readonly Coordinates[];
  readonly closed: boolean;
}

export interface SnapOptions {
  /** How close counts, in survey units. Derived from a pixel radius. */
  readonly tolerance: number;
  readonly enabled?: Partial<Record<SnapKind, boolean>>;
  /** Grid spacing in survey units; omit to leave the grid snap off. */
  readonly gridSpacing?: number;
  /**
   * Where a line being drawn started.
   *
   * Perpendicular is meaningless without it — it is the perpendicular *from*
   * somewhere — so the snap only offers itself once there is an anchor.
   */
  readonly from?: Coordinates;
}

const ALL_ON: Readonly<Record<SnapKind, boolean>> = {
  endpoint: true,
  midpoint: true,
  centre: true,
  intersection: true,
  perpendicular: true,
  nearest: true,
  grid: true,
};

/**
 * The single best snap for a cursor position, or null to use the raw point.
 *
 * Returning null rather than the cursor position matters: the caller needs to
 * know whether the point it is about to commit is exact geometry or a click,
 * because the canvas draws them differently and the provenance differs.
 */
export function snap(
  cursor: Coordinates,
  targets: readonly SnapTarget[],
  options: SnapOptions,
): SnapResult | null {
  const enabled = { ...ALL_ON, ...options.enabled };
  const candidates = collect(cursor, targets, options, enabled);

  let best: SnapResult | null = null;
  for (const candidate of candidates) {
    const distance = distanceBetween(cursor, candidate.at);
    if (distance > options.tolerance) continue;

    if (
      best === null ||
      SNAP_PRIORITY[candidate.kind] < SNAP_PRIORITY[best.kind] ||
      (SNAP_PRIORITY[candidate.kind] === SNAP_PRIORITY[best.kind] &&
        distance < best.distance)
    ) {
      best = { ...candidate, distance };
    }
  }
  return best;
}

/**
 * Every snap in range, best first.
 *
 * Exposed so the UI can cycle through them — pressing Tab to step from the
 * endpoint to the midpoint is how a drafter resolves a crowded corner, and it
 * needs the alternatives, not just the winner.
 */
export function snapCandidates(
  cursor: Coordinates,
  targets: readonly SnapTarget[],
  options: SnapOptions,
): readonly SnapResult[] {
  const enabled = { ...ALL_ON, ...options.enabled };

  return collect(cursor, targets, options, enabled)
    .map((candidate) => ({
      ...candidate,
      distance: distanceBetween(cursor, candidate.at),
    }))
    .filter((candidate) => candidate.distance <= options.tolerance)
    .sort(
      (a, b) =>
        SNAP_PRIORITY[a.kind] - SNAP_PRIORITY[b.kind] || a.distance - b.distance,
    );
}

function collect(
  cursor: Coordinates,
  targets: readonly SnapTarget[],
  options: SnapOptions,
  enabled: Readonly<Record<SnapKind, boolean>>,
): readonly SnapCandidate[] {
  const candidates: SnapCandidate[] = [];

  for (const target of targets) {
    const edges = edgesOf(target);

    if (enabled.endpoint) {
      for (const vertex of target.vertices) {
        candidates.push({ kind: 'endpoint', at: vertex, ownerId: target.id });
      }
    }

    for (const [from, to] of edges) {
      if (enabled.midpoint) {
        candidates.push({ kind: 'midpoint', at: midpoint(from, to), ownerId: target.id });
      }
      if (enabled.nearest) {
        candidates.push({
          kind: 'nearest',
          at: closestOnSegment(cursor, from, to).at,
          ownerId: target.id,
        });
      }
      if (enabled.perpendicular && options.from) {
        const foot = perpendicularFoot(options.from, from, to);
        // Only offer it where the foot is on the line as drawn; a
        // perpendicular to the imaginary extension of a wall is not one.
        if (foot && closestOnSegment(foot, from, to).distance < 1e-9) {
          candidates.push({ kind: 'perpendicular', at: foot, ownerId: target.id });
        }
      }
    }

    // The centroid of a closed shape — the snap for "put this in the middle".
    if (enabled.centre && target.closed && target.vertices.length >= 3) {
      candidates.push({ kind: 'centre', at: centreOf(target.vertices), ownerId: target.id });
    }
  }

  if (enabled.intersection) {
    candidates.push(...intersections(targets));
  }

  if (enabled.grid && options.gridSpacing && options.gridSpacing > 0) {
    const spacing = options.gridSpacing;
    candidates.push({
      kind: 'grid',
      at: {
        easting: Math.round(cursor.easting / spacing) * spacing,
        northing: Math.round(cursor.northing / spacing) * spacing,
      },
    });
  }

  return candidates;
}

function edgesOf(target: SnapTarget): readonly (readonly [Coordinates, Coordinates])[] {
  const edges: (readonly [Coordinates, Coordinates])[] = [];
  for (let i = 0; i + 1 < target.vertices.length; i += 1) {
    edges.push([target.vertices[i]!, target.vertices[i + 1]!]);
  }
  const first = target.vertices[0];
  const last = target.vertices[target.vertices.length - 1];
  if (target.closed && first && last && target.vertices.length > 2) {
    edges.push([last, first]);
  }
  return edges;
}

/**
 * Crossings between different objects, and within one that crosses itself.
 *
 * Quadratic in the number of edges, which is why the caller is expected to
 * pass only what is near the cursor. At the size a snap search covers — a
 * handful of objects within a tolerance of a click — that is the right
 * trade against the bookkeeping an index would need on every edit.
 */
function intersections(targets: readonly SnapTarget[]): readonly SnapCandidate[] {
  const found: SnapCandidate[] = [];

  for (let i = 0; i < targets.length; i += 1) {
    const a = edgesOf(targets[i]!);
    for (let j = i; j < targets.length; j += 1) {
      const b = edgesOf(targets[j]!);
      for (let m = 0; m < a.length; m += 1) {
        // Within one object, skip adjacent edges: they meet at a corner, which
        // the endpoint snap already offers and offers better.
        const startAt = i === j ? m + 2 : 0;
        for (let n = startAt; n < b.length; n += 1) {
          const hit = intersectSegments(a[m]![0], a[m]![1], b[n]![0], b[n]![1]);
          if (hit?.onBoth) {
            found.push({ kind: 'intersection', at: hit.at, ownerId: targets[i]!.id });
          }
        }
      }
    }
  }
  return found;
}

function centreOf(vertices: readonly Coordinates[]): Coordinates {
  const easting = vertices.reduce((sum, v) => sum + v.easting, 0) / vertices.length;
  const northing = vertices.reduce((sum, v) => sum + v.northing, 0) / vertices.length;
  return { easting, northing };
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/**
 * Constrain a point to lie at a multiple of an angle from an anchor.
 *
 * Ortho and polar tracking. Ortho is this with `step = 90`: it holds a line
 * square to the grid while the surveyor picks its length, which is how a
 * building gets drawn square without typing a single coordinate.
 *
 * The distance is preserved, not the projection, because the surveyor is
 * choosing a length by eye and a projection would shorten it as the cursor
 * drifted off-axis.
 */
export function constrainToAngle(
  anchor: Coordinates,
  cursor: Coordinates,
  stepDegrees = 90,
): Coordinates {
  const de = cursor.easting - anchor.easting;
  const dn = cursor.northing - anchor.northing;
  const distance = Math.hypot(de, dn);
  if (distance < 1e-9 || stepDegrees <= 0) return cursor;

  // Bearing: clockwise from north, matching every other angle in the system.
  const bearing = (Math.atan2(de, dn) * 180) / Math.PI;
  const snapped = Math.round(bearing / stepDegrees) * stepDegrees;
  const radians = (snapped * Math.PI) / 180;

  return {
    easting: anchor.easting + distance * Math.sin(radians),
    northing: anchor.northing + distance * Math.cos(radians),
  };
}
