/**
 * Labelling behaviour, both halves.
 *
 * The templates tests exist to pin invariant I2 of the LabelSpecification
 * contract: survey text is rendered from the model, so a label cannot carry a
 * number the model does not contain.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  LabelSpecification,
  SurveyDataModel,
  SurveyPoint,
} from '@surveyor/contracts';

import { computeRing, type ResolvedRing } from '../src/cogo.js';
import {
  contextFor,
  renderContent,
  availableTemplates,
} from '../src/labeling/templates.js';
import { generateBaseLabels } from '../src/labeling/semantic.js';
import {
  estimateTextWidth,
  orientedBounds,
  placeLabels,
  droppedRequiredLabels,
  worldUnitsPerMm,
} from '../src/labeling/placement.js';

function point(id: string, e: number, n: number): SurveyPoint {
  return { id, coordinates: { easting: e, northing: n }, provenance: { source: 'measured' } };
}

const POINTS = [
  point('PT1', 0, 0),
  point('PT2', 30, 0),
  point('PT3', 30, 20),
  point('PT4', 0, 20),
];

const MODEL: SurveyDataModel = {
  metadata: { jurisdiction: 'generic', siteAddress: '25 High Street' },
  crs: {
    code: 'EPSG:27700',
    name: 'OSGB36 / British National Grid',
    datum: 'OSGB36',
    units: 'metre',
    bearingConvention: 'quadrant',
  },
  points: POINTS,
  boundary: [],
  siteFeatures: [
    {
      id: 'bld_1',
      type: 'building',
      geometry: {
        kind: 'polygon',
        vertices: [
          { easting: 8, northing: 6 },
          { easting: 18, northing: 6 },
          { easting: 18, northing: 13 },
          { easting: 8, northing: 13 },
        ],
      },
      attributes: { name: 'House' },
      provenance: { source: 'measured' },
    },
  ],
  notes: [
    { id: 'note_1', text: 'Boundary subject to deed of easement.', provenance: { source: 'user-confirmed' } },
  ],
};

function ring(): ResolvedRing {
  const result = computeRing(
    {
      id: 'ring_1',
      closed: true,
      segments: [
        { from: 'PT1', to: 'PT2', provenance: { source: 'measured' } },
        { from: 'PT2', to: 'PT3', provenance: { source: 'measured' } },
        { from: 'PT3', to: 'PT4', provenance: { source: 'measured' } },
        { from: 'PT4', to: 'PT1', provenance: { source: 'measured' } },
      ],
    },
    POINTS,
  );
  if (!result.ok) throw new Error(result.reason);
  return result.ring;
}

const RINGS = [ring()];
const CTX = contextFor(MODEL, RINGS);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('a bearing/distance label is rendered from the model, not supplied', () => {
  const result = renderContent(
    {
      mode: 'derived',
      template: 'segment.bearingDistance',
      bindings: { segment: { ref: 'segment:PT1>PT2' } },
    },
    CTX,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  // PT1 -> PT2 runs due east for 30 m.
  assert.equal(result.text, 'N 90°00\'00" E   30.00 m');
});

test('area renders in square metres, with hectares once it is large', () => {
  const small = renderContent(
    { mode: 'derived', template: 'ring.area', bindings: { ring: { ref: 'ring:ring_1' } } },
    CTX,
  );
  assert.equal(small.ok, true);
  if (small.ok) assert.equal(small.text, '600 m²');

  const bigRing: ResolvedRing = { ...RINGS[0]!, area: 25000 };
  const big = renderContent(
    { mode: 'derived', template: 'ring.area', bindings: { ring: { ref: 'ring:ring_1' } } },
    contextFor(MODEL, [bigRing]),
  );
  assert.equal(big.ok, true);
  if (big.ok) assert.match(big.text, /2\.500 ha/);
});

test('feature dimensions come from the drawn polygon', () => {
  const result = renderContent(
    {
      mode: 'derived',
      template: 'feature.dimensions',
      bindings: { feature: { ref: 'feature:bld_1' } },
    },
    CTX,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, '10.00 m × 7.00 m');
});

test('an unresolvable reference fails by name rather than rendering blank', () => {
  const result = renderContent(
    {
      mode: 'derived',
      template: 'segment.bearingDistance',
      bindings: { segment: { ref: 'segment:PT9>PT8' } },
    },
    CTX,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /does not match anything/);
});

test('an unknown template is refused', () => {
  const result = renderContent(
    { mode: 'derived', template: 'segment.vibes', bindings: { segment: { ref: 'segment:PT1>PT2' } } },
    CTX,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Unknown label template/);
});

test('a missing binding is refused before anything is drawn', () => {
  const result = renderContent(
    { mode: 'derived', template: 'segment.bearingDistance', bindings: {} },
    CTX,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /needs a "segment" binding/);
});

test('literal content passes through — this is the free-text path', () => {
  const result = renderContent({ mode: 'literal', text: 'Subject to easement.' }, CTX);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, 'Subject to easement.');
});

test('every registered template declares its bindings', () => {
  for (const template of availableTemplates()) {
    assert.ok(template.bindings.length > 0, `${template.id} declares no bindings`);
    assert.ok(template.description.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Semantic generation
// ---------------------------------------------------------------------------

test('the base label set covers dimensions, corners, area and features', () => {
  const labels = generateBaseLabels({ model: MODEL, rings: RINGS });
  const roles = labels.map((l) => l.role);

  assert.equal(roles.filter((r) => r === 'bearing').length, 4);
  assert.equal(roles.filter((r) => r === 'point-id').length, 4);
  assert.equal(roles.filter((r) => r === 'area').length, 1);
  assert.ok(roles.includes('feature-name'));

  // Coordinates are off by default: they belong in a table, not on the face.
  assert.equal(roles.includes('coordinate'), false);
  // Notes belong to the sheet and are laid out by the Plan Composer. Emitting
  // them here too printed every note twice.
  assert.equal(roles.includes('note'), false);
});

test('every generated label uses derived content', () => {
  const labels = generateBaseLabels({ model: MODEL, rings: RINGS });
  assert.ok(labels.length > 0);
  for (const label of labels) {
    assert.equal(
      label.content.mode,
      'derived',
      `${label.id} (${label.role}) should not carry literal text`,
    );
  }
});

test('boundary dimensions are required, decoration is not', () => {
  const labels = generateBaseLabels({ model: MODEL, rings: RINGS });
  const bearing = labels.find((l) => l.role === 'bearing');
  const area = labels.find((l) => l.role === 'area');

  assert.equal(bearing?.visibility, 'required');
  assert.equal(area?.visibility, 'preferred');
});

test('preferences switch optional label families on and off', () => {
  const labels = generateBaseLabels({
    model: MODEL,
    rings: RINGS,
    preferences: { coordinates: true, area: false },
  });
  assert.ok(labels.some((l) => l.role === 'coordinate'));
  assert.equal(labels.some((l) => l.role === 'area'), false);
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const OPTIONS = { scaleDenominator: 200, textHeightMm: 2.5, clearanceMm: 0.8 };

test('text metrics scale with height and grow with length', () => {
  assert.ok(estimateTextWidth('PT1', 2) > 0);
  assert.ok(estimateTextWidth('PT1', 4) > estimateTextWidth('PT1', 2));
  assert.ok(estimateTextWidth('PT10', 2) > estimateTextWidth('PT1', 2));
});

test('world units per millimetre follow the plan scale', () => {
  // At 1:200, one millimetre of paper is 0.2 m on the ground.
  assert.ok(Math.abs(worldUnitsPerMm(200, 'metre') - 0.2) < 1e-12);
  assert.ok(Math.abs(worldUnitsPerMm(1000, 'metre') - 1) < 1e-12);
});

test('oriented bounds widen as text rotates', () => {
  const flat = orientedBounds({ x: 0, y: 0 }, 10, 2, 0);
  assert.ok(Math.abs(flat.max.x - flat.min.x - 10) < 1e-9);

  const turned = orientedBounds({ x: 0, y: 0 }, 10, 2, 90);
  assert.ok(Math.abs(turned.max.y - turned.min.y - 10) < 1e-9);
});

test('the base label set places without dropping anything required', () => {
  const specs = generateBaseLabels({ model: MODEL, rings: RINGS });
  const result = placeLabels({ specs, ctx: CTX, options: OPTIONS });

  assert.equal(result.unresolved.length, 0);
  assert.equal(droppedRequiredLabels(result).length, 0);
  assert.equal(result.labels.length, specs.length);
});

test('placed labels carry rendered text and a real position', () => {
  const specs = generateBaseLabels({ model: MODEL, rings: RINGS });
  const result = placeLabels({ specs, ctx: CTX, options: OPTIONS });

  const bearing = result.labels.find((l) => l.spec.role === 'bearing');
  assert.ok(bearing);
  assert.match(bearing.text, /\d+\.\d{2} m$/);
  assert.ok(Number.isFinite(bearing.position.x));
  assert.ok(Number.isFinite(bearing.position.y));
});

test('a label along a line is rotated to read with the line', () => {
  const specs = generateBaseLabels({ model: MODEL, rings: RINGS });
  const result = placeLabels({ specs, ctx: CTX, options: OPTIONS });

  // PT1->PT2 runs due east, so its dimension reads horizontally.
  const east = result.labels.find((l) => l.spec.id === 'lbl_ring_1_PT1_PT2');
  assert.ok(east);
  assert.ok(Math.abs(east.rotation) < 1e-9);

  // PT2->PT3 runs due north; upright text turns 90 degrees, never 270.
  const north = result.labels.find((l) => l.spec.id === 'lbl_ring_1_PT2_PT3');
  assert.ok(north);
  assert.ok(Math.abs(north.rotation) <= 90 + 1e-9);
  assert.ok(Math.abs(Math.abs(north.rotation) - 90) < 1e-9);
});

test('no two placed labels overlap', () => {
  const specs = generateBaseLabels({ model: MODEL, rings: RINGS });
  const result = placeLabels({ specs, ctx: CTX, options: OPTIONS });
  const boxes = result.labels
    .filter((l) => l.outcome !== 'dropped')
    .map((l) => l.bounds);

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlaps =
        a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y;
      assert.equal(overlaps, false, `labels ${i} and ${j} overlap`);
    }
  }
});

test('placement is deterministic', () => {
  const specs = generateBaseLabels({ model: MODEL, rings: RINGS });
  const a = placeLabels({ specs, ctx: CTX, options: OPTIONS });
  const b = placeLabels({ specs, ctx: CTX, options: OPTIONS });
  assert.deepEqual(
    a.labels.map((l) => [l.spec.id, l.position, l.rotation, l.outcome]),
    b.labels.map((l) => [l.spec.id, l.position, l.rotation, l.outcome]),
  );
});

test('a label pointing at nothing is reported as unresolved, never guessed', () => {
  const orphan: LabelSpecification = {
    id: 'lbl_orphan',
    subject: { kind: 'point', pointId: 'PT99' },
    role: 'point-id',
    content: {
      mode: 'derived',
      template: 'point.id',
      bindings: { point: { ref: 'point:PT99' } },
    },
    anchor: { relation: 'near' },
    priority: 1,
    visibility: 'required',
    style: { token: 'label.point-id' },
    provenance: { source: 'calculated' },
  };

  const result = placeLabels({ specs: [orphan], ctx: CTX, options: OPTIONS });
  assert.equal(result.labels.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0]!.message, /not in the survey/);
});

test('crowding forces displacement, and drops are reported with a reason', () => {
  // Far more interior labels than there are interior positions: the first few
  // are placed or displaced, and the rest have to be dropped.
  const crowd: LabelSpecification[] = Array.from({ length: 80 }, (_, i) => ({
    id: `lbl_crowd_${i}`,
    subject: { kind: 'ring', ringId: 'ring_1' },
    role: 'area',
    content: {
      mode: 'derived',
      template: 'ring.area',
      bindings: { ring: { ref: 'ring:ring_1' } },
    },
    anchor: { relation: 'inside', preferredOrder: ['inside'] },
    priority: 3,
    visibility: 'optional',
    style: { token: 'label.area' },
    provenance: { source: 'calculated' },
  }));

  const result = placeLabels({ specs: crowd, ctx: CTX, options: OPTIONS });
  const dropped = result.labels.filter((l) => l.outcome === 'dropped');

  assert.ok(dropped.length > 0, 'expected some labels to be dropped');
  for (const label of dropped) {
    assert.ok(label.reason, 'a dropped label must say why');
  }
  assert.ok(result.labels.some((l) => l.outcome === 'displaced' || l.outcome === 'placed'));
});

test('sheet bounds keep labels on the page', () => {
  const specs = generateBaseLabels({ model: MODEL, rings: RINGS });
  const result = placeLabels({
    specs,
    ctx: CTX,
    options: {
      ...OPTIONS,
      sheetBounds: {
        min: { easting: -5, northing: -5 },
        max: { easting: 35, northing: 25 },
      },
    },
  });

  for (const label of result.labels) {
    if (label.outcome === 'dropped') continue;
    assert.ok(label.bounds.min.x >= -5 - 1e-9, `${label.spec.id} ran off the west edge`);
    assert.ok(label.bounds.max.x <= 35 + 1e-9, `${label.spec.id} ran off the east edge`);
    assert.ok(label.bounds.min.y >= -5 - 1e-9);
    assert.ok(label.bounds.max.y <= 25 + 1e-9);
  }
});

test('labels avoid crossing the lines they describe', () => {
  const specs = generateBaseLabels({ model: MODEL, rings: RINGS });
  const obstacles = RINGS[0]!.segments.map((s) => [s.start, s.end]);
  const result = placeLabels({ specs, ctx: CTX, options: { ...OPTIONS, obstacles } });

  for (const label of result.labels) {
    if (label.outcome === 'dropped') continue;
    for (const segment of obstacles) {
      const [a, b] = segment as [{ easting: number; northing: number }, { easting: number; northing: number }];
      const box = label.bounds;
      const inside =
        a.easting > box.min.x && a.easting < box.max.x &&
        a.northing > box.min.y && a.northing < box.max.y;
      assert.equal(inside, false, `${label.spec.id} sits on top of a boundary line`);
    }
  }
});
