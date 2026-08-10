/**
 * COGO correctness. These are the calculations every downstream stage trusts,
 * so they are checked against shapes whose answers are known independently.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoundaryRing, SurveyPoint } from '@surveyor/contracts';

import {
  centroid,
  circularSegmentArea,
  computeRing,
  curveFromChord,
  distanceBetween,
  forward,
  inverse,
  pointInPolygon,
  polygonArea,
  segmentsCross,
  signedArea,
  tessellateCurve,
} from '../src/cogo.js';

const ORIGIN = { easting: 0, northing: 0 };

function point(id: string, easting: number, northing: number): SurveyPoint {
  return {
    id,
    coordinates: { easting, northing },
    provenance: { source: 'measured' },
  };
}

// ---------------------------------------------------------------------------
// Inverse / forward
// ---------------------------------------------------------------------------

test('inverse measures azimuth clockwise from north', () => {
  assert.equal(inverse(ORIGIN, { easting: 0, northing: 10 }).bearing, 0);
  assert.equal(inverse(ORIGIN, { easting: 10, northing: 0 }).bearing, 90);
  assert.equal(inverse(ORIGIN, { easting: 0, northing: -10 }).bearing, 180);
  assert.equal(inverse(ORIGIN, { easting: -10, northing: 0 }).bearing, 270);
});

test('inverse returns a 3-4-5 distance', () => {
  assert.equal(inverse(ORIGIN, { easting: 3, northing: 4 }).distance, 5);
});

test('forward is the exact inverse of inverse', () => {
  const from = { easting: 534821.42, northing: 182934.18 };
  const to = { easting: 534902.57, northing: 182915.33 };

  const { bearing, distance } = inverse(from, to);
  const round = forward(from, bearing, distance);

  assert.ok(Math.abs(round.easting - to.easting) < 1e-9);
  assert.ok(Math.abs(round.northing - to.northing) < 1e-9);
});

// ---------------------------------------------------------------------------
// Polygon measures
// ---------------------------------------------------------------------------

test('polygon area of a 30x20 rectangle is 600', () => {
  const rect = [
    { easting: 0, northing: 0 },
    { easting: 30, northing: 0 },
    { easting: 30, northing: 20 },
    { easting: 0, northing: 20 },
  ];
  assert.equal(polygonArea(rect), 600);
  assert.ok(signedArea(rect) > 0, 'counter-clockwise ring should be positive');
  assert.ok(signedArea([...rect].reverse()) < 0);
});

test('centroid of a rectangle is its middle', () => {
  const c = centroid([
    { easting: 0, northing: 0 },
    { easting: 30, northing: 0 },
    { easting: 30, northing: 20 },
    { easting: 0, northing: 20 },
  ]);
  assert.ok(Math.abs(c.easting - 15) < 1e-9);
  assert.ok(Math.abs(c.northing - 10) < 1e-9);
});

test('centroid falls back to the vertex mean for a degenerate ring', () => {
  const c = centroid([
    { easting: 0, northing: 0 },
    { easting: 10, northing: 0 },
    { easting: 20, northing: 0 },
  ]);
  assert.ok(Math.abs(c.easting - 10) < 1e-9);
  assert.ok(Math.abs(c.northing) < 1e-9);
});

test('point-in-polygon distinguishes inside from outside', () => {
  const square = [
    { easting: 0, northing: 0 },
    { easting: 10, northing: 0 },
    { easting: 10, northing: 10 },
    { easting: 0, northing: 10 },
  ];
  assert.equal(pointInPolygon({ easting: 5, northing: 5 }, square), true);
  assert.equal(pointInPolygon({ easting: 15, northing: 5 }, square), false);
});

test('segmentsCross ignores shared endpoints but catches a real crossing', () => {
  const a1 = { easting: 0, northing: 0 };
  const a2 = { easting: 10, northing: 10 };

  assert.equal(
    segmentsCross(a1, a2, { easting: 0, northing: 10 }, { easting: 10, northing: 0 }),
    true,
  );
  // Two segments meeting at a corner are not a crossing.
  assert.equal(
    segmentsCross(a1, a2, a2, { easting: 20, northing: 0 }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

const SQUARE_POINTS: SurveyPoint[] = [
  point('PT1', 0, 0),
  point('PT2', 30, 0),
  point('PT3', 30, 20),
  point('PT4', 0, 20),
];

function ringOf(segments: BoundaryRing['segments']): BoundaryRing {
  return { id: 'ring_1', segments, closed: true };
}

const SQUARE_RING = ringOf([
  { from: 'PT1', to: 'PT2', provenance: { source: 'measured' } },
  { from: 'PT2', to: 'PT3', provenance: { source: 'measured' } },
  { from: 'PT3', to: 'PT4', provenance: { source: 'measured' } },
  { from: 'PT4', to: 'PT1', provenance: { source: 'measured' } },
]);

test('a coordinate-defined ring closes exactly and reports its area', () => {
  const result = computeRing(SQUARE_RING, SQUARE_POINTS);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.ring.area, 600);
  assert.equal(result.ring.perimeter, 100);
  assert.ok(result.ring.closure.misclosure < 1e-9);
  assert.equal(result.ring.closure.precisionRatio, Infinity);
  assert.equal(result.ring.vertices.length, 4);
});

test('a deed traverse is computed forward from a single known point', () => {
  // Only PT1 has coordinates; every corner comes from bearing and distance.
  const traverse = ringOf([
    { from: 'PT1', to: 'PT2', bearing: 90, distance: 30, provenance: { source: 'measured' } },
    { from: 'PT2', to: 'PT3', bearing: 0, distance: 20, provenance: { source: 'measured' } },
    { from: 'PT3', to: 'PT4', bearing: 270, distance: 30, provenance: { source: 'measured' } },
    { from: 'PT4', to: 'PT1', bearing: 180, distance: 20, provenance: { source: 'measured' } },
  ]);

  const result = computeRing(traverse, [point('PT1', 0, 0)]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.ok(result.ring.closure.misclosure < 1e-9);
  assert.ok(Math.abs(result.ring.area - 600) < 1e-9);
  assert.ok(result.ring.segments.every((s) => s.derivedEndpoint));

  const pt3 = result.ring.segments[2]!.start;
  assert.ok(Math.abs(pt3.easting - 30) < 1e-9);
  assert.ok(Math.abs(pt3.northing - 20) < 1e-9);
});

test('a traverse that does not close reports the gap rather than hiding it', () => {
  // The final leg is 0.4 short, so the traverse ends 0.4 from where it began.
  const traverse = ringOf([
    { from: 'PT1', to: 'PT2', bearing: 90, distance: 30, provenance: { source: 'measured' } },
    { from: 'PT2', to: 'PT3', bearing: 0, distance: 20, provenance: { source: 'measured' } },
    { from: 'PT3', to: 'PT4', bearing: 270, distance: 30, provenance: { source: 'measured' } },
    { from: 'PT4', to: 'PT1', bearing: 180, distance: 19.6, provenance: { source: 'measured' } },
  ]);

  const result = computeRing(traverse, [point('PT1', 0, 0)]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.ok(Math.abs(result.ring.closure.misclosure - 0.4) < 1e-9);
  assert.ok(Math.abs(result.ring.closure.latitude - 0.4) < 1e-9);
  // 99.6 m walked with a 0.4 m gap is roughly 1:249.
  assert.ok(result.ring.closure.precisionRatio < 250);
});

test('a ring whose start point has no coordinates fails with a named subject', () => {
  const result = computeRing(SQUARE_RING, []);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.subjects, ['PT1']);
});

test('a segment with neither endpoint nor bearing fails rather than guessing', () => {
  const result = computeRing(
    ringOf([
      { from: 'PT1', to: 'PT2', bearing: 90, distance: 30, provenance: { source: 'measured' } },
      { from: 'PT2', to: 'PTX', provenance: { source: 'measured' } },
    ]),
    [point('PT1', 0, 0)],
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /neither an endpoint with coordinates nor a bearing/);
});

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

test('curveFromChord derives a semicircle and rejects an impossible chord', () => {
  const semi = curveFromChord(10, 20, 'clockwise');
  assert.ok(semi);
  assert.ok(Math.abs(semi.delta - 180) < 1e-9);
  assert.ok(Math.abs(semi.arcLength - Math.PI * 10) < 1e-9);

  // A chord longer than the diameter cannot lie on the circle.
  assert.equal(curveFromChord(10, 21, 'clockwise'), null);
});

test('the circular segment of a semicircle is half its circle', () => {
  const semi = curveFromChord(10, 20, 'clockwise')!;
  assert.ok(Math.abs(circularSegmentArea(semi) - (Math.PI * 100) / 2) < 1e-9);
});

/**
 * Curve direction is the way the arc turns as you travel it, so which side it
 * bulges depends on the direction of travel. Walking PT2->PT3 northward up the
 * east side, a left-turning (counter-clockwise) arc bulges east, away from the
 * rectangle. These two tests pin that down from both ends: the area correction
 * and the traced geometry have to agree about it.
 */
function bulgedRing(direction: 'clockwise' | 'counter-clockwise') {
  return ringOf([
    { from: 'PT1', to: 'PT2', provenance: { source: 'measured' } },
    {
      from: 'PT2',
      to: 'PT3',
      curve: curveFromChord(10, 20, direction)!,
      provenance: { source: 'measured' },
    },
    { from: 'PT3', to: 'PT4', provenance: { source: 'measured' } },
    { from: 'PT4', to: 'PT1', provenance: { source: 'measured' } },
  ]);
}

test('an outward bulging arc adds its segment area to the ring', () => {
  const result = computeRing(bulgedRing('counter-clockwise'), SQUARE_POINTS);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const expected = 600 + (Math.PI * 100) / 2;
  assert.ok(
    Math.abs(result.ring.area - expected) < 1e-6,
    `expected ${expected}, got ${result.ring.area}`,
  );
});

test('an inward bulging arc subtracts its segment area from the ring', () => {
  const result = computeRing(bulgedRing('clockwise'), SQUARE_POINTS);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const expected = 600 - (Math.PI * 100) / 2;
  assert.ok(
    Math.abs(result.ring.area - expected) < 1e-6,
    `expected ${expected}, got ${result.ring.area}`,
  );
});

test('tessellateCurve traces an arc that starts and ends on its chord', () => {
  const from = { easting: 30, northing: 0 };
  const to = { easting: 30, northing: 20 };
  const centre = { easting: 30, northing: 10 };

  const outward = tessellateCurve(
    from,
    to,
    curveFromChord(10, 20, 'counter-clockwise')!,
    32,
  );

  assert.equal(outward.length, 33);
  assert.ok(distanceBetween(outward[0]!, from) < 1e-6);
  assert.ok(distanceBetween(outward[32]!, to) < 1e-6);

  // Every traced point must sit on the circle of radius 10 about the midpoint.
  for (const p of outward) {
    assert.ok(Math.abs(distanceBetween(p, centre) - 10) < 1e-6);
  }
  assert.ok(outward[16]!.easting > 30, 'left turn should bulge east');

  // The same chord turned the other way must mirror across it.
  const inward = tessellateCurve(from, to, curveFromChord(10, 20, 'clockwise')!, 32);
  assert.ok(inward[16]!.easting < 30, 'right turn should bulge west');
});

test('a right-turning quarter circle puts its centre right of travel', () => {
  // (0,0) -> (10,10) turning right sits on a circle centred at (10,0).
  const points = tessellateCurve(
    { easting: 0, northing: 0 },
    { easting: 10, northing: 10 },
    curveFromChord(10, Math.hypot(10, 10), 'clockwise')!,
    16,
  );
  for (const p of points) {
    assert.ok(
      Math.abs(distanceBetween(p, { easting: 10, northing: 0 }) - 10) < 1e-6,
    );
  }
});
