/**
 * Viewport maths for the drawing canvas.
 *
 * Kept out of the component so panning and zooming can be reasoned about (and
 * changed) without touching React. Survey coordinates go in, screen pixels come
 * out; north is up, so the northing axis is flipped.
 */

import type { Coordinates } from '@surveyor/contracts';

export interface Viewport {
  /** Screen pixels per survey unit. */
  readonly scale: number;
  /** Survey coordinate currently at the centre of the view. */
  readonly centre: Coordinates;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 40;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function toScreen(
  world: Coordinates,
  viewport: Viewport,
  size: Size,
): ScreenPoint {
  return {
    x: size.width / 2 + (world.easting - viewport.centre.easting) * viewport.scale,
    y: size.height / 2 - (world.northing - viewport.centre.northing) * viewport.scale,
  };
}

export function toWorld(
  screen: ScreenPoint,
  viewport: Viewport,
  size: Size,
): Coordinates {
  return {
    easting: viewport.centre.easting + (screen.x - size.width / 2) / viewport.scale,
    northing: viewport.centre.northing - (screen.y - size.height / 2) / viewport.scale,
  };
}

/**
 * Zoom about a fixed screen point, so pinching or double-tapping keeps the
 * spot under the fingers still rather than lurching to the middle.
 */
export function zoomAbout(
  viewport: Viewport,
  size: Size,
  anchor: ScreenPoint,
  factor: number,
): Viewport {
  const scale = clampScale(viewport.scale * factor);
  if (scale === viewport.scale) return viewport;

  const before = toWorld(anchor, viewport, size);
  const after = toWorld(anchor, { ...viewport, scale }, size);

  return {
    scale,
    centre: {
      easting: viewport.centre.easting + (before.easting - after.easting),
      northing: viewport.centre.northing + (before.northing - after.northing),
    },
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return {
    scale: viewport.scale,
    centre: {
      easting: viewport.centre.easting - dx / viewport.scale,
      northing: viewport.centre.northing + dy / viewport.scale,
    },
  };
}

/** The viewport that frames the given bounds with a comfortable margin. */
export function fitTo(
  bounds: { readonly min: Coordinates; readonly max: Coordinates },
  size: Size,
  paddingPx = 56,
): Viewport {
  const worldWidth = Math.max(bounds.max.easting - bounds.min.easting, 1e-6);
  const worldHeight = Math.max(bounds.max.northing - bounds.min.northing, 1e-6);

  const usableWidth = Math.max(size.width - paddingPx * 2, 40);
  const usableHeight = Math.max(size.height - paddingPx * 2, 40);

  return {
    scale: clampScale(Math.min(usableWidth / worldWidth, usableHeight / worldHeight)),
    centre: {
      easting: (bounds.min.easting + bounds.max.easting) / 2,
      northing: (bounds.min.northing + bounds.max.northing) / 2,
    },
  };
}

/**
 * A grid spacing that stays legible at any zoom: the nearest 1/2/5 x 10^n that
 * is at least 28 screen pixels apart.
 */
export function gridSpacing(scale: number, minimumPx = 28): number {
  const target = minimumPx / scale;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const step of [1, 2, 5, 10]) {
    if (magnitude * step >= target) return magnitude * step;
  }
  return magnitude * 10;
}

/** Shortest distance from a point to a line segment, in screen pixels. */
export function distanceToSegment(
  p: ScreenPoint,
  a: ScreenPoint,
  b: ScreenPoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);

  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared),
  );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
