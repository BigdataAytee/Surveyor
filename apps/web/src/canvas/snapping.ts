/**
 * Snap targets for the canvas, and the tolerance in ground units.
 *
 * The engine's snapper works in survey units and knows nothing about zoom.
 * This is the piece between: it turns what is drawn into things worth snapping
 * to, and turns a pixel radius into the ground distance that radius covers at
 * the current scale.
 *
 * Doing the conversion this way round — pixels in, metres out — is what makes
 * snapping feel the same at every zoom. A fixed ground tolerance would be
 * unusable zoomed out, where a metre is a fraction of a pixel, and maddening
 * zoomed in, where it is half the screen.
 */

import type { Coordinates } from '@surveyor/contracts';
import type { Drawing, SnapTarget } from '@surveyor/engine';

/** How close a cursor has to be, in CSS pixels, for a snap to take. */
export const SNAP_RADIUS_PX = 18;

/**
 * Everything on the drawing a snap can land on.
 *
 * Symbols contribute their own position: a survey point is exactly the kind of
 * thing a surveyor wants to snap to, and it is drawn as a symbol rather than
 * as geometry.
 */
export function snapTargetsFrom(drawing: Drawing): readonly SnapTarget[] {
  const targets: SnapTarget[] = [];

  for (const layer of drawing.layers) {
    for (const element of layer.elements) {
      if (element.kind === 'symbol') {
        targets.push({ id: element.id, vertices: [element.at], closed: false });
        continue;
      }
      if (element.points.length === 0) continue;
      targets.push({
        id: element.id,
        vertices: element.points,
        closed: element.kind === 'polygon',
      });
    }
  }
  return targets;
}

/** The ground distance a pixel radius covers at the current scale. */
export function snapTolerance(worldPerPixel: number, radiusPx = SNAP_RADIUS_PX): number {
  return worldPerPixel * radiusPx;
}

/**
 * Only the targets near enough to be worth testing.
 *
 * The engine's intersection search is quadratic in the number of edges, which
 * is fine for a handful of objects near the cursor and not fine for a whole
 * site. Filtering by a generous box first keeps a snap a constant-time
 * operation as the drawing grows, which is what keeps panning smooth on a
 * large survey.
 */
export function targetsNear(
  targets: readonly SnapTarget[],
  cursor: Coordinates,
  reach: number,
): readonly SnapTarget[] {
  return targets.filter((target) =>
    target.vertices.some(
      (vertex) =>
        Math.abs(vertex.easting - cursor.easting) <= reach &&
        Math.abs(vertex.northing - cursor.northing) <= reach,
    ),
  );
}
