/**
 * Tests for working offline.
 *
 * Two things are checked here, and both are behavioural claims the app makes
 * to a surveyor standing in a field: that a question asked with no signal is
 * answered immediately rather than after a timeout, and that work which needs
 * a server is kept until there is one and then goes through exactly once.
 *
 * The queue is exercised against a fake store rather than a real IndexedDB,
 * because what is worth testing is the decision-making — when to retry, when
 * to stop, what happens to a result nobody has looked at yet — and not whether
 * the browser can write a record.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_MODEL } from '../src/state/store.js';
import { runPipeline } from '@surveyor/engine';
import { modelPlanner } from '../src/ai/planner.js';
import type { AssistantContext } from '../src/ai/assistant.js';
import { reportReachability } from '../src/state/connectivity.js';
import {
  MAX_ATTEMPTS,
  _resetOutbox,
  drainOutbox,
  enqueue,
  loadOutbox,
  outboxItems,
  registerOutboxHandler,
  updateOutboxItem,
  type OutboxItem,
  type OutboxStore,
} from '../src/state/outbox.js';

function context(): AssistantContext {
  return { model: EMPTY_MODEL, pipeline: runPipeline(EMPTY_MODEL), suggestions: [] };
}

// ---------------------------------------------------------------------------
// The assistant offline
// ---------------------------------------------------------------------------

test('offline, the assistant does not touch the network at all', async () => {
  let called = false;
  const planner = modelPlanner({
    transport: async () => {
      called = true;
      return {};
    },
    online: () => false,
  });

  const reply = await planner.reply('how do I get my points in?', context());

  assert.equal(called, false, 'the transport was called with no network');
  assert.ok(reply.text.length > 0, 'no answer was given');
  assert.equal(reply.answeredOffline, true, 'the answer is not marked as an offline one');
});

test('offline answers keep the question, so they can be asked again', async () => {
  const planner = modelPlanner({
    transport: async () => ({}),
    online: () => false,
  });

  const reply = await planner.reply('how big is the parcel?', context());
  assert.equal(reply.question, 'how big is the parcel?');
});

test('offline, an answer arrives without waiting for a timeout', async () => {
  const planner = modelPlanner({
    transport: () => new Promise(() => {}), // never settles, like a dead socket
    online: () => false,
    timeoutMs: 20_000,
  });

  const started = Date.now();
  await planner.reply('what is closure?', context());
  const took = Date.now() - started;

  // The point of the check is the ordering, not the exact number: a planner
  // that tried the network first could not possibly finish this quickly.
  assert.ok(took < 1000, `took ${took}ms — it waited for the network`);
});

test('online, the model is still asked', async () => {
  let called = false;
  const planner = modelPlanner({
    transport: async () => {
      called = true;
      throw new Error('stub');
    },
    online: () => true,
  });

  const reply = await planner.reply('how big is the parcel?', context());
  assert.equal(called, true, 'the model was skipped while online');
  // A failed transport still answers, from the rules — that is the existing
  // guarantee and it must survive the offline path being added.
  assert.ok(reply.text.length > 0);
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** A stand-in for IndexedDB: the same interface, a Map behind it. */
function memoryStore(): OutboxStore & { readonly rows: Map<string, OutboxItem> } {
  const rows = new Map<string, OutboxItem>();
  return {
    rows,
    put: async (item) => rows.set(item.id, item),
    all: async () => [...rows.values()],
    remove: async (id) => rows.delete(id),
    clear: async () => rows.clear(),
  };
}

test('work queued offline goes through when the network returns', async () => {
  const store = memoryStore();
  _resetOutbox(store);

  const sent: string[] = [];
  registerOutboxHandler('transcribe', async (item) => {
    sent.push(item.label);
    return { status: 'done' };
  });

  reportReachability(false);
  await enqueue('transcribe', 'levels page 1', { data: 'x', mediaType: 'image/jpeg' });
  await drainOutbox();

  assert.deepEqual(sent, [], 'the queue tried to send with no network');
  assert.equal(outboxItems().length, 1, 'the work was not kept');
  assert.equal(store.rows.size, 1, 'the work was not written down, so a reload would lose it');

  reportReachability(true);
  await drainOutbox();

  assert.deepEqual(sent, ['levels page 1']);
  assert.equal(outboxItems().length, 0, 'finished work stayed in the queue');
  assert.equal(store.rows.size, 0, 'finished work was left on disk');
});

test('a queued item survives a reload', async () => {
  const store = memoryStore();
  _resetOutbox(store);
  reportReachability(false);

  await enqueue('transcribe', 'levels page 2', { data: 'x', mediaType: 'image/jpeg' });

  // A new page load: same storage, nothing in memory.
  _resetOutbox(store);
  const restored = await loadOutbox();

  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.label, 'levels page 2');
});

test('a failing item is retried, then parked rather than hammered', async () => {
  _resetOutbox(memoryStore());
  reportReachability(true);

  let attempts = 0;
  registerOutboxHandler('transcribe', async () => {
    attempts += 1;
    return { status: 'retry', reason: 'no answer' };
  });

  await enqueue('transcribe', 'unlucky', {});
  for (let i = 0; i < 10; i += 1) await drainOutbox();

  assert.equal(attempts, MAX_ATTEMPTS, `tried ${attempts} times, expected ${MAX_ATTEMPTS}`);
  assert.equal(outboxItems().length, 1, 'a failed item was thrown away rather than kept');
  assert.equal(outboxItems()[0]?.lastError, 'no answer', 'the reason it failed was not kept');
});

test('a refusal is not retried at all', async () => {
  _resetOutbox(memoryStore());
  reportReachability(true);

  let attempts = 0;
  registerOutboxHandler('transcribe', async () => {
    attempts += 1;
    return { status: 'failed', reason: 'no coordinates on that page' };
  });

  await enqueue('transcribe', 'a photo of a gate', {});
  for (let i = 0; i < 5; i += 1) await drainOutbox();

  assert.equal(attempts, 1, 'a permanent refusal was retried');
  assert.equal(outboxItems().length, 1, 'the photograph was discarded');
});

test('a result nobody has looked at is neither retried nor lost', async () => {
  _resetOutbox(memoryStore());
  reportReachability(true);

  let reads = 0;
  registerOutboxHandler('transcribe', async (item) => {
    const payload = item.payload as { text?: string };
    if (payload.text) return { status: 'waiting' };
    reads += 1;
    await updateOutboxItem(item.id, { payload: { ...payload, text: 'P1 100 200' } });
    return { status: 'waiting' };
  });

  await enqueue('transcribe', 'levels', {});
  for (let i = 0; i < 4; i += 1) await drainOutbox();

  assert.equal(reads, 1, `the photograph was read ${reads} times — it would be charged for each`);
  assert.equal(outboxItems().length, 1, 'the transcription was dropped before anyone saw it');
  assert.equal(
    (outboxItems()[0]?.payload as { text?: string }).text,
    'P1 100 200',
    'the transcription was not kept',
  );
  assert.equal(outboxItems()[0]?.lastError, undefined, 'a successful read was recorded as an error');
});

test('two drains at once do not send the same work twice', async () => {
  _resetOutbox(memoryStore());
  reportReachability(true);

  let sends = 0;
  registerOutboxHandler('transcribe', async () => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 'done' };
  });

  await enqueue('transcribe', 'levels', {});
  await Promise.all([drainOutbox(), drainOutbox(), drainOutbox()]);

  assert.equal(sends, 1, `sent ${sends} times`);
});
