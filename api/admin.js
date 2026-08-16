/**
 * The deployed admin endpoint.
 *
 * Two things live here: the console's read routes, which only a `developer` or
 * `admin` can reach, and the report route, which any signed-in surveyor calls
 * to tell the system what happened. They share a function because they share a
 * store and a cold start, and they share nothing else — the gate is inside
 * each handler, not out here.
 *
 * The same store as `auth.js`, deliberately. The console reads accounts, the
 * audit trail and telemetry together, and splitting them across two backends
 * would mean two things to provision and a console that half works when one of
 * them is missing.
 *
 * Environment: as `auth.js`. Nothing extra is required to turn the console on
 * — an account with an admin role is what makes it reachable, and
 * `AUTH_ADMIN_EMAILS` is how the first one comes to exist.
 */

import { handleAdmin, handleReport } from './_admin-routes.mjs';
import { SESSION_COOKIE, readCookie } from './_auth-core.mjs';
import { securityHeaders } from './_auth-routes.mjs';
import { createFileStore } from './_auth-store-file.mjs';
import { kvStoreFromEnv } from './_auth-store-kv.mjs';

let cachedStore = null;

function resolveStore() {
  if (cachedStore) return cachedStore;
  const kind = process.env.AUTH_STORE ?? '';
  if (kind === 'file') {
    cachedStore = createFileStore(process.env.AUTH_STORE_PATH ?? '/tmp/surveyor-auth.json');
  } else {
    cachedStore = kvStoreFromEnv();
  }
  return cachedStore;
}

function allowedOrigins() {
  return (process.env.AUTH_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export default async function handler(request, response) {
  const origin = request.headers.origin;
  const allowed = allowedOrigins();
  const headers = securityHeaders(origin && allowed.includes(origin) ? origin : undefined);

  if (request.method === 'OPTIONS') {
    response
      .writeHead(204, {
        ...headers,
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
      })
      .end();
    return;
  }

  const store = resolveStore();
  if (!store) {
    response
      .writeHead(503, headers)
      .end(JSON.stringify({ error: 'This deployment has no account store attached.' }));
    return;
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  const action = url.searchParams.get('action') ?? '';
  const token = readCookie(request.headers.cookie ?? '', SESSION_COOKIE);
  const body = typeof request.body === 'object' && request.body !== null ? request.body : {};

  try {
    if (action === 'report') {
      if (request.method !== 'POST') {
        response.writeHead(405, headers).end(JSON.stringify({ error: 'Use POST.' }));
        return;
      }
      const result = await handleReport({ store, token, events: body.events });
      response.writeHead(result.status, headers).end(JSON.stringify(result.body));
      return;
    }

    const query = Object.fromEntries(url.searchParams.entries());
    const result = await handleAdmin(action, { store, body, token, query });
    response.writeHead(result.status, headers).end(JSON.stringify(result.body));
  } catch (error) {
    // Never the message. An exception from the store can carry a key, and a
    // key here can carry an address.
    console.error('[admin]', error);
    response
      .writeHead(500, headers)
      .end(JSON.stringify({ error: 'Something went wrong. Try again.' }));
  }
}
