/**
 * Semantic intent classification.
 *
 * The mechanism these replace was keyword matching, which failed the only way
 * it could: "size of the land" matched and "size of this land" did not. The
 * model now makes that judgement, so what is testable — and what these test —
 * is everything around it: that a classification is checked before it is
 * believed, that confidence decides whether to act or ask, that in-scope and
 * out-of-scope go different places, and that no reading of any classification
 * lets a model put a number on the plan.
 *
 * A rejection here is the system working.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SurveyDataModel } from '@surveyor/contracts';
import { runPipeline, ringFromPointOrder } from '@surveyor/engine';

import { CLASSIFY_TOOL, validateClassification } from '../src/ai/classification.js';
import { routeClassification } from '../src/ai/route.js';
import { CAPABILITIES, COMPUTED_CAPABILITIES, answer, type Capability } from '../src/ai/scope.js';
import { modelPlanner, summarise, HISTORY_TURNS } from '../src/ai/planner.js';
import { TASKS, type AssistantContext } from '../src/ai/assistant.js';

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

/** A complete, valid classification; individual tests vary one field. */
function classification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    understanding: 'You want to know how big the parcel is.',
    scope: 'in-scope',
    capability: 'parcel-size',
    argument: '',
    confidence: 'high',
    message: 'Here you go.',
    clarification_question: '',
    clarification_options: [],
    actions: [],
    ...overrides,
  };
}

function route(overrides: Record<string, unknown> = {}) {
  const result = validateClassification(classification(overrides), MODEL);
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  if (!result.ok) throw new Error('unreachable');
  return routeClassification(result.classification, result.actions, context());
}

// ---------------------------------------------------------------------------
// The tool definition
// ---------------------------------------------------------------------------

test('the classifier schema is strict-eligible', () => {
  const schema = CLASSIFY_TOOL.input_schema;
  assert.equal(CLASSIFY_TOOL.strict, true);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
});

test('the classifier cannot express a survey value', () => {
  // The guarantee is structural, not instructional: no field anywhere in the
  // schema accepts a number, so no classification can carry a coordinate, a
  // distance or an area however the model is prompted.
  const serialised = JSON.stringify(CLASSIFY_TOOL.input_schema);
  assert.equal(/"type"\s*:\s*"(number|integer)"/.test(serialised), false);
});

test('the schema enumerates exactly the capabilities the router implements', () => {
  const enumerated = CLASSIFY_TOOL.input_schema.properties.capability.enum;
  assert.deepEqual([...enumerated].sort(), [...CAPABILITIES, 'none'].sort());
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a well-formed classification validates', () => {
  const result = validateClassification(classification(), MODEL);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.classification.capability, 'parcel-size');
  assert.equal(result.classification.confidence, 'high');
  assert.equal(result.classification.scope, 'in-scope');
});

test('an invented capability is rejected', () => {
  const result = validateClassification(
    classification({ capability: 'delete-the-survey' }),
    MODEL,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not something this app can do/);
});

test('a capability argument is checked against what exists', () => {
  assert.equal(
    validateClassification(classification({ capability: 'guide', argument: 'fly-a-kite' }), MODEL).ok,
    false,
  );
  assert.equal(
    validateClassification(classification({ capability: 'explain', argument: 'astrology' }), MODEL).ok,
    false,
  );
  assert.equal(
    validateClassification(classification({ capability: 'tool', argument: 'bulldoze' }), MODEL).ok,
    false,
  );
  assert.equal(
    validateClassification(classification({ capability: 'open', argument: 'admin' }), MODEL).ok,
    false,
  );

  // And the real ones pass.
  for (const task of TASKS) {
    assert.equal(
      validateClassification(classification({ capability: 'guide', argument: task.task }), MODEL).ok,
      true,
      task.task,
    );
  }
});

test('in scope with nothing to handle it is a shrug, and is rejected', () => {
  // A classification that claims the question is answerable and then names
  // nothing that answers it is the failure this whole mechanism replaces.
  const result = validateClassification(
    classification({ scope: 'in-scope', capability: 'none' }),
    MODEL,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /named nothing that handles it/);
});

test('offering readings without asking anything is rejected', () => {
  const result = validateClassification(
    classification({
      scope: 'ambiguous',
      capability: 'none',
      clarification_question: '',
      clarification_options: [{ label: 'The area', capability: 'parcel-size', argument: '' }],
    }),
    MODEL,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /without asking anything/);
});

test('structurally malformed classifications are rejected, not coerced', () => {
  for (const bad of [
    null,
    'a string',
    42,
    {},
    classification({ scope: 'maybe' }),
    classification({ confidence: 'very' }),
    classification({ understanding: '' }),
    classification({ message: '' }),
    classification({ understanding: 'x'.repeat(500) }),
    classification({ message: 'x'.repeat(5000) }),
    classification({ actions: 'not an array' }),
    classification({ actions: [null] }),
    classification({ actions: [{ label: 'Go' }] }),
    classification({ actions: [{ label: 'Go', capability: 'nope', argument: '' }] }),
  ]) {
    assert.equal(validateClassification(bad, MODEL).ok, false, JSON.stringify(bad)?.slice(0, 80));
  }
});

// ---------------------------------------------------------------------------
// Routing on confidence
// ---------------------------------------------------------------------------

test('a confident in-scope reading is answered by the engine, not the model', () => {
  // The model's message says "Here you go." and the reply does not, because
  // the responder wrote it off the pipeline.
  const message = route({ capability: 'parcel-size', confidence: 'high' });
  assert.match(message.text, /600\.0 m²/);
  assert.doesNotMatch(message.text, /Here you go/);
});

test('a medium-confidence reading is acted on but declares what it assumed', () => {
  const message = route({
    capability: 'parcel-size',
    confidence: 'medium',
    understanding: 'Taking that as how big the parcel is.',
  });
  assert.match(message.text, /Taking that as how big the parcel is\./);
  assert.match(message.text, /600\.0 m²/);
});

test('low confidence asks instead of guessing', () => {
  // Answering the wrong question confidently is worse than a short question
  // back — the surveyor is the one who knows which reading was meant.
  const message = route({
    capability: 'parcel-size',
    confidence: 'low',
    clarification_question: 'Do you mean the area, or how far across it is?',
    clarification_options: [
      { label: 'The area', capability: 'parcel-size', argument: '' },
      { label: 'How to measure it', capability: 'guide', argument: 'measure' },
    ],
  });

  assert.equal(message.text, 'Do you mean the area, or how far across it is?');
  assert.doesNotMatch(message.text, /m²/, 'a question should not also answer itself');
  assert.equal(message.actions?.length, 2);
  assert.equal(message.actions?.[0]?.label, 'The area');
});

test('an ambiguous request asks even when the model was confident', () => {
  // Confidence in a reading of an ambiguous question is confidence in a coin
  // toss. The app decides whether to act, not the party that guessed.
  const message = route({
    scope: 'ambiguous',
    capability: 'none',
    confidence: 'high',
    clarification_question: 'Which one did you mean?',
    clarification_options: [
      { label: 'The parcel', capability: 'parcel-size', argument: '' },
      { label: 'The house', capability: 'site-features', argument: '' },
    ],
  });
  assert.equal(message.text, 'Which one did you mean?');
  assert.doesNotMatch(message.text, /m²/);
});

test('an out-of-scope question is declined in the model’s own words', () => {
  const message = route({
    scope: 'out-of-scope',
    capability: 'none',
    confidence: 'high',
    message: 'Whether you can build there is a planning question, and not one I can answer. I can tell you what the survey shows.',
  });

  assert.match(message.text, /planning question/);
  assert.doesNotMatch(message.text, /m²/, 'declining should not answer something else instead');
  assert.equal(message.actions?.[0]?.label, 'What can you help with?');
});

test('every capability routes to something, with no survey value from the model', () => {
  const ctx = context();
  for (const capability of CAPABILITIES) {
    const message = answer(capability as Capability, argumentFor(capability), ctx, 'MODEL PROSE');
    assert.ok(message.text.length > 0, capability);

    // For anything that carries figures, the model's prose must not appear —
    // the responder wrote the whole reply.
    if (COMPUTED_CAPABILITIES.has(capability as Capability)) {
      assert.doesNotMatch(message.text, /MODEL PROSE/, capability);
    }
  }
});

function argumentFor(capability: string): string {
  if (capability === 'guide') return 'export';
  if (capability === 'explain') return 'area';
  if (capability === 'tool') return 'measure';
  if (capability === 'open') return 'data';
  return '';
}

// ---------------------------------------------------------------------------
// Conversation and fallback
// ---------------------------------------------------------------------------

test('recent turns are sent, bounded, oldest first', async () => {
  let seen: { history?: readonly { role: string; text: string }[] } = {};
  const planner = modelPlanner({
    transport: async (request) => {
      seen = request;
      return classification();
    },
  });

  const history = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `turn ${i}`,
  }));
  await planner.reply('and the area?', context(), history);

  assert.equal(seen.history?.length, HISTORY_TURNS);
  assert.equal(seen.history?.[seen.history.length - 1]?.text, 'turn 19');
});

test('the survey summary still carries names and structure, never values', () => {
  const summary = summarise(context());
  const serialised = JSON.stringify(summary);
  assert.equal(serialised.includes('534800'), false);
  assert.equal(serialised.includes('182900'), false);
  assert.equal(/\b600\b/.test(serialised), false);
});

test('a rejected classification falls back to the keyword planner, and says why', async () => {
  const reasons: string[] = [];
  const planner = modelPlanner({
    transport: async () => classification({ capability: 'exfiltrate' }),
    onFallback: (reason) => reasons.push(reason),
  });

  const message = await planner.reply('what is the area?', context());
  assert.match(message.text, /m²/, 'the surveyor should still get an answer');
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? '', /not something this app can do/);
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
  assert.match(message.text, /m²/);
  assert.deepEqual(reasons, ['endpoint unreachable']);
});

test('a hanging transport times out instead of leaving the surveyor waiting', async () => {
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

test('an accepted classification is reported, so what it understood is visible', async () => {
  const seen: string[] = [];
  const planner = modelPlanner({
    transport: async () => classification({ understanding: 'How big the parcel is.' }),
    onClassified: (c) => seen.push(`${c.capability}/${c.confidence}/${c.understanding}`),
  });

  await planner.reply('how many meters is this land', context());
  assert.deepEqual(seen, ['parcel-size/high/How big the parcel is.']);
});
