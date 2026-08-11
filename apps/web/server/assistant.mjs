/**
 * Reference assistant endpoint.
 *
 * The browser app never holds an API key — it posts a question and a survey
 * summary here, and this process talks to Claude. Run it alongside the app and
 * point `VITE_ASSISTANT_ENDPOINT` at it.
 *
 *   ANTHROPIC_API_KEY=... node server/assistant.mjs
 *   VITE_ASSISTANT_ENDPOINT=http://127.0.0.1:8787/assistant npm run dev
 *
 * The model is constrained twice over: a strict tool schema bounds what it can
 * express, and the browser re-validates every action against the survey before
 * acting on it (see src/ai/intent-schema.ts). This file is the outer layer, not
 * the guarantee — it is written assuming the model may return something
 * unexpected, and the client is written assuming this endpoint may too.
 */

import { createServer } from 'node:http';

import Anthropic from '@anthropic-ai/sdk';

const PORT = Number(process.env.ASSISTANT_PORT ?? 8787);
const ORIGIN = process.env.ASSISTANT_ALLOW_ORIGIN ?? 'http://127.0.0.1:5173';

const client = new Anthropic();

/**
 * Kept in step with `PROPOSE_ACTIONS_TOOL` in src/ai/intent-schema.ts.
 *
 * `strict: true` is a top-level field on the tool definition — not on
 * `tool_choice` — and requires `additionalProperties: false` plus a complete
 * `required` list on every object. With it, tool input is guaranteed to
 * validate against this schema.
 */
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

Use "show" only with an id that appears in the survey summary you were given.`;

createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, cors).end();
    return;
  }

  try {
    const body = JSON.parse(await readBody(req));
    const question = String(body.question ?? '').slice(0, 2000);
    const survey = body.survey ?? {};

    const response = await client.messages.create({
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

    // Check stop_reason before reading content: a refusal returns HTTP 200
    // with empty or partial content, and indexing into it blindly throws.
    if (response.stop_reason === 'refusal') {
      res.writeHead(422, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'refused' }));
      return;
    }

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse) {
      res.writeHead(502, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no tool call in response' }));
      return;
    }

    // Returned as-is. The browser validates it — this process does not get to
    // vouch for the model's output on the client's behalf.
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(toolUse.input));
  } catch (error) {
    console.error('[assistant]', error);
    res.writeHead(500, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'assistant failed' }));
  }
}).listen(PORT, () => {
  console.log(`Assistant endpoint on http://127.0.0.1:${PORT}/assistant`);
  console.log(`Allowing browser origin ${ORIGIN}`);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
