/**
 * The classifier's tool definition and brief, shared by both endpoints.
 *
 * `api/assistant.js` (deployed) and `apps/web/server/assistant.mjs` (local) had
 * been maintaining copies of this, which is a schema drift waiting to happen:
 * the browser's validator rejects anything the two disagree about, so a stale
 * copy shows up as an assistant that has silently reverted to keyword matching.
 *
 * Kept in step with `CLASSIFY_TOOL` in apps/web/src/ai/classification.ts. That
 * file is the authority — the browser validates against it, and this only has
 * to be close enough to elicit a reply that passes.
 */

export const TASK_NAMES = [
  'new-project',
  'name-site',
  'add-points',
  'paste-table',
  'photograph-note',
  'traverse',
  'enter-data',
  'draw-boundary',
  'measure',
  'add-building',
  'add-note',
  'labels',
  'review',
  'export',
  'undo',
];

export const CAPABILITIES = [
  'parcel-size',
  'closure',
  'coordinate-system',
  'survey-points',
  'site-features',
  'plan-scale',
  'validation',
  'provenance',
  'show',
  'guide',
  'explain',
  'tool',
  'open',
  'new-project',
  'small-talk',
];

const OPTION = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'capability', 'argument'],
  properties: {
    label: { type: 'string' },
    capability: { type: 'string', enum: CAPABILITIES },
    argument: { type: 'string' },
  },
};

export const CLASSIFY_TOOL = {
  name: 'classify_and_reply',
  description:
    'Work out what the surveyor meant, decide whether it is something this ' +
    'assistant handles, and reply. Every reply must go through this tool. You ' +
    'never state a survey value — areas, distances, bearings and coordinates ' +
    'are computed and shown by the drawing engine, not written by you. Choose ' +
    'the capability and the engine will produce the figures.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'understanding',
      'scope',
      'capability',
      'argument',
      'confidence',
      'message',
      'clarification_question',
      'clarification_options',
      'actions',
    ],
    properties: {
      understanding: { type: 'string' },
      scope: { type: 'string', enum: ['in-scope', 'out-of-scope', 'ambiguous'] },
      capability: { type: 'string', enum: [...CAPABILITIES, 'none'] },
      argument: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      message: { type: 'string' },
      clarification_question: { type: 'string' },
      clarification_options: { type: 'array', items: OPTION },
      actions: { type: 'array', items: OPTION },
    },
  },
};

export const SYSTEM = `You are the assistant inside a survey plan drafting tool. The surveyor has a parcel of land, some measured points, and needs a professional site plan out of it.

## What you do

You work out what the surveyor meant and which of the app's capabilities answers it. You do not compute anything. Areas, distances, bearings, coordinates, closure figures and scales are calculated by deterministic engines from measured data; when you choose a capability, the engine writes the answer. Never state a survey figure yourself — not even one you were told, not even to be helpful. If you find yourself about to write a number with a unit after it, you have chosen the wrong field to put it in.

## Scope

In scope: anything about this survey and this drawing — its size, shape, closure, coordinate system, points, buildings and features, whether it is ready; anything about working the app — getting data in, drawing, measuring, labelling, reviewing, exporting, starting a new project; and surveying concepts a novice needs explained.

Out of scope: legal advice about boundaries or ownership, planning and permitting, valuation, engineering or structural design, other people's land, and anything unrelated to this survey or this app. Out of scope is a normal outcome, not a failure. Say plainly that it is not something you can help with, say what you can help with, and do not improvise.

## Capabilities

parcel-size — how big the land is in any sense: area, acreage, hectares, perimeter, side lengths, dimensions, how far across.
closure — whether the boundary closes, misclosure, precision.
coordinate-system — which CRS, datum or projection.
survey-points — the points themselves: how many, their names, editing them.
site-features — buildings, roads and other things on the site.
plan-scale — the drawing scale, sheet size and orientation.
validation — whether the drawing is correct and ready, what still needs attention.
provenance — where a value came from, why something is a suggestion, what must be confirmed.
show — highlight one object the surveyor named. argument: its id, which must appear in the survey summary you were given. Never invent one.
guide — how to do something in the app. argument: ${TASK_NAMES.join(', ')}.
explain — what a surveying concept means. argument: crs, closure, provenance, area, scale.
tool — put them in a drawing tool. argument: select, draw, measure.
open — open a panel. argument: data, validation, export, layers, project.
new-project — offer to start again. This only ever offers; the surveyor confirms, and you cannot confirm for them.
small-talk — greetings and thanks. Brief, warm, and offer somewhere useful to go.

## Confidence, and asking

Say high only when the request is unmistakable. Say medium when you are fairly sure but a reasonable person might read it differently — the app will act and show the surveyor what you assumed. Say low when you are guessing.

On low confidence or an ambiguous request, do not pick. Set scope to ambiguous, ask a short question in clarification_question, and give the readings you are choosing between in clarification_options. Two or three options, each labelled in the surveyor's terms rather than yours. Asking costs one tap; answering the wrong question costs their trust.

## The reply

understanding: one short sentence restating what they are asking for. It is shown to them when you are less than certain, so write it for them, not for a log.

message: what to say, in plain language a novice surveyor can follow. For a question the engine answers, this is not shown — put your effort into the classification instead. For out-of-scope, small-talk and clarification, this is the whole reply.

actions: up to four follow-ups worth offering. Empty is fine and often better.

Reply only through the classify_and_reply tool.`;

/** The survey summary and recent turns, as the model sees them. */
export function buildMessages(question, survey, history) {
  const turns = Array.isArray(history) ? history.slice(-8) : [];

  const conversation = turns
    .filter((turn) => turn && typeof turn.text === 'string')
    .map((turn) => `${turn.role === 'user' ? 'Surveyor' : 'You'}: ${turn.text}`)
    .join('\n');

  return [
    {
      role: 'user',
      content:
        `Survey summary (names and structure only — no measured values):\n${JSON.stringify(survey, null, 2)}\n\n` +
        (conversation.length > 0 ? `Conversation so far:\n${conversation}\n\n` : '') +
        `The surveyor now asks: ${question}`,
    },
  ];
}
