/**
 * The AI-layer boundary.
 *
 * These tests treat model output as hostile input, because the whole point of
 * the validator is the case where the strict schema did not hold — a schema
 * regression, a proxy rewriting a response, a model that ignores its tool
 * definition. A rejection here is the system working.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SurveyDataModel } from '@surveyor/contracts';

import {
  ACTION_KINDS,
  PROPOSE_ACTIONS_TOOL,
  knownElementIds,
  validateProposal,
} from '../src/ai/intent-schema.js';
import { modelPlanner, summarise } from '../src/ai/planner.js';
import type { AssistantContext } from '../src/ai/assistant.js';
import { runPipeline, ringFromPointOrder } from '@surveyor/engine';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const MODEL: SurveyDataModel = {
  metadata: { jurisdiction: 'uk-land-registry', siteAddress: '25 High Street' },
  crs: {
    code: 'EPSG:27700',
    name: 'OSGB36 / British National Grid',
    datum: 'OSGB36',
    units: 'metre',
    bearingConvention: 'quadrant',
  },
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
};

function context(): AssistantContext {
  return { model: MODEL, pipeline: runPipeline(MODEL), suggestions: [] };
}

function proposal(actions: unknown[]): unknown {
  return { message: 'Here is what I found.', actions };
}

// ---------------------------------------------------------------------------
// The tool definition
// ---------------------------------------------------------------------------

test('the tool schema is strict-eligible', () => {
  const schema = PROPOSE_ACTIONS_TOOL.input_schema;

  // strict:true requires additionalProperties:false and a complete required
  // list on every object in the schema.
  assert.equal(PROPOSE_ACTIONS_TOOL.strict, true);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required], Object.keys(schema.properties));

  const action = schema.properties.actions.items;
  assert.equal(action.additionalProperties, false);
  assert.deepEqual([...action.required], Object.keys(action.properties));
});

test('the schema enumerates exactly the vocabulary the validator accepts', () => {
  const enumerated = PROPOSE_ACTIONS_TOOL.input_schema.properties.actions.items
    .properties.kind.enum;
  assert.deepEqual([...enumerated].sort(), [...ACTION_KINDS].sort());
});

test('the vocabulary cannot express geometry', () => {
  // The guarantee is structural: no field anywhere in the schema accepts a
  // number, so a model cannot supply a coordinate, dimension, or bearing.
  const serialised = JSON.stringify(PROPOSE_ACTIONS_TOOL.input_schema);
  assert.equal(/"type"\s*:\s*"(number|integer)"/.test(serialised), false);
});

// ---------------------------------------------------------------------------
// Accepting good output
// ---------------------------------------------------------------------------

test('a well-formed proposal validates into typed intents', () => {
  const result = validateProposal(
    proposal([
      { label: 'Show the house', kind: 'show', argument: 'bld_1' },
      { label: 'Why does this matter?', kind: 'explain', argument: 'crs' },
      { label: 'Export', kind: 'open', argument: 'export' },
    ]),
    MODEL,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.proposal.message, 'Here is what I found.');
  assert.deepEqual(result.proposal.actions.map((a) => a.intent), [
    { kind: 'show', elementId: 'bld_1' },
    { kind: 'explain', topic: 'crs' },
    { kind: 'open', panel: 'export' },
  ]);
});

test('an empty action list is fine', () => {
  const result = validateProposal(proposal([]), MODEL);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.proposal.actions, []);
});

test('a building proposal carries only a name', () => {
  const result = validateProposal(
    proposal([{ label: 'Add a garage', kind: 'suggest-building', argument: 'Garage' }]),
    MODEL,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.proposal.actions[0]?.intent, {
    kind: 'suggest-building',
    label: 'Garage',
  });
});

// ---------------------------------------------------------------------------
// Rejecting bad output
// ---------------------------------------------------------------------------

test('an off-vocabulary action kind is rejected', () => {
  const result = validateProposal(
    proposal([{ label: 'Delete everything', kind: 'delete-survey', argument: '' }]),
    MODEL,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not an action this app can perform/);
});

test('show is rejected when it points at something not on the drawing', () => {
  // The important case: the model names a plausible-looking id that does not
  // exist. Accepting it would let the assistant reference invented geometry.
  const result = validateProposal(
    proposal([{ label: 'Show the shed', kind: 'show', argument: 'bld_99' }]),
    MODEL,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not on the drawing/);
});

test('show accepts every id that is actually on the drawing', () => {
  for (const id of knownElementIds(MODEL)) {
    const result = validateProposal(
      proposal([{ label: 'Show it', kind: 'show', argument: id }]),
      MODEL,
    );
    assert.equal(result.ok, true, `${id} should be referenceable`);
  }
});

test('an unknown panel or topic is rejected', () => {
  const panel = validateProposal(
    proposal([{ label: 'Open settings', kind: 'open', argument: 'settings' }]),
    MODEL,
  );
  assert.equal(panel.ok, false);

  const topic = validateProposal(
    proposal([{ label: 'Explain', kind: 'explain', argument: 'the meaning of life' }]),
    MODEL,
  );
  assert.equal(topic.ok, false);
});

test('one bad action rejects the whole proposal', () => {
  // Dropping the bad action and keeping the rest would show the user a reply
  // that is partly the model's and partly ours, with no way to tell which.
  const result = validateProposal(
    proposal([
      { label: 'Show the house', kind: 'show', argument: 'bld_1' },
      { label: 'Do something else', kind: 'wipe-disk', argument: '' },
    ]),
    MODEL,
  );
  assert.equal(result.ok, false);
});

test('structurally malformed replies are rejected, not coerced', () => {
  for (const bad of [
    null,
    'a string',
    42,
    {},
    { message: '' },
    { message: 'hi' },
    { message: 'hi', actions: 'not an array' },
    { message: 'hi', actions: [null] },
    { message: 'hi', actions: [{ label: 'x', kind: 'show' }] },
    { message: 'hi', actions: [{ label: '', kind: 'none', argument: '' }] },
    { message: 'hi', actions: [{ label: 'x', kind: 'none', argument: 42 }] },
  ]) {
    const result = validateProposal(bad, MODEL);
    assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('oversized replies are rejected', () => {
  const longMessage = validateProposal(
    { message: 'x'.repeat(5000), actions: [] },
    MODEL,
  );
  assert.equal(longMessage.ok, false);

  const tooManyActions = validateProposal(
    proposal(
      Array.from({ length: 9 }, () => ({ label: 'Go', kind: 'none', argument: '' })),
    ),
    MODEL,
  );
  assert.equal(tooManyActions.ok, false);
});

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

test('the survey summary carries names and structure, never values', () => {
  const summary = summarise(context());

  assert.deepEqual([...summary.pointIds], ['PT1', 'PT2', 'PT3', 'PT4']);
  assert.equal(summary.features[0]?.name, 'House');
  assert.equal(summary.hasClosedBoundary, true);

  // No coordinate, area, bearing or distance may reach the model — anything it
  // is not told, it cannot repeat back as though it were measured.
  const serialised = JSON.stringify(summary);
  assert.equal(serialised.includes('534800'), false);
  assert.equal(serialised.includes('182900'), false);
  assert.equal(/\b600\b/.test(serialised), false);
});

test('a valid model reply becomes an assistant message', async () => {
  const planner = modelPlanner({
    transport: async () =>
      proposal([{ label: 'Show the house', kind: 'show', argument: 'bld_1' }]),
  });

  const message = await planner.reply('where is the house?', context());
  assert.equal(message.role, 'assistant');
  assert.equal(message.text, 'Here is what I found.');
  assert.deepEqual(message.actions?.[0]?.intent, { kind: 'show', elementId: 'bld_1' });
});

test('an invalid model reply falls back to the rules, and says why', async () => {
  const reasons: string[] = [];
  const planner = modelPlanner({
    transport: async () =>
      proposal([{ label: 'Nope', kind: 'exfiltrate', argument: '' }]),
    onFallback: (reason) => reasons.push(reason),
  });

  const message = await planner.reply('what is the area?', context());
  assert.equal(message.role, 'assistant');
  // The rule planner answers the area question, so the user still gets a reply.
  assert.match(message.text, /m²|boundary/i);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? '', /not an action this app can perform/);
});

test('a transport failure falls back rather than surfacing an error', async () => {
  const reasons: string[] = [];
  const planner = modelPlanner({
    transport: async () => {
      throw new Error('endpoint unreachable');
    },
    onFallback: (reason) => reasons.push(reason),
  });

  const message = await planner.reply('what is the area?', context());
  assert.equal(message.role, 'assistant');
  assert.ok(message.text.length > 0);
  assert.deepEqual(reasons, ['endpoint unreachable']);
});

test('a hanging transport times out instead of leaving the user waiting', async () => {
  const reasons: string[] = [];
  const planner = modelPlanner({
    transport: () => new Promise(() => {}),
    onFallback: (reason) => reasons.push(reason),
    timeoutMs: 30,
  });

  const message = await planner.reply('what is the area?', context());
  assert.ok(message.text.length > 0);
  assert.match(reasons[0] ?? '', /did not respond in time/);
});
