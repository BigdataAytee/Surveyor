/**
 * What this agent is for, and what it can actually do about it.
 *
 * One declaration, three consumers: the system prompt that tells the model what
 * it is, the tool schema that bounds what it may return, and the router that
 * turns a classification into an answer. Keeping them in one place is not
 * tidiness — a scope the model believes in and a router that disagrees is an
 * assistant that confidently promises things the app cannot do.
 *
 * The division of labour is the important part, and it is the same one the
 * whole system is built on. **The model decides what the surveyor meant. The
 * engines decide what is true.** Classification is a judgement about language,
 * which is what a model is genuinely good at. Every survey value in the reply
 * comes from `answer`, which reads it off the pipeline. A model that could write
 * the numbers would be authoring survey values, and no amount of accuracy makes
 * that acceptable on a document someone signs.
 */

import type { AssistantContext, AssistantMessage, TaskName } from './assistant.js';
import {
  TASKS,
  capabilitiesMessage,
  describeParcel,
  explainMessage,
  featureMessage,
  pointsMessage,
  scaleMessage,
  taskMessage,
  validationMessage,
  closureMessage,
  crsMessage,
  provenanceMessage,
} from './assistant.js';

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Prose given to the model as its brief.
 *
 * Written as what the agent *is*, not as a list of keywords, because the whole
 * point of classifying with a model is that it can reason about a question
 * nobody anticipated. A keyword list here would reintroduce the problem one
 * layer up.
 */
export const AGENT_SCOPE = `You are the assistant inside a survey plan drafting tool. The surveyor has a parcel of land, some measured points, and needs a professional site plan out of it.

You are in scope for: anything about this survey and this drawing — its size, shape, closure, coordinate system, points, buildings and features, what the plan says, whether it is ready; anything about working the app — getting data in, drawing, measuring, labelling, reviewing, exporting, starting a new project; and surveying concepts a novice would need explained to understand what they are looking at.

You are out of scope for: legal advice about boundaries or ownership, planning and permitting decisions, valuation, engineering or structural design, other people's land, and anything unrelated to this survey or this app. Being out of scope is not a failure — say so plainly, say what you can help with instead, and do not improvise an answer.`;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Every question this agent can answer, as a thing it can be asked *about*
 * rather than a phrase it can match.
 *
 * The model picks one of these. It does not write the answer for the ones that
 * carry survey values — it decides which of them the surveyor meant, and the
 * responder below produces the figures.
 */
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
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** How sure the model is that it understood. Drives whether we act or ask. */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const SCOPE_VERDICTS = ['in-scope', 'out-of-scope', 'ambiguous'] as const;
export type ScopeVerdict = (typeof SCOPE_VERDICTS)[number];

/**
 * What each capability is, in the words the model is given.
 *
 * These are descriptions of subject matter, not trigger phrases. "The size of
 * the land" and "how many metres across is it" and "acreage" are all
 * `parcel-size`, and the model works that out because it understands the
 * subject — which is exactly what the keyword matcher could not do.
 */
export const CAPABILITY_BRIEF: Readonly<Record<Capability, string>> = {
  'parcel-size':
    'How big the land is in any sense — area, acreage, hectares, perimeter, ' +
    'the length of the sides, overall dimensions, how far across it is.',
  closure:
    'Whether the boundary closes, the misclosure, the precision ratio, and ' +
    'whether the measurements are good enough.',
  'coordinate-system':
    'Which coordinate system, datum or projection the survey is on, and what ' +
    'the eastings and northings are referenced to.',
  'survey-points':
    'The survey points themselves — how many, what they are called, editing ' +
    'or checking their coordinates.',
  'site-features':
    'Buildings, roads and other things on the site: where they are, what is ' +
    'there, adding one.',
  'plan-scale':
    'The drawing scale, the sheet size and orientation, and how the site fits ' +
    'on paper.',
  validation:
    'Whether the drawing is correct and ready — problems found, warnings, ' +
    'what still needs attention before export.',
  provenance:
    'Where a value on the plan came from, why something is marked as a ' +
    'suggestion, and what has to be confirmed before it can be exported.',
  show:
    'Point the drawing at one specific object the surveyor named. The ' +
    'argument is its id, and it must be an id that appears in the survey ' +
    'summary you were given — never one you have inferred.',
  guide:
    'How to do something in the app. The argument is the task; one of: ' +
    `${TASKS.map((task) => task.task).join(', ')}.`,
  explain:
    'What a surveying concept means, for someone who has not met it before. ' +
    'The argument is the topic: crs, closure, provenance, area, scale.',
  tool:
    'Put the surveyor into a drawing tool because they want to do something ' +
    'with it now. The argument is select, draw or measure.',
  open:
    'Open a panel of the app. The argument is data, validation, export, ' +
    'layers or project.',
  'new-project':
    'Start again with an empty plan. This only ever offers — the surveyor ' +
    'confirms it, and you cannot confirm it for them.',
  'small-talk':
    'Greetings, thanks, and other conversation that is not a request. Answer ' +
    'briefly and warmly, and offer somewhere useful to go next.',
};

/**
 * Capabilities that answer with survey values.
 *
 * These route to a deterministic responder, and the model's prose is used only
 * to frame the reply — never to state a figure. The distinction is enforced in
 * `answer` rather than trusted to a prompt.
 */
export const COMPUTED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'parcel-size',
  'closure',
  'coordinate-system',
  'survey-points',
  'site-features',
  'plan-scale',
  'validation',
]);

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface Classification {
  /** The model's restatement of what the surveyor meant. */
  readonly understanding: string;
  readonly scope: ScopeVerdict;
  readonly capability: Capability | null;
  readonly argument: string;
  readonly confidence: Confidence;
  /** Prose to show for the cases where no survey value is involved. */
  readonly message: string;
  readonly clarification: {
    readonly question: string;
    readonly options: readonly { readonly label: string; readonly capability: Capability; readonly argument: string }[];
  } | null;
}

/**
 * Produce the answer for a classified, in-scope question.
 *
 * Note what this does not take: the model's message. For anything carrying a
 * survey value the responder writes the whole reply, off the pipeline. The
 * model chose the question; the engine answers it.
 */
export function answer(
  capability: Capability,
  argument: string,
  ctx: AssistantContext,
  message: string,
): AssistantMessage {
  switch (capability) {
    case 'parcel-size':
      return describeParcel(ctx);
    case 'closure':
      return closureMessage(ctx);
    case 'coordinate-system':
      return crsMessage(ctx);
    case 'survey-points':
      return pointsMessage(ctx);
    case 'site-features':
      return featureMessage(ctx);
    case 'plan-scale':
      return scaleMessage(ctx);
    case 'validation':
      return validationMessage(ctx);
    case 'provenance':
      return provenanceMessage();
    case 'show':
      return {
        id: `msg_show_${argument}`,
        role: 'assistant',
        text: message,
        references: [argument],
      };
    case 'guide':
      return taskMessage(argument as TaskName);
    case 'explain':
      return explainMessage(argument as never);
    case 'small-talk':
      // No survey value in a greeting, so the model's own words are safe here
      // and far better than a canned line.
      return { ...capabilitiesMessage(), text: message };
    case 'tool':
    case 'open':
    case 'new-project':
      // These are things to *do*; the caller turns them into buttons.
      return { ...capabilitiesMessage(), text: message };
  }
}
