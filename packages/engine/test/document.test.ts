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
  readNumber,
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
// Finding the table in real-world paste
// ---------------------------------------------------------------------------

/** Reads the ids and coordinates out, so the assertions stay readable. */
function read(text: string, options = {}) {
  const result = extractPoints(text, options);
  return {
    ...result,
    read: result.points.map((p) => [
      p.value.id,
      p.value.coordinates.easting,
      p.value.coordinates.northing,
    ]),
  };
}

const SQUARE: readonly (readonly [string, number, number])[] = [
  ['PT1', 534800, 182900],
  ['PT2', 534830, 182900],
  ['PT3', 534830, 182920],
];

test('a title above the table does not stop it being read', () => {
  // The failure this fixes: one line of preamble was enough to make the whole
  // paste unreadable, because every line was assumed to be a row.
  const { read: points, analysis } = read(
    [
      'BOUNDARY SURVEY',
      '',
      'Point,Easting,Northing',
      'PT1,534800.00,182900.00',
      'PT2,534830.00,182900.00',
      'PT3,534830.00,182920.00',
    ].join('\n'),
  );

  assert.deepEqual(points, SQUARE.map((row) => [...row]));
  assert.deepEqual(
    analysis.ignored.map((l) => l.text),
    ['BOUNDARY SURVEY'],
  );
});

test('a total line below the table is set aside, not treated as a point', () => {
  const { read: points, analysis } = read(
    [
      'Point,Easting,Northing',
      'PT1,534800.00,182900.00',
      'PT2,534830.00,182900.00',
      'PT3,534830.00,182920.00',
      'Total: 3 points',
    ].join('\n'),
  );

  assert.deepEqual(points, SQUARE.map((row) => [...row]));
  assert.equal(analysis.ignored.length, 1);
});

test('a rule drawn under the heading does not hide the heading', () => {
  const analysis = analyzeTable(
    [
      'Point   Easting     Northing',
      '-----   -------     --------',
      'PT1     534800.00   182900.00',
      'PT2     534830.00   182900.00',
      'PT3     534830.00   182920.00',
    ].join('\n'),
  );

  assert.equal(analysis.hasHeader, true);
  assert.deepEqual(
    analysis.columns.map((c) => c.role),
    ['id', 'easting', 'northing'],
  );
  assert.ok(analysis.confidence >= CONFIDENCE.CERTAIN);
});

test('a column layout keeps a multi-word description in one field', () => {
  // Splitting on any whitespace turns `Boundary corner` into two columns and
  // throws the row width off; a run of spaces is the real separator here.
  const analysis = analyzeTable(
    [
      'Pt No   Easting     Northing    Description',
      '1       534800.00   182900.00   Boundary corner',
      '2       534830.00   182900.00   Fence post',
      '3       534830.00   182920.00   Gate',
    ].join('\n'),
  );

  assert.equal(analysis.delimiter, 'columns');
  assert.deepEqual(
    analysis.columns.map((c) => c.role),
    ['id', 'easting', 'northing', 'description'],
  );
  assert.deepEqual(analysis.rows[0], ['1', '534800.00', '182900.00', 'Boundary corner']);
});

test('a heading qualified by units or a word still names its column', () => {
  const analysis = analyzeTable(
    'Pt No,Easting (m),Northing (m)\nPT1,534800.00,182900.00\nPT2,534830.00,182900.00',
  );
  assert.deepEqual(
    analysis.columns.map((c) => c.role),
    ['id', 'easting', 'northing'],
  );
  assert.ok(analysis.confidence >= CONFIDENCE.CERTAIN);
});

test('problems point at the line of the original paste', () => {
  const result = extractPoints(
    [
      'SITE: 25 High Street', // 1
      '', // 2
      'Point,Easting,Northing', // 3
      'PT1,534800,182900', // 4
      'PT2,smudged,182903', // 5
    ].join('\n'),
  );

  assert.equal(result.points.length, 1);
  assert.equal(result.problems[0]?.line, 5);
});

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

test('a field that swallowed a delimiter is not a number', () => {
  // The regression that mattered most: whitespace used to be stripped before
  // the numeric test, so `800.00\t182` — the debris of splitting a tab-separated
  // row on the comma inside a grouped number — passed as 800.00182 and was
  // written into the survey as a coordinate.
  assert.equal(readNumber('800.00\t182'), null);
  assert.equal(readNumber('534800 182900'), null);
  assert.equal(readNumber('PT1'), null);
  assert.equal(readNumber(''), null);
});

test('grouped thousands are read as one number, in either convention', () => {
  assert.equal(readNumber('534,800.00')?.value, 534800);
  assert.equal(readNumber("534'800.00")?.value, 534800);
  assert.equal(readNumber('534.800,00')?.value, 534800);
  assert.equal(readNumber('534800,25')?.value, 534800.25);
  assert.equal(readNumber('-12.5')?.value, -12.5);
});

test('grouping that reads either way is flagged rather than chosen silently', () => {
  // `534,800` is 534800 grouped, or 534.8 to the millimetre. Nothing in the
  // text decides it, and the two differ by a factor of a thousand.
  assert.equal(readNumber('534,800')?.ambiguousGrouping, true);
  assert.equal(readNumber('534,800.00')?.ambiguousGrouping, false);

  // Tab separated, so the comma is unambiguously inside the field rather than
  // between two of them.
  const analysis = analyzeTable(
    'PT1\t534,800\t182,900\nPT2\t534,830\t182,900\nPT3\t534,830\t182,920',
  );
  assert.ok(analysis.warnings.some((w) => /thousand/.test(w)));
});

test('a grouped number quoted by a spreadsheet survives the comma split', () => {
  const { read: points } = read(
    [
      'Point,Easting,Northing',
      'PT1,"534,800.00","182,900.00"',
      'PT2,"534,830.00","182,900.00"',
      'PT3,"534,830.00","182,920.00"',
    ].join('\n'),
  );
  assert.deepEqual(points, SQUARE.map((row) => [...row]));
});

test('a split that cuts through a grouped number loses to one that does not', () => {
  // Both readings of `PT1, 534,800.00, 182,900.00` are internally consistent;
  // the debris of the wrong one is what gives it away.
  const { read: points } = read(
    [
      'PT1, 534,800.00, 182,900.00',
      'PT2, 534,830.00, 182,900.00',
      'PT3, 534,830.00, 182,920.00',
    ].join('\n'),
  );
  assert.deepEqual(points, SQUARE.map((row) => [...row]));
});

test('an axis letter on the value settles which column is which', () => {
  const analysis = analyzeTable(
    ['PT1 534800.00E 182900.00N', 'PT2 534830.00E 182900.00N'].join('\n'),
  );

  const easting = analysis.columns.find((c) => c.role === 'easting');
  const northing = analysis.columns.find((c) => c.role === 'northing');
  assert.equal(easting?.index, 1);
  assert.equal(northing?.index, 2);
  // Named outright by the data, so there is nothing to ask the user about.
  assert.equal(easting?.confidence, CONFIDENCE.CERTAIN);
});

test('an axis letter written beside the value belongs to that value', () => {
  // `534800.00 E, 182900.00 N` — attaching E to the number after it would put
  // the label on the wrong axis and mirror the site.
  const { read: points } = read(
    [
      'corner A = 534800.00 E, 182900.00 N',
      'corner B = 534830.00 E, 182900.00 N',
      'corner C = 534830.00 E, 182920.00 N',
    ].join('\n'),
  );
  assert.deepEqual(points, SQUARE.map(([, e, n], i) => [['A', 'B', 'C'][i], e, n]));
});

test('a station name is preferred over a word repeated on every row', () => {
  const analysis = analyzeTable(
    ['corner A 534800.00 182900.00', 'corner B 534830.00 182900.00'].join('\n'),
  );
  const id = analysis.columns.find((c) => c.role === 'id');
  assert.equal(id?.index, 1);
});

// ---------------------------------------------------------------------------
// Notes that are not tables
// ---------------------------------------------------------------------------

test('ragged field notes are read line by line when the columns do not line up', () => {
  // Remarks on some lines and not others means no two rows agree on a width,
  // which is fatal to a column model and fine when each line is read alone.
  const { read: points, analysis } = read(
    [
      'A 534800.00 182900.00',
      'B 534830.00 182900.00 fence corner',
      'C 534830.00 182920.00',
      'D 534800.00 182920.00 iron pin found',
    ].join('\n'),
  );

  assert.deepEqual(points, [
    ['A', 534800, 182900],
    ['B', 534830, 182900],
    ['C', 534830, 182920],
    ['D', 534800, 182920],
  ]);
  assert.ok(analysis.warnings.some((w) => /line on its own/.test(w)));
});

test('a line-by-line reading stays below the confirmation threshold', () => {
  const result = extractPoints(
    [
      'A 534800.00 182900.00',
      'B 534830.00 182900.00 fence corner',
      'C 534830.00 182920.00',
      'D 534800.00 182920.00 iron pin found',
    ].join('\n'),
  );
  assert.ok(result.points.every((p) => p.confidence <= CONFIDENCE.AMBIGUOUS));
});

test('prose with no coordinates in it is still refused', () => {
  const result = extractPoints('I went to the site and it was raining all day.');
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
