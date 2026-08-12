/**
 * The HTTP shape of authentication.
 *
 * One handler, used by both the serverless function and the local development
 * server, so the two cannot disagree about what a route does. An auth path
 * that behaves one way in development and another in production is a path
 * nobody can reason about.
 *
 * Every response is deliberately terse. Error text says what the person can do
 * about it and nothing about what the server knows — which addresses exist,
 * which half of a credential was right, how many accounts there are.
 */

import {
  SESSION_COOKIE,
  changePassword,
  clearedCookie,
  login,
  logout,
  originAllowed,
  readCookie,
  register,
  sessionCookie,
  sessionUser,
} from './_auth-core.mjs';

/** Requests larger than this are refused before being parsed. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Handle one authenticated request.
 *
 * `context` carries what only the transport knows: the parsed body, the
 * cookie header, the request origin, and whether the connection is secure.
 * Returns `{ status, body, cookie }` — the caller writes it.
 */
export async function handleAuth(action, context) {
  const { store, body, cookies, origin, allowedOrigins, secure } = context;

  /*
   * Cross-site requests are refused before anything is read.
   *
   * `SameSite=Lax` on the cookie already prevents it riding along with a form
   * posted from another site. This is the second lock, and it is checked
   * first: a request that should not exist should not reach the password
   * comparison at all.
   */
  if (!originAllowed(origin, allowedOrigins)) {
    return { status: 403, body: { error: 'This request did not come from the app.' } };
  }

  const token = readCookie(cookies, SESSION_COOKIE);

  switch (action) {
    case 'register': {
      const result = await register(store, {
        email: body.email,
        password: body.password,
        name: body.name,
      });
      if (!result.ok) return { status: result.status, body: { error: result.error } };

      /*
       * Registering signs you in.
       *
       * The alternative — create the account, then ask for the password again
       * — tells someone their details were accepted and then behaves as though
       * they were not. They have just proved they know the password.
       */
      const session = await login(store, {
        email: body.email,
        password: body.password,
        remember: body.remember === true,
      });
      if (!session.ok) return { status: session.status, body: { error: session.error } };

      return {
        status: 201,
        body: { user: session.user },
        cookie: sessionCookie(session.token, { secure, maxAgeMs: session.maxAgeMs }),
      };
    }

    case 'login': {
      const result = await login(store, {
        email: body.email,
        password: body.password,
        remember: body.remember === true,
      });
      if (!result.ok) return { status: result.status, body: { error: result.error } };

      return {
        status: 200,
        body: { user: result.user },
        cookie: sessionCookie(result.token, { secure, maxAgeMs: result.maxAgeMs }),
      };
    }

    case 'logout': {
      await logout(store, token);
      // The cookie is cleared whether or not the session existed, so a stale
      // one in the browser cannot survive a sign-out.
      return { status: 200, body: { ok: true }, cookie: clearedCookie({ secure }) };
    }

    case 'me': {
      const user = await sessionUser(store, token);
      // Not an error. "Nobody is signed in" is a normal answer to this
      // question, and treating it as a failure makes every first load look
      // broken in the console.
      return { status: 200, body: { user: user ?? null } };
    }

    case 'password': {
      const user = await sessionUser(store, token);
      if (!user) return { status: 401, body: { error: 'Sign in again.' } };

      const result = await changePassword(store, user.id, {
        current: body.current,
        next: body.next,
      });
      if (!result.ok) return { status: result.status, body: { error: result.error } };

      /*
       * The session that made the change is ended too, along with the others.
       *
       * Simpler to reason about than keeping one alive: after a password
       * change every session in existence predates it, and "sign in again with
       * your new password" is an instruction people expect.
       */
      return { status: 200, body: { ok: true }, cookie: clearedCookie({ secure }) };
    }

    default:
      return { status: 404, body: { error: 'No such action.' } };
  }
}

/**
 * Read a JSON body, with a size limit.
 *
 * The limit is not about memory; it is that an unbounded read on an
 * unauthenticated endpoint is something anyone can point at the server.
 */
export async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request too large.');
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body was not valid JSON.');
  }
}

/** Headers every auth response carries. */
export function securityHeaders(origin) {
  return {
    'content-type': 'application/json; charset=utf-8',
    // Never cached, anywhere. A proxy holding on to a `me` response would hand
    // one person's account to the next request through it.
    'cache-control': 'no-store',
    vary: 'Origin, Cookie',
    ...(origin
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
        }
      : {}),
  };
}
