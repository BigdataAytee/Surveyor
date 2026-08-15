/**
 * Tests for the coordinate systems and for what a new plan starts on.
 *
 * The default is worth pinning down. A survey drawn on the wrong datum is not
 * visibly wrong — the shape, the closure, the area and the bearings are all
 * exactly right, and the parcel is simply somewhere else on the earth. Nothing
 * downstream can catch that, which is why it is caught here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CRS,
  DEFAULT_CRS_CODE,
  DEFAULT_JURISDICTION,
  JURISDICTIONS,
  KNOWN_CRS,
  resolveCrs,
} from '../src/index.js';

test('a new plan is drawn on Minna / UTM zone 31N', () => {
  assert.equal(DEFAULT_CRS_CODE, 'EPSG:26331');
  assert.equal(DEFAULT_CRS.datum, 'Minna');
  assert.equal(DEFAULT_CRS.name, 'Minna / UTM zone 31N');
  assert.equal(DEFAULT_CRS.units, 'metre');
});

test('the default is not the British National Grid', () => {
  // The thing this change was made to stop.
  assert.notEqual(DEFAULT_CRS.code, 'EPSG:27700');
  assert.notEqual(DEFAULT_CRS.datum, 'OSGB36');
});

test('bearings default to whole-circle, which is what a Nigerian plan carries', () => {
  assert.equal(DEFAULT_CRS.bearingConvention, 'azimuth');
  assert.equal(JURISDICTIONS.get(DEFAULT_JURISDICTION)?.bearingConvention, 'azimuth');
});

test('every Nigerian system offered sits on the Minna datum', () => {
  for (const code of ['EPSG:26331', 'EPSG:26332', 'EPSG:26391', 'EPSG:26392', 'EPSG:26393']) {
    const crs = KNOWN_CRS[code];
    assert.ok(crs, `${code} is not offered`);
    assert.equal(crs.datum, 'Minna', `${code} is not on Minna`);
    assert.equal(crs.units, 'metre');
  }
});

test('the three national belts are all present and distinct', () => {
  const belts = ['EPSG:26391', 'EPSG:26392', 'EPSG:26393'].map((code) => KNOWN_CRS[code]?.name);
  assert.deepEqual(belts, [
    'Minna / Nigeria West Belt',
    'Minna / Nigeria Mid Belt',
    'Minna / Nigeria East Belt',
  ]);
});

test('no scale factor is assumed for a UTM zone', () => {
  /*
   * UTM's scale factor is 0.9996 only on the central meridian, and the
   * combined factor also depends on height. Baking a constant in would apply a
   * correction nobody asked for to every distance in the country.
   */
  assert.equal(DEFAULT_CRS.combinedScaleFactor, undefined);
});

test('the other systems are still offered, so an imported survey can say what it is', () => {
  assert.equal(KNOWN_CRS['EPSG:27700']?.name, 'OSGB36 / British National Grid');
  assert.equal(KNOWN_CRS['EPSG:27700']?.bearingConvention, 'quadrant');
});

test('a new plan is drawn to the Nigerian template', () => {
  assert.equal(DEFAULT_JURISDICTION, 'ng-survey-plan');

  const template = JURISDICTIONS.get(DEFAULT_JURISDICTION);
  assert.ok(template, 'the default jurisdiction has no template');

  // The UK template carries an Ordnance Survey attribution. On a Nigerian plan
  // that is not a harmless leftover, it is a false statement about the source
  // of the data.
  const notes = template.requiredNotes.join(' ');
  assert.ok(!/Ordnance Survey/i.test(notes), 'a Nigerian plan claims Ordnance Survey data');
  assert.ok(!/Land Registry/i.test(template.name));
});

test('the plan is not a plan until a surveyor has signed it', () => {
  const template = JURISDICTIONS.get(DEFAULT_JURISDICTION);
  const signature = template?.titleBlock.find((field) => /signature/i.test(field.label));
  assert.ok(signature, 'no place for the surveyor to sign');
  assert.equal(signature.required, true);
});

test('resolving by code still returns the system asked for, never the default', () => {
  // A lookup is not a fallback: someone who names EPSG:27700 gets it, and the
  // change of default must not quietly redirect an existing survey.
  const resolved = resolveCrs({ code: 'EPSG:27700' });
  assert.equal(resolved.kind, 'resolved');
  assert.equal(resolved.kind === 'resolved' && resolved.crs.datum, 'OSGB36');
});

test('an unknown system still halts rather than defaulting to Minna', () => {
  /*
   * The central rule of this engine: it does not guess a coordinate system.
   * Having a default for a blank sheet must not turn into a default for a
   * survey somebody imported.
   */
  const resolved = resolveCrs({ code: 'EPSG:99999' });
  assert.equal(resolved.kind, 'halt');
});
