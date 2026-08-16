/**
 * Tests for the annotation layer's Layer 1 contracts.
 *
 * Two things, both pure: the comparison between a stated area and the one the
 * geometry gives, and the arithmetic behind a representative fraction and a
 * scale bar. Neither has any UI, which is the point of doing them first — a
 * scale that is wrong is wrong on the sheet, on the screen and in the export,
 * and there should be exactly one place to be wrong.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SurveyDataModel } from '@surveyor/contracts';

import {
  AREA_MISMATCH_TOLERANCE,
  DEFAULT_CRS,
  chooseScale,
  compareAreas,
  representativeFraction,
  ringFromPointOrder,
  runPipeline,
  scaleBar,
  validate,
} from '../src/index.js';
import { computeRing, type ResolvedRing } from '../src/cogo.js';

/** A 40 × 30 m rectangle: 1200 m², exactly. */
function parcel(statedArea?: number): SurveyDataModel {
  const corners = [
    { easting: 544800, northing: 718900 },
    { easting: 544840, northing: 718900 },
    { easting: 544840, northing: 718930 },
    { easting: 544800, northing: 718930 },
  ];

  return {
    metadata: {
      jurisdiction: 'ng-survey-plan',
      siteAddress: 'Plot 15',
      ...(statedArea === undefined ? {} : { statedArea }),
    },
    crs: DEFAULT_CRS,
    points: corners.map((coordinates, index) => ({
      id: `PT${index + 1}`,
      coordinates,
      provenance: { source: 'measured' as const },
    })),
    boundary: [ringFromPointOrder('ring_1', ['PT1', 'PT2', 'PT3', 'PT4'])],
    siteFeatures: [],
    notes: [],
  };
}

const ringsOf = (model: SurveyDataModel): readonly ResolvedRing[] =>
  model.boundary.flatMap((ring) => {
    const computed = computeRing(ring, model.points);
    return computed.ok ? [computed.ring] : [];
  });

// ---------------------------------------------------------------------------
// Stated area against computed area
// ---------------------------------------------------------------------------

test('the parcel this suite is built on is exactly 1200 m²', () => {
  // Stated up front, because every comparison below leans on it.
  assert.ok(Math.abs((ringsOf(parcel())[0]?.area ?? 0) - 1200) < 1e-6);
});

test('with no stated area there is nothing to compare and nothing is said', () => {
  const model = parcel();
  assert.equal(compareAreas(model, ringsOf(model)), null);

  const report = validate({ model, rings: ringsOf(model) });
  assert.ok(!report.issues.some((issue) => issue.code === 'area-mismatch'));
});

test('a stated area that agrees raises nothing', () => {
  const model = parcel(1200);
  const comparison = compareAreas(model, ringsOf(model));

  assert.ok(comparison);
  assert.equal(comparison.withinTolerance, true);
  assert.equal(comparison.difference, 0);

  const report = validate({ model, rings: ringsOf(model) });
  assert.ok(!report.issues.some((issue) => issue.code === 'area-mismatch'));
});

test('a stated area inside the tolerance is not worth interrupting for', () => {
  // Half a per cent — a deed rounded to the nearest ten metres.
  const model = parcel(1194);
  const comparison = compareAreas(model, ringsOf(model));
  assert.ok(comparison?.withinTolerance, `proportion ${comparison?.proportion}`);
});

test('a stated area that disagrees is reported, and neither figure is preferred', () => {
  const model = parcel(1000);
  const comparison = compareAreas(model, ringsOf(model));

  assert.ok(comparison);
  assert.equal(comparison.withinTolerance, false);
  assert.equal(comparison.stated, 1000);
  assert.ok(Math.abs(comparison.computed - 1200) < 1e-6);
  assert.ok(Math.abs(comparison.proportion - 0.2) < 1e-9);

  const issue = validate({ model, rings: ringsOf(model) }).issues.find(
    (candidate) => candidate.code === 'area-mismatch',
  );
  assert.ok(issue, 'a 20% discrepancy was not reported');

  // Both numbers appear, and the message asks rather than decides.
  assert.match(issue.detail ?? '', /stated/);
  assert.match(issue.detail ?? '', /computed/);
  assert.match(issue.message, /which one/i);
  assert.equal(issue.severity, 'needs-review');

  // And the survey is untouched: reporting a discrepancy must not resolve it.
  assert.equal(model.metadata.statedArea, 1000);
  assert.ok(Math.abs((ringsOf(model)[0]?.area ?? 0) - 1200) < 1e-6);
});

test('the discrepancy says which way round it is', () => {
  const larger = validate({ model: parcel(1000), rings: ringsOf(parcel(1000)) }).issues.find(
    (issue) => issue.code === 'area-mismatch',
  );
  assert.match(larger?.message ?? '', /larger/);

  const smaller = validate({ model: parcel(1500), rings: ringsOf(parcel(1500)) }).issues.find(
    (issue) => issue.code === 'area-mismatch',
  );
  assert.match(smaller?.message ?? '', /smaller/);
});

test('a nonsensical stated area is ignored rather than compared', () => {
  for (const stated of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
    const model = parcel(stated);
    assert.equal(compareAreas(model, ringsOf(model)), null, `stated ${stated}`);
  }
});

test('a stated area with no closed boundary has nothing to disagree with', () => {
  const open: SurveyDataModel = { ...parcel(1200), boundary: [] };
  assert.equal(compareAreas(open, []), null);
});

test('the mismatch check reaches the pipeline, not just the validator', () => {
  const result = runPipeline(parcel(1000));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(
      result.validation.issues.some((issue) => issue.code === 'area-mismatch'),
      'the pipeline did not surface the discrepancy',
    );
  }
});

test('the tolerance is proportional, so it means the same on any size of parcel', () => {
  assert.ok(AREA_MISMATCH_TOLERANCE > 0 && AREA_MISMATCH_TOLERANCE < 0.1);

  const model = parcel(1200 * (1 + AREA_MISMATCH_TOLERANCE * 2));
  assert.equal(compareAreas(model, ringsOf(model))?.withinTolerance, false);
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

const A4 = { widthMm: 210, heightMm: 297 };

test('a scale is chosen from the standard set, never computed exactly', () => {
  const standard = [50, 100, 200, 250, 500, 1000, 1250, 2500, 5000];
  for (const extent of [
    { width: 40, height: 30 },
    { width: 120, height: 80 },
    { width: 900, height: 400 },
  ]) {
    assert.ok(
      standard.includes(chooseScale(extent, A4)),
      `${extent.width}×${extent.height} chose a non-standard scale`,
    );
  }
});

test('the chosen scale fits the parcel, wherever a standard scale can', () => {
  /*
   * Only where one exists. A 1400 m parcel needs about 1:6700 on A4 and the
   * standard set stops at 1:5000, so there is nothing correct to return — that
   * case is its own test below, and asserting a fit here would be asserting
   * something arithmetic cannot deliver.
   */
  for (const extent of [
    { width: 10, height: 8 },
    { width: 40, height: 30 },
    { width: 500, height: 260 },
    { width: 1000, height: 700 },
  ]) {
    const scale = chooseScale(extent, A4);
    // Rounding out, never in: the drawn size must be inside the sheet.
    assert.ok(
      (extent.width / scale) * 1000 <= A4.widthMm + 1e-9,
      `${extent.width} m at 1:${scale} is ${(extent.width / scale) * 1000} mm on a ${A4.widthMm} mm sheet`,
    );
    assert.ok((extent.height / scale) * 1000 <= A4.heightMm + 1e-9);
  }
});

test('a bigger parcel never gets a closer scale', () => {
  let previous = 0;
  for (const width of [10, 25, 60, 150, 400, 1200]) {
    const scale = chooseScale({ width, height: width * 0.6 }, A4);
    assert.ok(scale >= previous, `1:${scale} at ${width} m came after 1:${previous}`);
    previous = scale;
  }
});

test('a parcel too large for any standard scale gets the smallest one available', () => {
  // Not an exception and not a crash: the largest scale in the set, and the
  // composer's own fitting is what reports that it does not fit.
  assert.equal(chooseScale({ width: 100_000, height: 100_000 }, A4), 5000);
});

test('the representative fraction is written the way a plan writes it', () => {
  assert.equal(representativeFraction(500), 'SCALE 1:500');
  assert.equal(representativeFraction(1250), 'SCALE 1:1,250');
  assert.equal(representativeFraction(500.4), 'SCALE 1:500');
});

test('a scale bar measures a round number', () => {
  for (const denominator of [100, 200, 500, 1000, 2500]) {
    const bar = scaleBar(denominator);
    // The whole point of a bar is that a reader can take a distance off it.
    assert.ok(
      /^(1|2|2\.5|5|10)(0*)$/.test(String(bar.length).replace('.', '')) ||
        Number.isInteger(bar.length),
      `1:${denominator} produced a bar of ${bar.length}`,
    );
    assert.match(bar.label, /^[\d.]+ m$/);
  }
});

test('a scale bar is a usable length on paper', () => {
  for (const denominator of [50, 100, 500, 1000, 5000]) {
    const bar = scaleBar(denominator, 50);
    // Long enough to measure against, short enough for a title block.
    assert.ok(
      bar.lengthMm >= 20 && bar.lengthMm <= 90,
      `1:${denominator} produced a ${bar.lengthMm} mm bar`,
    );
  }
});

test('a scale bar divides evenly, so quarters can be read by eye', () => {
  const bar = scaleBar(500);
  assert.equal(bar.ticks.length, 5);
  assert.equal(bar.ticks[0], 0);
  assert.equal(bar.ticks[bar.ticks.length - 1], bar.length);

  for (let i = 1; i < bar.ticks.length; i += 1) {
    const gap = bar.ticks[i]! - bar.ticks[i - 1]!;
    assert.ok(Math.abs(gap - bar.length / 4) < 1e-9, 'the divisions are uneven');
  }
});

test('the bar and the fraction describe the same scale', () => {
  /*
   * The check that matters: a bar drawn `lengthMm` long on a sheet at 1:N must
   * measure `length` on the ground. If these two ever disagree the plan says
   * one scale and measures another, and a reader trusting the bar is wrong by
   * whatever the difference is.
   */
  for (const denominator of [100, 250, 500, 1000, 2500]) {
    const bar = scaleBar(denominator);
    const impliedGroundMetres = (bar.lengthMm / 1000) * denominator;
    assert.ok(
      Math.abs(impliedGroundMetres - bar.length) < 1e-9,
      `1:${denominator}: a ${bar.lengthMm} mm bar implies ${impliedGroundMetres} m but is labelled ${bar.length}`,
    );
  }
});
