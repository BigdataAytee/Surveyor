/**
 * Transcribe a photographed note, as a Vercel serverless function.
 *
 * Asked for one thing and given no others to do: return the characters visible
 * on the page. The deterministic extractor in packages/engine reads the result,
 * decides which column is which, and scores how sure it is — see
 * apps/web/src/ai/vision.ts for why the line is drawn there.
 *
 * Off by default. With no ANTHROPIC_API_KEY configured this replies 503 and the
 * app tells the user to paste the numbers instead.
 *
 * The same caution as api/assistant.js applies, more so: this is an
 * unauthenticated endpoint that accepts an image upload and spends your
 * Anthropic credits on every call. Put authentication and rate limiting in
 * front of it before exposing it to real traffic.
 */

import Anthropic from '@anthropic-ai/sdk';

/** A downscaled photo of a page; anything larger is not one. */
const MAX_IMAGE_BYTES = 6_000_000;

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const SYSTEM = `You transcribe photographs of survey field notes.

Return exactly what is written on the page, as plain text, preserving the line and column layout as closely as plain text allows. Keep column headings on their own line above the values they head. Separate columns with two or more spaces.

Transcribe only. Do not convert units, do not reorder columns, do not correct arithmetic, do not fill in a value that is obscured, and do not add any value that is not written on the page. Where a character is genuinely unreadable, write ? in its place — a wrong digit in a coordinate is far worse than a gap, because someone downstream will check a gap and will not check a plausible number.

Reply with the transcription and nothing else: no preamble, no explanation, no code fences.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'extraction not configured' });
    return;
  }

  const origin = req.headers.origin;
  if (origin && req.headers.host && new URL(origin).host !== req.headers.host) {
    res.status(403).json({ error: 'cross-origin request refused' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
    const image = body.image;
    const mediaType = body.mediaType;

    if (typeof image !== 'string' || image.length === 0) {
      res.status(400).json({ error: 'no image' });
      return;
    }
    if (image.length > MAX_IMAGE_BYTES) {
      res.status(413).json({ error: 'image too large' });
      return;
    }
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      res.status(400).json({ error: 'unsupported image type' });
      return;
    }

    const response = await new Anthropic().messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: 'Transcribe this page.' },
          ],
        },
      ],
    });

    // A refusal returns HTTP 200 with empty or partial content, so the stop
    // reason has to be checked before the content is indexed into.
    if (response.stop_reason === 'refusal') {
      res.status(422).json({ error: 'refused' });
      return;
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (text.length === 0) {
      res.status(502).json({ error: 'no transcription in response' });
      return;
    }

    // Returned as-is. The browser checks that it looks like survey data and
    // the engine parses it; this function does not vouch for the reading.
    res.status(200).json({ text });
  } catch (error) {
    console.error('[extract]', error);
    res.status(500).json({ error: 'extraction failed' });
  }
}
