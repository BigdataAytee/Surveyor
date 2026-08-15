/**
 * Web Mercator, and the tile grid every slippy map is cut into.
 *
 * This is display arithmetic, not survey arithmetic, and the distinction is
 * worth keeping sharp. Web Mercator (EPSG:3857) treats the earth as a sphere
 * even though its input is on an ellipsoid, which puts positions up to about
 * 20 km out in the north–south direction if you were foolish enough to measure
 * on it. It is here for one purpose: deciding which pixel of which tile a
 * position lands on. No survey value ever passes through it, and nothing it
 * produces is ever written back.
 *
 * It lives in the engine rather than the app because it is arithmetic with
 * right answers, and arithmetic with right answers belongs somewhere it can be
 * tested.
 */

/** Every tile scheme in common use is 256 pixels square. */
export const TILE_SIZE = 256;

/**
 * The latitude at which the Mercator projection is cut off.
 *
 * Mercator sends the poles to infinity, so the standard tile scheme stops at
 * the latitude that makes the world square — 85.0511287798…°, which is
 * `atan(sinh(π))`. Positions beyond it are clamped rather than turned into
 * infinities that would silently poison every subsequent calculation.
 */
export const MAX_LATITUDE = 85.05112877980659;

export interface WorldPixel {
  readonly x: number;
  readonly y: number;
}

/**
 * A position to a pixel in the whole-world image at a given zoom.
 *
 * At zoom 0 the world is one 256-pixel tile; each zoom doubles it. Fractional
 * zooms are allowed and meaningful — they are what a pinch produces between
 * one tile level and the next.
 */
export function toWorldPixel(
  latitude: number,
  longitude: number,
  zoom: number,
): WorldPixel {
  const scale = TILE_SIZE * 2 ** zoom;
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude));
  const phi = (clamped * Math.PI) / 180;

  return {
    x: ((longitude + 180) / 360) * scale,
    // The Mercator ordinate. `asinh(tan φ)` and the more familiar
    // `ln(tan φ + sec φ)` are the same function; this form is stabler near the
    // equator, where the other one is a logarithm of something very close to 1.
    y: (0.5 - Math.asinh(Math.tan(phi)) / (2 * Math.PI)) * scale,
  };
}

/** And back, which is what a drag on the map needs. */
export function fromWorldPixel(
  pixel: WorldPixel,
  zoom: number,
): { readonly latitude: number; readonly longitude: number } {
  const scale = TILE_SIZE * 2 ** zoom;

  return {
    longitude: (pixel.x / scale) * 360 - 180,
    latitude: (Math.atan(Math.sinh(Math.PI * (1 - (2 * pixel.y) / scale))) * 180) / Math.PI,
  };
}

/**
 * The zoom at which a bounding box fills a viewport.
 *
 * Returned as a fractional number and left to the caller to floor or not: the
 * tiles are fetched at an integer zoom, but the map may be showing a partly
 * zoomed state between two of them.
 */
export function zoomForBounds(
  bounds: readonly [number, number, number, number],
  width: number,
  height: number,
  padding = 1.25,
): number {
  const [west, south, east, north] = bounds;

  // A single point has no extent to fit. Somewhere close in, rather than zoom
  // 22 on a coordinate that is only accurate to a few metres anyway.
  if (east - west < 1e-9 && north - south < 1e-9) return 17;

  // Solved at zoom 0 and scaled, which avoids iterating over zoom levels.
  const corner = (lat: number, lon: number) => toWorldPixel(lat, lon, 0);
  const a = corner(north, west);
  const b = corner(south, east);

  const spanX = Math.max(Math.abs(b.x - a.x), 1e-9);
  const spanY = Math.max(Math.abs(b.y - a.y), 1e-9);

  const zoom = Math.log2(
    Math.min(width / (spanX * padding), height / (spanY * padding)),
  );

  // Below zoom 0 there is no more world to show; above 22 no provider has
  // tiles and the imagery is being stretched.
  return Math.max(0, Math.min(22, zoom));
}

export interface TileRef {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Which tiles cover a viewport, and where each one goes.
 *
 * `left` and `top` are offsets in CSS pixels from the top-left of the
 * viewport, so a caller can position them without repeating any of this.
 */
export function tilesFor(
  centre: { readonly latitude: number; readonly longitude: number },
  zoom: number,
  width: number,
  height: number,
  /**
   * The deepest zoom the provider actually has tiles for.
   *
   * Past it the last real level is fetched and drawn larger — "overzoom",
   * which is what every map does. The alternative is requesting tiles that do
   * not exist: a wall of 404s on somebody else's server and a blank screen
   * here, at exactly the zoom a surveyor is most likely to want.
   */
  maxZoom = 22,
): readonly (TileRef & { readonly left: number; readonly top: number; readonly size: number })[] {
  const z = Math.max(0, Math.min(22, Math.min(maxZoom, Math.round(zoom))));
  const count = 2 ** z;

  /*
   * Tiles are fetched at an integer zoom and drawn at the size the fractional
   * zoom asks for. That is what makes a pinch smooth: the imagery scales
   * continuously and only swaps level when it has to.
   */
  const size = TILE_SIZE * 2 ** (zoom - z);
  const middle = toWorldPixel(centre.latitude, centre.longitude, z);

  // Where the world's origin sits relative to the viewport's top-left.
  const originX = width / 2 - middle.x * (size / TILE_SIZE);
  const originY = height / 2 - middle.y * (size / TILE_SIZE);

  const first = { x: Math.floor(-originX / size), y: Math.floor(-originY / size) };
  const last = {
    x: Math.floor((width - originX) / size),
    y: Math.floor((height - originY) / size),
  };

  const tiles: (TileRef & { left: number; top: number; size: number })[] = [];

  for (let y = first.y; y <= last.y; y += 1) {
    // Vertically the world does not repeat: above the top tile and below the
    // bottom one there is nothing, and asking for it returns a 404 per tile.
    if (y < 0 || y >= count) continue;

    for (let x = first.x; x <= last.x; x += 1) {
      tiles.push({
        // Horizontally it does wrap — dragging west past the antimeridian
        // should keep showing map rather than blank.
        x: ((x % count) + count) % count,
        y,
        z,
        left: originX + x * size,
        top: originY + y * size,
        size,
      });
    }
  }

  return tiles;
}

/** Fill `{z}`, `{x}`, `{y}` and `{s}` in a tile URL template. */
export function tileUrl(template: string, tile: TileRef, subdomains = 'abc'): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))
    .replace(
      '{s}',
      subdomains.charAt(Math.abs(tile.x + tile.y) % Math.max(1, subdomains.length)),
    );
}
