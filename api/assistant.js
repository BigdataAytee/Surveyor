/**
 * The assistant endpoint, as a Vercel serverless function.
 *
 * The model's job here is classification, not answering: it decides what the
 * surveyor meant and which capability handles it, and the browser routes that
 * to a deterministic responder which produces the figures. See
 * apps/web/src/ai/classification.ts for why the line is drawn there.
 *
 * The tool definition and the brief live in _assistant-core.mjs, shared with
 * the local reference server, because two copies of a schema the browser
 * validates against is a drift bug waiting to be written.
 *
 * Off by default. With no ANTHROPIC_API_KEY configured this replies 503 and the
 * app falls back to its keyword planner, so a deployment that has not opted in
 * spends nothing and still works.
 *
 * A caution worth taking seriously before opting in: this is an unauthenticated
 * endpoint that spends your Anthropic credits on every call. The same-origin
 * check below stops a browser on another site from using it; it does not stop
 * anyone with curl. Put authentication and rate limiting in front of it before
 * exposing it to real traffic.
 */

import Anthropic from '@anthropic-ai/sdk';

import { CLASSIFY_TOOL, SYSTEM, buildMessages } from './_assistant-core.mjs';

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
    const history = body.history ?? [];

    const response = await new Anthropic().messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'classify_and_reply' },
      messages: buildMessages(question, survey, history),
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
