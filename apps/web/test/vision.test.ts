/**
 * The vision seam.
 *
 * The endpoint is on the network and its reply is a model's output, so it gets
 * the same treatment as the assistant's: checked before it is used, and never
 * allowed to fail silently. A rejection here is the system working.
 *
 * `readNoteImage` takes its endpoint as an argument so these run without a
 * build-time environment or a key.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { looksLikeSurveyData } from '@surveyor/engine';

import { readNoteImage } from '../src/ai/vision.js';

/** A one-pixel JPEG is enough: nothing here depends on what is in the image. */
const FILE = { name: 'note.jpg', type: 'image/jpeg' } as unknown as File;

const TABLE = [
  'Point  Easting     Northing',
  'PT1    534800.00   182900.00',
  'PT2    534830.00   182900.00',
  'PT3    534830.00   182920.00',
].join('\n');

function stubFetch(response: { status?: number; body?: unknown }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () => response.body,
    }) as Response) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * `downscale` needs a canvas, which node does not have. These tests are about
 * the contract with the endpoint, so the encoding step is stubbed out.
 */
function stubImagePipeline(): () => void {
  const globals = globalThis as Record<string, unknown>;
  const original = { createImageBitmap: globals.createImageBitmap, document: globals.document };

  globals.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
  globals.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => 'data:image/jpeg;base64,AAAA',
    }),
  };

  return () => {
    globals.createImageBitmap = original.createImageBitmap;
    globals.document = original.document;
  };
}

// ---------------------------------------------------------------------------

test('with no endpoint configured it says so and points at pasting', async () => {
  // The default deployment. It must not look broken, because it is not — the
  // rest of the app works without any service at all.
  const result = await readNoteImage(FILE);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /paste or type/);
});

test('a transcription that reads as survey data is accepted', async () => {
  const restoreImage = stubImagePipeline();
  const restoreFetch = stubFetch({ body: { text: TABLE } });
  try {
    const result = await readNoteImage(FILE, '/api/extract');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.text, TABLE);
  } finally {
    restoreFetch();
    restoreImage();
  }
});

test('a reply that is not a transcription is rejected, not passed on', async () => {
  const restoreImage = stubImagePipeline();
  for (const body of [null, {}, { text: '' }, { text: 42 }, { text: [] }]) {
    const restoreFetch = stubFetch({ body });
    try {
      const result = await readNoteImage(FILE, '/api/extract');
      assert.equal(result.ok, false, `should reject ${JSON.stringify(body)}`);
    } finally {
      restoreFetch();
    }
  }
  restoreImage();
});

test('prose from the model is refused rather than parsed into a survey', async () => {
  // The failure mode that matters: a model that describes the photo instead of
  // transcribing it. Handing that to the extractor would produce either
  // nothing or, worse, a few numbers pulled out of a sentence.
  const restoreImage = stubImagePipeline();
  const restoreFetch = stubFetch({
    body: { text: 'This appears to be a photograph of a surveyor’s field notebook.' },
  });
  try {
    const result = await readNoteImage(FILE, '/api/extract');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /three lines of/);
  } finally {
    restoreFetch();
    restoreImage();
  }
});

test('an unconfigured service is reported as unconfigured, not as an error', async () => {
  const restoreImage = stubImagePipeline();
  const restoreFetch = stubFetch({ status: 503 });
  try {
    const result = await readNoteImage(FILE, '/api/extract');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not set up/);
  } finally {
    restoreFetch();
    restoreImage();
  }
});

test('an unreachable service still leaves the user a way forward', async () => {
  const restoreImage = stubImagePipeline();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  try {
    const result = await readNoteImage(FILE, '/api/extract');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /paste the numbers/);
  } finally {
    globalThis.fetch = original;
    restoreImage();
  }
});

// ---------------------------------------------------------------------------
// The question/data split
// ---------------------------------------------------------------------------

test('a question is not mistaken for a table', () => {
  // Everything a surveyor might reasonably type. Treating any of these as a
  // paste would swallow the question and answer a different one.
  for (const question of [
    'what is the area?',
    'is this closed?',
    'add a garage 6m by 3m',
    'why does PT3 need confirming?',
    'the boundary is 45 m by 35 m, is that right?',
  ]) {
    assert.equal(looksLikeSurveyData(question), false, question);
  }
});

test('a pasted table is recognised as data', () => {
  assert.equal(looksLikeSurveyData(TABLE), true);
  assert.equal(
    looksLikeSurveyData('PT1,534800,182900\nPT2,534830,182900\nPT3,534830,182920'),
    true,
  );
});
