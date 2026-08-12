/**
 * Reading a photographed note (Architecture A.3 — the vision seam).
 *
 * The model is asked for one thing: a transcription. It returns the characters
 * it can see on the page, laid out as they are laid out, and nothing else — no
 * column names, no point objects, no opinion about which number is an easting.
 *
 * That division is the whole point. Transcription is the part a model is
 * genuinely better at than a parser, and it is a claim about the document that
 * the user can check by looking at the photo beside the numbers. Deciding that
 * the second column is a northing, or that a value is trustworthy, is a claim
 * about the *survey* — and those stay with `extractPoints`, which is
 * deterministic, tested, and scores its own confidence. A model that returned
 * finished points would be authoring survey values, which is the one thing
 * this system does not let it do.
 *
 * As everywhere else in this app, the browser is given a URL and never a key.
 */

import { looksLikeSurveyData } from '@surveyor/engine';

import { connectedFetch } from '../state/connectivity.js';

export type NoteReading =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * The service was never heard from — a dead network or a 5xx.
       *
       * Distinct from a refusal, because this is the one kind of failure worth
       * keeping the photograph for.
       */
      readonly unreachable?: true;
    };

/** Long enough for a page of points, short enough not to be a runaway reply. */
const MAX_TRANSCRIPT = 20_000;

/** A photo large enough to read, small enough to post. */
const MAX_EDGE = 1600;

const NOT_CONFIGURED =
  'Reading photos needs the extraction service, which is not set up on this ' +
  'deployment. You can still paste or type the numbers and I will read those.';

/** A photograph, shrunk and encoded, ready to be sent — now or in an hour. */
export interface PreparedNote {
  /** Base64, without the data-URL prefix. */
  readonly data: string;
  readonly mediaType: string;
}

/**
 * Get a photograph ready to send, without sending it.
 *
 * Split out from `readNoteImage` so that a note photographed with no signal
 * can be prepared and kept. The expensive, device-bound half — decoding a
 * camera image and shrinking it — has no reason to wait for a network, and
 * doing it now means the queued item is a few hundred kilobytes rather than
 * several megabytes.
 */
export async function prepareNote(file: File): Promise<PreparedNote | null> {
  try {
    return await downscale(file);
  } catch {
    return null;
  }
}

export function extractEndpoint(endpoint?: string): string | undefined {
  // Resolved rather than defaulted, so that passing nothing and being
  // configured with nothing are the same case — which is what the tests, and
  // any environment without a build-time `import.meta.env`, need it to be.
  return endpoint ?? import.meta.env?.VITE_EXTRACT_ENDPOINT;
}

export async function readNoteImage(
  file: File,
  endpoint?: string,
): Promise<NoteReading> {
  const target = extractEndpoint(endpoint);
  if (!target) return { ok: false, reason: NOT_CONFIGURED };

  const encoded = await prepareNote(file);
  if (!encoded) return { ok: false, reason: 'I could not open that image.' };

  return transcribeNote(encoded, target);
}

/**
 * Send a prepared note and check what comes back.
 *
 * `unreachable` is reported separately from a refusal, because the two call
 * for opposite things: an unreachable service is worth trying again later, and
 * a service that read the photo and found no coordinates on it is not.
 */
export async function transcribeNote(
  note: PreparedNote,
  endpoint?: string,
): Promise<NoteReading> {
  const target = extractEndpoint(endpoint);
  if (!target) return { ok: false, reason: NOT_CONFIGURED };

  let payload: unknown;
  try {
    const response = await connectedFetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: note.data, mediaType: note.mediaType }),
    });
    if (!response.ok) {
      return {
        ok: false,
        // A 5xx is the service having a bad day; a 4xx is this request being
        // wrong, and no amount of waiting fixes that.
        ...(response.status >= 500 ? { unreachable: true as const } : {}),
        reason:
          response.status === 503
            ? NOT_CONFIGURED
            : `The extraction service answered ${response.status}. You can paste the numbers instead.`,
      };
    }
    payload = await response.json();
  } catch {
    return {
      ok: false,
      unreachable: true,
      reason: 'I could not reach the extraction service. You can paste the numbers instead.',
    };
  }

  // The reply is checked before it is used, on the same principle as the
  // assistant's: an endpoint on the network is not something to take on trust.
  const text = (payload as { text?: unknown } | null)?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'The extraction service sent something I could not read.' };
  }
  if (text.length > MAX_TRANSCRIPT) {
    return { ok: false, reason: 'That transcription was too long to be a page of points.' };
  }
  if (!looksLikeSurveyData(text)) {
    return {
      ok: false,
      reason:
        'I could read the photo, but I could not find at least three lines of ' +
        'coordinates on it. Try a straighter, closer shot of the table.',
    };
  }

  return { ok: true, text };
}

/**
 * Shrink the photo before sending it.
 *
 * A phone camera produces several megabytes at a resolution far beyond what
 * reading a table needs, and the whole thing has to cross the network before
 * anything happens. Capping the long edge keeps the round trip short without
 * losing the characters.
 */
async function downscale(file: File): Promise<{ data: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' };
}
