/**
 * Tests for roles, verification, password reset, and the audit trail.
 *
 * The Authentication Architecture's own integration checklist is what these
 * are written against, item by item, and each test is phrased as the property
 * rather than as the implementation — so it goes on holding if the code
 * underneath is rewritten, and fails the moment the property stops being true.
 *
 * The items that carry the most weight, and the ones worth reading first:
 *
 *   - signup cannot grant an admin role under any input at all;
 *   - the role check reads the *stored* role, so nothing a client sends
 *     matters;
 *   - a reset invalidates every existing session, including the attacker's;
 *   - an emailed token never appears in an HTTP response.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAdmin, handleReport } from './_admin-routes.mjs';
import {
  DEFAULT_ROLE,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_ADMIN_TTL_MS,
  SESSION_SHORT_TTL_MS,
  beginPasswordReset,
  beginVerification,
  completePasswordReset,
  isAdminRole,
  login,
  register,
  requireAdmin,
  resolveSession,
  sessionUser,
  setRole,
  verifyEmail,
} from './_auth-core.mjs';
import { handleAuth } from './_auth-routes.mjs';
import { createFileStore } from './_auth-store-file.mjs';
import { createMailer } from './_mailer.mjs';

const store = () => createFileStore(null);
const GOOD = 'correct horse battery';

/** A mailer that keeps what it was asked to send, instead of sending it. */
function spyMailer() {
  const sent = [];
  const mailer = createMailer({
    webhook: 'https://mail.example/send',
    appUrl: 'https://surveyor.example',
    transport: async () => ({ ok: true }),
    log: {},
  });
  // `method` rather than `name`, because the mailer's own arguments include a
  // `name` — the recipient's — and spreading them over a field called `name`
  // silently replaced the thing being recorded with `null`.
  const wrap = (method) => {
    const original = mailer[method].bind(mailer);
    mailer[method] = async (args) => {
      sent.push({ method, ...args });
      return original(args);
    };
  };
  wrap('sendVerification');
  wrap('sendPasswordReset');
  return { mailer, sent };
}

const routeContext = (db, body, extra = {}) => ({
  store: db,
  body,
  cookies: '',
  origin: 'https://surveyor.example',
  allowedOrigins: ['https://surveyor.example'],
  secure: true,
  ...extra,
});

/** Register, sign in, and hand back the session token. */
async function signedIn(db, email, options = {}) {
  await register(db, { email, password: GOOD }, options);
  if (options.verified) {
    const { token } = await beginVerification(db, (await db.findByEmail(email)).id);
    await verifyEmail(db, token);
  }
  const session = await login(db, { email, password: GOOD }, { requireVerification: false });
  assert.ok(session.ok, `could not sign in as ${email}`);
  return session;
}

// ---------------------------------------------------------------------------
// Roles: never self-assignable
// ---------------------------------------------------------------------------

test('signup cannot grant an admin role, whatever the request contains', async () => {
  const db = store();

  /*
   * Every shape somebody would try. This is not really a test of the
   * validation — it is a test that there is no parameter to validate: `register`
   * takes email, password and name, so none of these fields has anywhere to go.
   */
  const attempts = [
    { email: 'a@example.com', password: GOOD, role: 'admin' },
    { email: 'b@example.com', password: GOOD, role: 'developer' },
    { email: 'c@example.com', password: GOOD, Role: 'admin' },
    { email: 'd@example.com', password: GOOD, user: { role: 'admin' } },
    { email: 'e@example.com', password: GOOD, role: ['admin'] },
    { email: 'f@example.com', password: GOOD, isAdmin: true },
  ];

  for (const body of attempts) {
    const result = await register(db, body);
    assert.equal(result.ok, true, `registration failed for ${body.email}`);
    assert.equal(result.user.role, DEFAULT_ROLE, `${body.email} was granted ${result.user.role}`);
    assert.equal(isAdminRole(result.user.role), false);
  }
});

test('the same is true through the HTTP route', async () => {
  const db = store();
  const made = await handleAuth(
    'register',
    routeContext(db, { email: 'a@example.com', password: GOOD, role: 'admin' }),
  );
  assert.equal(made.status, 201);
  assert.equal(made.body.user.role, DEFAULT_ROLE);

  // And the stored record, not just what came back.
  const stored = await db.findByEmail('a@example.com');
  assert.equal(stored.role, DEFAULT_ROLE);
});

test('the deployment can name the first administrator; a request cannot', async () => {
  const db = store();

  const granted = await register(
    db,
    { email: 'ops@example.com', password: GOOD },
    { adminEmails: ['ops@example.com'] },
  );
  assert.equal(granted.user.role, 'admin');

  // The same list, a different address: still a surveyor.
  const other = await register(
    db,
    { email: 'someone@example.com', password: GOOD, role: 'admin' },
    { adminEmails: ['ops@example.com'] },
  );
  assert.equal(other.user.role, DEFAULT_ROLE);
});

test('only an admin may change a role, and a developer may not', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });
  await register(db, { email: 'dev@example.com', password: GOOD });
  await register(db, { email: 'sam@example.com', password: GOOD });

  const boss = await db.findByEmail('boss@example.com');
  const dev = await db.findByEmail('dev@example.com');
  const sam = await db.findByEmail('sam@example.com');

  const promoted = await setRole(db, { actor: boss, userId: dev.id, role: 'developer' });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.user.role, 'developer');

  // A developer can read the console and cannot hand out roles.
  const refused = await setRole(db, {
    actor: { ...dev, role: 'developer' },
    userId: sam.id,
    role: 'admin',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.equal((await db.findById(sam.id)).role, DEFAULT_ROLE);

  // And a surveyor certainly cannot promote themselves.
  const selfServe = await setRole(db, { actor: sam, userId: sam.id, role: 'admin' });
  assert.equal(selfServe.ok, false);
  assert.equal((await db.findById(sam.id)).role, DEFAULT_ROLE);
});

test('the last administrator cannot demote themselves out of the building', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });
  const boss = await db.findByEmail('boss@example.com');

  const refused = await setRole(db, { actor: boss, userId: boss.id, role: 'surveyor' });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.equal((await db.findById(boss.id)).role, 'admin');

  // With a second admin in place it is allowed, because there is a way back.
  await register(db, { email: 'other@example.com', password: GOOD });
  const other = await db.findByEmail('other@example.com');
  await setRole(db, { actor: boss, userId: other.id, role: 'admin' });

  const allowed = await setRole(db, { actor: boss, userId: boss.id, role: 'surveyor' });
  assert.equal(allowed.ok, true);
});

test('losing a role ends the sessions that had it', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });
  await register(db, { email: 'other@example.com', password: GOOD });
  const boss = await db.findByEmail('boss@example.com');
  const other = await db.findByEmail('other@example.com');
  await setRole(db, { actor: boss, userId: other.id, role: 'developer' });

  const session = await login(db, { email: 'other@example.com', password: GOOD });
  assert.equal((await requireAdmin(db, session.token)).ok, true);

  await setRole(db, { actor: boss, userId: other.id, role: 'surveyor' });

  /*
   * Immediately, not at the session's own expiry.
   *
   * Someone whose access has just been revoked keeping it until their cookie
   * happens to lapse is the difference between revocation and a request.
   */
  assert.equal(await sessionUser(db, session.token), null);
});

// ---------------------------------------------------------------------------
// The role gate is server-side
// ---------------------------------------------------------------------------

test('the admin gate reads the stored role, not anything the caller sends', async () => {
  const db = store();
  const surveyor = await signedIn(db, 'sam@example.com');

  // Everything a client could try: the body, the query, a claimed role.
  for (const attempt of [
    { body: { role: 'admin' } },
    { body: { user: { role: 'admin' } } },
    { query: { role: 'admin' } },
    { query: { as: 'developer' } },
  ]) {
    const result = await handleAdmin('overview', {
      store: db,
      token: surveyor.token,
      body: attempt.body ?? {},
      query: attempt.query ?? {},
    });
    assert.equal(result.status, 404, `a surveyor got in with ${JSON.stringify(attempt)}`);
  }

  // The same session, once the role is actually granted server-side.
  const user = await db.findByEmail('sam@example.com');
  await db.setRole(user.id, 'developer');
  const again = await login(db, { email: 'sam@example.com', password: GOOD });
  const allowed = await handleAdmin('overview', { store: db, token: again.token, query: {} });
  assert.equal(allowed.status, 200);
});

test('every admin view is gated, not just the first one', async () => {
  const db = store();
  const surveyor = await signedIn(db, 'sam@example.com');

  for (const action of [
    'overview',
    'projects',
    'project',
    'suggestions',
    'errors',
    'usage',
    'audit',
    'accounts',
    'set-role',
  ]) {
    const result = await handleAdmin(action, {
      store: db,
      token: surveyor.token,
      body: {},
      query: { id: 'p1' },
    });
    assert.equal(result.status, 404, `${action} answered a surveyor`);
  }
});

test('a signed-out caller gets nothing from the console', async () => {
  const db = store();
  const result = await handleAdmin('overview', { store: db, token: null, query: {} });
  assert.equal(result.status, 401);
});

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

test('an unverified account is refused, with something it can act on', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  const blocked = await login(
    db,
    { email: 'a@example.com', password: GOOD },
    { requireVerification: true },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.reason, 'unverified');
  assert.match(blocked.error, /verify/i);

  // Distinct from a wrong password, which is the whole point: one of these
  // has a next step and the other does not.
  const wrong = await login(
    db,
    { email: 'a@example.com', password: 'nope nope nope' },
    { requireVerification: true },
  );
  assert.notEqual(wrong.status, blocked.status);
  assert.equal(wrong.reason, 'bad-credentials');
});

test('verification is checked after the password, so it reveals no accounts', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  // A wrong password against an unverified account must look exactly like a
  // wrong password against an address with no account at all. If verification
  // were checked first, the first would say "verify your email" and the
  // second would not — which answers "does this person have an account".
  const unverifiedWrongPassword = await login(
    db,
    { email: 'a@example.com', password: 'nope nope nope' },
    { requireVerification: true },
  );
  const noSuchAccount = await login(
    db,
    { email: 'nobody@example.com', password: 'nope nope nope' },
    { requireVerification: true },
  );

  assert.equal(unverifiedWrongPassword.error, noSuchAccount.error);
  assert.equal(unverifiedWrongPassword.status, noSuchAccount.status);
});

test('a verification link works once, and then never again', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const user = await db.findByEmail('a@example.com');

  const { token } = await beginVerification(db, user.id);
  const first = await verifyEmail(db, token);
  assert.equal(first.ok, true);
  assert.equal((await db.findById(user.id)).emailVerified, true);

  const second = await verifyEmail(db, token);
  assert.equal(second.ok, false);
  assert.match(second.error, /not valid|already/i);

  // And now sign-in works even where verification is insisted on.
  const session = await login(
    db,
    { email: 'a@example.com', password: GOOD },
    { requireVerification: true },
  );
  assert.equal(session.ok, true);
});

test('an expired verification link says so, and says what to do', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const user = await db.findByEmail('a@example.com');
  const { token } = await beginVerification(db, user.id);

  const later = Date.now() + 25 * 60 * 60 * 1000;
  const result = await verifyEmail(db, token, later);
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/i);
  assert.match(result.error, /new one/i);
});

test('resending replaces the previous link rather than adding to it', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const user = await db.findByEmail('a@example.com');

  const first = await beginVerification(db, user.id);
  const second = await beginVerification(db, user.id);

  // The old one is dead. Several live links in several inboxes is several
  // chances for the wrong one to be the one that leaks.
  assert.equal((await verifyEmail(db, first.token)).ok, false);
  assert.equal((await verifyEmail(db, second.token)).ok, true);
});

test('registering with verification required does not sign you in', async () => {
  const db = store();
  const { mailer, sent } = spyMailer();

  const made = await handleAuth(
    'register',
    routeContext(db, { email: 'a@example.com', password: GOOD }, {
      mailer,
      requireVerification: true,
    }),
  );

  assert.equal(made.status, 201);
  assert.equal(made.body.verificationRequired, true);
  /*
   * No cookie. This is the half-finished state the architecture warns about:
   * signed in *and* waiting to confirm, where the emailed link arrives at an
   * account that is already logged in and the two steps fight each other.
   */
  assert.equal(made.cookie, undefined);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'sendVerification');
});

test('registering without verification required signs you in, as before', async () => {
  const db = store();
  const made = await handleAuth(
    'register',
    routeContext(db, { email: 'a@example.com', password: GOOD }, { requireVerification: false }),
  );
  assert.equal(made.status, 201);
  assert.match(made.cookie, /surveyor_session=/);
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

test('a reset changes the password and ends every session in existence', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  // Two sessions: the owner's, and one an attacker is sitting in.
  const owner = await login(db, { email: 'a@example.com', password: GOOD });
  const intruder = await login(db, { email: 'a@example.com', password: GOOD });
  assert.ok(await sessionUser(db, intruder.token));

  const begun = await beginPasswordReset(db, 'a@example.com');
  const done = await completePasswordReset(db, { token: begun.token, password: 'a new long one' });
  assert.equal(done.ok, true);

  /*
   * Both are gone, and that includes the one that asked for the reset.
   *
   * A reset is what somebody does when they believe another person has their
   * password. Leaving that person signed in makes the reset a formality.
   */
  assert.equal(await sessionUser(db, owner.token), null);
  assert.equal(await sessionUser(db, intruder.token), null);

  assert.equal((await login(db, { email: 'a@example.com', password: GOOD })).ok, false);
  assert.equal((await login(db, { email: 'a@example.com', password: 'a new long one' })).ok, true);
});

test('a reset link works once', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const begun = await beginPasswordReset(db, 'a@example.com');

  assert.equal((await completePasswordReset(db, { token: begun.token, password: 'first new one' })).ok, true);
  const again = await completePasswordReset(db, { token: begun.token, password: 'second new one' });
  assert.equal(again.ok, false);
  // And the second attempt did not take effect.
  assert.equal((await login(db, { email: 'a@example.com', password: 'first new one' })).ok, true);
});

test('an expired reset link is refused', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const begun = await beginPasswordReset(db, 'a@example.com');

  const later = Date.now() + 2 * 60 * 60 * 1000;
  const result = await completePasswordReset(
    db,
    { token: begun.token, password: 'a new long one' },
    later,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/i);
});

test('a rejected new password does not cost you the link', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const begun = await beginPasswordReset(db, 'a@example.com');

  const tooShort = await completePasswordReset(db, { token: begun.token, password: 'short' });
  assert.equal(tooShort.ok, false);
  assert.ok(tooShort.token, 'no replacement link was issued');

  // The replacement works, so a typo does not send someone back to their inbox
  // with no explanation of why the link they just used stopped working.
  const retried = await completePasswordReset(db, {
    token: tooShort.token,
    password: 'a properly long one',
  });
  assert.equal(retried.ok, true);
});

test('a reset also proves the address', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const begun = await beginPasswordReset(db, 'a@example.com');
  await completePasswordReset(db, { token: begun.token, password: 'a new long one' });

  // They received mail at it and acted on it, which is the evidence
  // verification asks for. Without this they could reset their password and
  // still be refused at sign-in, with no way to break the loop.
  assert.equal((await db.findByEmail('a@example.com')).emailVerified, true);
  assert.equal(
    (await login(db, { email: 'a@example.com', password: 'a new long one' }, { requireVerification: true })).ok,
    true,
  );
});

test('reset emails to one address are rate limited', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  const results = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    results.push(await beginPasswordReset(db, 'a@example.com'));
  }

  // The abuse is email-bombing somebody, so the limit is on the address being
  // mailed rather than on whoever is asking.
  assert.ok(results.some((result) => result.token === null), 'never throttled');
  // And it still answers ok, so the throttle is not itself an oracle.
  assert.ok(results.every((result) => result.ok));
});

// ---------------------------------------------------------------------------
// Tokens never come back over HTTP
// ---------------------------------------------------------------------------

test('no route ever puts an emailed token in its response', async () => {
  const db = store();
  const { mailer, sent } = spyMailer();

  const made = await handleAuth(
    'register',
    routeContext(db, { email: 'a@example.com', password: GOOD }, {
      mailer,
      requireVerification: true,
    }),
  );

  const requested = await handleAuth(
    'request-reset',
    routeContext(db, { email: 'a@example.com' }, { mailer }),
  );

  const resent = await handleAuth(
    'resend-verification',
    routeContext(db, { email: 'a@example.com' }, { mailer }),
  );

  /*
   * The tokens exist — they were handed to the mailer — and none of them
   * appears anywhere in any response. This is the property the whole idea of
   * emailing a link rests on: if the token comes back to whoever asked, then
   * anybody can "verify" any address and reset any password, and both steps
   * become ceremony.
   */
  assert.ok(sent.length >= 2, 'nothing was mailed');
  const bodies = JSON.stringify([made.body, requested.body, resent.body]);
  for (const message of sent) {
    assert.ok(message.token.length > 20);
    assert.equal(bodies.includes(message.token), false, `${message.method} leaked its token`);
  }
});

test('asking for a reset says the same thing whether or not the account exists', async () => {
  const db = store();
  const { mailer } = spyMailer();
  await register(db, { email: 'a@example.com', password: GOOD });

  const known = await handleAuth('request-reset', routeContext(db, { email: 'a@example.com' }, { mailer }));
  const unknown = await handleAuth(
    'request-reset',
    routeContext(db, { email: 'nobody@example.com' }, { mailer }),
  );

  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.body, unknown.body);
});

test('resending verification says the same thing for any address', async () => {
  const db = store();
  const { mailer } = spyMailer();
  await register(db, { email: 'a@example.com', password: GOOD });

  const real = await handleAuth('resend-verification', routeContext(db, { email: 'a@example.com' }, { mailer }));
  const fake = await handleAuth('resend-verification', routeContext(db, { email: 'no@example.com' }, { mailer }));
  assert.deepEqual(real.body, fake.body);
  assert.equal(real.status, fake.status);
});

// ---------------------------------------------------------------------------
// Sessions: renewal, ceilings, and the shorter admin one
// ---------------------------------------------------------------------------

test('a session in use is extended rather than expiring mid-task', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const session = await login(db, { email: 'a@example.com', password: GOOD, remember: false });

  // Most of the way through its life, but not past it.
  const late = Date.now() + SESSION_SHORT_TTL_MS * 0.9;
  const found = await resolveSession(db, session.token, late);

  assert.ok(found, 'the session had already gone');
  assert.ok(found.renewedFor > 0, 'a session near its end was not renewed');

  // And it survives beyond where it would originally have died.
  const beyond = Date.now() + SESSION_SHORT_TTL_MS * 1.5;
  assert.ok(await resolveSession(db, session.token, beyond), 'renewal did not take');
});

test('a fresh session is not rewritten on every request', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const session = await login(db, { email: 'a@example.com', password: GOOD });

  const found = await resolveSession(db, session.token);
  assert.equal(found.renewedFor, null, 'a brand new session was renewed immediately');
});

test('renewal cannot push a session past its ceiling', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  const session = await login(db, { email: 'a@example.com', password: GOOD, remember: true });

  // Used constantly, right up to the ceiling.
  let at = Date.now();
  for (let step = 0; step < 200; step += 1) {
    at += 12 * 60 * 60 * 1000;
    await resolveSession(db, session.token, at);
  }

  /*
   * A sliding window with no ceiling is not "12 hours" or "30 days", it is
   * "forever, as long as you open the app". The ceiling is what makes the
   * renewal bounded, so this must be gone.
   */
  const past = Date.now() + SESSION_ABSOLUTE_TTL_MS + 1000;
  assert.equal(await sessionUser(db, session.token, past), null);
});

test('an admin session is short, and ignores "remember me"', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });

  const session = await login(db, { email: 'boss@example.com', password: GOOD, remember: true });
  assert.equal(session.maxAgeMs, SESSION_ADMIN_TTL_MS);

  // A surveyor asking to be remembered gets what they asked for; the point is
  // that the console is treated differently, not that nobody is remembered.
  await register(db, { email: 'sam@example.com', password: GOOD });
  const surveyor = await login(db, { email: 'sam@example.com', password: GOOD, remember: true });
  assert.ok(surveyor.maxAgeMs > SESSION_ADMIN_TTL_MS);
});

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

test('every auth event the console needs is written when it happens', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });
  await register(db, { email: 'sam@example.com', password: GOOD });

  await login(db, { email: 'sam@example.com', password: 'wrong one entirely' });
  await login(db, { email: 'sam@example.com', password: GOOD });

  const boss = await db.findByEmail('boss@example.com');
  const sam = await db.findByEmail('sam@example.com');
  await setRole(db, { actor: boss, userId: sam.id, role: 'developer' });

  const kinds = (await db.listEvents({ limit: 100 })).map((event) => event.kind);
  for (const expected of ['signup', 'login', 'login-failed', 'role-changed']) {
    assert.ok(kinds.includes(expected), `no ${expected} event was recorded`);
  }
});

test('a failed sign-in records which half was wrong, and never returns it', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });

  const wrongPassword = await login(db, { email: 'a@example.com', password: 'nope nope nope' });
  const noAccount = await login(db, { email: 'nobody@example.com', password: 'nope nope nope' });

  // The same answer to the browser…
  assert.equal(wrongPassword.error, noAccount.error);

  // …and a usable distinction in the log, which is what an operator needs
  // when somebody says "I cannot get in".
  const details = (await db.listEvents({ kinds: ['login-failed'] })).map((e) => e.detail);
  assert.ok(details.includes('wrong-password'));
  assert.ok(details.includes('no-such-account'));
});

test('a role change records who did it, to whom, and what changed', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });
  await register(db, { email: 'sam@example.com', password: GOOD });
  const boss = await db.findByEmail('boss@example.com');
  const sam = await db.findByEmail('sam@example.com');

  await setRole(db, { actor: boss, userId: sam.id, role: 'developer' });

  const [event] = await db.listEvents({ kinds: ['role-changed'] });
  assert.equal(event.userId, sam.id);
  assert.equal(event.actorId, boss.id);
  assert.equal(event.actorEmail, 'boss@example.com');
  assert.equal(event.role, 'developer');
  assert.match(event.detail, /surveyor → developer/);
});

test('a broken log never breaks a sign-in', async () => {
  const db = store();
  await register(db, { email: 'a@example.com', password: GOOD });
  // The log is a record of the system, not part of the transaction.
  db.recordEvent = async () => {
    throw new Error('disk full');
  };

  const session = await login(db, { email: 'a@example.com', password: GOOD });
  assert.equal(session.ok, true);
});

// ---------------------------------------------------------------------------
// What the console shows
// ---------------------------------------------------------------------------

test('an admin sees accounts without a single password hash', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });
  await register(db, { email: 'sam@example.com', password: GOOD });
  const session = await login(db, { email: 'boss@example.com', password: GOOD });

  const result = await handleAdmin('accounts', { store: db, token: session.token, query: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.users.length, 2);

  const serialised = JSON.stringify(result.body);
  assert.equal(serialised.includes('passwordHash'), false);
  assert.equal(serialised.includes('scrypt$'), false);
});

test('the console reports what was suggested against what was kept', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });
  const session = await login(db, { email: 'boss@example.com', password: GOOD });

  await handleReport({
    store: db,
    token: session.token,
    events: [
      { kind: 'suggestion-offered', projectId: 'p1', detail: { suggestion: 'title' } },
      { kind: 'suggestion-offered', projectId: 'p1', detail: { suggestion: 'title' } },
      { kind: 'suggestion-accepted', projectId: 'p1', detail: { suggestion: 'title' } },
      { kind: 'suggestion-offered', projectId: 'p2', detail: { suggestion: 'scale-bar' } },
      { kind: 'suggestion-rejected', projectId: 'p2', detail: { suggestion: 'scale-bar' } },
    ],
  });

  const result = await handleAdmin('suggestions', { store: db, token: session.token, query: {} });
  const title = result.body.suggestions.find((row) => row.type === 'title');
  assert.equal(title.offered, 2);
  assert.equal(title.accepted, 1);
  assert.equal(title.acceptanceRate, 0.5);

  const bar = result.body.suggestions.find((row) => row.type === 'scale-bar');
  assert.equal(bar.acceptanceRate, 0);
});

test('a suggestion nobody has seen reports no rate, not a rate of zero', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });
  const session = await login(db, { email: 'boss@example.com', password: GOOD });

  await handleReport({
    store: db,
    token: session.token,
    // Accepted with nothing recorded as offered: a shape that turns up when
    // reporting is added to one half of a flow before the other.
    events: [{ kind: 'suggestion-accepted', projectId: 'p1', detail: { suggestion: 'note' } }],
  });

  const result = await handleAdmin('suggestions', { store: db, token: session.token, query: {} });
  const note = result.body.suggestions.find((row) => row.type === 'note');
  // 0% and "no data" look identical on a dashboard and mean opposite things.
  assert.equal(note.acceptanceRate, null);
});

test('an empty console says whether anything is reporting at all', async () => {
  const db = store();
  await register(db, { email: 'boss@example.com', password: GOOD }, { adminEmails: ['boss@example.com'] });
  const session = await login(db, { email: 'boss@example.com', password: GOOD });

  const quiet = await handleAdmin('overview', { store: db, token: session.token, query: {} });
  assert.equal(quiet.body.reporting, false);

  await handleReport({
    store: db,
    token: session.token,
    events: [{ kind: 'validation', projectId: 'p1', detail: { status: 'ready' } }],
  });

  const busy = await handleAdmin('overview', { store: db, token: session.token, query: {} });
  assert.equal(busy.body.reporting, true);
});
