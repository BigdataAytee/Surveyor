/**
 * Reference assistant endpoint, for running the model locally.
 *
 * The browser app never holds an API key — it posts a question, a survey
 * summary and the recent conversation here, and this process talks to Claude.
 * Run it alongside the app and point `VITE_ASSISTANT_ENDPOINT` at it.
 *
 *   ANTHROPIC_API_KEY=... node server/assistant.mjs
 *   VITE_ASSISTANT_ENDPOINT=http://127.0.0.1:8787/assistant npm run dev
 *
 * The model classifies; it does not answer. It decides what the surveyor meant
 * and which capability handles it, and the browser routes that to a
 * deterministic responder which produces every figure — see
 * src/ai/classification.ts for why the line is drawn there.
 *
 * The tool definition and the brief are shared with the deployed function in
 * api/_assistant-core.mjs. The browser's validator rejects anything the two
 * disagree about, so they are not allowed to be two copies.
 */

import { createServer } from 'node:http';

import Anthropic from '@anthropic-ai/sdk';

import { CLASSIFY_TOOL, SYSTEM, buildMessages } from '../../../api/_assistant-core.mjs';

const PORT = Number(process.env.ASSISTANT_PORT ?? 8787);
const ORIGIN = process.env.ASSISTANT_ALLOW_ORIGIN ?? 'http://127.0.0.1:5173';

const client = new Anthropic();

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
    const history = body.history ?? [];

    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'classify_and_reply' },
      messages: buildMessages(question, survey, history),
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
