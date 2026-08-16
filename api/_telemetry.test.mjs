/**
 * Tests for what the app is allowed to report.
 *
 * There is one property here that matters more than the rest, and it is worth
 * stating plainly: a telemetry event must never carry survey content. Not a
 * coordinate, not a bearing, not an owner's name, not a site address, not a
 * note somebody typed. The console has a far wider audience than any one
 * project — whoever can read it can read every deployment's plans at once — so
 * a single field that leaks one client's parcel into it leaks all of them.
 *
 * The rest of these check that the whitelist is a whitelist: that a field
 * nobody thought about has nowhere to land, rather than being caught by a list
 * of things to strip.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitiseEvent, summarise, SUGGESTION_TYPES, TELEMETRY_KINDS } from './_telemetry.mjs';

const report = (raw) => sanitiseEvent(raw, { userId: 'u1', role: 'surveyor' });

// ---------------------------------------------------------------------------
// Nothing about the ground gets through
// ---------------------------------------------------------------------------

test('survey content cannot be reported, however it is dressed up', async () => {
  /*
   * Every shape a leak would plausibly take — a well-meant "extra context"
   * field, a copy of the model, a nested detail, a stringified blob.
   */
  const attempts = [
    { kind: 'validation', projectId: 'p1', detail: { easting: 544800, northing: 718900 } },
    { kind: 'validation', projectId: 'p1', detail: { coordinates: [[544800, 718900]] } },
    { kind: 'validation', projectId: 'p1', detail: { siteAddress: '15 Adeola Close' } },
    { kind: 'validation', projectId: 'p1', detail: { owner: 'A. Surveyor' } },
    { kind: 'validation', projectId: 'p1', detail: { bearing: 'N 45° 00\' 00" E' } },
    { kind: 'validation', projectId: 'p1', detail: { note: 'fence in poor repair' } },
    { kind: 'validation', projectId: 'p1', model: { points: [{ easting: 1, northing: 2 }] } },
    { kind: 'validation', projectId: 'p1', detail: { blob: JSON.stringify({ easting: 544800 }) } },
    { kind: 'validation', projectId: 'p1', email: 'client@example.com' },
  ];

  for (const attempt of attempts) {
    const event = report(attempt);
    assert.ok(event, `dropped an otherwise valid event: ${JSON.stringify(attempt)}`);

    const serialised = JSON.stringify(event);
    for (const forbidden of [
      '544800',
      '718900',
      'Adeola',
      'A. Surveyor',
      '45°',
      'fence in poor repair',
      'client@example.com',
    ]) {
      assert.equal(
        serialised.includes(forbidden),
        false,
        `"${forbidden}" survived into ${serialised}`,
      );
    }
  }
});

test('a stored event contains only the fields the console reads', async () => {
  const event = report({
    kind: 'validation',
    projectId: 'p1',
    detail: { status: 'ready', codes: ['closure'], surprise: 'anything at all' },
    extra: 'nowhere to go',
  });

  // Built field by field into a fresh object, so an invented property has no
  // landing place rather than needing to be recognised and removed.
  assert.deepEqual(Object.keys(event).sort(), ['at', 'detail', 'kind', 'projectId', 'role', 'userId']);
  assert.deepEqual(Object.keys(event.detail).sort(), ['codes', 'status']);
});

test('the identity comes from the session, never from the body', async () => {
  const event = sanitiseEvent(
    { kind: 'export', projectId: 'p1', userId: 'somebody-else', role: 'admin' },
    { userId: 'u1', role: 'surveyor' },
  );
  assert.equal(event.userId, 'u1');
  assert.equal(event.role, 'surveyor');
});

// ---------------------------------------------------------------------------
// The whitelist
// ---------------------------------------------------------------------------

test('an unknown kind is dropped entirely', async () => {
  for (const kind of ['anything', 'plan-contents', '', null, undefined, 42, 'VALIDATION']) {
    assert.equal(report({ kind, projectId: 'p1' }), null, `accepted kind ${String(kind)}`);
  }
  for (const kind of TELEMETRY_KINDS) {
    assert.ok(report({ kind, projectId: 'p1' }), `rejected its own kind ${kind}`);
  }
});

test('a project id that is not an id is refused', async () => {
  // The check exists because "opaque identifier" is exactly the field somebody
  // eventually puts a site address in.
  for (const projectId of [
    '15 Adeola Close, Ikeja',
    'x'.repeat(200),
    'has spaces',
    { id: 'p1' },
    123,
  ]) {
    assert.equal(report({ kind: 'export', projectId }), null, `accepted ${String(projectId)}`);
  }
  assert.ok(report({ kind: 'export', projectId: 'p_abc-123.4' }));
  // No project at all is fine: not everything reported is about one.
  assert.ok(report({ kind: 'export' }));
});

test('a detail field that fails its check is dropped, and the event survives', async () => {
  const event = report({
    kind: 'pipeline',
    projectId: 'p1',
    detail: { stage: 'validation', ms: -5, format: 'exe', confidence: 12 },
  });

  // The event is still evidence that something happened, which is the part
  // the console cannot reconstruct later.
  assert.ok(event);
  assert.equal(event.detail.stage, 'validation');
  assert.equal('ms' in event.detail, false);
  assert.equal('format' in event.detail, false);
  assert.equal('confidence' in event.detail, false);
});

test('only known suggestion types are recorded', async () => {
  for (const suggestion of SUGGESTION_TYPES) {
    const event = report({ kind: 'suggestion-offered', detail: { suggestion } });
    assert.equal(event.detail.suggestion, suggestion);
  }
  const invented = report({ kind: 'suggestion-offered', detail: { suggestion: 'invented' } });
  assert.equal('suggestion' in invented.detail, false);
});

test('a reason cannot smuggle a sentence through', async () => {
  // Reasons are slugs. Left free-form, this is where a stack trace or an
  // error message containing a filename and a client name would end up.
  const wordy = report({
    kind: 'export-failed',
    detail: { reason: 'failed to write /home/ada/plans/15-adeola-close.pdf' },
  });
  assert.equal('reason' in wordy.detail, false);

  const slug = report({ kind: 'export-failed', detail: { reason: 'font-missing' } });
  assert.equal(slug.detail.reason, 'font-missing');
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('acceptance counts an edited suggestion as accepted, and reports it separately', async () => {
  const events = [
    { kind: 'suggestion-offered', detail: { suggestion: 'title' } },
    { kind: 'suggestion-offered', detail: { suggestion: 'title' } },
    { kind: 'suggestion-offered', detail: { suggestion: 'title' } },
    { kind: 'suggestion-offered', detail: { suggestion: 'title' } },
    { kind: 'suggestion-accepted', detail: { suggestion: 'title' } },
    { kind: 'suggestion-edited', detail: { suggestion: 'title' } },
    { kind: 'suggestion-rejected', detail: { suggestion: 'title' } },
  ].map((raw) => report(raw));

  const [title] = summarise(events).suggestions;
  /*
   * Kept and corrected still counts as kept — the surveyor wanted it there.
   * The edit rate is reported on its own because it is the number that says
   * the suggestion is nearly right, which is a different problem from one
   * being refused outright.
   */
  assert.equal(title.acceptanceRate, 0.5);
  assert.equal(title.editRate, 0.25);
});

test('the summary never divides by nothing', async () => {
  const empty = summarise([]);
  assert.equal(empty.events, 0);
  assert.equal(empty.exportFailureRate, null);
  assert.deepEqual(empty.suggestions, []);
  assert.deepEqual(empty.stages, []);
});

test('stage timings report the worst case as well as the average', async () => {
  const events = [
    { kind: 'pipeline', detail: { stage: 'drawing', ms: 10 } },
    { kind: 'pipeline', detail: { stage: 'drawing', ms: 30 } },
    { kind: 'pipeline', detail: { stage: 'drawing', ms: 3200 } },
  ].map((raw) => report(raw));

  const [drawing] = summarise(events).stages;
  // The average alone hides the one run that took three seconds, which is the
  // run somebody was sitting in front of.
  assert.equal(drawing.runs, 3);
  assert.equal(drawing.worstMs, 3200);
  assert.ok(drawing.averageMs > 1000);
});
