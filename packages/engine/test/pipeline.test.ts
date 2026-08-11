/**
 * End-to-end pipeline, composition and export.
 *
 * The fixture is the worked example from the architecture document: a small
 * rectangular parcel with a house on it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  LabelSpecification,
  PipelineStage,
  StageEvent,
  SurveyDataModel,
} from '@surveyor/contracts';

import { runPipeline, UI_STAGES } from '../src/pipeline.js';
import { composePlan } from '../src/compose/composer.js';
import { buildDrawing } from '../src/drawing.js';
import { computeRing } from '../src/cogo.js';
import { generateBaseLabels } from '../src/labeling/semantic.js';
import { planToSvg } from '../src/export/svg.js';
import { planToDxf } from '../src/export/dxf.js';
import { planToPdf, escapePdfString } from '../src/export/pdf.js';
import {
  parsePointTable,
  parseTraverse,
  ringFromPointOrder,
  buildModel,
} from '../src/input.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CRS = {
  code: 'EPSG:27700',
  name: 'OSGB36 / British National Grid',
  datum: 'OSGB36',
  units: 'metre' as const,
  bearingConvention: 'quadrant' as const,
};

function model(overrides: Partial<SurveyDataModel> = {}): SurveyDataModel {
  return {
    metadata: {
      jurisdiction: 'uk-land-registry',
      siteAddress: '25 High Street',
      client: 'A. Client',
      jobNumber: 'J-1042',
      surveyor: 'R. Surveyor',
      date: '2026-08-10',
    },
    crs: CRS,
    points: [
      { id: 'PT1', coordinates: { easting: 534800, northing: 182900 }, provenance: { source: 'measured' } },
      { id: 'PT2', coordinates: { easting: 534830, northing: 182900 }, provenance: { source: 'measured' } },
      { id: 'PT3', coordinates: { easting: 534830, northing: 182920 }, provenance: { source: 'measured' } },
      { id: 'PT4', coordinates: { easting: 534800, northing: 182920 }, provenance: { source: 'measured' } },
    ],
    boundary: [ringFromPointOrder('ring_1', ['PT1', 'PT2', 'PT3', 'PT4'])],
    siteFeatures: [
      {
        id: 'bld_1',
        type: 'building',
        geometry: {
          kind: 'polygon',
          vertices: [
            { easting: 534808, northing: 182906 },
            { easting: 534818, northing: 182906 },
            { easting: 534818, northing: 182913 },
            { easting: 534808, northing: 182913 },
          ],
        },
        attributes: { name: 'House' },
        provenance: { source: 'measured' },
      },
    ],
    notes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

test('the pipeline runs end to end and produces a plan', () => {
  const result = runPipeline(model());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.rings.length, 1);
  assert.equal(result.rings[0]?.area, 600);
  assert.equal(result.validation.status, 'ready');
  assert.ok(result.plan.labels.length > 0);
  assert.equal(result.plan.jurisdiction.id, 'uk-land-registry');
});

test('stage events are emitted in pipeline order, active before complete', () => {
  const events: StageEvent[] = [];
  const result = runPipeline(model(), { onStage: (e) => events.push(e) });
  assert.equal(result.ok, true);

  const completed = events.filter((e) => e.state === 'complete').map((e) => e.stage);
  assert.deepEqual(completed, UI_STAGES as PipelineStage[]);

  for (const stage of UI_STAGES) {
    const activeAt = events.findIndex((e) => e.stage === stage && e.state === 'active');
    const doneAt = events.findIndex((e) => e.stage === stage && e.state === 'complete');
    assert.ok(activeAt >= 0, `${stage} never went active`);
    assert.ok(doneAt > activeAt, `${stage} completed before it started`);
  }
  // Every event carries copy a novice can read (B.8).
  assert.ok(events.every((e) => e.message.length > 0));
});

test('an undetermined CRS halts the pipeline with a question', () => {
  const result = runPipeline(
    model({
      crs: { datum: '', name: '', units: 'metre', bearingConvention: 'quadrant' },
    }),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failedAt, 'crs');
  assert.match(result.message, /coordinate system/i);
  assert.ok(result.crs);
});

test('a failing closure stops before drawing and hands back the issues', () => {
  const broken = model({
    points: [
      { id: 'PT1', coordinates: { easting: 534800, northing: 182900 }, provenance: { source: 'measured' } },
    ],
    boundary: [
      {
        id: 'ring_1',
        closed: true,
        segments: [
          { from: 'PT1', to: 'PT2', bearing: 90, distance: 30, provenance: { source: 'measured' } },
          { from: 'PT2', to: 'PT3', bearing: 0, distance: 20, provenance: { source: 'measured' } },
          { from: 'PT3', to: 'PT4', bearing: 270, distance: 30, provenance: { source: 'measured' } },
          { from: 'PT4', to: 'PT1', bearing: 180, distance: 18.5, provenance: { source: 'measured' } },
        ],
      },
    ],
    siteFeatures: [],
  });

  const result = runPipeline(broken);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failedAt, 'validation');
  assert.equal(result.validation?.status, 'error');
  // The geometry so far is still returned, so the canvas can show the problem.
  assert.ok(result.drawing);
});

// ---------------------------------------------------------------------------
// The export gate
// ---------------------------------------------------------------------------

test('composition refuses while an AI suggestion is unconfirmed', () => {
  const m = model();
  const ring = computeRing(m.boundary[0]!, m.points);
  assert.equal(ring.ok, true);
  if (!ring.ok) return;

  const suggestion: LabelSpecification = {
    id: 'lbl_ai_1',
    subject: { kind: 'feature', featureId: 'bld_1' },
    role: 'feature-name',
    content: { mode: 'literal', text: 'Proposed garage' },
    anchor: { relation: 'inside' },
    priority: 2,
    visibility: 'preferred',
    style: { token: 'label.feature' },
    provenance: { source: 'ai-suggested' },
  };

  const result = composePlan({
    model: m,
    rings: [ring.ring],
    drawing: buildDrawing({ model: m, rings: [ring.ring] }),
    specs: [...generateBaseLabels({ model: m, rings: [ring.ring] }), suggestion],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'unconfirmed-labels');
  assert.deepEqual(result.blocking.map((s) => s.id), ['lbl_ai_1']);
  assert.match(result.message, /confirmation/);
});

test('the same plan composes once the suggestion is confirmed', () => {
  const m = model();
  const ring = computeRing(m.boundary[0]!, m.points);
  if (!ring.ok) throw new Error(ring.reason);

  const confirmed: LabelSpecification = {
    id: 'lbl_ai_1',
    subject: { kind: 'feature', featureId: 'bld_1' },
    role: 'feature-name',
    content: { mode: 'literal', text: 'Proposed garage' },
    anchor: { relation: 'inside' },
    priority: 2,
    visibility: 'preferred',
    style: { token: 'label.feature' },
    provenance: {
      source: 'user-confirmed',
      confirmedBy: { actorId: 'user_1' },
      confirmedAt: '2026-08-10T12:00:00Z',
    },
  };

  const result = composePlan({
    model: m,
    rings: [ring.ring],
    drawing: buildDrawing({ model: m, rings: [ring.ring] }),
    specs: [...generateBaseLabels({ model: m, rings: [ring.ring] }), confirmed],
  });

  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test('the composer picks a sheet and scale that fit the survey', () => {
  const result = runPipeline(model());
  if (!result.ok) throw new Error(result.message);

  assert.ok(['A4', 'A3'].includes(result.plan.sheet.id));
  assert.ok(result.plan.transform.scaleDenominator >= 50);

  // Every drawn point must land inside the sheet.
  for (const layer of result.plan.drawing.layers) {
    for (const element of layer.elements) {
      const points = element.kind === 'symbol' ? [element.at] : element.points;
      for (const c of points) {
        const x =
          result.plan.transform.frame.xMm +
          result.plan.transform.frame.widthMm / 2 +
          (c.easting - result.plan.transform.worldCentre.easting) /
            result.plan.transform.worldPerMm;
        assert.ok(x >= 0 && x <= result.plan.sheet.widthMm, 'geometry ran off the sheet');
      }
    }
  }
});

test('the jurisdiction template drives the title block and notes', () => {
  const uk = runPipeline(model());
  if (!uk.ok) throw new Error(uk.message);

  assert.ok(uk.plan.titleBlock.some((f) => f.label === 'Property'));
  assert.equal(uk.plan.titleBlock.find((f) => f.label === 'Scale')?.value.startsWith('1:'), true);
  assert.equal(uk.plan.titleBlock.find((f) => f.label === 'Sheet')?.value, uk.plan.sheet.id);
  assert.ok(uk.plan.notes.some((n) => /Land Registry|identification purposes/.test(n)));

  const us = runPipeline(model({ metadata: { ...model().metadata, jurisdiction: 'us-generic' } }));
  if (!us.ok) throw new Error(us.message);

  assert.ok(us.plan.titleBlock.some((f) => f.label === 'Basis of bearings'));
  assert.notDeepEqual(
    uk.plan.titleBlock.map((f) => f.label),
    us.plan.titleBlock.map((f) => f.label),
  );
});

test('an unknown jurisdiction falls back but says so', () => {
  const result = runPipeline(
    model({ metadata: { ...model().metadata, jurisdiction: 'atlantis' } }),
  );
  if (!result.ok) throw new Error(result.message);

  assert.equal(result.plan.template.substituted, true);
  assert.ok(result.warnings.some((w) => /generic/.test(w)));
});

test('a missing required title block field is marked rather than invented', () => {
  const result = runPipeline(
    model({ metadata: { jurisdiction: 'uk-land-registry', siteAddress: '25 High Street' } }),
  );
  if (!result.ok) throw new Error(result.message);

  const client = result.plan.titleBlock.find((f) => f.label === 'Client');
  assert.ok(client);
  assert.equal(client.missing, true);
  assert.equal(client.value, '');
});

test('the legend lists only the styles actually drawn', () => {
  const result = runPipeline(model());
  if (!result.ok) throw new Error(result.message);

  const styles = result.plan.legend.map((e) => e.style);
  assert.ok(styles.includes('boundary'));
  assert.ok(styles.includes('building'));
  assert.equal(styles.includes('water'), false);
});

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

test('SVG export is well formed and carries the geometry and labels', () => {
  const result = runPipeline(model());
  if (!result.ok) throw new Error(result.message);

  const svg = planToSvg(result.plan);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.match(svg, /width="\d+mm"/);
  assert.ok((svg.match(/<polyline/g) ?? []).length >= 4, 'boundary lines missing');
  assert.ok(svg.includes('<text'), 'labels missing');
  assert.ok(svg.includes('id="north-arrow"'));
  assert.ok(svg.includes('id="title-block"'));

  // Every tag that opens a group closes it.
  assert.equal((svg.match(/<g\b/g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length);
});

test('SVG escapes text rather than letting it break the document', () => {
  const result = runPipeline(
    model({
      notes: [
        { id: 'n1', text: 'Fence <north> & "east" side', provenance: { source: 'user-confirmed' } },
      ],
    }),
  );
  if (!result.ok) throw new Error(result.message);

  const svg = planToSvg(result.plan);
  assert.ok(svg.includes('&lt;north&gt; &amp;'));
  assert.equal(svg.includes('<north>'), false);
});

test('DXF export declares its layers and writes geometry in survey coordinates', () => {
  const result = runPipeline(model());
  if (!result.ok) throw new Error(result.message);

  const dxf = planToDxf(result.plan);
  assert.ok(dxf.includes('SECTION'));
  assert.ok(dxf.includes('AC1009'));
  assert.ok(dxf.trimEnd().endsWith('EOF'));
  assert.ok(dxf.includes('BOUNDARY'));
  assert.ok(dxf.includes('LABELS'));

  // Real eastings, not sheet millimetres.
  assert.ok(dxf.includes('534800'));
  assert.equal((dxf.match(/\nLINE\n/g) ?? []).length >= 4, true);
});

test('PDF export produces a loadable document with a correct xref', () => {
  const result = runPipeline(model());
  if (!result.ok) throw new Error(result.message);

  const bytes = planToPdf(result.plan);
  const text = Buffer.from(bytes).toString('latin1');

  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.ok(text.includes('/Type /Catalog'));
  assert.ok(text.includes('/BaseFont /Helvetica'));

  // The startxref offset must actually point at the xref table.
  const startxref = /startxref\n(\d+)\n/.exec(text);
  assert.ok(startxref, 'no startxref');
  const offset = Number(startxref[1]);
  assert.equal(text.slice(offset, offset + 4), 'xref');

  // Each object offset must point at that object's header.
  const rows = text.slice(offset).split('\n').slice(2);
  for (let i = 0; i < 5; i += 1) {
    const row = rows[i];
    if (!row || !/^\d{10} \d{5} n/.test(row)) break;
    const objectOffset = Number(row.slice(0, 10));
    assert.equal(
      text.slice(objectOffset, objectOffset + `${i + 1} 0 obj`.length),
      `${i + 1} 0 obj`,
      `object ${i + 1} offset is wrong`,
    );
  }

  // The declared stream length must match the bytes actually written.
  const length = /\/Length (\d+) >>\nstream\n/.exec(text);
  assert.ok(length);
  const streamStart = text.indexOf('stream\n') + 'stream\n'.length;
  const streamEnd = text.indexOf('\nendstream');
  assert.equal(streamEnd - streamStart, Number(length[1]));
});

test('PDF string escaping protects the syntax and keeps degree signs', () => {
  assert.equal(escapePdfString('a(b)c\\d'), 'a\\(b\\)c\\\\d');
  assert.equal(escapePdfString('87°'), '87\\260');
  assert.equal(escapePdfString('20 m²'), '20 m\\262');
});

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

test('a pasted coordinate table parses, header and all', () => {
  const { parsed, problems } = parsePointTable(
    ['Point,Easting,Northing', 'PT1, 534821.42, 182934.18', 'PT2\t534902.57\t182915.33\tfence corner'].join('\n'),
  );

  assert.equal(problems.length, 0);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.coordinates.easting, 534821.42);
  assert.equal(parsed[1]?.description, 'fence corner');
});

test('a bad row is reported with its line and text, not skipped', () => {
  const { parsed, problems } = parsePointTable(
    ['PT1, 534821.42, 182934.18', 'PT2, north-ish, 182915.33', 'PT1, 1, 2'].join('\n'),
  );

  assert.equal(parsed.length, 1);
  assert.equal(problems.length, 2);
  assert.equal(problems[0]?.line, 2);
  assert.match(problems[0]?.message ?? '', /not both numbers/);
  assert.match(problems[1]?.message ?? '', /already a point called PT1/);
});

test('northing-first order is honoured rather than sniffed', () => {
  const { parsed } = parsePointTable('PT1, 182934.18, 534821.42', {
    order: 'id-northing-easting',
  });
  assert.equal(parsed[0]?.coordinates.easting, 534821.42);
  assert.equal(parsed[0]?.coordinates.northing, 182934.18);
});

test('a deed traverse parses quadrant bearings', () => {
  const { parsed, problems } = parseTraverse(
    ['PT1 PT2 N 90°00\'00" E 30.00', 'PT2 PT3 N 00°00\'00" E 20.00'].join('\n'),
  );

  assert.equal(problems.length, 0);
  assert.equal(parsed.length, 2);
  assert.ok(Math.abs((parsed[0]?.bearing ?? 0) - 90) < 1e-9);
  assert.equal(parsed[0]?.distance, 30);
});

test('an unreadable bearing is reported rather than approximated', () => {
  const { parsed, problems } = parseTraverse('PT1 PT2 roughly north 30.00');
  assert.equal(parsed.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.message ?? '', /could not read/);
});

test('buildModel fills the collections it was not given', () => {
  const built = buildModel({ metadata: { jurisdiction: 'generic' }, crs: CRS });
  assert.deepEqual(built.points, []);
  assert.deepEqual(built.boundary, []);
  assert.deepEqual(built.notes, []);
});

// ---------------------------------------------------------------------------
// Placed dimensions
// ---------------------------------------------------------------------------

test('a placed dimension is drawn and labelled with a distance nobody typed', () => {
  // PT1 to PT3 is a diagonal of the 30 x 20 parcel, which is not a boundary
  // segment — the case the whole feature exists for.
  const withDimension = model({
    points: [
      ...model().points,
      { id: 'PT9', coordinates: { easting: 534810, northing: 182900 }, provenance: { source: 'measured' } },
    ],
    dimensions: [
      { id: 'dim_1', from: 'PT1', to: 'PT3', provenance: { source: 'user-confirmed' } },
    ],
  });

  const result = runPipeline(withDimension);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const dimensions = result.drawing.layers.find((layer) => layer.id === 'dimensions');
  assert.ok(dimensions, 'there should be a dimensions layer');
  // A dimension line and two witness lines.
  assert.equal(dimensions!.elements.length, 3);

  // The line is offset from what it measures rather than drawn on top of it.
  const line = dimensions!.elements.find((element) => element.id === 'dim_1_line');
  assert.ok(line && line.kind === 'polyline');
  const [start] = line!.kind === 'polyline' ? line!.points : [];
  assert.ok(start);
  assert.ok(
    Math.hypot(start!.easting - 534800, start!.northing - 182900) > 1,
    'the dimension line should stand clear of the points it measures',
  );

  // And the text is the COGO answer, not a stored number: √(30² + 20²).
  const label = result.plan.labels.find((placed) => placed.spec.id === 'lbl_dim_1');
  assert.ok(label, 'the dimension should be labelled');
  assert.match(label!.text, /36\.06/);
});

test('a dimension whose point is deleted is dropped rather than drawn to nowhere', () => {
  const orphaned = model({
    dimensions: [
      { id: 'dim_1', from: 'PT1', to: 'PT_GONE', provenance: { source: 'user-confirmed' } },
    ],
  });

  const drawing = buildDrawing({
    model: orphaned,
    rings: orphaned.boundary.flatMap((ring) => {
      const computed = computeRing(ring, orphaned.points);
      return computed.ok ? [computed.ring] : [];
    }),
  });

  const dimensions = drawing.layers.find((layer) => layer.id === 'dimensions');
  assert.equal(dimensions?.elements.length, 0);
});
