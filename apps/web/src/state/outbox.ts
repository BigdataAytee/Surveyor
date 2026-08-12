/**
 * Work that needs a server, kept until there is one.
 *
 * A surveyor photographs a page of levels in a field with no signal. Today
 * that fails and the photograph is gone — they are told the service is not
 * reachable and left holding a phone. Everything else in this app was built so
 * the work can happen on site; this is the one place where it could not, and
 * the fix is not to make the network work but to stop needing it *now*.
 *
 * So the photograph is kept, and read when there is signal. The same shape
 * serves anything else that has to reach a server later — each kind registers
 * a handler and the queue does not care what it does.
 *
 * Three rules the queue holds to:
 *
 *   Nothing is dropped silently. An item that fails keeps its error and its
 *   attempt count and stays visible. A queue that quietly discards work is
 *   worse than no queue, because the work looked safe.
 *
 *   Nothing is retried forever. After `MAX_ATTEMPTS` an item is parked rather
 *   than deleted — still there, still openable, no longer hammering a server
 *   that has said no five times.
 *
 *   Nothing is processed twice at once. Draining is guarded, because two
 *   drains racing is how one photograph gets transcribed twice and charged
 *   twice.
 */

import { idbClear, idbDelete, idbGetAll, idbPut } from './idb.js';
import { isOnline, subscribeConnectivity } from './connectivity.js';

/**
 * Where the queue is kept.
 *
 * A seam rather than a direct call to IndexedDB, so the rules above — when to
 * retry, when to stop, what happens to a result nobody has looked at — can be
 * tested without a browser. Those rules are the part worth testing; whether
 * the browser can write a record is not.
 */
export interface OutboxStore {
  readonly put: (item: OutboxItem) => Promise<unknown>;
  readonly all: () => Promise<readonly OutboxItem[]>;
  readonly remove: (id: string) => Promise<unknown>;
  readonly clear: () => Promise<unknown>;
}

let store: OutboxStore = {
  put: idbPut,
  all: () => idbGetAll<OutboxItem>(),
  remove: idbDelete,
  clear: idbClear,
};

/**
 * One kind today, and the queue is written not to care.
 *
 * Reading a photographed note is the only thing in this app that needs a
 * server and can be deferred — the assistant answers from the engines, the
 * geometry is local, and sign-in is not something to do on someone's behalf an
 * hour later. Anything added later registers a handler and works the same way.
 */
export type OutboxKind = 'transcribe';

export interface OutboxItem {
  readonly id: string;
  readonly kind: OutboxKind;
  /** What to call this in a list a person reads. */
  readonly label: string;
  readonly createdAt: string;
  readonly attempts: number;
  readonly lastError?: string;
  /** Kind-specific. Only the handler for this kind knows what is in here. */
  readonly payload: unknown;
}

/** Enough tries to ride out a bad connection, few enough to stop. */
export const MAX_ATTEMPTS = 5;

export type OutboxOutcome =
  /** Finished. The item is removed. */
  | { readonly status: 'done' }
  /**
   * The server's part is finished, but a person still has to look at the
   * result — a transcription nobody has confirmed yet.
   *
   * Distinct from a failure on purpose. Parking it as an error would put a red
   * message on something that worked, and retrying it would transcribe the
   * same photograph again on every drain.
   */
  | { readonly status: 'waiting' }
  /** Worth trying again — a dead network, a 503. */
  | { readonly status: 'retry'; readonly reason: string }
  /** Trying again will not help — a malformed payload, a 400, no service. */
  | { readonly status: 'failed'; readonly reason: string };

export type OutboxHandler = (item: OutboxItem) => Promise<OutboxOutcome>;

const handlers = new Map<OutboxKind, OutboxHandler>();

export function registerOutboxHandler(kind: OutboxKind, handler: OutboxHandler): void {
  handlers.set(kind, handler);
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

type Listener = (items: readonly OutboxItem[]) => void;
const listeners = new Set<Listener>();

/**
 * A copy in memory, so the UI can render synchronously.
 *
 * IndexedDB is asynchronous and React is not. Reading the queue from disk on
 * every render would make an empty list flash on every mount.
 */
let cache: readonly OutboxItem[] = [];
let loaded = false;

export async function loadOutbox(): Promise<readonly OutboxItem[]> {
  const rows = await store.all();
  cache = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  loaded = true;
  announce();
  return cache;
}

export function outboxItems(): readonly OutboxItem[] {
  return cache;
}

/** Items still expected to go through — parked failures do not count. */
export function pendingCount(): number {
  return cache.filter((item) => item.attempts < MAX_ATTEMPTS).length;
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of [...listeners]) {
    try {
      listener(cache);
    } catch {
      // One bad subscriber must not stop the rest being told.
    }
  }
}

export async function enqueue(
  kind: OutboxKind,
  label: string,
  payload: unknown,
): Promise<OutboxItem> {
  const item: OutboxItem = {
    id: `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    label,
    createdAt: new Date().toISOString(),
    attempts: 0,
    payload,
  };

  await store.put(item);
  cache = [...cache, item];
  announce();

  // Straight through if there is a network. The queue is for when there is
  // not; making someone wait for a timer when they have signal would be a
  // queue that slowed the app down to prove it exists.
  if (isOnline()) void drainOutbox();
  return item;
}

export async function removeFromOutbox(id: string): Promise<void> {
  await store.remove(id);
  cache = cache.filter((item) => item.id !== id);
  announce();
}

/**
 * Change an item in place — for a handler that has a partial result to keep.
 *
 * Goes through the queue rather than around it, so the copy on disk and the
 * copy the UI is rendering cannot disagree.
 */
export async function updateOutboxItem(
  id: string,
  patch: Partial<Omit<OutboxItem, 'id' | 'kind'>>,
): Promise<void> {
  const existing = cache.find((item) => item.id === id);
  if (!existing) return;

  const next: OutboxItem = { ...existing, ...patch };
  await store.put(next);
  cache = cache.map((item) => (item.id === id ? next : item));
  announce();
}

/** The current copy of an item, since a handler may have changed it. */
function current(id: string, fallback: OutboxItem): OutboxItem {
  return cache.find((item) => item.id === id) ?? fallback;
}

/** Put a parked item back in the queue, on request. */
export async function retryItem(id: string): Promise<void> {
  const item = cache.find((entry) => entry.id === id);
  if (!item) return;

  const reset: OutboxItem = { ...item, attempts: 0 };
  delete (reset as { lastError?: string }).lastError;

  await store.put(reset);
  cache = cache.map((entry) => (entry.id === id ? reset : entry));
  announce();
  void drainOutbox();
}

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

/**
 * The drain in flight, if there is one.
 *
 * A promise rather than a boolean, and set before the first `await`, for two
 * reasons that both showed up as real defects. A flag raised *after* an await
 * is not a guard at all — two callers can pass it and transcribe the same
 * photograph twice, which costs money as well as being wrong. And a second
 * caller that returns immediately has told a lie: `await drainOutbox()` should
 * mean the queue has been drained, so a concurrent call joins the one running
 * rather than silently doing nothing.
 */
let draining: Promise<void> | null = null;

export function drainOutbox(): Promise<void> {
  if (draining) return draining;
  if (!isOnline()) return Promise.resolve();

  draining = drainOnce().finally(() => {
    draining = null;
  });
  return draining;
}

async function drainOnce(): Promise<void> {
  if (!loaded) await loadOutbox();

  // A snapshot, because handlers may enqueue. Whatever they add is picked up
  // by the next drain rather than extending this one indefinitely.
  for (const item of [...cache]) {
    if (!isOnline()) break;
    if (item.attempts >= MAX_ATTEMPTS) continue;

    const handler = handlers.get(item.kind);
    if (!handler) continue;

    let outcome: OutboxOutcome;
    try {
      outcome = await handler(item);
    } catch (error) {
      outcome = {
        status: 'retry',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.status === 'done') {
      await removeFromOutbox(item.id);
      continue;
    }
    // Handled, and now somebody else's turn. Left exactly as the handler
    // wrote it — it may have stored a result on the payload.
    if (outcome.status === 'waiting') continue;

    const failed: OutboxItem = {
      ...current(item.id, item),
      // A permanent failure is parked immediately rather than after five
      // identical rejections.
      attempts: outcome.status === 'failed' ? MAX_ATTEMPTS : item.attempts + 1,
      lastError: outcome.reason,
    };
    await store.put(failed);
    cache = cache.map((entry) => (entry.id === item.id ? failed : entry));
    announce();
  }
}

/**
 * Test seam: swap the storage and empty the queue.
 *
 * Exported because the alternative is a module that can only be exercised
 * inside a browser, and the decisions in it are exactly the kind that are
 * cheaper to get wrong in a test than on a phone in a field.
 */
export function _resetOutbox(replacement?: OutboxStore): void {
  if (replacement) store = replacement;
  cache = [];
  loaded = false;
  draining = null;
  handlers.clear();
  listeners.clear();
}

/**
 * Drain whenever the network comes back.
 *
 * Called once at startup. The alternative — a timer — either polls a dead
 * network for nothing or waits after signal returns, and the browser already
 * knows the moment it happens.
 */
export function startOutbox(): void {
  void loadOutbox().then(() => {
    if (isOnline()) void drainOutbox();
  });

  subscribeConnectivity((state) => {
    if (state === 'online') void drainOutbox();
  });
}
