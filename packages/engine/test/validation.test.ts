/**
 * Validation Engine behaviour. The rule under test throughout is A.1 §4:
 * problems are reported with options, never quietly repaired.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoundaryRing, SurveyDataModel, SurveyPoint } from '@surveyor/contracts';

import { computeRing, type ResolvedRing } from '../src/cogo.js';
import { validate, DEFAULT_CLOSURE_TOLERANCE } from '../src/validation.js';

function point(id: string, e: number, n: number, confidence?: number): SurveyPoint {
  return {
    id,
    coordinates: { easting: e, northing: n },
    provenance:
      confidence === undefined
        ? { source: 'measured' }
        : { source: 'measured', confidence },
  };
}

function modelOf(points: SurveyPoint[]): SurveyDataModel {
  return {
    metadata: { jurisdiction: 'generic' },
    crs: {
      code: 'EPSG:27700',
      name: 'OSGB36 / British National Grid',
      datum: 'OSGB36',
      units: 'metre',
      bearingConvention: 'quadrant',
    },
    points,
    boundary: [],
    siteFeatures: [],
    notes: [],
  };
}

function ringFrom(ring: BoundaryRing, points: SurveyPoint[]): ResolvedRing {
  const result = computeRing(ring, points);
  if (!result.ok) throw new Error(result.reason);
  return result.ring;
}

const SQUARE_POINTS = [
  point('PT1', 0, 0),
  point('PT2', 30, 0),
  point('PT3', 30, 20),
  point('PT4', 0, 20),
];

const SQUARE: BoundaryRing = {
  id: 'ring_1',
  closed: true,
  segments: [
    { from: 'PT1', to: 'PT2', provenance: { source: 'measured' } },
    { from: 'PT2', to: 'PT3', provenance: { source: 'measured' } },
    { from: 'PT3', to: 'PT4', provenance: { source: 'measured' } },
    { from: 'PT4', to: 'PT1', provenance: { source: 'measured' } },
  ],
};

test('a clean square validates as ready', () => {
  const report = validate({
    model: modelOf(SQUARE_POINTS),
    rings: [ringFrom(SQUARE, SQUARE_POINTS)],
  });

  assert.equal(report.status, 'ready');
  assert.deepEqual(report.issues, []);
  assert.equal(report.closure[0]?.withinTolerance, true);
});

test('closure outside tolerance is an error with adjust/reject options', () => {
  const sloppy: BoundaryRing = {
    id: 'ring_1',
    closed: true,
    segments: [
      { from: 'PT1', to: 'PT2', bearing: 90, distance: 30, provenance: { source: 'measured' } },
      { from: 'PT2', to: 'PT3', bearing: 0, distance: 20, provenance: { source: 'measured' } },
      { from: 'PT3', to: 'PT4', bearing: 270, distance: 30, provenance: { source: 'measured' } },
      { from: 'PT4', to: 'PT1', bearing: 180, distance: 19.6, provenance: { source: 'measured' } },
    ],
  };

  const report = validate({
    model: modelOf([point('PT1', 0, 0)]),
    rings: [ringFrom(sloppy, [point('PT1', 0, 0)])],
  });

  assert.equal(report.status, 'error');
  const issue = report.issues.find((i) => i.code === 'closure-out-of-tolerance');
  assert.ok(issue, 'expected a closure issue');
  assert.equal(issue.severity, 'error');
  assert.deepEqual(issue.options, ['adjust', 'reject']);
  // The message has to be readable by a novice, so it states the gap in words.
  assert.match(issue.message, /does not close/);
  assert.match(issue.message, /0\.400 m/);
  assert.equal(report.closure[0]?.withinTolerance, false);
});

test('closure within tolerance passes without an issue', () => {
  // 5 mm of misclosure over ~100 m is about 1:20000 — inside the default.
  const slight: BoundaryRing = {
    id: 'ring_1',
    closed: true,
    segments: [
      { from: 'PT1', to: 'PT2', bearing: 90, distance: 30, provenance: { source: 'measured' } },
      { from: 'PT2', to: 'PT3', bearing: 0, distance: 20, provenance: { source: 'measured' } },
      { from: 'PT3', to: 'PT4', bearing: 270, distance: 30, provenance: { source: 'measured' } },
      { from: 'PT4', to: 'PT1', bearing: 180, distance: 19.995, provenance: { source: 'measured' } },
    ],
  };

  const report = validate({
    model: modelOf([point('PT1', 0, 0)]),
    rings: [ringFrom(slight, [point('PT1', 0, 0)])],
  });

  assert.equal(report.closure[0]?.withinTolerance, true);
  assert.equal(report.issues.some((i) => i.code === 'closure-out-of-tolerance'), false);
  assert.ok(DEFAULT_CLOSURE_TOLERANCE.minimumRatio === 5000);
});

test('a self-intersecting boundary is caught', () => {
  // PT3 and PT4 swapped, producing a bow-tie.
  const bowtie: BoundaryRing = {
    id: 'ring_1',
    closed: true,
    segments: [
      { from: 'PT1', to: 'PT2', provenance: { source: 'measured' } },
      { from: 'PT2', to: 'PT4', provenance: { source: 'measured' } },
      { from: 'PT4', to: 'PT3', provenance: { source: 'measured' } },
      { from: 'PT3', to: 'PT1', provenance: { source: 'measured' } },
    ],
  };

  const report = validate({
    model: modelOf(SQUARE_POINTS),
    rings: [ringFrom(bowtie, SQUARE_POINTS)],
  });

  assert.equal(report.status, 'error');
  assert.ok(report.issues.some((i) => i.code === 'self-intersection'));
});

test('duplicate points are flagged for review, not deleted', () => {
  const withDupe = [...SQUARE_POINTS, point('PT5', 30, 20)];
  const report = validate({
    model: modelOf(withDupe),
    rings: [ringFrom(SQUARE, withDupe)],
  });

  const issue = report.issues.find((i) => i.code === 'duplicate-point');
  assert.ok(issue);
  assert.equal(issue.severity, 'needs-review');
  assert.deepEqual([...issue.subjects].sort(), ['PT3', 'PT5']);
  assert.equal(report.status, 'needs-review');
});

test('a low-confidence extraction asks for confirmation', () => {
  const extracted = [
    point('PT1', 0, 0),
    point('PT2', 30, 0),
    point('PT3', 30, 20, 0.42),
    point('PT4', 0, 20),
  ];
  const report = validate({
    model: modelOf(extracted),
    rings: [ringFrom(SQUARE, extracted)],
  });

  const issue = report.issues.find((i) => i.code === 'low-confidence-extraction');
  assert.ok(issue);
  assert.ok(issue.options.includes('confirm'));
  assert.match(issue.detail ?? '', /42%/);
});

test('an implausible scale factor is questioned rather than applied silently', () => {
  const model = modelOf(SQUARE_POINTS);
  const report = validate({
    model: { ...model, crs: { ...model.crs, combinedScaleFactor: 1.5 } },
    rings: [ringFrom(SQUARE, SQUARE_POINTS)],
  });

  const issue = report.issues.find((i) => i.code === 'crs-inconsistent');
  assert.ok(issue);
  assert.equal(issue.severity, 'needs-review');
});

test('an error outranks a review flag when both are present', () => {
  const messy = [...SQUARE_POINTS, point('PT5', 30, 20)];
  const bowtie: BoundaryRing = {
    id: 'ring_1',
    closed: true,
    segments: [
      { from: 'PT1', to: 'PT2', provenance: { source: 'measured' } },
      { from: 'PT2', to: 'PT4', provenance: { source: 'measured' } },
      { from: 'PT4', to: 'PT3', provenance: { source: 'measured' } },
      { from: 'PT3', to: 'PT1', provenance: { source: 'measured' } },
    ],
  };

  const report = validate({
    model: modelOf(messy),
    rings: [ringFrom(bowtie, messy)],
  });

  assert.equal(report.status, 'error');
  assert.ok(report.issues.length > 1);
});
