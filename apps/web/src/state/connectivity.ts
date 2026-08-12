/**
 * Whether the network is there.
 *
 * The browser's own answer is only half of one. `navigator.onLine === false`
 * is trustworthy — the device knows when it has no interface — but `true` only
 * means there is a network attached, not that anything on it can be reached. A
 * site hut with wifi and no uplink reports `true` all day.
 *
 * So this combines the two things that can actually be known: what the browser
 * says, and what happened the last time we tried. A request that fails at the
 * transport layer (a `TypeError` from `fetch`, not a 500) says more about the
 * connection than `navigator.onLine` does, and it is what moves this module to
 * `offline` while the browser still claims otherwise.
 *
 * The distinction it does *not* make is between "server is down" and "we are
 * offline". They call for the same behaviour here — do the local thing, queue
 * the rest — and pretending to tell them apart would mean guessing.
 */

export type Connectivity = 'online' | 'offline';

type Listener = (state: Connectivity) => void;

const listeners = new Set<Listener>();

/**
 * Set when a request failed at the transport layer.
 *
 * Cleared by any success, and by the browser's own `online` event — coming
 * back onto a network is exactly the moment to stop assuming the last failure
 * still applies.
 */
let transportFailed = false;

/** How long a transport failure keeps us pessimistic with no other evidence. */
const DOUBT_MS = 20_000;
let doubtedAt = 0;

export function connectivity(): Connectivity {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (transportFailed && Date.now() - doubtedAt < DOUBT_MS) return 'offline';
  return 'online';
}

export function isOnline(): boolean {
  return connectivity() === 'online';
}

/**
 * Called by anything that talks to a server.
 *
 * `reachable: false` means the request never got an answer — not that it got a
 * bad one. A 401 is the server working correctly and must not be reported here,
 * or a wrong password would look like a dead network.
 */
export function reportReachability(reachable: boolean): void {
  const before = connectivity();

  if (reachable) {
    transportFailed = false;
  } else {
    transportFailed = true;
    doubtedAt = Date.now();
  }

  const after = connectivity();
  if (before !== after) announce(after);
}

export function subscribeConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(state: Connectivity): void {
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch {
      // One bad subscriber must not stop the rest being told.
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    transportFailed = false;
    announce(connectivity());
  });
  window.addEventListener('offline', () => announce(connectivity()));
}

/**
 * A fetch that reports what it learned.
 *
 * Everything that talks to a server should go through this, so that one
 * failure anywhere teaches the whole app it is offline rather than each caller
 * discovering it separately, twenty seconds at a time.
 */
export async function connectedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    const response = await fetch(input, init);
    reportReachability(true);
    return response;
  } catch (error) {
    // A caller's own AbortController is not evidence about the network.
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      reportReachability(false);
    }
    throw error;
  }
}
