/**
 * The assistant as a way through the interface (Architecture B.4).
 *
 * These exist because of a specific report: asked to start a new project, the
 * assistant replied about area and dimensions. Nothing in its rule table
 * mentioned projects, so the question fell through to a generic list of things
 * it could not help with either.
 *
 * The tests are phrased the way people ask, not the way the regexes are
 * written. That is the point — a vocabulary that only answers its own phrasing
 * is the failure being fixed, so each case here is a sentence someone would
 * actually type.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SurveyDataModel } from '@surveyor/contracts';
import { runPipeline, ringFromPointOrder } from '@surveyor/engine';

import {
  TASKS,
  capabilitiesMessage,
  findTask,
  respond,
  taskMessage,
  type AssistantContext,
  type Intent,
  type TaskName,
} from '../src/ai/assistant.js';
import { ACTION_KINDS, PANELS, TASK_NAMES, TOOLS, validateProposal } from '../src/ai/intent-schema.js';

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
  siteFeatures: [],
  notes: [],
};

function context(): AssistantContext {
  return { model: MODEL, pipeline: runPipeline(MODEL), suggestions: [] };
}

function intents(question: string): readonly Intent[] {
  return respond(question, context()).actions?.map((action) => action.intent) ?? [];
}

function offersKind(question: string, kind: Intent['kind']): boolean {
  return intents(question).some((intent) => intent.kind === kind);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test('asking to start a new project offers to start a new project', () => {
  // Every phrasing that came to mind for the same request. The original
  // failure was that none of them matched anything at all.
  for (const question of [
    'create a new project',
    'I want to start a new project',
    'how do I create a new project?',
    'can I make another plan',
    'start over',
    'new survey please',
    'begin a fresh drawing',
    'how do i start again',
  ]) {
    assert.ok(offersKind(question, 'new-project'), `no way to start a project from: ${question}`);
  }
});

test('starting a new project is offered, never done in the same breath', () => {
  // The reply from the planner may only ever *open* the question. Confirming
  // is a tap, and the vocabulary a model shares cannot express the tap.
  const kinds = intents('create a new project').map((intent) => intent.kind);
  assert.ok(kinds.includes('new-project'));
  assert.ok(!kinds.includes('confirm-new-project'));
  assert.ok(!(ACTION_KINDS as readonly string[]).includes('confirm-new-project'));
});

// ---------------------------------------------------------------------------
// Guidance across the app
// ---------------------------------------------------------------------------

test('every task the app can do is reachable by asking for it', () => {
  // A guide nothing routes to is a guide nobody reads.
  const unreachable = TASKS.filter((guide) => findTask(guide.title)?.task !== guide.task);
  assert.deepEqual(
    unreachable.map((guide) => guide.task),
    [],
    'these tasks cannot be found by their own title',
  );
});

test('how-to questions get steps, in the words someone would ask them', () => {
  const cases: readonly (readonly [string, TaskName])[] = [
    ['how do I paste my points in?', 'paste-table'],
    ['how do I get my points in?', 'enter-data'],
    ['where do I put my survey data', 'enter-data'],
    ['how do i take a photo of my field book', 'photograph-note'],
    ['how do I enter bearings and distances?', 'traverse'],
    ['how can I draw the boundary myself', 'draw-boundary'],
    ['show me how to measure between two corners', 'measure'],
    ['how do I export a pdf', 'export'],
    ['where do I rename the site', 'name-site'],
    ['how do i undo that', 'undo'],
  ];

  for (const [question, task] of cases) {
    const message = respond(question, context());
    const expected = TASKS.find((guide) => guide.task === task);
    assert.ok(expected, task);
    assert.ok(
      message.text.startsWith(expected.title),
      `"${question}" should be answered with the ${task} guide, got: ${message.text.slice(0, 60)}`,
    );
    // Steps, numbered, not a paragraph telling them to look around.
    assert.match(message.text, /\n1\. /);
  }
});

test('a guide that can be acted on offers the button that acts', () => {
  for (const guide of TASKS) {
    const message = taskMessage(guide.task);
    if (!guide.action) continue;
    assert.deepEqual(
      message.actions?.[0]?.intent,
      guide.action.intent,
      `${guide.task} does not offer its own action`,
    );
  }
});

test('a question about the survey still gets the answer, not a tutorial', () => {
  // Guidance must not swallow the factual questions the assistant was already
  // good at. "What is the area" wants a number, not three steps.
  const area = respond('what is the area?', context());
  assert.match(area.text, /m²/);

  const closure = respond('does it close?', context());
  assert.match(closure.text, /closes/);
});

test('nothing matched offers the things it can do, not a shrug', () => {
  const message = respond('qwertyuiop', context());
  assert.deepEqual(message.text, capabilitiesMessage().text);
  assert.ok((message.actions?.length ?? 0) >= 3, 'the fallback should offer somewhere to go');
});

// ---------------------------------------------------------------------------
// The model shares the same vocabulary
// ---------------------------------------------------------------------------

test('a model can offer guidance, and only for tasks that exist', () => {
  for (const task of TASK_NAMES) {
    const result = validateProposal(
      { message: 'Here is how.', actions: [{ label: 'Show me', kind: 'guide', argument: task }] },
      MODEL,
    );
    assert.equal(result.ok, true, task);
  }

  const invented = validateProposal(
    { message: 'Here is how.', actions: [{ label: 'Do it', kind: 'guide', argument: 'delete-everything' }] },
    MODEL,
  );
  assert.equal(invented.ok, false);
});

test('a model can switch tools, and only to tools that exist', () => {
  for (const tool of TOOLS) {
    const result = validateProposal(
      { message: 'Switching.', actions: [{ label: 'Go', kind: 'tool', argument: tool }] },
      MODEL,
    );
    assert.equal(result.ok, true, tool);
  }

  const invented = validateProposal(
    { message: 'Switching.', actions: [{ label: 'Go', kind: 'tool', argument: 'bulldoze' }] },
    MODEL,
  );
  assert.equal(invented.ok, false);
});

test('the project panel is openable and the panel list has no strays', () => {
  for (const panel of PANELS) {
    const result = validateProposal(
      { message: 'Opening.', actions: [{ label: 'Open', kind: 'open', argument: panel }] },
      MODEL,
    );
    assert.equal(result.ok, true, panel);
  }
  assert.ok((PANELS as readonly string[]).includes('project'));
});
