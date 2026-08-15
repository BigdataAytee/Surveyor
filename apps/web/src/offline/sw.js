/*
 * The service worker.
 *
 * Written as plain JavaScript rather than TypeScript because it is not part of
 * the app bundle — it is a separate script the browser runs on its own, and a
 * build step between here and what ships is a build step that can disagree
 * with what this file says. `PRECACHE` is filled in at build time with the
 * hashed asset names, which is the one thing this file cannot know for itself.
 *
 * What it is for: the app has to open on a site with no signal. Everything the
 * drawing tools need is already in the browser — the engines, the canvas, the
 * rule planner — but none of that matters if fetching index.html fails. This
 * keeps the shell on the device so the app starts, and then gets out of the way.
 *
 * What it deliberately does not do: cache anything from `/api/`. A stale
 * answer about who is signed in, or a model reply served from cache minutes
 * later, would be worse than no answer at all. Those requests go to the
 * network or they fail, and the app is written to handle failing.
 */

/* eslint-env serviceworker */

const VERSION = '__BUILD_ID__';
const CACHE = `surveyor-shell-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      /*
       * One at a time, and failures are survivable. `cache.addAll` rejects the
       * whole install if any single request fails, which would leave the app
       * with no offline shell because of one optional file.
       */
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch {
            // Logged nowhere on purpose: a service worker console message on
            // every install is noise, and the next launch will try again.
          }
        }),
      );
      // Take over as soon as this build is cached. The alternative — waiting
      // for every tab to close — means someone who reloads to get a fix keeps
      // being served the version that has the bug.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('surveyor-shell-') && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/*
 * `Vary` is ignored when matching, and this is not a shortcut.
 *
 * Vite marks its module script and stylesheet `crossorigin`, so the browser
 * sends an `Origin` header with them; a static server that answers
 * `Vary: Origin` then makes those responses unmatchable, because the copy this
 * worker precached was fetched without one. Every asset would miss, the app
 * would fail to open offline, and the cache would look perfectly healthy while
 * it happened — which is exactly how this was found.
 *
 * Safe because everything in here is this app's own content-hashed output.
 * There is no negotiated variant of it to get wrong.
 */
const MATCH = { ignoreVary: true };

/** Requests that must never be answered from a cache. */
function mustBeFresh(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/__');
}

/*
 * Tiles live in their own cache, with their own budget.
 *
 * Kept apart from the app shell so that clearing one does not take the other,
 * and so the cap below can never evict the files the app needs to start.
 */
const TILE_CACHE = 'surveyor-tiles';

/** Roughly a few sites' worth at a couple of zoom levels each. */
const TILE_LIMIT = 400;

function isTile(url) {
  // Recognised by shape rather than by host, so a deployment pointing at its
  // own provider gets the same behaviour without this file knowing the name.
  return /\/\d{1,2}\/\d+\/\d+(\.(png|jpe?g|webp|avif))?(\?|$)/.test(url.pathname);
}

async function tileResponse(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);

  /*
   * Cache first. Tiles at a given zoom and position do not change in any way
   * that matters to a survey, and going to the network first would mean a slow
   * or flaky connection is worse than none — which is precisely backwards for
   * where this app is used.
   */
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // `opaque` is what a no-cors image response looks like. Its status cannot
    // be read, so it is stored only when the request was made in a mode that
    // gives us a real one.
    if (response.ok || response.type === 'opaque') {
      void cache.put(request, response.clone()).then(() => trimTiles(cache));
    }
    return response;
  } catch (error) {
    // No tile and no network. Returning the error lets the page's `onerror`
    // fire, which is what puts "map imagery needs a connection" on screen.
    throw error;
  }
}

/** Keep the tile cache to its budget, oldest first. */
async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  // `keys()` is in insertion order, so the front of it is the least recently
  // added. Not true LRU, and it does not need to be: the cost of dropping a
  // tile is one request.
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((key) => cache.delete(key)));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET. A POST is someone doing something, and replaying or caching one
  // is how a request happens twice.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /*
   * Map tiles, which are the one cross-origin thing worth keeping.
   *
   * A surveyor who looked at the site's imagery with signal should see it
   * again without — that is the same site, the same afternoon, and refetching
   * is not an option out there. Only tiles that were actually viewed are kept,
   * and the store is capped: this is a cache of what someone looked at, not a
   * download of a region, which is a thing tile providers ask people not to do.
   */
  // Cross-origin only. A same-origin path that happened to look like a tile
  // would otherwise be routed away from the shell rules it belongs to.
  if (url.origin !== self.location.origin && isTile(url)) {
    event.respondWith(tileResponse(request));
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (mustBeFresh(url)) return;

  /*
   * A navigation is a request for the app, not for a file. Every route in this
   * app is rendered by the same shell, so that is what gets served — from the
   * cache first, because the whole point is that it works with the network
   * down.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match('/index.html', MATCH);
        if (cached) return cached;
        try {
          return await fetch(request);
        } catch {
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Surveyor</title>' +
              '<body style="font:16px system-ui;padding:2rem">' +
              '<h1>Surveyor</h1><p>This copy has not finished downloading yet. ' +
              'Open it once with a connection and it will work offline after that.</p>',
            { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  /*
   * Assets are content-hashed, so a cached one is never the wrong one and
   * there is nothing to revalidate. Anything else same-origin tries the
   * network and falls back — that ordering matters, because a file that is not
   * hashed can change under the same name.
   */
  const immutable = url.pathname.startsWith('/assets/');

  event.respondWith(
    (async () => {
      if (immutable) {
        const cached = await caches.match(request, MATCH);
        if (cached) return cached;
      }

      try {
        const response = await fetch(request);
        // Only keep what is ours and worth keeping. An opaque cross-origin
        // response has an unknowable status and would poison the cache.
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(CACHE);
          void cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await caches.match(request, MATCH);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
