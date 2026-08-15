/**
 * The WGS 84 copy, for maps.
 *
 * The workflow this file implements, and the order matters:
 *
 *   the survey stays in Minna  →  a converted copy is made  →  the map uses
 *   the copy
 *
 * Nothing here writes back. `wgs84Copy` takes a Survey Data Model and returns
 * a separate structure; the model it was given is not touched, not cloned and
 * modified, not reordered. The Minna eastings and northings the surveyor
 * measured remain exactly what they were, for viewing, editing, exporting and
 * the survey record — because those are the numbers on the plan that gets
 * lodged, and they are the legal description of the parcel.
 *
 * The copy exists for one purpose: putting the parcel on a GPS or web map,
 * which speaks WGS 84 and nothing else. It carries the transformation that
 * produced it and that transformation's accuracy, so nobody can mistake a
 * position good to a few metres for a surveyed one.
 *
 * When the transformation is not available the answer is a refusal with a
 * reason, never a number. A datum shift cannot be guessed at: an invented one
 * produces coordinates that plot beautifully and are a hundred metres from the
 * truth, and there is nothing downstream that can notice.
 */

import type { Coordinates, SurveyDataModel } from '@surveyor/contracts';

import { shiftDatum, type HelmertParameters } from './datum.js';
import { gridToGeographic, type Geographic } from './transverse-mercator.js';
import {
  DATUM_TRANSFORMATIONS,
  PROJECTED_CRS,
  type DatumTransformation,
} from './registry.js';

export type ConversionFailure =
  /** The survey's grid is not one this app knows how to leave. */
  | {
      readonly ok: false;
      readonly missing: 'projection';
      readonly reason: string;
    }
  /** The grid is known, but its datum has no named shift to WGS 84. */
  | {
      readonly ok: false;
      readonly missing: 'transformation';
      readonly reason: string;
    };

export interface ConvertedPosition {
  readonly ok: true;
  readonly position: Geographic;
  readonly transformation: DatumTransformation;
}

export type ConversionResult = ConvertedPosition | ConversionFailure;

export interface ConversionOptions {
  /**
   * Local parameters, where a surveyor has them.
   *
   * A national three-parameter shift is good to a few metres. Anyone who has
   * had parameters derived from control observed in their own area should use
   * those, and this is where they go — it replaces the registry's set rather
   * than adjusting it.
   */
  readonly transformation?: DatumTransformation;
}

/** Look up what would be used, without converting anything. */
export function transformationFor(
  crs: SurveyDataModel['crs'],
  options: ConversionOptions = {},
): DatumTransformation | null {
  return options.transformation ?? DATUM_TRANSFORMATIONS[crs.datum] ?? null;
}

/**
 * One coordinate, converted.
 *
 * Grid → geographic on the source datum → geocentric → shifted → geographic on
 * WGS 84. Each step is exact for its inputs; the accuracy of the whole is the
 * accuracy of the shift, which is why that number is returned with it.
 */
export function toWgs84(
  coordinates: Coordinates,
  crs: SurveyDataModel['crs'],
  options: ConversionOptions = {},
): ConversionResult {
  const code = crs.code ?? '';
  const grid = PROJECTED_CRS[code];

  if (!grid) {
    return {
      ok: false,
      missing: 'projection',
      reason:
        `“${crs.name}” is not a grid this app can convert from. Converting ` +
        'needs the projection it was computed on — the central meridian, the ' +
        'scale factor and the false origin — and those are not something to ' +
        'assume from a coordinate.',
    };
  }

  const transformation = transformationFor(crs, options);
  if (!transformation) {
    return {
      ok: false,
      missing: 'transformation',
      reason:
        `There is no named transformation from the ${crs.datum} datum to ` +
        'WGS 84 in this app, so the survey cannot be put on a map. A datum ' +
        'shift has to come from a published or locally derived parameter set; ' +
        'a guessed one produces positions that look right and are tens of ' +
        'metres out.',
    };
  }

  const onSourceDatum = gridToGeographic(coordinates, grid);

  /*
   * Height, or the lack of it.
   *
   * Most survey points carry no ellipsoidal height, and there is none to
   * invent. Assuming zero costs almost nothing here: the shift is a rigid
   * translation, so an error of a hundred metres in the assumed height moves
   * the resulting latitude and longitude by about three millimetres. That is
   * far inside the transformation's own few metres, and it is the reason this
   * is safe to do silently where guessing a datum shift is not.
   */
  const position = shiftDatum(
    coordinates.elevation === undefined
      ? onSourceDatum
      : { ...onSourceDatum, height: coordinates.elevation },
    transformation.sourceEllipsoid,
    transformation.targetEllipsoid,
    transformation.parameters,
  );

  return { ok: true, position, transformation };
}

// ---------------------------------------------------------------------------
// A whole survey, copied
// ---------------------------------------------------------------------------

export interface Wgs84Point {
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface Wgs84Ring {
  readonly id: string;
  /** Closed: the first position is repeated at the end. */
  readonly positions: readonly Geographic[];
}

export interface Wgs84Feature {
  readonly id: string;
  readonly type: string;
  readonly name: string | null;
  readonly kind: 'polygon' | 'polyline' | 'point';
  readonly positions: readonly Geographic[];
}

/**
 * A survey in WGS 84 — separate from the survey.
 *
 * Deliberately not a `SurveyDataModel`. It has no provenance, no boundary
 * segments, no metadata to export from: it is a set of positions for drawing
 * on a map and nothing else. Giving it the same shape as the survey would
 * invite somebody to save it as one, and a survey saved in the wrong datum is
 * the failure this whole module is arranged to prevent.
 */
export interface Wgs84Plan {
  readonly points: readonly Wgs84Point[];
  readonly rings: readonly Wgs84Ring[];
  readonly features: readonly Wgs84Feature[];
  /** Which transformation produced these, and how good it is. */
  readonly transformation: DatumTransformation;
  /** [west, south, east, north], for fitting a map to the parcel. */
  readonly bounds: readonly [number, number, number, number];
  /** Where to centre a map. */
  readonly centre: { readonly latitude: number; readonly longitude: number };
}

export type Wgs84CopyResult = { readonly ok: true; readonly plan: Wgs84Plan } | ConversionFailure;

/**
 * Convert a copy of a survey for mapping.
 *
 * The model goes in and comes out untouched — this reads it and builds
 * something new beside it. That is the whole contract, and it is what the
 * tests check first.
 */
export function wgs84Copy(
  model: SurveyDataModel,
  options: ConversionOptions = {},
): Wgs84CopyResult {
  // Checked once, up front, so a survey that cannot be converted says so
  // rather than half-converting and failing partway through a boundary.
  const probe = toWgs84({ easting: 0, northing: 0 }, model.crs, options);
  if (!probe.ok) return probe;

  const { transformation } = probe;
  const convert = (coordinates: Coordinates): Geographic => {
    const result = toWgs84(coordinates, model.crs, options);
    // Unreachable: the probe above established the grid and the shift, and
    // neither depends on the coordinate. Written as a throw rather than a
    // silent zero because a zero here would plot in the Gulf of Guinea.
    if (!result.ok) throw new Error(result.reason);
    return result.position;
  };

  const points = model.points.map((point) => {
    const position = convert(point.coordinates);
    return { id: point.id, latitude: position.latitude, longitude: position.longitude };
  });

  const byId = new Map(model.points.map((point) => [point.id, point.coordinates]));

  const rings = model.boundary.map((ring) => {
    const positions = ring.segments
      .map((segment) => byId.get(segment.from))
      .filter((coordinates): coordinates is Coordinates => coordinates !== undefined)
      .map(convert);

    // Closed explicitly. A map expects the ring to return to its start, and a
    // polygon that does not close is drawn as an open shape or rejected.
    const first = positions[0];
    return {
      id: ring.id,
      positions: first === undefined ? positions : [...positions, first],
    };
  });

  const features = model.siteFeatures.map((feature) => {
    const { kind, vertices } = flatten(feature.geometry);
    const positions = vertices.map(convert);
    const first = positions[0];

    return {
      id: feature.id,
      type: feature.type,
      name: feature.attributes.name === undefined ? null : String(feature.attributes.name),
      kind,
      positions: kind === 'polygon' && first !== undefined ? [...positions, first] : positions,
    };
  });

  const everything = [
    ...points.map((point) => ({ latitude: point.latitude, longitude: point.longitude })),
    ...rings.flatMap((ring) => ring.positions),
    ...features.flatMap((feature) => feature.positions),
  ];

  const latitudes = everything.map((position) => position.latitude);
  const longitudes = everything.map((position) => position.longitude);

  // An empty survey has no extent. Reported as a degenerate box at the origin
  // rather than as NaN, which a map would silently render as a blank world.
  const bounds: readonly [number, number, number, number] =
    everything.length === 0
      ? [0, 0, 0, 0]
      : [
          Math.min(...longitudes),
          Math.min(...latitudes),
          Math.max(...longitudes),
          Math.max(...latitudes),
        ];

  return {
    ok: true,
    plan: {
      points,
      rings,
      features,
      transformation,
      bounds,
      centre: {
        longitude: (bounds[0] + bounds[2]) / 2,
        latitude: (bounds[1] + bounds[3]) / 2,
      },
    },
  };
}

/** How finely a circle or arc becomes a run of straight lines. */
const CURVE_SEGMENTS = 64;

/**
 * Reduce any feature geometry to a run of positions.
 *
 * Circles and arcs are flattened here, on the *grid*, before conversion — not
 * afterwards. A circle is defined on the grid as a centre and a radius in
 * metres, so that is where its points are correct; converting a centre and a
 * radius and then drawing a circle on a map would draw the wrong shape,
 * because a circle in one projection is not a circle in another.
 */
function flatten(geometry: SurveyDataModel['siteFeatures'][number]['geometry']): {
  readonly kind: 'polygon' | 'polyline' | 'point';
  readonly vertices: readonly Coordinates[];
} {
  switch (geometry.kind) {
    case 'point':
      return { kind: 'point', vertices: [geometry.at] };
    case 'polygon':
      return { kind: 'polygon', vertices: geometry.vertices };
    case 'polyline':
      return { kind: 'polyline', vertices: geometry.vertices };
    case 'circle':
      return {
        kind: 'polygon',
        vertices: sweep(geometry.centre, geometry.radius, 0, 360, CURVE_SEGMENTS),
      };
    case 'arc': {
      const span = ((geometry.endBearing - geometry.startBearing) % 360 + 360) % 360;
      return {
        kind: 'polyline',
        vertices: sweep(
          geometry.centre,
          geometry.radius,
          geometry.startBearing,
          geometry.startBearing + span,
          Math.max(2, Math.round((CURVE_SEGMENTS * span) / 360)),
        ),
      };
    }
  }
}

/** Bearings clockwise from north, as everywhere else in this system. */
function sweep(
  centre: Coordinates,
  radius: number,
  fromBearing: number,
  toBearing: number,
  steps: number,
): readonly Coordinates[] {
  const points: Coordinates[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const bearing = fromBearing + ((toBearing - fromBearing) * i) / steps;
    const radians = (bearing * Math.PI) / 180;
    points.push({
      easting: centre.easting + radius * Math.sin(radians),
      northing: centre.northing + radius * Math.cos(radians),
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// What a map actually consumes
// ---------------------------------------------------------------------------

/**
 * GeoJSON, which is WGS 84 by definition.
 *
 * RFC 7946 fixes the coordinate reference system: longitude then latitude, on
 * WGS 84, and no other. That is exactly why this is the shape the converted
 * copy is handed over in — a GeoJSON file carrying Minna eastings would be a
 * malformed file that most software would draw somewhere off the coast of
 * Ghana rather than reject.
 */
export function toGeoJson(plan: Wgs84Plan): unknown {
  const position = (p: Geographic): readonly number[] => [
    round(p.longitude),
    round(p.latitude),
  ];

  const features: unknown[] = [];

  for (const ring of plan.rings) {
    if (ring.positions.length < 4) continue;
    features.push({
      type: 'Feature',
      properties: { id: ring.id, role: 'boundary' },
      geometry: { type: 'Polygon', coordinates: [ring.positions.map(position)] },
    });
  }

  for (const feature of plan.features) {
    if (feature.positions.length === 0) continue;
    const geometry =
      feature.kind === 'polygon'
        ? { type: 'Polygon', coordinates: [feature.positions.map(position)] }
        : feature.kind === 'polyline'
          ? { type: 'LineString', coordinates: feature.positions.map(position) }
          : { type: 'Point', coordinates: position(feature.positions[0]!) };

    features.push({
      type: 'Feature',
      properties: { id: feature.id, type: feature.type, name: feature.name },
      geometry,
    });
  }

  for (const point of plan.points) {
    features.push({
      type: 'Feature',
      properties: { id: point.id, role: 'survey-point' },
      geometry: {
        type: 'Point',
        coordinates: [round(point.longitude), round(point.latitude)],
      },
    });
  }

  return {
    type: 'FeatureCollection',
    /*
     * The transformation travels with the file.
     *
     * Somebody will open this in six months and need to know whether these
     * positions are good to three metres or three centimetres. Putting the
     * operation and its accuracy in the file is the only way that question has
     * an answer once the file has left this app.
     */
    properties: {
      transformation: plan.transformation.name,
      transformationCode: plan.transformation.code,
      accuracyMetres: plan.transformation.accuracyMetres,
      note:
        'Positions converted from the survey datum for mapping only. The ' +
        'survey record is the original grid coordinates.',
    },
    features,
  };
}

/**
 * Seven decimal places — about a centimetre.
 *
 * Finer than the transformation can justify, and deliberately so: rounding at
 * the accuracy of the shift would make a round trip lossy and imply a
 * precision the file does not carry. The accuracy is stated in the properties,
 * which is where a claim about precision belongs.
 */
function round(degrees: number): number {
  return Math.round(degrees * 1e7) / 1e7;
}
