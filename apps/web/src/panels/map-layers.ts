/**
 * The basemaps the map can show.
 *
 * Two, because a surveyor wants both and for different reasons. Streets tell
 * you which road the plot is off and what the neighbours are called; imagery
 * tells you what is actually standing on it. Neither replaces the other, so
 * neither replaces the other here.
 *
 * ---------------------------------------------------------------------------
 * Why every layer states its tile scheme
 * ---------------------------------------------------------------------------
 *
 * Switching layers must not move the parcel by a pixel, and the only way that
 * can go wrong is a provider whose tiles are not laid out the way the overlay
 * assumes. Three ways it happens in practice: 512-pixel tiles instead of 256,
 * a TMS origin at the bottom of the world rather than the top (which flips
 * `y`), and a projection that is not Web Mercator at all.
 *
 * So each layer says which it is, and the map asserts it rather than assuming.
 * A layer that got this wrong would draw a perfectly convincing map with the
 * boundary in the wrong field — the same class of silent error the datum work
 * is arranged against, one layer up.
 */

export interface MapLayer {
  readonly id: 'streets' | 'satellite';
  readonly label: string;
  /** `{z}`, `{x}`, `{y}` and optionally `{s}`, in whatever order the provider wants. */
  readonly template: string;
  /** Shown under the map. A licence condition for both of these, not a credit. */
  readonly attribution: string;
  /**
   * The deepest zoom the provider actually has tiles for.
   *
   * Past it the map keeps zooming and stretches the last real tile rather than
   * asking for ones that do not exist — which would be a wall of 404s on
   * somebody else's server and a blank screen here.
   */
  readonly maxZoom: number;
  /**
   * Pixels per tile. 256 everywhere below, and checked: a 512-pixel tile in a
   * 256-pixel grid puts the imagery at half scale under a correctly placed
   * boundary, which looks like the survey is wrong.
   */
  readonly tileSize: 256;
}

/**
 * OpenStreetMap. The default, and unchanged.
 *
 * Its terms are clear and its attribution requirement is met by showing the
 * string below.
 */
export const STREETS: MapLayer = {
  id: 'streets',
  label: 'Streets',
  template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
  // OSM's own tiles stop at 19.
  maxZoom: 19,
  tileSize: 256,
};

/**
 * Esri's World Imagery.
 *
 * Note the path: `{z}/{y}/{x}`, row before column, which is Esri's convention
 * and not a typo. The tiles themselves are the standard Web Mercator scheme
 * with the origin at the top left, the same as OSM's — which is what makes the
 * two interchangeable under one overlay.
 *
 * Attribution is required. Anyone deploying this should satisfy themselves
 * that their use sits within Esri's terms; a deployment with a licence from
 * another provider can point `VITE_MAP_TILES` at it instead, and that
 * override applies to this layer.
 */
export const SATELLITE: MapLayer = {
  id: 'satellite',
  label: 'Satellite',
  template:
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community',
  // Imagery depth varies by region; 19 is where it is reliably present.
  maxZoom: 19,
  tileSize: 256,
};

/**
 * A build-time override, applied to whichever layer it is meant for.
 *
 * `VITE_MAP_TILES` predates the switcher and pointed at the single layer there
 * was. It keeps working and now replaces the *streets* layer, so an existing
 * deployment that configured it sees no change. `VITE_MAP_SATELLITE_TILES`
 * does the same for imagery, for an operator with their own licensed source.
 */
function overridden(layer: MapLayer, template?: string, attribution?: string): MapLayer {
  const url = template?.trim();
  if (!url) return layer;
  return {
    ...layer,
    template: url,
    // An override without its own credit keeps the original's, which would be
    // crediting the wrong people. Better to say nothing than to say something
    // untrue about who made the imagery.
    attribution: attribution?.trim() || 'Map imagery',
  };
}

export const MAP_LAYERS: readonly MapLayer[] = [
  overridden(
    STREETS,
    import.meta.env?.VITE_MAP_TILES as string | undefined,
    import.meta.env?.VITE_MAP_ATTRIBUTION as string | undefined,
  ),
  overridden(
    SATELLITE,
    import.meta.env?.VITE_MAP_SATELLITE_TILES as string | undefined,
    import.meta.env?.VITE_MAP_SATELLITE_ATTRIBUTION as string | undefined,
  ),
];

/** Streets, because it loads anywhere and reads at any zoom. */
export const DEFAULT_LAYER_ID: MapLayer['id'] = 'streets';

export function layerById(id: string | undefined): MapLayer {
  return MAP_LAYERS.find((layer) => layer.id === id) ?? MAP_LAYERS[0]!;
}
