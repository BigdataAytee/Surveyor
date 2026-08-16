/**
 * A local authentication and admin server.
 *
 * Runs the same route handlers the deployed functions do, over plain
 * `node:http` and a file-backed store, so sign-in, verification, password
 * reset, the audit trail and the admin console can all be developed and tested
 * without a database or a cloud account.
 *
 *   node server/auth.mjs
 *   VITE_AUTH_ENDPOINT=http://127.0.0.1:8788/api/auth npm run dev
 *
 * Not a production server. It keeps accounts in one JSON file, serves over
 * plain http, and has no process supervision — it exists so the real code
 * paths can be exercised locally.
 *
 * With no mail webhook configured, verification and reset links are written to
 * this process's log. That is how they are meant to be read in development —
 * see `_mailer.mjs` for why they never travel back over HTTP.
 */

import { createServer } from 'node:http';

import { handleAdmin, handleReport } from '../../../api/_admin-routes.mjs';
import { SESSION_COOKIE, readCookie } from '../../../api/_auth-core.mjs';
import {
  callerAddress,
  handleAuth,
  readJsonBody,
  securityHeaders,
} from '../../../api/_auth-routes.mjs';
import { createFileStore } from '../../../api/_auth-store-file.mjs';
import { adminEmailsFromEnv, mailerFromEnv, verificationRequired } from '../../../api/_mailer.mjs';

const PORT = Number(process.env.AUTH_PORT ?? 8788);
const STORE_PATH = process.env.AUTH_STORE_PATH ?? '.auth-store.json';
const ORIGINS = (process.env.AUTH_ORIGINS ?? 'http://127.0.0.1:5173,http://127.0.0.1:4173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const store = createFileStore(STORE_PATH);
const mailer = mailerFromEnv(process.env, {
  appUrl: process.env.APP_URL ?? ORIGINS[0] ?? 'http://127.0.0.1:4173',
});
const requireVerification = verificationRequired(process.env, mailer);
const adminEmails = adminEmailsFromEnv();

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
  const isAuth = url.pathname.startsWith('/api/auth');
  const isAdmin = url.pathname.startsWith('/api/admin');

  if (!isAuth && !isAdmin) {
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
    const headers = securityHeaders(known);

    if (isAdmin) {
      const token = readCookie(request.headers.cookie ?? '', SESSION_COOKIE);
      const result =
        action === 'report'
          ? await handleReport({ store, token, events: body.events })
          : await handleAdmin(action, {
              store,
              body,
              token,
              query: Object.fromEntries(url.searchParams.entries()),
            });
      response.writeHead(result.status, headers).end(JSON.stringify(result.body));
      return;
    }

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
      ip: callerAddress(request.headers, request.socket.remoteAddress ?? null),
      mailer,
      requireVerification,
      adminEmails,
    });

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
  console.log(`admin on http://127.0.0.1:${PORT}/api/admin`);
  console.log(`allowing origins: ${ORIGINS.join(', ')}`);
  console.log(
    requireVerification
      ? 'email verification: required'
      : 'email verification: not required (no mail webhook configured)',
  );
  if (adminEmails.length > 0) {
    console.log(`admin on registration: ${adminEmails.join(', ')}`);
  }
});
