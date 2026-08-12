/**
 * The deployed authentication endpoint.
 *
 * One function for every action, chosen by `?action=`, because the platform
 * this deploys to bills and cold-starts per function and five near-identical
 * ones would be five things to keep in step.
 *
 * ---------------------------------------------------------------------------
 * Before this works in production
 * ---------------------------------------------------------------------------
 *
 * It needs a store backed by a database. The file store this falls back to is
 * real, but a serverless filesystem is ephemeral and unshared: accounts
 * written by one invocation are invisible to the next and gone on the next
 * deploy. Rather than appear to work and quietly lose people's accounts, this
 * refuses to run when `AUTH_STORE` is not configured for a persistent store.
 *
 * See `_auth-store-file.mjs` for the interface and the SQL to implement it
 * against.
 *
 * Environment:
 *   AUTH_STORE       'kv' for Redis over HTTP, 'file' for development. Unset,
 *                    a Redis is used if one is attached and this refuses to
 *                    run if not.
 *   KV_REST_API_URL / KV_REST_API_TOKEN
 *                    injected by Vercel KV. `UPSTASH_REDIS_REST_*` also works.
 *   AUTH_STORE_PATH  where the file store writes, when AUTH_STORE=file
 *   AUTH_ORIGINS     comma-separated origins allowed to call this. Unset,
 *                    same-origin only, which is what a normal deployment wants.
 */

import { handleAuth, securityHeaders } from './_auth-routes.mjs';
import { createFileStore } from './_auth-store-file.mjs';
import { kvStoreFromEnv } from './_auth-store-kv.mjs';

let cachedStore = null;

function resolveStore() {
  if (cachedStore) return cachedStore;

  const kind = process.env.AUTH_STORE ?? '';

  if (kind === 'kv') {
    cachedStore = kvStoreFromEnv();
    return cachedStore;
  }

  if (kind === 'file') {
    cachedStore = createFileStore(process.env.AUTH_STORE_PATH ?? '/tmp/surveyor-auth.json');
    return cachedStore;
  }

  /*
   * Nothing named, but a Redis is attached: use it.
   *
   * Adding Upstash or Vercel KV to a project injects its credentials
   * automatically, and requiring a second, hand-typed variable to say "yes,
   * the thing I just attached" is a step whose only outcome is a sign-in page
   * that answers 503 for reasons nobody can see.
   */
  if (kind === '') {
    cachedStore = kvStoreFromEnv();
    return cachedStore;
  }

  // Deliberately fatal. An auth endpoint that starts without somewhere to keep
  // accounts is one that accepts registrations and forgets them, and the
  // person affected finds out when they cannot sign in.
  return null;
}

function allowedOrigins() {
  const configured = (process.env.AUTH_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return configured;
}

export default async function handler(request, response) {
  const origin = request.headers.origin;
  const allowed = allowedOrigins();

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      ...securityHeaders(origin && allowed.includes(origin) ? origin : undefined),
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
    });
    response.end();
    return;
  }

  const store = resolveStore();
  if (!store) {
    response.writeHead(503, securityHeaders()).end(
      JSON.stringify({
        error:
          'Accounts are not set up on this deployment yet. Attach a Redis ' +
          '(Upstash or Vercel KV) to the project — its credentials are picked ' +
          'up automatically — or set AUTH_STORE.',
      }),
    );
    return;
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  const action = url.searchParams.get('action') ?? '';

  // `me` is the only one that reads rather than changes, so it is the only
  // one reachable by GET.
  if (action !== 'me' && request.method !== 'POST') {
    response.writeHead(405, securityHeaders(origin)).end(
      JSON.stringify({ error: 'Use POST.' }),
    );
    return;
  }

  let body = {};
  if (request.method === 'POST') {
    // The platform parses JSON bodies for us; fall back to the raw value when
    // it has not.
    body = typeof request.body === 'object' && request.body !== null ? request.body : {};
  }

  try {
    const result = await handleAuth(action, {
      store,
      body,
      cookies: request.headers.cookie ?? '',
      origin,
      allowedOrigins: allowed,
      // Deployed behind TLS. The flag is what stops the browser sending the
      // session cookie over plain http.
      secure: true,
    });

    const headers = securityHeaders(origin && allowed.includes(origin) ? origin : undefined);
    if (result.cookie) headers['set-cookie'] = result.cookie;

    response.writeHead(result.status, headers).end(JSON.stringify(result.body));
  } catch (error) {
    // Never the message: an exception from the store can carry a query, a
    // path, or an address, and none of that belongs in a response.
    console.error('[auth]', error);
    response.writeHead(500, securityHeaders(origin)).end(
      JSON.stringify({ error: 'Something went wrong. Try again.' }),
    );
  }
}
