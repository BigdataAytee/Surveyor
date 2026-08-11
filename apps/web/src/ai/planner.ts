/**
 * The planner seam.
 *
 * `assistant.ts` decides intent with rules. This file lets a language model
 * decide it instead, without changing anything downstream: both planners return
 * the same `AssistantMessage`, and a model-authored reply passes through
 * `validateProposal` before it becomes one.
 *
 * The model is reached through a `PlannerTransport` rather than the Anthropic
 * SDK directly. That is not indirection for its own sake — this is a browser
 * application, and an API key shipped to the browser is a key published to
 * every user. The transport posts to an endpoint the operator hosts (see
 * `server/assistant.mjs` for a reference implementation); the key stays there.
 *
 * Failure is never fatal: a transport error, a refusal, or a reply that fails
 * validation falls back to the rule planner. The assistant degrades to the
 * behaviour it had before rather than going silent.
 */

import type { SurveyDataModel } from '@surveyor/contracts';

import {
  respond,
  type AssistantContext,
  type AssistantMessage,
} from './assistant.js';
import { validateClassification } from './classification.js';
import { routeClassification } from './route.js';
import type { Classification } from './scope.js';

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** What the planner sends to the operator's endpoint. */
export interface PlannerRequest {
  /** What the user typed. */
  readonly question: string;
  /**
   * A summary of the survey — never the whole model. The assistant needs to
   * know what exists, not every coordinate, and a smaller payload is a smaller
   * thing to leak.
   */
  readonly survey: SurveySummary;
  /**
   * Recent turns, oldest first.
   *
   * Without these "what about the garage?" is unanswerable, and so is "yes" —
   * which is what people say after being asked a clarifying question. A
   * classifier with no memory of what it just asked cannot use the answer.
   */
  readonly history: readonly ConversationTurn[];
}

export interface ConversationTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** Enough context to follow a thread; not so much that the payload grows without bound. */
export const HISTORY_TURNS = 8;

export interface SurveySummary {
  readonly siteAddress: string | null;
  readonly crs: string;
  readonly units: string;
  readonly pointIds: readonly string[];
  readonly features: readonly { readonly id: string; readonly type: string; readonly name: string | null }[];
  readonly ringIds: readonly string[];
  readonly validation: 'ready' | 'needs-review' | 'error' | 'blocked';
  readonly hasClosedBoundary: boolean;
}

/**
 * Returns the raw tool input the model produced, or throws.
 *
 * Deliberately untyped: whatever comes back is untrusted until
 * `validateProposal` has been over it.
 */
export type PlannerTransport = (request: PlannerRequest) => Promise<unknown>;

export interface Planner {
  readonly name: 'rules' | 'model';
  readonly reply: (
    question: string,
    ctx: AssistantContext,
    history?: readonly ConversationTurn[],
  ) => Promise<AssistantMessage>;
}

// ---------------------------------------------------------------------------
// Planners
// ---------------------------------------------------------------------------

export function rulePlanner(): Planner {
  return {
    name: 'rules',
    reply: async (question, ctx) => respond(question, ctx),
  };
}

export interface ModelPlannerOptions {
  readonly transport: PlannerTransport;
  /** Called when a model reply is rejected, so the failure is visible. */
  readonly onFallback?: (reason: string) => void;
  /** Every accepted classification, for logging what the assistant understood. */
  readonly onClassified?: (classification: Classification) => void;
  readonly timeoutMs?: number;
}

/**
 * Understand the question with a model, answer it with the engines.
 *
 * The model's whole job is the classification: what did the surveyor mean,
 * which capability is that, is it in scope, how sure am I. `routeClassification`
 * then decides whether that is sure enough to act on, and the capability's
 * responder produces the figures. The model chooses the question; it never
 * writes the answer to one that carries a survey value.
 *
 * Every failure lands on the keyword planner rather than on the surveyor. It is
 * a worse assistant, but it is one, and a degraded reply beats a spinner.
 */
export function modelPlanner(options: ModelPlannerOptions): Planner {
  const fallback = rulePlanner();

  return {
    name: 'model',
    reply: async (question, ctx, history = []) => {
      try {
        const raw = await withTimeout(
          options.transport({
            question,
            survey: summarise(ctx),
            history: history.slice(-HISTORY_TURNS),
          }),
          options.timeoutMs ?? 20_000,
        );

        const validated = validateClassification(raw, ctx.model);
        if (!validated.ok) {
          // A model that goes off-vocabulary is a rules turn, not an error
          // shown to the surveyor — but it must not be silent either.
          options.onFallback?.(validated.reason);
          return fallback.reply(question, ctx);
        }

        options.onClassified?.(validated.classification);
        return routeClassification(validated.classification, validated.actions, ctx);
      } catch (error) {
        options.onFallback?.(error instanceof Error ? error.message : String(error));
        return fallback.reply(question, ctx);
      }
    },
  };
}

/**
 * The planner the app uses.
 *
 * A model planner only when an endpoint is configured; otherwise rules. There
 * is no key-in-the-browser path, by construction — the app never sees a
 * credential, only a URL.
 */
export function createPlanner(
  endpoint: string | undefined,
  onFallback?: (reason: string) => void,
): Planner {
  if (!endpoint) return rulePlanner();

  return modelPlanner({
    transport: httpTransport(endpoint),
    ...(onFallback ? { onFallback } : {}),
  });
}

export function httpTransport(endpoint: string): PlannerTransport {
  return async (request) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Assistant endpoint returned ${response.status}.`);
    }
    return response.json();
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * What the model is told about the survey.
 *
 * Names and structure, deliberately not values. The assistant never needs a
 * coordinate to decide what to say, and anything it is not told it cannot
 * repeat back as though it were measured.
 */
export function summarise(ctx: AssistantContext): SurveySummary {
  const { model, pipeline } = ctx;

  return {
    siteAddress: model.metadata.siteAddress ?? null,
    crs: model.crs.name,
    units: model.crs.units,
    pointIds: model.points.map((p) => p.id),
    features: model.siteFeatures.map((f) => ({
      id: f.id,
      type: f.type,
      name: f.attributes.name === undefined ? null : String(f.attributes.name),
    })),
    ringIds: model.boundary.map((r) => r.id),
    validation: pipeline.ok ? pipeline.validation.status : 'blocked',
    hasClosedBoundary: pipeline.ok && pipeline.rings.length > 0,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The assistant did not respond in time.')),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
