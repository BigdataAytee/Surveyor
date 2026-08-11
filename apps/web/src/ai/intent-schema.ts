/**
 * The intent vocabulary as a tool schema, and the validator that enforces it.
 *
 * This is the file that lets a language model drive the assistant without
 * gaining any authority it should not have. Two mechanisms, and the second is
 * the one that matters:
 *
 * 1. The model is *constrained* by a strict tool schema — enumerated `kind`
 *    values, `additionalProperties: false`, every field required. A well-behaved
 *    model cannot express an off-vocabulary action.
 * 2. The model is *checked* by `validateProposal` below, which re-derives every
 *    action from scratch and rejects anything it cannot account for. A
 *    misbehaving model, a schema regression, or a compromised transport
 *    produces a rejection, not an action.
 *
 * The schema is the seatbelt; the validator is the crumple zone. Neither is
 * sufficient alone — strict schemas are a model-side guarantee, and this code
 * has to hold even when that guarantee doesn't.
 *
 * Note what the vocabulary cannot express: there is no coordinate, dimension,
 * bearing, or area anywhere in it. A model can ask for a building to be
 * *proposed*; the engines decide where it goes and how big it is, and the user
 * confirms it. That is the same authority the rule-based planner has.
 */

import type { SurveyDataModel } from '@surveyor/contracts';

import {
  EXPLANATIONS,
  TASKS,
  type ExplainTopic,
  type Intent,
  type TaskName,
} from './assistant.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * What a model is allowed to propose.
 *
 * `guide`, `tool` and `new-project` are here because an assistant that cannot
 * help you work the app is not much of an assistant — but note what is *not*
 * here: `confirm-new-project`. `new-project` opens the question of replacing
 * the user's work; only a tap answers it. A model that could emit the
 * confirmation could destroy a survey by misreading a sentence.
 */
export const ACTION_KINDS = [
  'suggest-building',
  'suggest-note',
  'show',
  'open',
  'explain',
  'guide',
  'tool',
  'new-project',
  'none',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export const PANELS = ['data', 'validation', 'export', 'layers', 'project'] as const;
export const EXPLAIN_TOPICS = Object.keys(EXPLANATIONS) as ExplainTopic[];
export const TOOLS = ['select', 'draw', 'measure'] as const;
export const TASK_NAMES = TASKS.map((guide) => guide.task);

/** Free-text label length cap, so a label cannot become a wall of prose. */
const MAX_LABEL = 40;
const MAX_MESSAGE = 1200;
const MAX_ACTIONS = 4;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * The single tool the model may call.
 *
 * `strict: true` sits at the top level of the tool definition — not inside
 * `tool_choice` — and requires `additionalProperties: false` plus a complete
 * `required` list on every object. With it, tool input is guaranteed to
 * validate against this schema.
 *
 * `argument` is a flat string rather than a per-kind union: strict schemas
 * support `anyOf`, but a discriminated union here would push the real checking
 * into the schema, where a model-side guarantee is doing safety work. Keeping
 * the shape simple and validating the (kind, argument) pairing in code keeps
 * that check on our side of the boundary.
 */
export const PROPOSE_ACTIONS_TOOL = {
  name: 'propose_actions',
  description:
    'Reply to the surveyor and offer up to four follow-up actions. Every ' +
    'reply must go through this tool. You cannot state survey values — ' +
    'bearings, distances, areas, coordinates — because they are calculated ' +
    'and shown by the drawing engine, not written by you.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['message', 'actions'],
    properties: {
      message: {
        type: 'string',
        description:
          'What to say to the surveyor. Plain language, no invented numbers.',
      },
      actions: {
        type: 'array',
        description: 'Follow-up actions to offer as buttons. May be empty.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'kind', 'argument'],
          properties: {
            label: {
              type: 'string',
              description: 'Button text, a few words at most.',
            },
            kind: {
              type: 'string',
              enum: [...ACTION_KINDS],
              description: 'Which action this button performs.',
            },
            argument: {
              type: 'string',
              description:
                'For "suggest-building", the building name. For "show", the ' +
                'id of an object already on the drawing. For "open", one of ' +
                `${PANELS.join(', ')}. For "explain", one of ` +
                `${EXPLAIN_TOPICS.join(', ')}. For "guide", one of ` +
                `${TASK_NAMES.join(', ')}. For "tool", one of ` +
                `${TOOLS.join(', ')}. Otherwise an empty string.`,
            },
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidatedAction {
  readonly label: string;
  readonly intent: Intent;
}

export interface ValidatedProposal {
  readonly message: string;
  readonly actions: readonly ValidatedAction[];
}

export type ValidationOutcome =
  | { readonly ok: true; readonly proposal: ValidatedProposal }
  | { readonly ok: false; readonly reason: string };

/**
 * Turn raw tool input into typed intents, rejecting anything unaccounted for.
 *
 * Deliberately paranoid: it assumes the input is arbitrary JSON from an
 * untrusted source, because in the failure cases that matter, it is. An action
 * that does not validate rejects the whole proposal rather than being dropped
 * silently — a partially-applied reply is harder to reason about than none.
 */
export function validateProposal(
  raw: unknown,
  model: SurveyDataModel,
): ValidationOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'The assistant returned something that is not a reply.' };
  }

  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.message !== 'string' || candidate.message.trim().length === 0) {
    return { ok: false, reason: 'The assistant returned no message.' };
  }
  if (candidate.message.length > MAX_MESSAGE) {
    return { ok: false, reason: 'The assistant’s message was too long to show.' };
  }
  if (!Array.isArray(candidate.actions)) {
    return { ok: false, reason: 'The assistant returned a malformed action list.' };
  }
  if (candidate.actions.length > MAX_ACTIONS) {
    return { ok: false, reason: 'The assistant offered more actions than the sheet allows.' };
  }

  const actions: ValidatedAction[] = [];
  for (const entry of candidate.actions) {
    const action = validateAction(entry, model);
    if (!action.ok) return action;
    actions.push(action.action);
  }

  return {
    ok: true,
    proposal: { message: candidate.message.trim(), actions },
  };
}

function validateAction(
  raw: unknown,
  model: SurveyDataModel,
):
  | { readonly ok: true; readonly action: ValidatedAction }
  | { readonly ok: false; readonly reason: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'An offered action was malformed.' };
  }

  const entry = raw as Record<string, unknown>;
  const { label, kind, argument } = entry;

  if (typeof label !== 'string' || label.trim().length === 0) {
    return { ok: false, reason: 'An offered action had no label.' };
  }
  if (label.length > MAX_LABEL) {
    return { ok: false, reason: 'An offered action’s label was too long.' };
  }
  if (typeof kind !== 'string' || !isActionKind(kind)) {
    return { ok: false, reason: `"${String(kind)}" is not an action this app can perform.` };
  }
  if (typeof argument !== 'string') {
    return { ok: false, reason: 'An offered action had a malformed argument.' };
  }

  const intent = toIntent(kind, argument.trim(), model);
  if (!intent.ok) return intent;

  return { ok: true, action: { label: label.trim(), intent: intent.intent } };
}

function isActionKind(value: string): value is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(value);
}

/**
 * Map a validated (kind, argument) pair to an Intent.
 *
 * Every argument is checked against something real: panels and topics against
 * their enums, and `show` against the ids actually present in the Survey Data
 * Model — so the assistant cannot point the canvas at an object that does not
 * exist, whatever it was told to say.
 */
function toIntent(
  kind: ActionKind,
  argument: string,
  model: SurveyDataModel,
):
  | { readonly ok: true; readonly intent: Intent }
  | { readonly ok: false; readonly reason: string } {
  switch (kind) {
    case 'none':
      return { ok: true, intent: { kind: 'none' } };

    case 'suggest-note':
      return { ok: true, intent: { kind: 'suggest-note' } };

    case 'suggest-building': {
      // A name only. Size and position come from the engines, and the result
      // still goes through the trust loop before it is survey data.
      const label = argument.length > 0 ? argument : 'Building';
      return { ok: true, intent: { kind: 'suggest-building', label } };
    }

    case 'open':
      return (PANELS as readonly string[]).includes(argument)
        ? { ok: true, intent: { kind: 'open', panel: argument as (typeof PANELS)[number] } }
        : { ok: false, reason: `There is no "${argument}" panel to open.` };

    case 'explain':
      return (EXPLAIN_TOPICS as readonly string[]).includes(argument)
        ? { ok: true, intent: { kind: 'explain', topic: argument as ExplainTopic } }
        : { ok: false, reason: `There is nothing to explain about "${argument}".` };

    case 'guide':
      return (TASK_NAMES as readonly string[]).includes(argument)
        ? { ok: true, intent: { kind: 'guide', task: argument as TaskName } }
        : { ok: false, reason: `There is no "${argument}" task to walk through.` };

    case 'tool':
      return (TOOLS as readonly string[]).includes(argument)
        ? { ok: true, intent: { kind: 'tool', tool: argument as (typeof TOOLS)[number] } }
        : { ok: false, reason: `There is no "${argument}" tool.` };

    case 'new-project':
      // Opens the question; it does not answer it. The confirmation is a tap
      // the user makes, and it has no representation in this vocabulary.
      return { ok: true, intent: { kind: 'new-project' } };

    case 'show':
      return knownElementIds(model).has(argument)
        ? { ok: true, intent: { kind: 'show', elementId: argument } }
        : { ok: false, reason: `"${argument}" is not on the drawing.` };
  }
}

/** Ids the assistant is allowed to point at: points, features and rings. */
export function knownElementIds(model: SurveyDataModel): ReadonlySet<string> {
  return new Set<string>([
    ...model.points.map((p) => p.id),
    ...model.siteFeatures.map((f) => f.id),
    ...model.boundary.map((r) => r.id),
  ]);
}
