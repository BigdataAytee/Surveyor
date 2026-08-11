/**
 * Structured intent classification, and the validator that enforces it.
 *
 * The assistant used to decide what a question was about by matching phrases.
 * That failed in the only way it could: "size of the land" matched and "size of
 * this land" did not, one word apart, and the reply was a menu. No amount of
 * additional patterns fixes that, because the space of sentences people write
 * is not enumerable.
 *
 * So the judgement moves to a model, and the judgement is *all* that moves. The
 * model returns a classification — what it thinks the surveyor meant, which
 * capability that maps to, whether it is in scope, and how sure it is — and the
 * app decides what to do with it. Three outcomes, in `route`:
 *
 *   in-scope, confident   → run the capability's responder, which reads the
 *                           figures off the pipeline
 *   ambiguous or unsure   → ask, with the readings offered as buttons
 *   out of scope          → say so, and say what it is for
 *
 * The thing the model never gets is the number. `answer` in scope.ts produces
 * every survey value from the engine, so a classification can send the reply to
 * the wrong subject but cannot put a wrong figure in it. Misunderstanding a
 * question is recoverable; a plausible wrong area on a plan someone signs is
 * not.
 */

import type { SurveyDataModel } from '@surveyor/contracts';

import { EXPLANATIONS, TASKS, type PanelName, type TaskName } from './assistant.js';
import {
  CAPABILITIES,
  CAPABILITY_BRIEF,
  CONFIDENCE_LEVELS,
  SCOPE_VERDICTS,
  type Capability,
  type Classification,
  type Confidence,
  type ScopeVerdict,
} from './scope.js';

const PANELS: readonly PanelName[] = ['data', 'validation', 'export', 'layers', 'project'];
const TOOLS = ['select', 'draw', 'measure'] as const;

const MAX_UNDERSTANDING = 200;
const MAX_MESSAGE = 1200;
const MAX_OPTIONS = 4;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * The single tool the classifier may call.
 *
 * `strict: true` is a top-level field on the tool definition and requires
 * `additionalProperties: false` plus a complete `required` list on every
 * object. Note what is still absent from the whole schema: any numeric field.
 * The classifier cannot express a coordinate, a distance or an area, which is
 * not a matter of instruction but of shape.
 */
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
      understanding: {
        type: 'string',
        description:
          'One short sentence restating what the surveyor is actually asking ' +
          'for, in your own words. Shown to them when you are less than sure.',
      },
      scope: {
        type: 'string',
        enum: [...SCOPE_VERDICTS],
        description:
          'in-scope when this is about the survey, the drawing or the app. ' +
          'out-of-scope when it is not something this assistant handles. ' +
          'ambiguous when it could reasonably be two different requests.',
      },
      capability: {
        type: 'string',
        enum: [...CAPABILITIES, 'none'],
        description:
          'Which capability answers this. Use "none" when out of scope or ' +
          'ambiguous. ' +
          Object.entries(CAPABILITY_BRIEF)
            .map(([name, brief]) => `"${name}": ${brief}`)
            .join(' '),
      },
      argument: {
        type: 'string',
        description:
          `For "guide", the task: ${TASKS.map((t) => t.task).join(', ')}. ` +
          `For "explain", the topic: ${Object.keys(EXPLANATIONS).join(', ')}. ` +
          `For "tool": ${TOOLS.join(', ')}. For "open": ${PANELS.join(', ')}. ` +
          'Otherwise an empty string.',
      },
      confidence: {
        type: 'string',
        enum: [...CONFIDENCE_LEVELS],
        description:
          'high when the request is unmistakable. medium when you are fairly ' +
          'sure but a reasonable person might read it differently. low when ' +
          'you are guessing — say low rather than guessing confidently.',
      },
      message: {
        type: 'string',
        description:
          'What to say. Plain language a novice surveyor can follow. Do not ' +
          'state any survey figure here — for a question about the survey the ' +
          'engine writes the answer and this is not shown.',
      },
      clarification_question: {
        type: 'string',
        description:
          'When ambiguous or unsure, the question to ask back. Empty string ' +
          'otherwise.',
      },
      clarification_options: {
        type: 'array',
        description:
          'The readings you are choosing between, as buttons. Empty unless ' +
          'you are asking for clarification.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'capability', 'argument'],
          properties: {
            label: { type: 'string', description: 'Button text, a few words.' },
            capability: { type: 'string', enum: [...CAPABILITIES] },
            argument: { type: 'string' },
          },
        },
      },
      actions: {
        type: 'array',
        description: 'Follow-up buttons to offer. May be empty.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'capability', 'argument'],
          properties: {
            label: { type: 'string' },
            capability: { type: 'string', enum: [...CAPABILITIES] },
            argument: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ClassificationOutcome =
  | { readonly ok: true; readonly classification: Classification; readonly actions: readonly ClassifiedAction[] }
  | { readonly ok: false; readonly reason: string };

export interface ClassifiedAction {
  readonly label: string;
  readonly capability: Capability;
  readonly argument: string;
}

/**
 * Turn raw tool input into a checked classification.
 *
 * Written as though the input were arbitrary JSON from a stranger, because in
 * the cases that matter it is: a schema regression, a proxy rewriting a
 * response, a model ignoring its tool definition. A classification that does
 * not validate is refused whole — a half-applied one would leave the reply
 * partly the model's and partly ours with no way to tell which.
 */
export function validateClassification(
  raw: unknown,
  model: SurveyDataModel,
): ClassificationOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'The assistant returned something that is not a reply.' };
  }
  const input = raw as Record<string, unknown>;

  const understanding = text(input.understanding, MAX_UNDERSTANDING);
  if (understanding === null) {
    return { ok: false, reason: 'The assistant did not say what it understood.' };
  }

  // Empty is legitimate when the classifier is asking rather than answering:
  // the clarification question *is* the message, and demanding a second one
  // forces the model to invent prose nobody will read. What is not legitimate
  // is a reply with neither.
  const message = text(input.message, MAX_MESSAGE) ?? '';
  const clarificationQuestion =
    typeof input.clarification_question === 'string' ? input.clarification_question.trim() : '';

  if (message.length === 0 && clarificationQuestion.length === 0) {
    return { ok: false, reason: 'The assistant returned nothing to say.' };
  }
  if (clarificationQuestion.length > MAX_MESSAGE) {
    return { ok: false, reason: 'The assistant’s question was too long to show.' };
  }

  if (!isOneOf(input.scope, SCOPE_VERDICTS)) {
    return { ok: false, reason: `"${String(input.scope)}" is not a scope verdict.` };
  }
  if (!isOneOf(input.confidence, CONFIDENCE_LEVELS)) {
    return { ok: false, reason: `"${String(input.confidence)}" is not a confidence level.` };
  }

  const scope: ScopeVerdict = input.scope;
  const confidence: Confidence = input.confidence;

  const rawCapability = input.capability;
  if (typeof rawCapability !== 'string') {
    return { ok: false, reason: 'The assistant returned no capability.' };
  }
  const capability =
    rawCapability === 'none'
      ? null
      : isOneOf(rawCapability, CAPABILITIES)
        ? rawCapability
        : undefined;
  if (capability === undefined) {
    return { ok: false, reason: `"${rawCapability}" is not something this app can do.` };
  }

  const argument = typeof input.argument === 'string' ? input.argument : '';
  if (capability !== null) {
    const check = checkArgument(capability, argument, model);
    if (!check.ok) return check;
  }

  // In scope with no capability is not a classification, it is a shrug — and a
  // shrug dressed as an answer is what this whole mechanism replaces.
  if (scope === 'in-scope' && capability === null) {
    return { ok: false, reason: 'The assistant called it in scope but named nothing that handles it.' };
  }

  const options = validateOptions(input.clarification_options, MAX_OPTIONS, model);
  if (!options.ok) return options;

  const actions = validateOptions(input.actions, MAX_OPTIONS, model);
  if (!actions.ok) return actions;

  // Asking for clarification means asking something. An empty question with
  // options is a dialog with no prompt.
  if (options.actions.length > 0 && clarificationQuestion.length === 0) {
    return { ok: false, reason: 'The assistant offered readings without asking anything.' };
  }

  return {
    ok: true,
    classification: {
      understanding,
      scope,
      capability,
      argument,
      confidence,
      message,
      clarification:
        clarificationQuestion.length > 0
          ? { question: clarificationQuestion, options: options.actions }
          : null,
    },
    actions: actions.actions,
  };
}

function checkArgument(
  capability: Capability,
  argument: string,
  model: SurveyDataModel,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  switch (capability) {
    case 'show':
      // The case that matters: a model naming a plausible id that does not
      // exist. Accepting it would let the assistant point the drawing at
      // geometry nobody surveyed.
      return knownElementIds(model).has(argument)
        ? { ok: true }
        : { ok: false, reason: `"${argument}" is not on the drawing.` };
    case 'guide':
      return TASKS.some((task) => task.task === argument)
        ? { ok: true }
        : { ok: false, reason: `There is no "${argument}" task to walk through.` };
    case 'explain':
      return argument in EXPLANATIONS
        ? { ok: true }
        : { ok: false, reason: `There is nothing to explain about "${argument}".` };
    case 'tool':
      return (TOOLS as readonly string[]).includes(argument)
        ? { ok: true }
        : { ok: false, reason: `There is no "${argument}" tool.` };
    case 'open':
      return (PANELS as readonly string[]).includes(argument)
        ? { ok: true }
        : { ok: false, reason: `There is no "${argument}" panel to open.` };
    default:
      return { ok: true };
  }
}

function validateOptions(
  raw: unknown,
  max: number,
  model: SurveyDataModel,
):
  | { readonly ok: true; readonly actions: readonly ClassifiedAction[] }
  | { readonly ok: false; readonly reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'A malformed list of options.' };
  if (raw.length > max) return { ok: false, reason: 'More options than the sheet allows.' };

  const actions: ClassifiedAction[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: 'An option that is not an option.' };
    }
    const option = entry as Record<string, unknown>;
    const label = text(option.label, 60);
    if (label === null) return { ok: false, reason: 'An option with no label.' };
    if (!isOneOf(option.capability, CAPABILITIES)) {
      return { ok: false, reason: `"${String(option.capability)}" is not something this app can do.` };
    }
    const argument = typeof option.argument === 'string' ? option.argument : '';
    const check = checkArgument(option.capability, argument, model);
    if (!check.ok) return check;
    actions.push({ label, capability: option.capability, argument });
  }
  return { ok: true, actions };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Ids the assistant is allowed to point at: points, features and rings. */
export function knownElementIds(model: SurveyDataModel): ReadonlySet<string> {
  return new Set<string>([
    ...model.points.map((point) => point.id),
    ...model.siteFeatures.map((feature) => feature.id),
    ...model.boundary.map((ring) => ring.id),
  ]);
}

/** Capability arguments the app understands, exposed for the router's typing. */
export type { TaskName };
