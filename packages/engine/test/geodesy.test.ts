/**
 * Tests for the Minna → WGS 84 workflow.
 *
 * The four the workflow was specified around come first, because they are the
 * whole point:
 *
 *   1. the original Minna coordinates are unchanged
 *   2. the WGS 84 coordinates are a separate thing
 *   3. what a map consumes is the WGS 84 copy
 *   4. a conversion with no named parameters fails, loudly, rather than
 *      producing a plausible number
 *
 * Then the geodesy itself, because a workflow that keeps the original safe and
 * converts it wrongly has only solved half the problem — and the wrong half is
 * the invisible one. A position on the wrong datum plots perfectly and is a
 * hundred metres out.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SurveyDataModel } from '@surveyor/contracts';

import {
  CLARKE_1880_RGS,
  DEFAULT_CRS,
  KNOWN_CRS,
  MINNA_TO_WGS84,
  PROJECTED_CRS,
  WGS84_ELLIPSOID,
  constantsOf,
  geocentricToGeographic,
  geographicToGeocentric,
  geographicToGrid,
  gridToGeographic,
  ringFromPointOrder,
  shiftDatum,
  MAX_LATITUDE,
  fromWorldPixel,
  tileUrl,
  tilesFor,
  toGeoJson,
  toWgs84,
  toWorldPixel,
  zoomForBounds,
  transformationFor,
  wgs84Copy,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// A survey to work on
// ---------------------------------------------------------------------------

/** Four corners in Minna / UTM zone 31N, near Lagos. */
const MINNA_CORNERS = [
  { easting: 544800, northing: 718900 },
  { easting: 544832.4, northing: 718903.1 },
  { easting: 544828.9, northing: 718924.6 },
  { easting: 544798.2, northing: 718921.3 },
] as const;

function survey(): SurveyDataModel {
  return {
    metadata: { jurisdiction: 'ng-survey-plan', siteAddress: 'Plot 15' },
    crs: DEFAULT_CRS,
    points: MINNA_CORNERS.map((coordinates, index) => ({
      id: `PT${index + 1}`,
      coordinates,
      provenance: { source: 'measured' as const },
    })),
    boundary: [ringFromPointOrder('ring_1', ['PT1', 'PT2', 'PT3', 'PT4'])],
    siteFeatures: [
      {
        id: 'bld_1',
        type: 'building' as const,
        geometry: {
          kind: 'polygon' as const,
          vertices: [
            { easting: 544807, northing: 718907 },
            { easting: 544819, northing: 718908.2 },
            { easting: 544818, northing: 718916 },
          ],
        },
        attributes: { name: 'House' },
        provenance: { source: 'measured' as const },
      },
    ],
    notes: [],
  };
}

/** Freeze a value and everything under it, so any write throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 1. The original Minna coordinates remain unchanged
// ---------------------------------------------------------------------------

test('converting does not touch the survey', () => {
  const model = survey();
  const before = structuredClone(model);

  const result = wgs84Copy(model);
  assert.equal(result.ok, true);

  assert.deepEqual(model, before, 'the survey was modified by converting a copy of it');
});

test('the survey is not even writable during a conversion', () => {
  /*
   * Stronger than comparing before and after: a frozen model turns any write
   * into a thrown error in strict mode, so this fails on an attempt rather
   * than on an attempt that happened to restore the same value.
   */
  const model = deepFreeze(survey());
  const result = wgs84Copy(model);
  assert.equal(result.ok, true, 'converting a read-only survey threw');
});

test('the Minna coordinates are exactly as measured afterwards', () => {
  const model = survey();
  wgs84Copy(model);

  model.points.forEach((point, index) => {
    const expected = MINNA_CORNERS[index]!;
    assert.equal(point.coordinates.easting, expected.easting, `${point.id} easting moved`);
    assert.equal(point.coordinates.northing, expected.northing, `${point.id} northing moved`);
  });
  assert.equal(model.crs.datum, 'Minna', 'the survey was re-stamped with another datum');
  assert.equal(model.crs.code, 'EPSG:26331');
});

test('converting twice gives the same answer and still leaves the survey alone', () => {
  const model = survey();
  const first = wgs84Copy(model);
  const second = wgs84Copy(model);

  assert.equal(first.ok && second.ok, true);
  if (first.ok && second.ok) {
    assert.deepEqual(first.plan.points, second.plan.points);
  }
  assert.equal(model.points[0]?.coordinates.easting, 544800);
});

// ---------------------------------------------------------------------------
// 2. The WGS 84 coordinates are generated separately
// ---------------------------------------------------------------------------

test('the converted copy is a separate object graph', () => {
  const model = survey();
  const result = wgs84Copy(model);
  assert.ok(result.ok);

  const plan = result.plan;

  // Nothing in the copy is the same object as anything in the survey.
  for (const point of plan.points) {
    for (const original of model.points) {
      assert.notEqual(point as unknown, original as unknown);
      assert.notEqual(point as unknown, original.coordinates as unknown);
    }
  }

  // And it is a different shape entirely — degrees, not eastings.
  const first = plan.points[0]!;
  assert.equal(typeof first.latitude, 'number');
  assert.equal(typeof first.longitude, 'number');
  assert.equal('easting' in first, false, 'the copy carries grid coordinates');
  assert.equal('northing' in first, false);
});

test('the copy is in degrees, in the right part of the world', () => {
  const result = wgs84Copy(survey());
  assert.ok(result.ok);

  for (const point of result.plan.points) {
    // Nigeria: roughly 4°–14°N, 2°–15°E. A conversion that went wrong lands
    // in the Gulf of Guinea at 0,0 or off by whole degrees, and this catches
    // both without pretending to be a precision check.
    assert.ok(point.latitude > 4 && point.latitude < 14, `latitude ${point.latitude} is not in Nigeria`);
    assert.ok(point.longitude > 2 && point.longitude < 15, `longitude ${point.longitude} is not in Nigeria`);
  }
});

test('the copy carries the transformation that produced it, and its accuracy', () => {
  const result = wgs84Copy(survey());
  assert.ok(result.ok);

  const { transformation } = result.plan;
  assert.equal(transformation.name, 'Minna to WGS 84 (1)');
  assert.equal(transformation.code, 'EPSG:1310');
  assert.equal(transformation.from, 'Minna');
  assert.equal(transformation.to, 'WGS 84');
  // Stated, not implied. A position good to metres must never be mistaken for
  // a surveyed one, and the only way anyone can tell is if the number travels
  // with the coordinate.
  assert.ok(transformation.accuracyMetres > 0);
});

test('the survey keeps its own coordinates for the record while the copy exists', () => {
  const model = survey();
  const result = wgs84Copy(model);
  assert.ok(result.ok);

  // Both available at once, which is the point: the plan prints Minna, the map
  // draws WGS 84, and neither has replaced the other.
  assert.equal(model.points[0]?.coordinates.easting, 544800);
  assert.ok(Math.abs(result.plan.points[0]!.latitude - 6.5) < 0.2);
});

// ---------------------------------------------------------------------------
// 3. The map uses the WGS 84 coordinates
// ---------------------------------------------------------------------------

test('GeoJSON carries degrees, never grid coordinates', () => {
  const result = wgs84Copy(survey());
  assert.ok(result.ok);

  const geojson = toGeoJson(result.plan) as {
    features: { geometry: { type: string; coordinates: unknown } }[];
  };

  const flat = JSON.stringify(geojson);
  // A grid easting is six digits. If one reached the file, this finds it.
  assert.ok(!/5448\d\d/.test(flat), 'a Minna easting reached the GeoJSON');
  assert.ok(!/7189\d\d/.test(flat), 'a Minna northing reached the GeoJSON');

  const polygon = geojson.features.find((feature) => feature.geometry.type === 'Polygon');
  assert.ok(polygon, 'the boundary is not in the GeoJSON');

  const ring = (polygon.geometry.coordinates as number[][][])[0]!;
  for (const [longitude, latitude] of ring) {
    // RFC 7946 fixes the order: longitude first, then latitude, on WGS 84.
    assert.ok(longitude! > 2 && longitude! < 15, `longitude ${longitude} out of range`);
    assert.ok(latitude! > 4 && latitude! < 14, `latitude ${latitude} out of range`);
  }

  // The ring closes, or a map draws it as an open shape.
  assert.deepEqual(ring[0], ring[ring.length - 1], 'the boundary ring does not close');
});

test('the file says how good its positions are', () => {
  const result = wgs84Copy(survey());
  assert.ok(result.ok);

  const geojson = toGeoJson(result.plan) as {
    properties: { transformationCode: string; accuracyMetres: number };
  };
  assert.equal(geojson.properties.transformationCode, 'EPSG:1310');
  assert.equal(geojson.properties.accuracyMetres, MINNA_TO_WGS84.accuracyMetres);
});

test('the map is given bounds and a centre it can use', () => {
  const result = wgs84Copy(survey());
  assert.ok(result.ok);

  const [west, south, east, north] = result.plan.bounds;
  assert.ok(west < east && south < north, 'the bounds are inside out or empty');
  assert.ok(east - west < 0.01 && north - south < 0.01, 'a 30 m parcel spans more than a kilometre');

  assert.ok(Math.abs(result.plan.centre.longitude - (west + east) / 2) < 1e-12);
  assert.ok(Math.abs(result.plan.centre.latitude - (south + north) / 2) < 1e-12);
});

test('the converted shape is the same shape, to the centimetre', () => {
  /*
   * The conversion must not distort the parcel. Distances between the corners
   * are compared on the grid and on the sphere: a datum shift is a rigid
   * movement, so they have to agree.
   */
  const result = wgs84Copy(survey());
  assert.ok(result.ok);

  const [a, b] = [MINNA_CORNERS[0], MINNA_CORNERS[1]];
  const onGrid = Math.hypot(b.easting - a.easting, b.northing - a.northing);

  const [pa, pb] = [result.plan.points[0]!, result.plan.points[1]!];
  const mLat = 111132.92;
  const mLon = 111412.84 * Math.cos((pa.latitude * Math.PI) / 180);
  const onGround = Math.hypot(
    (pb.latitude - pa.latitude) * mLat,
    (pb.longitude - pa.longitude) * mLon,
  );

  // A few centimetres of slack: the grid distance carries UTM's scale factor,
  // and the comparison uses a spherical approximation for the ground one.
  assert.ok(
    Math.abs(onGrid - onGround) < 0.1,
    `the shape changed: ${onGrid.toFixed(3)} m on the grid, ${onGround.toFixed(3)} m converted`,
  );
});

// ---------------------------------------------------------------------------
// 4. It fails clearly when the parameters are missing
// ---------------------------------------------------------------------------

test('a datum with no named transformation is refused, not approximated', () => {
  const model = survey();
  const onOsgb: SurveyDataModel = { ...model, crs: KNOWN_CRS['EPSG:27700']! };

  const result = wgs84Copy(onOsgb);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.missing, 'transformation');
    assert.match(result.reason, /OSGB36/);
    assert.match(result.reason, /transformation/i);
  }
});

test('a grid the app has no projection for is refused', () => {
  const model = survey();
  const unknown: SurveyDataModel = {
    ...model,
    crs: { code: 'EPSG:99999', name: 'Someone’s local grid', datum: 'Minna', units: 'metre', bearingConvention: 'azimuth' },
  };

  const result = wgs84Copy(unknown);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.missing, 'projection');
});

test('a survey with no CRS code at all is refused', () => {
  const model = survey();
  const noCode: SurveyDataModel = {
    ...model,
    crs: { name: 'Assumed local grid', datum: 'Minna', units: 'metre', bearingConvention: 'azimuth' },
  };

  const result = wgs84Copy(noCode);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.missing, 'projection');
});

test('a refusal names what is missing rather than saying it went wrong', () => {
  const result = toWgs84(
    { easting: 544800, northing: 718900 },
    { name: 'Nowhere', datum: 'Nothing', units: 'metre', bearingConvention: 'azimuth' },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reason.length > 40, 'the reason is too short to be useful');
    // The one thing it must never do is offer a number anyway.
    assert.equal('position' in result, false);
  }
});

test('a refused conversion leaves the survey untouched', () => {
  const model: SurveyDataModel = { ...survey(), crs: KNOWN_CRS['EPSG:27700']! };
  const before = structuredClone(model);

  const result = wgs84Copy(model);
  assert.equal(result.ok, false);
  assert.deepEqual(model, before);
});

test('local parameters can be supplied where a surveyor has them', () => {
  const model = survey();
  const national = wgs84Copy(model);
  const local = wgs84Copy(model, {
    transformation: {
      ...MINNA_TO_WGS84,
      name: 'Local ties, Lagos 2026',
      code: 'local',
      parameters: { dx: -90.1, dy: -95.2, dz: 120.8 },
      accuracyMetres: 0.3,
    },
  });

  assert.ok(national.ok && local.ok);
  if (national.ok && local.ok) {
    assert.notEqual(national.plan.points[0]!.latitude, local.plan.points[0]!.latitude);
    assert.equal(local.plan.transformation.accuracyMetres, 0.3);
  }
  // And still nothing written back.
  assert.equal(model.points[0]?.coordinates.easting, 544800);
});

test('which transformation would be used can be asked without converting', () => {
  assert.equal(transformationFor(DEFAULT_CRS)?.code, 'EPSG:1310');
  assert.equal(transformationFor(KNOWN_CRS['EPSG:27700']!), null);
});

// ---------------------------------------------------------------------------
// The geodesy itself
// ---------------------------------------------------------------------------

test('the meridional arc matches numerical integration', () => {
  /*
   * The series is the part most likely to be subtly wrong, and it cannot be
   * checked against itself. Simpson's rule on the meridional radius of
   * curvature is a completely independent route to the same number.
   */
  const grid = PROJECTED_CRS['EPSG:26331']!;
  const { a, e2 } = constantsOf(CLARKE_1880_RGS);

  const byIntegration = (latitudeDegrees: number, steps = 20000): number => {
    const rho = (phi: number) => (a * (1 - e2)) / (1 - e2 * Math.sin(phi) ** 2) ** 1.5;
    const upper = (latitudeDegrees * Math.PI) / 180;
    const h = upper / steps;
    let total = rho(0) + rho(upper);
    for (let i = 1; i < steps; i += 1) total += rho(i * h) * (i % 2 === 1 ? 4 : 2);
    return (total * h) / 3;
  };

  for (const latitude of [4, 6.5, 10, 13.9]) {
    // On the central meridian, and with the origin on the equator, the
    // northing is exactly the scaled arc.
    const { northing } = geographicToGrid(
      { latitude, longitude: grid.centralMeridian },
      grid,
    );
    const expected = byIntegration(latitude) * grid.scaleFactor;
    assert.ok(
      Math.abs(northing - expected) < 0.001,
      `arc at ${latitude}°: series ${northing}, integral ${expected}`,
    );
  }
});

test('UTM puts the origin where UTM puts the origin', () => {
  const grid = PROJECTED_CRS['EPSG:26331']!;
  const origin = geographicToGrid({ latitude: 0, longitude: 3 }, grid);

  assert.ok(Math.abs(origin.easting - 500000) < 1e-6, `easting ${origin.easting}`);
  assert.ok(Math.abs(origin.northing) < 1e-6, `northing ${origin.northing}`);
  assert.equal(grid.scaleFactor, 0.9996);
  assert.equal(grid.ellipsoid.name, 'Clarke 1880 (RGS)');
});

test('the projection round-trips to under a millimetre', () => {
  const grid = PROJECTED_CRS['EPSG:26331']!;

  for (const latitude of [4, 6.5, 9, 13.9]) {
    for (const longitude of [0.5, 3, 5.5]) {
      const back = gridToGeographic(geographicToGrid({ latitude, longitude }, grid), grid);
      const north = Math.abs(back.latitude - latitude) * 111320;
      const east =
        Math.abs(back.longitude - longitude) * 111320 * Math.cos((latitude * Math.PI) / 180);

      assert.ok(
        Math.hypot(north, east) < 0.001,
        `round trip at ${latitude},${longitude} lost ${Math.hypot(north, east)} m`,
      );
    }
  }
});

test('the belts are Transverse Mercator on their published parameters', () => {
  const west = PROJECTED_CRS['EPSG:26391']!;
  const mid = PROJECTED_CRS['EPSG:26392']!;
  const east = PROJECTED_CRS['EPSG:26393']!;

  for (const belt of [west, mid, east]) {
    assert.equal(belt.latitudeOfOrigin, 4, 'the belts share a latitude of origin of 4°N');
    assert.equal(belt.scaleFactor, 0.99975);
    assert.equal(belt.falseNorthing, 0);
    assert.equal(belt.ellipsoid.name, 'Clarke 1880 (RGS)');
  }

  assert.equal(west.centralMeridian, 4.5);
  assert.equal(mid.centralMeridian, 8.5);
  assert.equal(east.centralMeridian, 12.5);

  // The false eastings are not round numbers, and that is not a typo — the
  // belts were laid out in feet.
  assert.equal(west.falseEasting, 230738.26);
  assert.equal(mid.falseEasting, 670553.98);
  assert.equal(east.falseEasting, 1110369.7);
});

test('a position converts the same whichever Minna grid it was computed on', () => {
  /*
   * The strongest check available without external control: the same place on
   * the ground, expressed on two different Minna grids, must convert to the
   * same WGS 84 position. It exercises both projections and the shift, and
   * only agrees if all three are right.
   */
  const utm = PROJECTED_CRS['EPSG:26331']!;
  const belt = PROJECTED_CRS['EPSG:26391']!;
  const place = { latitude: 6.5, longitude: 3.4 };

  const viaUtm = toWgs84(geographicToGrid(place, utm), KNOWN_CRS['EPSG:26331']!);
  const viaBelt = toWgs84(geographicToGrid(place, belt), KNOWN_CRS['EPSG:26391']!);

  assert.ok(viaUtm.ok && viaBelt.ok);
  if (viaUtm.ok && viaBelt.ok) {
    const metres = Math.hypot(
      (viaUtm.position.latitude - viaBelt.position.latitude) * 111132,
      (viaUtm.position.longitude - viaBelt.position.longitude) * 111412 * Math.cos(6.5 * Math.PI / 180),
    );
    assert.ok(metres < 0.01, `the two grids disagree by ${metres} m`);
  }
});

test('geocentric conversion round-trips on both ellipsoids', () => {
  for (const ellipsoid of [CLARKE_1880_RGS, WGS84_ELLIPSOID]) {
    for (const position of [
      { latitude: 6.5, longitude: 3.4, height: 42 },
      { latitude: 13.9, longitude: 13.2, height: 0 },
      { latitude: -33.9, longitude: 151.2, height: 1200 },
    ]) {
      const back = geocentricToGeographic(
        geographicToGeocentric(position, ellipsoid),
        ellipsoid,
      );
      assert.ok(Math.abs(back.latitude - position.latitude) * 111320 < 1e-6);
      assert.ok(Math.abs((back.height ?? 0) - position.height) < 1e-6);
    }
  }
});

test('the Minna shift moves a position by the amount that datum is known to differ', () => {
  /*
   * Not a precision check — a bound. Minna and WGS 84 differ across Nigeria by
   * something of the order of a hundred metres. A shift of a few metres would
   * mean the translation was not applied; one of several kilometres would mean
   * the wrong ellipsoid or a sign error. Both are the mistakes worth catching,
   * and both are invisible on a map.
   */
  for (const place of [
    { latitude: 6.5, longitude: 3.4 },
    { latitude: 9.06, longitude: 7.49 },
    { latitude: 12.0, longitude: 8.6 },
  ]) {
    const moved = shiftDatum(place, CLARKE_1880_RGS, WGS84_ELLIPSOID, MINNA_TO_WGS84.parameters);
    const metres = Math.hypot(
      (moved.latitude - place.latitude) * 111132,
      (moved.longitude - place.longitude) * 111412 * Math.cos((place.latitude * Math.PI) / 180),
    );
    assert.ok(metres > 20 && metres < 500, `shift at ${place.latitude}° was ${metres} m`);
  }
});

test('the transformation is stated as a geocentric translation, with no rotations', () => {
  // Which is why the rotation sign convention — the classic way to be a few
  // metres wrong while every number looks fine — cannot apply to it.
  assert.equal(MINNA_TO_WGS84.parameters.rx, undefined);
  assert.equal(MINNA_TO_WGS84.parameters.ry, undefined);
  assert.equal(MINNA_TO_WGS84.parameters.rz, undefined);
  assert.equal(MINNA_TO_WGS84.parameters.scalePpm, undefined);
  assert.equal(MINNA_TO_WGS84.sourceEllipsoid.name, 'Clarke 1880 (RGS)');
  assert.equal(MINNA_TO_WGS84.sourceEllipsoid.a, 6378249.145);
  assert.equal(MINNA_TO_WGS84.sourceEllipsoid.invF, 293.465);
});

test('a survey already on WGS 84 passes through without being shifted', () => {
  const model: SurveyDataModel = {
    ...survey(),
    crs: KNOWN_CRS['EPSG:32633']!,
    points: [
      { id: 'PT1', coordinates: { easting: 500000, northing: 718900 }, provenance: { source: 'measured' } },
    ],
    boundary: [],
    siteFeatures: [],
  };

  const result = wgs84Copy(model);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.plan.transformation.accuracyMetres, 0);
    // On the central meridian of zone 33N.
    assert.ok(Math.abs(result.plan.points[0]!.longitude - 15) < 1e-9);
  }
});

// ---------------------------------------------------------------------------
// The tile grid
// ---------------------------------------------------------------------------

test('Web Mercator puts the origin in the middle of the world', () => {
  // At zoom 0 the whole world is one 256-pixel tile, so null island is at its
  // centre and the antimeridian at its edges.
  const middle = toWorldPixel(0, 0, 0);
  assert.ok(Math.abs(middle.x - 128) < 1e-9, `x ${middle.x}`);
  assert.ok(Math.abs(middle.y - 128) < 1e-9, `y ${middle.y}`);

  assert.ok(Math.abs(toWorldPixel(0, 180, 0).x - 256) < 1e-9);
  assert.ok(Math.abs(toWorldPixel(0, -180, 0).x) < 1e-9);
});

test('the projection is cut off at the latitude that makes the world square', () => {
  // Mercator sends the poles to infinity; the tile scheme stops at
  // atan(sinh(π)), which is what makes a zoom level a square of tiles.
  assert.ok(Math.abs(MAX_LATITUDE - (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI) < 1e-9);
  assert.ok(Math.abs(toWorldPixel(MAX_LATITUDE, 0, 0).y) < 1e-6);
  assert.ok(Math.abs(toWorldPixel(-MAX_LATITUDE, 0, 0).y - 256) < 1e-6);

  // Beyond it, clamped rather than turned into an infinity that would poison
  // every subsequent calculation silently.
  assert.ok(Number.isFinite(toWorldPixel(90, 0, 0).y));
  assert.ok(Number.isFinite(toWorldPixel(-90, 0, 0).y));
});

test('a position survives the round trip through pixel space', () => {
  for (const zoom of [1, 8, 17, 21]) {
    for (const place of [
      { latitude: 6.5042, longitude: 3.4052 },
      { latitude: 13.9, longitude: 13.2 },
      { latitude: -33.87, longitude: 151.21 },
    ]) {
      const back = fromWorldPixel(toWorldPixel(place.latitude, place.longitude, zoom), zoom);
      assert.ok(Math.abs(back.latitude - place.latitude) < 1e-9, `zoom ${zoom} latitude`);
      assert.ok(Math.abs(back.longitude - place.longitude) < 1e-9, `zoom ${zoom} longitude`);
    }
  }
});

test('every zoom level doubles the world', () => {
  const here = { latitude: 6.5, longitude: 3.4 };
  for (const zoom of [0, 5, 12]) {
    const a = toWorldPixel(here.latitude, here.longitude, zoom);
    const b = toWorldPixel(here.latitude, here.longitude, zoom + 1);
    assert.ok(Math.abs(b.x - a.x * 2) < 1e-6);
    assert.ok(Math.abs(b.y - a.y * 2) < 1e-6);
  }
});

test('a survey-sized parcel is fitted at a zoom that can actually see it', () => {
  const result = wgs84Copy(survey());
  assert.ok(result.ok);
  if (!result.ok) return;

  const zoom = zoomForBounds(result.plan.bounds, 360, 340);
  // A 30 m parcel. Zoomed out to street level it is a dot; past 21 no provider
  // has tiles. Both ends are mistakes worth catching.
  assert.ok(zoom > 15 && zoom <= 21, `fitted at zoom ${zoom}`);
});

test('a single point has no extent, and is not fitted to infinity', () => {
  const zoom = zoomForBounds([3.4, 6.5, 3.4, 6.5], 360, 340);
  assert.ok(Number.isFinite(zoom));
  assert.ok(zoom > 10 && zoom <= 22, `a point fitted at zoom ${zoom}`);
});

test('the tiles cover the viewport, and no more than they need to', () => {
  const centre = { latitude: 6.5042, longitude: 3.4052 };
  const tiles = tilesFor(centre, 17, 360, 340);

  assert.ok(tiles.length > 0, 'no tiles for a viewport');
  // 360×340 at 256 px a tile needs at most 3×3.
  assert.ok(tiles.length <= 12, `${tiles.length} tiles for one small viewport`);

  // Together they cover it: nothing in the viewport is left uncovered.
  const covered = (x: number, y: number) =>
    tiles.some(
      (tile) =>
        x >= tile.left && x < tile.left + tile.size && y >= tile.top && y < tile.top + tile.size,
    );
  for (const [x, y] of [[0, 0], [359, 0], [0, 339], [359, 339], [180, 170]]) {
    assert.ok(covered(x!, y!), `the viewport is not covered at ${x},${y}`);
  }
});

test('tile indices stay inside the grid for the zoom', () => {
  for (const zoom of [0, 1, 6, 18]) {
    for (const tile of tilesFor({ latitude: 6.5, longitude: 3.4 }, zoom, 400, 400)) {
      const count = 2 ** zoom;
      assert.ok(tile.x >= 0 && tile.x < count, `x ${tile.x} at zoom ${zoom}`);
      assert.ok(tile.y >= 0 && tile.y < count, `y ${tile.y} at zoom ${zoom}`);
    }
  }
});

test('there are no tiles above the north edge of the world or below the south', () => {
  // The world wraps sideways but not vertically, and asking for a row that
  // does not exist is a 404 per tile on somebody else's server.
  const top = tilesFor({ latitude: 84.9, longitude: 0 }, 2, 600, 600);
  assert.ok(top.every((tile) => tile.y >= 0 && tile.y < 4));
  const bottom = tilesFor({ latitude: -84.9, longitude: 0 }, 2, 600, 600);
  assert.ok(bottom.every((tile) => tile.y >= 0 && tile.y < 4));
});

test('a tile URL is filled in, with nothing left unsubstituted', () => {
  const url = tileUrl('https://tile.example/{z}/{x}/{y}.png', { x: 12, y: 34, z: 5 });
  assert.equal(url, 'https://tile.example/5/12/34.png');
  assert.ok(!/\{/.test(url), 'a placeholder survived');

  // Subdomain sharding, for providers that ask for it.
  const sharded = tileUrl('https://{s}.tile.example/{z}/{x}/{y}.png', { x: 1, y: 1, z: 3 });
  assert.match(sharded, /^https:\/\/[abc]\.tile\.example\/3\/1\/1\.png$/);
});

test('the map projection never touches survey coordinates', () => {
  /*
   * Web Mercator treats the earth as a sphere, which is fine for deciding
   * which pixel something lands on and wrong by up to twenty kilometres for
   * anything else. This is the guard that it stays on the display side: it is
   * fed degrees from the converted copy, and there is no path from a survey
   * easting into it.
   */
  const model = survey();
  const before = structuredClone(model);
  const result = wgs84Copy(model);
  assert.ok(result.ok);
  if (result.ok) {
    for (const point of result.plan.points) {
      toWorldPixel(point.latitude, point.longitude, 17);
    }
  }
  assert.deepEqual(model, before);
});
