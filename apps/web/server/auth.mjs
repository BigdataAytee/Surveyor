/**
 * A local authentication server.
 *
 * Runs the same route handler the deployed function does, over plain `node:http`
 * and a file-backed store, so sign-in can be developed and tested without a
 * database or a cloud account.
 *
 *   node server/auth.mjs
 *   VITE_AUTH_ENDPOINT=http://127.0.0.1:8788/api/auth npm run dev
 *
 * Not a production server. It keeps accounts in one JSON file, serves over
 * plain http, and has no process supervision — it exists so the real code
 * paths can be exercised locally.
 */

import { createServer } from 'node:http';

import { handleAuth, readJsonBody, securityHeaders } from '../../../api/_auth-routes.mjs';
import { createFileStore } from '../../../api/_auth-store-file.mjs';

const PORT = Number(process.env.AUTH_PORT ?? 8788);
const STORE_PATH = process.env.AUTH_STORE_PATH ?? '.auth-store.json';
const ORIGINS = (process.env.AUTH_ORIGINS ?? 'http://127.0.0.1:5173,http://127.0.0.1:4173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const store = createFileStore(STORE_PATH);

createServer(async (request, response) => {
  const origin = request.headers.origin;
  const known = origin && ORIGINS.includes(origin) ? origin : undefined;

  if (request.method === 'OPTIONS') {
    response
      .writeHead(204, {
        ...securityHeaders(known),
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
      })
      .end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  if (!url.pathname.startsWith('/api/auth')) {
    response.writeHead(404, securityHeaders()).end(JSON.stringify({ error: 'Not found.' }));
    return;
  }

  const action = url.searchParams.get('action') ?? '';

  let body = {};
  if (request.method === 'POST') {
    try {
      body = await readJsonBody(request);
    } catch (error) {
      response
        .writeHead(400, securityHeaders(known))
        .end(JSON.stringify({ error: error.message }));
      return;
    }
  }

  try {
    const result = await handleAuth(action, {
      store,
      body,
      cookies: request.headers.cookie ?? '',
      origin,
      allowedOrigins: ORIGINS,
      /*
       * No Secure flag locally.
       *
       * A Secure cookie is dropped by the browser over plain http, so setting
       * it here would mean nobody could stay signed in in development — and
       * the usual "fix" for that is to stop using it in production too.
       */
      secure: false,
    });

    const headers = securityHeaders(known);
    if (result.cookie) headers['set-cookie'] = result.cookie;

    response.writeHead(result.status, headers).end(JSON.stringify(result.body));
  } catch (error) {
    console.error('[auth]', error);
    response
      .writeHead(500, securityHeaders(known))
      .end(JSON.stringify({ error: 'Something went wrong. Try again.' }));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`auth on http://127.0.0.1:${PORT}/api/auth — accounts in ${STORE_PATH}`);
  console.log(`allowing origins: ${ORIGINS.join(', ')}`);
});
