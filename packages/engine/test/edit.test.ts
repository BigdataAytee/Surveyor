/**
 * CAD editing operations.
 *
 * These are tested against values worked out by hand rather than against
 * themselves, because the whole claim of this module is that a drawing is
 * geometry and not a picture. A test that asserted an offset was "about right"
 * would be testing the wrong property — a setback line that is 2.999 m from
 * the boundary is a defect, and one that is 3.000001 m from it is a different
 * defect.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Coordinates, SiteFeature } from '@surveyor/contracts';

import { distanceBetween, internalAngles, polygonArea, signedArea } from '../src/cogo.js';
import { buildDrawing } from '../src/drawing.js';
import { dxfToSurvey, looksLikeDxf, parseDxf } from '../src/import/dxf.js';
import {
  displacement,
  mirror,
  mirrorRing,
  polarDisplacement,
  rectangularArray,
  rotate,
  rotatePoint,
  scale,
  scaleFactorFromReference,
  translate,
} from '../src/edit/transform.js';
import {
  closestOnSegment,
  intersectSegments,
  perpendicularFoot,
  polylineIntersections,
} from '../src/edit/intersect.js';
import {
  chamferCorner,
  extendSegment,
  filletCorner,
  joinPolylines,
  offsetPolyline,
  offsetRing,
  splitPolyline,
  trimSegment,
} from '../src/edit/modify.js';
import { SNAP_PRIORITY, constrainToAngle, snap, snapCandidates } from '../src/edit/snap.js';

const at = (easting: number, northing: number): Coordinates => ({ easting, northing });

/** A 30 × 20 rectangle, wound anticlockwise, at a realistic grid origin. */
const RECT: readonly Coordinates[] = [
  at(534800, 182900),
  at(534830, 182900),
  at(534830, 182920),
  at(534800, 182920),
];

function near(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  );
}

function nearPoint(actual: Coordinates, e: number, n: number, tolerance = 1e-9): void {
  near(actual.easting, e, tolerance);
  near(actual.northing, n, tolerance);
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

test('a move preserves every length and the area', () => {
  const moved = translate(RECT, displacement(at(534800, 182900), at(600000, 200000)));

  nearPoint(moved[0]!, 600000, 200000);
  near(polygonArea(moved), polygonArea(RECT));
  for (let i = 0; i + 1 < RECT.length; i += 1) {
    near(distanceBetween(moved[i]!, moved[i + 1]!), distanceBetween(RECT[i]!, RECT[i + 1]!));
  }
});

test('a polar move goes the bearing and distance asked for', () => {
  // Bearings are clockwise from north, so 90° is due east.
  const east = polarDisplacement(90, 25);
  near(east.de, 25);
  near(east.dn, 0, 1e-12);

  const northEast = polarDisplacement(45, Math.SQRT2);
  near(northEast.de, 1, 1e-12);
  near(northEast.dn, 1, 1e-12);
});

test('rotation is clockwise, so 90 degrees sends north to east', () => {
  // The convention has to match bearings, or a 90° rotation and a 90° bearing
  // would point different ways in the same drawing.
  const rotated = rotatePoint(at(0, 10), at(0, 0), 90);
  nearPoint(rotated, 10, 0, 1e-9);
});

test('rotation preserves distances and area', () => {
  const rotated = rotate(RECT, RECT[0]!, 37.5);
  near(polygonArea(rotated), polygonArea(RECT), 1e-6);
  near(distanceBetween(rotated[0]!, rotated[1]!), 30, 1e-9);
});

test('four right-angle rotations return the original exactly enough', () => {
  let shape = RECT;
  for (let i = 0; i < 4; i += 1) shape = rotate(shape, at(534800, 182900), 90);
  for (let i = 0; i < RECT.length; i += 1) {
    near(distanceBetween(shape[i]!, RECT[i]!), 0, 1e-6);
  }
});

test('scaling squares the area, and the reference form finds the factor', () => {
  const scaled = scale(RECT, RECT[0]!, 2);
  near(polygonArea(scaled), polygonArea(RECT) * 4, 1e-6);
  near(distanceBetween(scaled[0]!, scaled[1]!), 60);

  near(scaleFactorFromReference(30, 45) ?? 0, 1.5);
  // A zero reference has no factor; returning Infinity would put NaN geometry
  // into the survey and it would fail somewhere less obvious.
  assert.equal(scaleFactorFromReference(0, 45), null);
});

test('a mirror is its own inverse and preserves lengths', () => {
  const axisA = at(534815, 182800);
  const axisB = at(534815, 183000);

  const once = mirror(RECT, axisA, axisB);
  const twice = mirror(once, axisA, axisB);

  near(distanceBetween(once[0]!, once[1]!), 30);
  for (let i = 0; i < RECT.length; i += 1) nearPoint(twice[i]!, RECT[i]!.easting, RECT[i]!.northing);

  // Reflected across the vertical centre line, the west edge becomes the east.
  near(once[0]!.easting, 534830);
});

test('mirroring a ring keeps the direction it is wound in', () => {
  // Reflection reverses winding, which would flip the sign of the area and
  // turn "outside" into "inside" for every offset taken afterwards.
  const reflected = mirrorRing(RECT, at(534815, 182800), at(534815, 183000));
  assert.equal(Math.sign(signedArea(reflected)), Math.sign(signedArea(RECT)));
  near(polygonArea(reflected), polygonArea(RECT));
});

test('a rectangular array places copies at the spacing given', () => {
  const copies = rectangularArray([at(0, 0)], {
    rows: 2,
    columns: 3,
    rowSpacing: 5,
    columnSpacing: 10,
  });

  assert.equal(copies.length, 6);
  nearPoint(copies[0]![0]!, 0, 0);
  nearPoint(copies[2]![0]!, 20, 0, 1e-9);
  // Columns run east, rows north — the same convention as a CAD array.
  nearPoint(copies[3]![0]!, 0, 5, 1e-9);
});

// ---------------------------------------------------------------------------
// Intersection
// ---------------------------------------------------------------------------

test('two crossing segments meet where they should', () => {
  const hit = intersectSegments(at(0, 0), at(10, 10), at(0, 10), at(10, 0));
  assert.ok(hit);
  nearPoint(hit.at, 5, 5);
  assert.equal(hit.onBoth, true);
});

test('a crossing beyond the drawn ends is reported but not "on both"', () => {
  // This is the whole difference between Trim and Extend, so it has to be
  // reported rather than collapsed into "no intersection".
  const hit = intersectSegments(at(0, 0), at(1, 0), at(5, -5), at(5, 5));
  assert.ok(hit);
  nearPoint(hit.at, 5, 0);
  assert.equal(hit.onBoth, false);
  assert.ok(hit.t > 1);
});

test('parallel and collinear segments have no single intersection', () => {
  assert.equal(intersectSegments(at(0, 0), at(10, 0), at(0, 5), at(10, 5)), null);
  assert.equal(intersectSegments(at(0, 0), at(10, 0), at(20, 0), at(30, 0)), null);
});

test('the closest point on a segment is clamped to it', () => {
  const before = closestOnSegment(at(-5, 3), at(0, 0), at(10, 0));
  nearPoint(before.at, 0, 0);
  near(before.distance, Math.hypot(5, 3));

  const middle = closestOnSegment(at(4, 3), at(0, 0), at(10, 0));
  nearPoint(middle.at, 4, 0);
  near(middle.distance, 3);
});

test('the perpendicular foot is not clamped, because the perpendicular is not', () => {
  // Snapping perpendicular to a short wall must be able to land past its end;
  // clamping would quietly turn it into an endpoint snap and the line drawn
  // would not be perpendicular to anything.
  const foot = perpendicularFoot(at(20, 5), at(0, 0), at(10, 0));
  assert.ok(foot);
  nearPoint(foot, 20, 0);
});

test('polyline intersections find every real crossing', () => {
  const crossings = polylineIntersections(
    [at(0, 0), at(10, 0), at(10, 10)],
    [at(5, -5), at(5, 5), at(15, 5)],
  );
  assert.equal(crossings.length, 2);
});

// ---------------------------------------------------------------------------
// Offset
// ---------------------------------------------------------------------------

test('an offset line is exactly the distance away, everywhere along it', () => {
  const offset = offsetPolyline([at(0, 0), at(100, 0)], 3);
  assert.ok(offset);
  near(offset[0]!.northing, 3);
  near(offset[1]!.northing, 3);
});

test('a mitred corner keeps the offset distance on both legs', () => {
  // The property that makes a setback line a setback line: measure
  // perpendicular from anywhere on the boundary and you get the same number.
  const offset = offsetPolyline([at(0, 0), at(10, 0), at(10, 10)], 2);
  assert.ok(offset);
  assert.equal(offset.length, 3);

  near(closestOnSegment(offset[1]!, at(0, 0), at(10, 0)).distance, 2, 1e-9);
  near(closestOnSegment(offset[1]!, at(10, 0), at(10, 10)).distance, 2, 1e-9);
});

test('a ring offset outward grows, and inward shrinks, by the right amount', () => {
  const outward = offsetRing(RECT, 5);
  const inward = offsetRing(RECT, -5);
  assert.ok(outward);
  assert.ok(inward);

  // 30 × 20 grown by 5 on every side is 40 × 30; shrunk by 5 is 20 × 10.
  near(polygonArea(outward), 40 * 30, 1e-6);
  near(polygonArea(inward), 20 * 10, 1e-6);
});

test('an offset ring keeps its winding, so its area stays positive', () => {
  const offset = offsetRing(RECT, -3);
  assert.ok(offset);
  assert.equal(Math.sign(signedArea(offset)), Math.sign(signedArea(RECT)));
});

test('a sharp corner is cut rather than grown into a spike', () => {
  // The exact miter of a near-doubled-back corner is enormous. A 400 m spike
  // off a 10 m fence is worse than a cut corner, so the limit applies.
  const offset = offsetPolyline([at(0, 0), at(10, 0), at(0, 0.5)], 2, 4);
  assert.ok(offset);
  for (const vertex of offset) {
    assert.ok(distanceBetween(vertex, at(10, 0)) < 100, 'a miter spike escaped the limit');
  }
});

// ---------------------------------------------------------------------------
// Trim and extend
// ---------------------------------------------------------------------------

test('trim cuts back to the crossing, keeping the end asked for', () => {
  const keepStart = trimSegment(at(0, 0), at(10, 0), at(4, -5), at(4, 5), 'start');
  assert.ok(keepStart);
  nearPoint(keepStart.from, 0, 0);
  nearPoint(keepStart.to, 4, 0);

  const keepEnd = trimSegment(at(0, 0), at(10, 0), at(4, -5), at(4, 5), 'end');
  assert.ok(keepEnd);
  nearPoint(keepEnd.from, 4, 0);
  nearPoint(keepEnd.to, 10, 0);
});

test('trimming to something the line misses is refused, not ignored', () => {
  // Returning the line unchanged would look like the tool had worked.
  assert.equal(trimSegment(at(0, 0), at(10, 0), at(20, -5), at(20, 5)), null);
});

test('extend lengthens to the target, and only forwards', () => {
  const extended = extendSegment(at(0, 0), at(10, 0), at(20, -5), at(20, 5), 'end');
  assert.ok(extended);
  nearPoint(extended.to, 20, 0);

  // The crossing is behind the start, so extending the end cannot reach it.
  assert.equal(extendSegment(at(0, 0), at(10, 0), at(-5, -5), at(-5, 5), 'end'), null);
});

test('extend refuses a target the line would miss as drawn', () => {
  // The crossing is on the target's imaginary continuation, and you cannot
  // extend a line to a wall that is not there.
  assert.equal(extendSegment(at(0, 0), at(10, 0), at(20, 5), at(20, 15), 'end'), null);
});

// ---------------------------------------------------------------------------
// Fillet and chamfer
// ---------------------------------------------------------------------------

test('a chamfer cuts the setbacks asked for', () => {
  const chamfer = chamferCorner(at(0, 10), at(0, 0), at(10, 0), 3, 4);
  assert.ok(chamfer);
  nearPoint(chamfer[0], 0, 3);
  nearPoint(chamfer[1], 4, 0);
});

test('a chamfer longer than its leg is refused rather than trimmed to fit', () => {
  // Fitting it would produce a dimension the surveyor did not ask for.
  assert.equal(chamferCorner(at(0, 10), at(0, 0), at(10, 0), 20), null);
});

test('a fillet is tangent to both legs at the radius given', () => {
  const fillet = filletCorner(at(0, 10), at(0, 0), at(10, 0), 3);
  assert.ok(fillet);

  // A right-angled corner: tangent length equals the radius, and the centre
  // sits at (r, r) from the corner.
  nearPoint(fillet.start, 0, 3);
  nearPoint(fillet.end, 3, 0);
  nearPoint(fillet.centre, 3, 3);
  near(distanceBetween(fillet.centre, fillet.start), 3);
  near(distanceBetween(fillet.centre, fillet.end), 3);
});

test('a fillet too big for the corner is refused', () => {
  assert.equal(filletCorner(at(0, 10), at(0, 0), at(10, 0), 50), null);
  // And a straight "corner" has no arc that fits it.
  assert.equal(filletCorner(at(-10, 0), at(0, 0), at(10, 0), 1), null);
});

// ---------------------------------------------------------------------------
// Join and split
// ---------------------------------------------------------------------------

test('join connects two lines that share an end, reversing where needed', () => {
  const joined = joinPolylines([at(0, 0), at(10, 0)], [at(20, 0), at(10, 0)]);
  assert.ok(joined);
  assert.equal(joined.length, 3);
  nearPoint(joined[2]!, 20, 0);
});

test('join refuses lines that do not meet', () => {
  // Joining them would invent a segment, and an invented segment is
  // indistinguishable from a measured one once it is in the drawing.
  assert.equal(joinPolylines([at(0, 0), at(10, 0)], [at(20, 0), at(30, 0)]), null);
});

test('split cuts a polyline in two at a point on it', () => {
  const halves = splitPolyline([at(0, 0), at(10, 0), at(10, 10)], at(10, 4));
  assert.ok(halves);
  const [head, tail] = halves;
  nearPoint(head[head.length - 1]!, 10, 4);
  nearPoint(tail[0]!, 10, 4);
  assert.equal(head.length + tail.length, 5);
});

test('split refuses a point that is not on the line', () => {
  assert.equal(splitPolyline([at(0, 0), at(10, 0)], at(5, 5)), null);
});

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

const TARGETS = [{ id: 'ring_1', vertices: RECT, closed: true }];

test('a snap lands on the exact coordinate, not near it', () => {
  // The point of the whole module: a click 40 cm from a corner must produce
  // the corner's own values, or the area comes out wrong and nothing says why.
  const result = snap(at(534800.4, 182900.3), TARGETS, { tolerance: 1 });
  assert.ok(result);
  assert.equal(result.kind, 'endpoint');
  assert.equal(result.at.easting, 534800);
  assert.equal(result.at.northing, 182900);
  assert.equal(result.ownerId, 'ring_1');
});

test('an endpoint beats a nearer point on the edge', () => {
  // Reaching for a line near its end almost always means the end, and a
  // surveyor whose corner snap loses to the edge stops trusting snapping.
  const result = snap(at(534800.5, 182900.05), TARGETS, { tolerance: 2 });
  assert.equal(result?.kind, 'endpoint');
});

test('the midpoint of an edge is offered where it is', () => {
  const result = snap(at(534815, 182900.2), TARGETS, {
    tolerance: 1,
    enabled: { nearest: false },
  });
  assert.equal(result?.kind, 'midpoint');
  nearPoint(result!.at, 534815, 182900);
});

test('nothing in range snaps to nothing, rather than to the nearest thing', () => {
  // The caller has to know whether the point it is about to commit is exact
  // geometry or a click; silently returning the closest object would remove
  // that distinction.
  assert.equal(snap(at(534700, 182800), TARGETS, { tolerance: 1 }), null);
});

test('a crossing between two objects is snappable', () => {
  const fence = { id: 'fence_1', vertices: [at(534790, 182910), at(534840, 182910)], closed: false };
  const result = snap(at(534800.2, 182910.1), [...TARGETS, fence], {
    tolerance: 0.5,
    enabled: { endpoint: false, nearest: false, midpoint: false },
  });
  assert.equal(result?.kind, 'intersection');
  nearPoint(result!.at, 534800, 182910);
});

test('the grid snap rounds to the spacing', () => {
  const result = snap(at(534801.2, 182903.4), [], { tolerance: 5, gridSpacing: 5 });
  assert.equal(result?.kind, 'grid');
  nearPoint(result!.at, 534800, 182905);
});

test('alternatives are offered in priority order, for cycling', () => {
  const candidates = snapCandidates(at(534800.2, 182900.2), TARGETS, { tolerance: 2 });
  assert.ok(candidates.length > 1);
  assert.equal(candidates[0]?.kind, 'endpoint');

  // Priority never decreases down the list, so Tab always steps to something
  // less specific rather than jumping about.
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(
      SNAP_PRIORITY[candidates[i]!.kind] >= SNAP_PRIORITY[candidates[i - 1]!.kind],
      `${candidates[i - 1]!.kind} then ${candidates[i]!.kind} is out of order`,
    );
  }
});

test('ortho holds a line square while its length is chosen', () => {
  // 20 m of drift off-axis must not shorten the line — the surveyor is
  // choosing a length by eye, and a projection would fight them.
  const constrained = constrainToAngle(at(0, 0), at(100, 20), 90);
  near(constrained.northing, 0, 1e-9);
  near(distanceBetween(at(0, 0), constrained), Math.hypot(100, 20), 1e-9);
});

test('polar tracking snaps to any step, including 45 degrees', () => {
  const constrained = constrainToAngle(at(0, 0), at(10, 9), 45);
  near(constrained.easting, constrained.northing, 1e-9);
});

// ---------------------------------------------------------------------------
// Drawing entities
// ---------------------------------------------------------------------------

/** A drawing of nothing but the features given, for testing how they render. */
function drawingOf(features: readonly SiteFeature[]) {
  return buildDrawing({
    model: {
      metadata: { jurisdiction: 'generic' },
      crs: {
        code: 'EPSG:27700',
        name: 'OSGB36 / British National Grid',
        datum: 'OSGB36',
        units: 'metre',
        bearingConvention: 'quadrant',
      },
      points: [],
      boundary: [],
      siteFeatures: features,
      notes: [],
    },
    rings: [],
  });
}

test('a circle is drawn round, closed, and at its real radius', () => {
  // Stored as centre and radius, tessellated only to draw it — so the spread
  // of a tree canopy stays a number the drawing knows rather than one you
  // measure off it.
  const drawing = drawingOf([
      {
        id: 'tree_1',
        type: 'tree',
        geometry: { kind: 'circle', centre: at(534810, 182910), radius: 3 },
        attributes: { name: 'Oak' },
        provenance: { source: 'measured' },
      },
  ]);

  const element = drawing.layers
    .flatMap((layer) => layer.elements)
    .find((candidate) => candidate.id === 'tree_1');

  assert.ok(element);
  assert.equal(element.kind, 'polygon');
  if (element.kind !== 'polygon') return;

  for (const vertex of element.points) {
    near(distanceBetween(vertex, at(534810, 182910)), 3, 1e-9);
  }
  // Round enough that the chord error is finer than any plan scale can show.
  assert.ok(element.points.length >= 32);
});

test('an arc runs between the bearings it was given, the short way round', () => {
  const drawing = drawingOf([
      {
        id: 'arc_1',
        type: 'access',
        geometry: {
          kind: 'arc',
          centre: at(0, 0),
          radius: 10,
          startBearing: 0,
          endBearing: 90,
        },
        attributes: {},
        provenance: { source: 'measured' },
      },
  ]);

  const element = drawing.layers
    .flatMap((layer) => layer.elements)
    .find((candidate) => candidate.id === 'arc_1');
  assert.ok(element);
  if (element.kind === 'symbol') return;

  // Bearing 0 is due north, 90 due east — the same convention as everywhere.
  nearPoint(element.points[0]!, 0, 10, 1e-9);
  nearPoint(element.points[element.points.length - 1]!, 10, 0, 1e-9);
  for (const vertex of element.points) near(distanceBetween(vertex, at(0, 0)), 10, 1e-9);
});

test('every feature kind has a stroke style, so none is drawn as an unexplained line', () => {
  // The compiler enforces this too; the test states why it matters.
  for (const kind of [
    'building', 'road', 'driveway', 'fence', 'wall', 'gate', 'access',
    'water', 'vegetation', 'tree', 'utility', 'easement', 'level',
    'benchmark', 'annotation', 'other',
  ] as const) {
    const drawing = drawingOf([
      {
        id: `f_${kind}`,
        type: kind,
        geometry: { kind: 'point', at: at(0, 0) },
        attributes: {},
        provenance: { source: 'measured' },
      },
    ]);
    const element = drawing.layers
      .flatMap((layer) => layer.elements)
      .find((candidate) => candidate.id === `f_${kind}`);
    assert.ok(element, `${kind} was not drawn at all`);
  }
});

// ---------------------------------------------------------------------------
// Internal angles
// ---------------------------------------------------------------------------

test('the internal angles of a rectangle are four right angles', () => {
  const angles = internalAngles(RECT);
  assert.equal(angles.length, 4);
  for (const angle of angles) near(angle.degrees, 90, 1e-9);
});

test('internal angles sum to (n − 2) × 180, whatever the shape', () => {
  // The check a surveyor would run by hand, and it holds for any simple
  // polygon — convex or not — which is why it is the property worth testing
  // rather than a list of expected values.
  const shapes: readonly (readonly Coordinates[])[] = [
    RECT,
    [at(0, 0), at(10, 0), at(10, 10)],
    // An L, so one corner is reflex.
    [at(0, 0), at(20, 0), at(20, 8), at(8, 8), at(8, 20), at(0, 20)],
    [at(0, 0), at(15, 2), at(18, 11), at(7, 16), at(-2, 9)],
  ];

  for (const shape of shapes) {
    const total = internalAngles(shape).reduce((sum, angle) => sum + angle.degrees, 0);
    near(total, (shape.length - 2) * 180, 1e-6);
  }
});

test('a reflex corner is reported as reflex, not folded back under 180', () => {
  // The inside of an L really is more than a straight line at the notch, and
  // reporting 90° there would put a figure on the plan that contradicts the
  // drawing it sits on.
  const ell = [at(0, 0), at(20, 0), at(20, 8), at(8, 8), at(8, 20), at(0, 20)];
  const angles = internalAngles(ell);
  const reflex = angles.filter((angle) => angle.degrees > 180);
  assert.equal(reflex.length, 1);
  near(reflex[0]!.degrees, 270, 1e-9);
});

test('winding does not change the angles, because it does not change the ground', () => {
  const clockwise = [...RECT].reverse();
  const a = internalAngles(RECT).map((angle) => angle.degrees);
  const b = internalAngles(clockwise).map((angle) => angle.degrees);

  near(a.reduce((x, y) => x + y, 0), b.reduce((x, y) => x + y, 0), 1e-9);
  for (const angle of b) near(angle, 90, 1e-9);
});

test('a repeated closing vertex does not produce a zero-length leg', () => {
  const closed = [...RECT, RECT[0]!];
  assert.equal(internalAngles(closed).length, 4);
});

// ---------------------------------------------------------------------------
// DXF import
// ---------------------------------------------------------------------------

test('a DXF this app exported can be read back', () => {
  // The round trip is the point: an export nothing can read is a one-way door,
  // and a surveyor who sends a drawing out cannot take corrections back.
  const dxf = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '8', 'BOUNDARY', '90', '4', '70', '1',
    '10', '534800.0', '20', '182900.0',
    '10', '534830.0', '20', '182900.0',
    '10', '534830.0', '20', '182920.0',
    '10', '534800.0', '20', '182920.0',
    '0', 'POINT', '8', 'POINTS', '10', '534810.0', '20', '182910.0', '30', '45.2',
    '0', 'CIRCLE', '8', 'TREES', '10', '534820.0', '20', '182915.0', '40', '3.0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');

  const document = parseDxf(dxf);
  assert.equal(document.problems.length, 0);
  assert.equal(document.entities.length, 3);

  const survey = dxfToSurvey(document);
  assert.equal(survey.points.length, 1);
  nearPoint(survey.points[0]!.coordinates, 534810, 182910);
  assert.equal(survey.points[0]!.coordinates.elevation, 45.2);

  // The closed polyline is offered as the boundary candidate.
  assert.equal(survey.rings.length, 1);
  assert.equal(survey.rings[0]!.length, 4);
  near(polygonArea(survey.rings[0]!), 600, 1e-6);
});

test('a circle keeps its radius through the import', () => {
  const dxf = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'CIRCLE', '8', '0', '10', '10.0', '20', '20.0', '40', '4.5',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');

  const circle = parseDxf(dxf).entities[0];
  assert.equal(circle?.kind, 'circle');
  assert.equal(circle?.radius, 4.5);
});

test('an open polyline is not offered as a boundary', () => {
  // A boundary that does not close is not a boundary, and importing one as if
  // it were would produce an area for a shape that has no inside.
  const dxf = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '8', 'FENCE', '90', '3', '70', '0',
    '10', '0.0', '20', '0.0',
    '10', '10.0', '20', '0.0',
    '10', '10.0', '20', '10.0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');

  const survey = dxfToSurvey(parseDxf(dxf));
  assert.equal(survey.rings.length, 0);
});

test('a file with no geometry says so rather than importing an empty survey', () => {
  // An empty survey looks like a successful import of a site with nothing on
  // it, which is the one outcome the user cannot tell from a failure.
  const empty = parseDxf(['0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF'].join('\n'));
  assert.equal(empty.entities.length, 0);
  assert.match(empty.problems[0]?.message ?? '', /no points, lines or polylines/);

  const notDxf = parseDxf('this is a text file, not a drawing');
  assert.match(notDxf.problems[0]?.message ?? '', /no ENTITIES section/);
});

test('windows line endings and stray whitespace do not break it', () => {
  // A file that has been through an editor, a mail client and a zip is still
  // one the surveyor expects to open.
  const dxf = [
    ' 0 ', 'SECTION', '  2', 'ENTITIES',
    '0', 'POINT', '8', '0', ' 10 ', ' 5.0 ', '20', '7.0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');

  const point = parseDxf(dxf).entities[0];
  assert.equal(point?.kind, 'point');
  nearPoint(point!.vertices[0]!, 5, 7);
});

test('a drawing is told apart from a table before either is read', () => {
  // The distinction that matters: a DXF put through the table extractor does
  // not fail, it succeeds — on group codes — and builds a survey of nonsense.
  assert.equal(looksLikeDxf('0\nSECTION\n2\nENTITIES\n'), true);
  assert.equal(looksLikeDxf('  0 \r\n SECTION \r\n'), true);

  assert.equal(looksLikeDxf('PT1, 534800.00, 182900.00\nPT2, 534850.00, 182900.00'), false);
  assert.equal(looksLikeDxf(''), false);
  // A table whose first cell happens to be zero is still a table.
  assert.equal(looksLikeDxf('0\t534800.00\t182900.00'), false);
  // "SECTION" as a column heading, not as a DXF opening pair.
  assert.equal(looksLikeDxf('SECTION, EASTING, NORTHING'), false);
});
