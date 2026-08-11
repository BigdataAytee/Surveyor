/**
 * From a classification to a reply.
 *
 * Three outcomes, and which one applies is decided here rather than by the
 * model. The model reports what it understood and how sure it is; the app
 * decides whether that is sure enough to act on. Handing the "should I act or
 * ask" decision to the same party that produced the guess would make the
 * confidence level decorative.
 */

import {
  capabilitiesMessage,
  type AssistantAction,
  type AssistantContext,
  type AssistantMessage,
  type ExplainTopic,
  type Intent,
  type PanelName,
  type TaskName,
} from './assistant.js';
import { answer, type Capability, type Classification } from './scope.js';
import type { ClassifiedAction } from './classification.js';

let counter = 0;
const id = (prefix: string): string => `${prefix}_route_${(counter += 1)}`;

/**
 * Below this, ask rather than answer.
 *
 * `medium` acts but says what it assumed, so a misread is visible and one tap
 * from being corrected. `low` does not act at all: answering the wrong question
 * confidently is worse than a short question back, and the surveyor is the one
 * who knows which reading was meant.
 */
const ACTS_ON: readonly Classification['confidence'][] = ['high', 'medium'];

export function routeClassification(
  classification: Classification,
  followUps: readonly ClassifiedAction[],
  ctx: AssistantContext,
): AssistantMessage {
  const { scope, capability, confidence } = classification;

  // --- Out of scope -------------------------------------------------------
  if (scope === 'out-of-scope') {
    return {
      id: id('msg'),
      role: 'assistant',
      // The model's own words: it knows what was asked, and a canned refusal
      // to a specific question reads as not having listened.
      text: classification.message,
      actions: [
        { id: id('act'), label: 'What can you help with?', intent: { kind: 'none' } },
      ],
    };
  }

  // --- Not sure enough to act --------------------------------------------
  const unsure = scope === 'ambiguous' || !ACTS_ON.includes(confidence);
  if (unsure || capability === null) {
    const clarification = classification.clarification;
    const options = clarification?.options ?? followUps;

    return {
      id: id('msg'),
      role: 'assistant',
      text: clarification?.question ?? classification.message,
      actions:
        options.length > 0
          ? options.map((option, index) => ({
              id: id('act'),
              label: option.label,
              intent: intentFor(option.capability, option.argument),
              ...(index === 0 ? { tone: 'primary' as const } : {}),
            }))
          : (capabilitiesMessage().actions ?? []),
    };
  }

  // --- Confident and in scope --------------------------------------------
  const reply = answer(capability, classification.argument, ctx, classification.message);

  // A medium-confidence reading is acted on but declared, so a wrong turn is
  // obvious at a glance instead of being buried in a confident answer.
  const text =
    confidence === 'medium'
      ? `${classification.understanding}\n\n${reply.text}`
      : reply.text;

  const extra = followUps.map(
    (action): AssistantAction => ({
      id: id('act'),
      label: action.label,
      intent: intentFor(action.capability, action.argument),
    }),
  );

  // The responder's own actions come first — they are the ones that belong to
  // the answer — with the model's suggestions after, capped so the sheet stays
  // a reply rather than a menu.
  return {
    ...reply,
    id: id('msg'),
    text,
    actions: [...(reply.actions ?? []), ...extra].slice(0, 4),
  };
}

/**
 * A capability the surveyor can be offered as a button.
 *
 * Capabilities that answer a question become `guide`-style re-asks; the ones
 * that do something map onto the existing intents, so everything downstream —
 * the trust loop, the confirmation on a new project — is unchanged.
 */
export function intentFor(capability: Capability, argument: string): Intent {
  switch (capability) {
    case 'guide':
      return { kind: 'guide', task: argument as TaskName };
    case 'explain':
      return { kind: 'explain', topic: argument as ExplainTopic };
    case 'tool':
      return { kind: 'tool', tool: argument as 'select' | 'draw' | 'measure' };
    case 'open':
      return { kind: 'open', panel: argument as PanelName };
    case 'new-project':
      return { kind: 'new-project' };
    case 'show':
      return { kind: 'show', elementId: argument };
    case 'site-features':
      // Asking about features when there are none is really asking for one.
      return { kind: 'suggest-building', label: argument.length > 0 ? argument : 'Building' };
    default:
      // Everything else is a question; re-asking it routes it back through the
      // planner rather than duplicating the responder here.
      return { kind: 'none' };
  }
}
