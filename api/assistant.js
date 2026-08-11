/**
 * The assistant endpoint, as a Vercel serverless function.
 *
 * Same contract as the local reference server in apps/web/server/assistant.mjs,
 * which is the file to read for the reasoning; this one exists so a deployed
 * build can reach a model without the browser ever holding a key. Point the app
 * at it by setting VITE_ASSISTANT_ENDPOINT=/api/assistant at build time.
 *
 * Off by default. With no ANTHROPIC_API_KEY configured this replies 503 and the
 * app falls back to its rule planner, so a deployment that has not opted in
 * spends nothing and still works.
 *
 * A caution worth taking seriously before opting in: this is an unauthenticated
 * endpoint that spends your Anthropic credits on every call. The same-origin
 * check below stops a browser on another site from using it; it does not stop
 * anyone with curl. Put authentication and rate limiting in front of it before
 * exposing it to real traffic.
 */

import Anthropic from '@anthropic-ai/sdk';

/** Kept in step with `PROPOSE_ACTIONS_TOOL` in apps/web/src/ai/intent-schema.ts. */
const TOOL = {
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
      message: { type: 'string' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'kind', 'argument'],
          properties: {
            label: { type: 'string' },
            kind: {
              type: 'string',
              enum: [
                'suggest-building',
                'suggest-note',
                'show',
                'open',
                'explain',
                'guide',
                'tool',
                'new-project',
                'none',
              ],
            },
            argument: { type: 'string' },
          },
        },
      },
    },
  },
};

const SYSTEM = `You are the assistant inside a survey plan drafting tool, sitting beside the drawing.

You decide what to say and what to offer next. You do not decide geometry. Bearings, distances, areas, coordinates and label positions are calculated by deterministic engines and rendered from measured data — you must never state one, estimate one, or repeat one back as fact. If the surveyor asks for a value, point them at where the drawing shows it.

You may propose a building. That is a proposal only: the engines choose its position and size, and the surveyor confirms it before it becomes survey data. Propose by name; never by dimension.

Reply only through the propose_actions tool. Keep the message to a few sentences of plain language a novice surveyor can follow. Offer actions only when they genuinely help — an empty action list is fine.

Use "show" only with an id that appears in the survey summary you were given.

You are also the way through the interface, so answer "how do I ..." questions and offer the action that does it. "guide" walks the surveyor through a task; its argument is one of new-project, name-site, add-points, paste-table, photograph-note, traverse, draw-boundary, measure, add-building, add-note, labels, review, export, undo. "tool" switches the drawing tool: select, draw, measure. "open" opens a panel: data, validation, export, layers, project. "new-project" offers to start again — it asks the surveyor to confirm before anything is replaced, and you cannot skip that step.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'assistant not configured' });
    return;
  }

  // The app is served from this same deployment, so a request carrying some
  // other site's origin is not the app asking.
  const origin = req.headers.origin;
  if (origin && req.headers.host && new URL(origin).host !== req.headers.host) {
    res.status(403).json({ error: 'cross-origin request refused' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
    const question = String(body.question ?? '').slice(0, 2000);
    const survey = body.survey ?? {};

    const response = await new Anthropic().messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'propose_actions' },
      messages: [
        {
          role: 'user',
          content:
            `Survey summary:\n${JSON.stringify(survey, null, 2)}\n\n` +
            `The surveyor asks: ${question}`,
        },
      ],
    });

    // Check stop_reason before reading content: a refusal returns HTTP 200 with
    // empty or partial content, and indexing into it blindly throws.
    if (response.stop_reason === 'refusal') {
      res.status(422).json({ error: 'refused' });
      return;
    }

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse) {
      res.status(502).json({ error: 'no tool call in response' });
      return;
    }

    // Returned as-is. The browser validates it — this function does not get to
    // vouch for the model's output on the client's behalf.
    res.status(200).json(toolUse.input);
  } catch (error) {
    console.error('[assistant]', error);
    res.status(500).json({ error: 'assistant failed' });
  }
}
