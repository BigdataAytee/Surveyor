/**
 * Document AI structure inference.
 *
 * The confidence scores matter as much as the values: A.3 routes anything
 * under the threshold to user confirmation, so a test that only checked the
 * parsed numbers would miss the whole mechanism.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeTable,
  extractPoints,
  extractTraverse,
  CONFIDENCE,
} from '../src/document.js';
import { pointsFromExtraction } from '../src/input.js';

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('a comma table with headings is read with full confidence', () => {
  const analysis = analyzeTable(
    ['Point,Easting,Northing', 'PT1,534800.00,182900.00', 'PT2,534832.40,182903.10'].join('\n'),
  );

  assert.equal(analysis.delimiter, 'comma');
  assert.equal(analysis.hasHeader, true);
  assert.equal(analysis.rows.length, 2);
  assert.deepEqual(
    analysis.columns.map((c) => c.role),
    ['id', 'easting', 'northing'],
  );
  assert.ok(analysis.confidence >= CONFIDENCE.CERTAIN);
});

test('tabs and semicolons are recognised too', () => {
  assert.equal(analyzeTable('PT1\t534800\t182900\nPT2\t534832\t182903').delimiter, 'tab');
  assert.equal(
    analyzeTable('Point;East;North\nPT1;534800;182900').delimiter,
    'semicolon',
  );
});

test('whitespace separation is handled when there is no punctuation', () => {
  const analysis = analyzeTable('PT1 534800.00 182900.00\nPT2 534832.40 182903.10');
  assert.equal(analysis.delimiter, 'whitespace');
  assert.equal(analysis.rows.length, 2);
});

test('a headerless table is detected as having no header', () => {
  const analysis = analyzeTable('PT1,534800,182900\nPT2,534832,182903');
  assert.equal(analysis.hasHeader, false);
  assert.equal(analysis.rows.length, 2);
});

test('coordinate order without a header is flagged, not assumed silently', () => {
  const analysis = analyzeTable('PT1,534800,182900\nPT2,534832,182903');

  const easting = analysis.columns.find((c) => c.role === 'easting');
  assert.ok(easting);
  // Both are large positive numbers; there is no honest way to tell them
  // apart, so this has to reach the user.
  assert.ok(easting.confidence <= CONFIDENCE.AMBIGUOUS);
  assert.ok(analysis.warnings.some((w) => /easting comes before northing/.test(w)));
});

test('alternative headings are matched', () => {
  const analysis = analyzeTable('Name,X,Y,Z,Code\nSTN1,100,200,15.2,fence');
  assert.deepEqual(
    analysis.columns.map((c) => c.role),
    ['id', 'easting', 'northing', 'elevation', 'description'],
  );
});

test('a northing-first heading is honoured rather than reordered', () => {
  const analysis = analyzeTable('Point,Northing,Easting\nPT1,182900,534800');
  assert.deepEqual(
    analysis.columns.map((c) => c.role),
    ['id', 'northing', 'easting'],
  );
  const northing = analysis.columns.find((c) => c.role === 'northing');
  assert.equal(northing?.confidence, CONFIDENCE.CERTAIN);
});

test('a decimal comma does not fool the delimiter sniffer', () => {
  // European style: semicolon separated, comma as the decimal point.
  const analysis = analyzeTable('PT1;534800,25;182900,50\nPT2;534832,40;182903,10');
  assert.equal(analysis.delimiter, 'semicolon');

  const { points } = extractPoints('PT1;534800,25;182900,50\nPT2;534832,40;182903,10');
  assert.equal(points[0]?.value.coordinates.easting, 534800.25);
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test('points come out with coordinates and confidences', () => {
  const result = extractPoints(
    ['Point,Easting,Northing', 'PT1,534800.00,182900.00', 'PT2,534832.40,182903.10'].join('\n'),
  );

  assert.equal(result.problems.length, 0);
  assert.equal(result.points.length, 2);
  assert.deepEqual(result.points[0]?.value.coordinates, {
    easting: 534800, northing: 182900,
  });
  assert.ok(result.points.every((p) => p.confidence >= CONFIDENCE.CERTAIN));
});

test('elevation is carried when a column holds it', () => {
  const result = extractPoints('Point,E,N,Z\nPT1,534800,182900,42.5');
  assert.equal(result.points[0]?.value.coordinates.elevation, 42.5);
});

test('confidence survives into provenance for the Validation Engine', () => {
  // No header, so the coordinate order is a guess and must be flagged.
  const result = extractPoints('PT1,534800,182900\nPT2,534832,182903');
  const points = pointsFromExtraction(result);

  assert.equal(points.length, 2);
  assert.ok((points[0]?.provenance.confidence ?? 1) <= CONFIDENCE.AMBIGUOUS);
  assert.equal(points[0]?.provenance.source, 'measured');
});

test('confirming the coordinate order swaps the columns', () => {
  const text = 'PT1,182900,534800';
  const asRead = extractPoints(text);
  const corrected = extractPoints(text, { swapEastingNorthing: true });

  assert.equal(asRead.points[0]?.value.coordinates.easting, 182900);
  assert.equal(corrected.points[0]?.value.coordinates.easting, 534800);
  assert.equal(corrected.points[0]?.value.coordinates.northing, 182900);
});

test('an unreadable row is reported with its text, not dropped', () => {
  const result = extractPoints(
    ['Point,Easting,Northing', 'PT1,534800,182900', 'PT2,smudged,182903'].join('\n'),
  );

  assert.equal(result.points.length, 1);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0]?.line, 3);
  assert.match(result.problems[0]?.text ?? '', /smudged/);
});

test('a duplicate name is kept but renamed and scored down', () => {
  const result = extractPoints(
    ['Point,Easting,Northing', 'PT1,534800,182900', 'PT1,534832,182903'].join('\n'),
  );

  assert.equal(result.points.length, 2);
  assert.equal(result.points[1]?.value.id, 'PT1_2');
  assert.ok((result.points[1]?.confidence ?? 1) <= CONFIDENCE.POOR);
  assert.match(result.problems[0]?.message ?? '', /already a point called PT1/);
});

test('a table with no coordinate columns extracts nothing and says why', () => {
  const result = extractPoints('Name,Code\nPT1,fence\nPT2,wall');
  assert.equal(result.points.length, 0);
  assert.match(result.problems[0]?.message ?? '', /could not find an easting/);
});

// ---------------------------------------------------------------------------
// Traverse
// ---------------------------------------------------------------------------

test('a deed traverse is read out of prose', () => {
  const { segments, problems } = extractTraverse(
    [
      'PT1 PT2 N 87°14\'32" E 81.42 m',
      'PT2 PT3 thence S 02°45\'28" E for a distance of 24.10',
    ].join('\n'),
  );

  assert.equal(problems.length, 0);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.value.from, 'PT1');
  assert.equal(segments[0]?.value.distance, 81.42);
  assert.ok(Math.abs((segments[0]?.value.bearing ?? 0) - 87.2422) < 0.001);
  assert.ok(Math.abs((segments[1]?.value.bearing ?? 0) - 177.2422) < 0.001);
});

test('a line with no bearing is reported rather than approximated', () => {
  const { segments, problems } = extractTraverse('PT1 PT2 roughly north for 30 m');
  assert.equal(segments.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.message ?? '', /could not find both/);
});
