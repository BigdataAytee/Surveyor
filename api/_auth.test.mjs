/**
 * Tests for the authentication core.
 *
 * These check the properties that make it authentication rather than a form:
 * that a password is never recoverable from what is stored, that a wrong
 * guess reveals nothing about which half was wrong, that guessing is slowed
 * down, and that sessions expire and can be revoked.
 *
 * Underscore-prefixed like the rest of the non-endpoints here: every other
 * file in this directory is deployed as a public function, and a test file
 * reachable over the network is not something to leave to chance.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_PASSWORD_LENGTH,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_ADMIN_TTL_MS,
  SESSION_SHORT_TTL_MS,
  beginPasswordReset,
  beginVerification,
  changePassword,
  completePasswordReset,
  emailProblem,
  hashPassword,
  hashToken,
  login,
  logout,
  normaliseEmail,
  originAllowed,
  passwordProblem,
  register,
  requireAdmin,
  resolveSession,
  sessionCookie,
  sessionUser,
  setRole,
  verifyEmail,
  verifyPassword,
} from './_auth-core.mjs';
import { createFileStore } from './_auth-store-file.mjs';
import { handleAuth } from './_auth-routes.mjs';

/** An in-memory store: the file store with no file behind it. */
const store = () => createFileStore(null);

const GOOD = 'correct horse battery';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

test('a stored password does not contain the password', async () => {
  const hash = await hashPassword(GOOD);
  assert.ok(!hash.includes(GOOD));
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
});

test('the same password hashes differently every time', async () => {
  // Salted. Without this, two people with the same password are visibly two
  // people with the same password, and one cracked hash breaks both.
  const a = await hashPassword(GOOD);
  const b = await hashPassword(GOOD);
  assert.notEqual(a, b);
  assert.ok(await verifyPassword(GOOD, a));
  assert.ok(await verifyPassword(GOOD, b));
});

test('verification rejects the wrong password and malformed hashes', async () => {
  const hash = await hashPassword(GOOD);
  assert.equal(await verifyPassword('wrong horse battery', hash), false);
  assert.equal(await verifyPassword('', hash), false);

  // Anything that is not a hash this build understands fails closed.
  for (const stored of ['', 'not-a-hash', 'scrypt$1$1$1$$', 'bcrypt$x$y', null, undefined]) {
    assert.equal(await verifyPassword(GOOD, stored), false, `accepted ${String(stored)}`);
  }
});

test('a password that differs only by unicode normalisation still works', async () => {
  // The same characters typed on two keyboards can arrive as different bytes.
  // Someone locked out of their own account by their keyboard layout would
  // have no way to work out why.
  const composed = 'café passphrase';
  const decomposed = 'café passphrase';
  assert.notEqual(composed, decomposed);

  const hash = await hashPassword(composed);
  assert.ok(await verifyPassword(decomposed, hash));
});

test('the password policy rejects what length alone would allow', () => {
  assert.ok(passwordProblem('short'));
  assert.ok(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1)));
  assert.equal(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH + 4), 'x@y.z'), null);

  assert.match(passwordProblem('password123'), /anyone would try/i);
  // The address in the password is a password anyone who knows the address has.
  assert.match(passwordProblem('rsurveyor12345', 'rsurveyor@example.com'), /email address/i);
  assert.ok(passwordProblem('a'.repeat(500)));
});

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

test('addresses are stored in one form', () => {
  assert.equal(normaliseEmail('  R.Surveyor@Example.COM '), 'r.surveyor@example.com');
  assert.equal(emailProblem('R.Surveyor@Example.com'), null);

  for (const bad of ['', 'nope', 'a@b', 'a b@c.d', '@example.com', 'a@@b.com']) {
    assert.ok(emailProblem(bad), `accepted ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Registration and sign-in
// ---------------------------------------------------------------------------

test('registering then signing in works, and is case-insensitive', async () => {
  const db = store();
  const made = await register(db, { email: 'R.Surveyor@Example.com', password: GOOD, name: 'R' });
  assert.equal(made.ok, true);
  assert.equal(made.user.email, 'r.surveyor@example.com');
  // The hash must never travel to a caller.
  assert.equal('passwordHash' in made.user, false);

  const session = await login(db, { email: 'r.surveyor@EXAMPLE.com', password: GOOD });
  assert.equal(session.ok, true);
  assert.equal('passwordHash' in session.user, false);
  assert.ok(session.token.length >= 32);
});

test('a second registration for one address says so, and says where to go', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const again = await register(db, { email: 'A@Example.com', password: GOOD });

  assert.equal(again.ok, false);
  /*
   * This one route tells the truth about an address, and the reason is
   * arithmetic rather than principle: signup cannot create a duplicate, so
   * *any* wording — including a deliberately vague one — tells the sender
   * whether the address was free. The vagueness buys nothing and costs a real
   * person, who typed their own address, a refusal that does not say why.
   *
   * Different capitals, same account. Someone who registered with a capital
   * and signs in without one must not end up with two.
   */
  assert.match(again.error, /already exists/i);
  assert.match(again.error, /sign in/i);
});

test('the routes where enumeration matters keep the defence', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  // Sign-in: one answer for a wrong password and for no such account.
  const wrong = await login(db, { email: 'a@example.com', password: 'wrong horse xyz' });
  const absent = await login(db, { email: 'nobody@example.com', password: GOOD });
  assert.equal(wrong.error, absent.error);
  assert.equal(wrong.status, absent.status);

  // Password reset: the *result* differs inside the server, and nothing that
  // reaches the caller does. That is what makes the difference unobservable.
  const known = await beginPasswordReset(db, 'a@example.com');
  const unknown = await beginPasswordReset(db, 'nobody@example.com');
  assert.equal(known.ok, unknown.ok);
  assert.equal(known.status ?? 200, unknown.status ?? 200);
  assert.ok(known.token, 'a real address produced no reset token');
  assert.equal(unknown.token, null, 'an unknown address produced a token');
});

test('a wrong password and an unknown address give the same answer', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  const wrongPassword = await login(db, { email: 'a@example.com', password: 'wrong horse xyz' });
  const noSuchUser = await login(db, { email: 'nobody@example.com', password: GOOD });

  assert.equal(wrongPassword.ok, false);
  assert.equal(noSuchUser.ok, false);
  assert.equal(wrongPassword.error, noSuchUser.error);
  assert.equal(wrongPassword.status, noSuchUser.status);
});

test('an unknown address costs about as long as a real one', async () => {
  // The decoy hash exists for this. Without it the unknown-address path
  // returns without hashing at all, and the difference is large enough to
  // measure over the network — which turns sign-in into a way to find out
  // who has an account.
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  const time = async (email) => {
    const started = process.hrtime.bigint();
    await login(db, { email, password: 'some other password' });
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  const real = await time('a@example.com');
  const absent = await time('nobody@example.com');

  // Generous: this is asserting the same order of magnitude, not a constant
  // time. A missing decoy makes the absent path near-instant, which this
  // catches, while ordinary scheduling noise does not trip it.
  assert.ok(
    absent > real * 0.4,
    `unknown address answered in ${absent.toFixed(0)}ms against ${real.toFixed(0)}ms for a real one`,
  );
});

test('repeated failures lock the account, and a success clears the count', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await login(db, { email: 'a@example.com', password: 'wrong guess here' });
    assert.equal(result.ok, false);
  }

  // Locked — and the right password does not open it either, which is the
  // point: a lockout that yields to the correct password is no obstacle to
  // someone who has just guessed it.
  const locked = await login(db, { email: 'a@example.com', password: GOOD });
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 429);
  assert.match(locked.error, /too many/i);

  // Once the lockout expires, the correct password works again.
  const later = Date.now() + 16 * 60 * 1000;
  const after = await login(db, { email: 'a@example.com', password: GOOD }, { now: later });
  assert.equal(after.ok, true);
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('a session identifies its user, and only the hash is stored', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const { token } = await login(db, { email: 'a@example.com', password: GOOD });

  const user = await sessionUser(db, token);
  assert.equal(user.email, 'a@example.com');

  // What is on disk must not be usable as a token.
  const stored = await db.findSession(hashToken(token));
  assert.ok(stored);
  assert.notEqual(stored.lookup, token);
  assert.equal(await sessionUser(db, stored.lookup), null);
});

test('an expired session stops working', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const { token } = await login(db, { email: 'a@example.com', password: GOOD, remember: false });

  assert.ok(await sessionUser(db, token));
  const past = Date.now() + SESSION_SHORT_TTL_MS + 1000;
  assert.equal(await sessionUser(db, past ? token : token, past), null);
});

test('signing out revokes the session immediately', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const { token } = await login(db, { email: 'a@example.com', password: GOOD });

  await logout(db, token);
  assert.equal(await sessionUser(db, token), null);
});

test('a forged or absent token is nobody', async () => {
  const db = store();
  for (const token of [null, undefined, '', 'made-up-token', 'x'.repeat(64)]) {
    assert.equal(await sessionUser(db, token), null, `accepted ${String(token)}`);
  }
});

test('changing a password ends every other session', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  const phone = await login(db, { email: 'a@example.com', password: GOOD });
  const laptop = await login(db, { email: 'a@example.com', password: GOOD });
  assert.ok(await sessionUser(db, phone.token));
  assert.ok(await sessionUser(db, laptop.token));

  const changed = await changePassword(db, phone.user.id, {
    current: GOOD,
    next: 'a different long passphrase',
  });
  assert.equal(changed.ok, true);

  // Someone changes their password because they think another person has it.
  // Leaving that person signed in elsewhere would defeat the change.
  assert.equal(await sessionUser(db, phone.token), null);
  assert.equal(await sessionUser(db, laptop.token), null);

  assert.equal((await login(db, { email: 'a@example.com', password: GOOD })).ok, false);
  assert.equal(
    (await login(db, { email: 'a@example.com', password: 'a different long passphrase' })).ok,
    true,
  );
});

test('a password change needs the current password', async () => {
  const db = store();
  const made = await register(db, { email: 'a@example.com', password: GOOD });

  const wrong = await changePassword(db, made.user.id, {
    current: 'not the password',
    next: 'a different long passphrase',
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 401);

  // And the new one still has to pass the policy.
  const weak = await changePassword(db, made.user.id, { current: GOOD, next: 'short' });
  assert.equal(weak.ok, false);
  assert.equal(weak.status, 400);
});

// ---------------------------------------------------------------------------
// Cookies and origins
// ---------------------------------------------------------------------------

test('the session cookie cannot be read by script or sent cross-site', () => {
  const cookie = sessionCookie('token-value', { secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);

  // Over plain http locally there is no Secure flag, or the browser drops the
  // cookie and nobody can sign in in development.
  assert.doesNotMatch(sessionCookie('t', { secure: false }), /Secure/);
});

test('requests from another origin are refused', () => {
  const allowed = ['https://surveyor.example'];
  assert.equal(originAllowed('https://surveyor.example', allowed), true);
  assert.equal(originAllowed('https://evil.example', allowed), false);
  // Some same-origin requests send no Origin at all; the cookie rules still
  // apply, so this is not treated as an attack.
  assert.equal(originAllowed(undefined, allowed), true);
});

// ---------------------------------------------------------------------------
// The HTTP layer
// ---------------------------------------------------------------------------

const routeContext = (db, body, cookies = '') => ({
  store: db,
  body,
  cookies,
  origin: 'https://surveyor.example',
  allowedOrigins: ['https://surveyor.example'],
  secure: true,
});

test('the routes register, identify, and sign out', async () => {
  const db = store();

  const made = await handleAuth('register', routeContext(db, { email: 'a@example.com', password: GOOD }));
  assert.equal(made.status, 201);
  assert.equal(made.body.user.email, 'a@example.com');
  assert.match(made.cookie, /surveyor_session=/);

  const token = /surveyor_session=([^;]+)/.exec(made.cookie)[1];
  const cookies = `surveyor_session=${token}`;

  const me = await handleAuth('me', routeContext(db, {}, cookies));
  assert.equal(me.body.user.email, 'a@example.com');

  const out = await handleAuth('logout', routeContext(db, {}, cookies));
  assert.match(out.cookie, /Max-Age=0/);

  const after = await handleAuth('me', routeContext(db, {}, cookies));
  assert.equal(after.body.user, null);
});

test('"who am I" with no session is an answer, not an error', async () => {
  const db = store();
  const me = await handleAuth('me', routeContext(db, {}));
  assert.equal(me.status, 200);
  assert.equal(me.body.user, null);
});

test('a cross-site request never reaches the password check', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  const result = await handleAuth('login', {
    ...routeContext(db, { email: 'a@example.com', password: GOOD }),
    origin: 'https://evil.example',
  });

  assert.equal(result.status, 403);
  assert.equal(result.cookie, undefined);
});
