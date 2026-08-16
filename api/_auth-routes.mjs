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
 *
 * Two rules hold across every route here:
 *
 *   - A token that was emailed never comes back in a response. Verification
 *     and reset work because only the mailbox owner has the link; returning it
 *     to whoever asked would make both steps ceremony.
 *   - Roles are read from the session, never from the body. `register` has no
 *     parameter for one, and `set-role` checks the caller's stored role.
 */

import {
  SESSION_COOKIE,
  beginPasswordReset,
  beginVerification,
  changePassword,
  clearedCookie,
  completePasswordReset,
  login,
  logout,
  originAllowed,
  readCookie,
  register,
  resolveSession,
  sessionCookie,
  sessionUser,
  verifyEmail,
  MAX_SIGNUPS_PER_IP,
  SIGNUP_WINDOW_MS,
} from './_auth-core.mjs';

/** Requests larger than this are refused before being parsed. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Handle one authenticated request.
 *
 * `context` carries what only the transport knows: the parsed body, the
 * cookie header, the request origin, the caller's address, and whether the
 * connection is secure. Returns `{ status, body, cookie }` — the caller
 * writes it.
 */
export async function handleAuth(action, context) {
  const {
    store,
    body = {},
    cookies,
    origin,
    allowedOrigins,
    secure,
    ip = null,
    mailer = null,
    requireVerification = false,
    adminEmails = [],
  } = context;

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
      /*
       * A limit on how many accounts one sender can create.
       *
       * Counted per address rather than per email, because the abuse being
       * stopped is automated signup and the whole point of it is that every
       * email is different.
       */
      if (ip) {
        const made = await store.countAttempt(`signup:${ip}`, Date.now(), SIGNUP_WINDOW_MS);
        if (made > MAX_SIGNUPS_PER_IP) {
          return {
            status: 429,
            body: { error: 'Too many accounts created from here. Try again later.' },
          };
        }
      }

      const result = await register(
        store,
        { email: body.email, password: body.password, name: body.name },
        { adminEmails, requireVerification },
      );
      if (!result.ok) return { status: result.status, body: { error: result.error } };

      const verification = await sendVerification(store, mailer, result.user);

      /*
       * Whether registering signs you in depends on one thing only.
       *
       * With verification required it does not, and the response says so —
       * auto-signing-in and *then* asking for the emailed link is the
       * half-finished state the architecture warns about, where the link
       * arrives at an account that is already logged in and the two steps
       * fight. With verification not required, they have just proved they know
       * the password, and asking for it again would be telling someone their
       * details were accepted and then behaving as though they were not.
       */
      if (requireVerification) {
        return {
          status: 201,
          body: {
            user: result.user,
            verificationRequired: true,
            verificationSent: verification.delivered,
            message: verification.delivered
              ? 'Check your email for a link to confirm your address.'
              : 'Your account was created, but the confirmation email could not be sent. ' +
                'Ask whoever runs this deployment to check its mail settings.',
          },
        };
      }

      const session = await login(
        store,
        { email: body.email, password: body.password, remember: body.remember === true },
        { requireVerification: false, ip },
      );
      if (!session.ok) return { status: session.status, body: { error: session.error } };

      return {
        status: 201,
        body: { user: session.user, verificationSent: verification.delivered },
        cookie: sessionCookie(session.token, { secure, maxAgeMs: session.maxAgeMs }),
      };
    }

    case 'login': {
      const result = await login(
        store,
        { email: body.email, password: body.password, remember: body.remember === true },
        { requireVerification, ip },
      );
      if (!result.ok) {
        return {
          status: result.status,
          body: {
            error: result.error,
            /*
             * The reason is machine-readable, and only for the states where
             * the browser has something useful to offer. "Unverified" gets a
             * resend button; a wrong password gets nothing, because there is
             * nothing to offer and a code would only tell a guesser which
             * half they got right.
             */
            ...(result.reason === 'unverified' ? { reason: 'unverified' } : {}),
          },
        };
      }

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
      const found = await resolveSession(store, token);
      // Not an error. "Nobody is signed in" is a normal answer to this
      // question, and treating it as a failure makes every first load look
      // broken in the console.
      if (!found) return { status: 200, body: { user: null } };

      return {
        status: 200,
        body: { user: found.user },
        /*
         * A renewed session gets a fresh cookie on the way past.
         *
         * This is the whole of "stay signed in while you are working": opening
         * the app pushes the expiry out, and the browser is handed the new
         * lifetime as a side effect of asking who it is. Nothing has to poll,
         * and there is no second token to keep in step.
         */
        ...(found.renewedFor
          ? { cookie: sessionCookie(token, { secure, maxAgeMs: found.renewedFor }) }
          : {}),
      };
    }

    case 'verify': {
      const result = await verifyEmail(store, body.token);
      if (!result.ok) return { status: result.status, body: { error: result.error } };
      /*
       * Verifying does not sign you in.
       *
       * The link may well be opened on a different device from the one that
       * registered — a phone, from the mail app — and quietly creating a
       * session there is not what somebody clicking "confirm my address"
       * asked for.
       */
      return { status: 200, body: { ok: true, email: result.user.email } };
    }

    case 'resend-verification': {
      /*
       * Answered identically whether or not the address exists, and whether or
       * not it is already verified. This route would otherwise be a cleaner
       * enumeration oracle than sign-in, since it needs no password.
       */
      const address = String(body.email ?? '');
      const user = await store.findByEmail(address.trim().toLowerCase());
      if (user && user.emailVerified !== true) {
        await sendVerification(store, mailer, user);
      }
      return {
        status: 200,
        body: {
          ok: true,
          message: 'If that address needs confirming, we have sent the link again.',
        },
      };
    }

    case 'request-reset': {
      const result = await beginPasswordReset(store, body.email);
      if (result.token && mailer) {
        await mailer.sendPasswordReset({
          to: result.user.email,
          name: result.user.name,
          token: result.token,
        });
      }
      /*
       * One answer, always.
       *
       * Not "we sent it" versus "no such account", and not a different status
       * code, and not a different response time worth measuring — the whole
       * defence is that this route says nothing about who has an account.
       */
      return {
        status: 200,
        body: {
          ok: true,
          message: 'If an account exists for that address, a reset link is on its way.',
        },
      };
    }

    case 'reset': {
      const result = await completePasswordReset(store, {
        token: body.token,
        password: body.password,
      });
      if (!result.ok) {
        return {
          status: result.status,
          body: {
            error: result.error,
            // Handed back only when it is the same link the sender already
            // holds, so a rejected password does not cost them the link.
            ...(result.token ? { token: result.token } : {}),
          },
        };
      }
      /*
       * No session is issued, and the cookie is cleared.
       *
       * Every session was just destroyed on purpose; handing this one a new
       * one immediately would re-open the door the reset closed, for whoever
       * happens to be holding this browser.
       */
      return {
        status: 200,
        body: { ok: true, message: 'Your password has been changed. Sign in with it.' },
        cookie: clearedCookie({ secure }),
      };
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
 * Mint a verification link and hand it to the mailer.
 *
 * Returns only whether it went. The token itself does not leave this function
 * — the caller has no legitimate use for it and every response it could end
 * up in is one somebody other than the mailbox owner can read.
 */
async function sendVerification(store, mailer, user) {
  if (!mailer) return { delivered: false, reason: 'not-configured' };
  const { token } = await beginVerification(store, user.id);
  return mailer.sendVerification({ to: user.email, name: user.name ?? null, token });
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

/**
 * The caller's address, as well as it can be known.
 *
 * Behind a proxy the socket address is the proxy, so the forwarded header is
 * read first — and only its first entry, since the rest can be written by
 * whoever sent the request. This is used for rate limiting and for the audit
 * trail, never as an authentication factor, because it can be wrong.
 */
export function callerAddress(headers, fallback = null) {
  const forwarded = headers['x-forwarded-for'] ?? headers['X-Forwarded-For'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return fallback;
}
