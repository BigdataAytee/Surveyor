/**
 * Authentication, the security-critical half.
 *
 * Everything here runs on a server. That is not an implementation detail, it
 * is the whole point: a sign-in checked in the browser protects nothing, since
 * whoever is holding the browser can simply set the flag that says they are
 * signed in. If any of this were ever moved client-side the feature would stop
 * being authentication and become decoration.
 *
 * Written against a small store interface rather than a particular database,
 * so the rules below — how a password is hashed, how long a session lives,
 * when an account is locked — are stated once and cannot drift between
 * environments. `_auth-store-file.mjs` implements the interface for local work
 * and self-hosting; a serverless deployment needs one backed by a real
 * database, because its filesystem does not survive between invocations.
 *
 * Deliberately dependency-free. Password hashing and constant-time comparison
 * are in Node's own crypto module, and an authentication path is the last
 * place to take on a supply chain.
 */

import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * scrypt parameters.
 *
 * N=32768 costs roughly a fifth of a second per attempt on a modern server.
 * That is meant to hurt: it is imperceptible once per sign-in and ruinous to
 * anyone working through a stolen table of hashes. `maxmem` has to be raised
 * because 128·N·r is 32 MB, which is exactly Node's default ceiling — leave it
 * and every hash throws.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

/** How long a session lasts without being used again. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A shorter life when the person did not ask to be remembered. */
export const SESSION_SHORT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The admin console's own, shorter, session.
 *
 * The console shows provenance trails, prompt/response pairs and error traces
 * across every project on the deployment. An unattended laptop signed into
 * that is worse than one signed into a single survey, so it re-authenticates
 * far sooner regardless of "remember me".
 */
export const SESSION_ADMIN_TTL_MS = 60 * 60 * 1000;

/**
 * How long a session may live in total, however much it is used.
 *
 * Renewal keeps a session alive while someone is working — see `sessionUser`
 * — and without a ceiling that turns "12 hours" into "forever, as long as you
 * open it once a day". The ceiling is what makes the sliding window bounded.
 */
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How much of a session's life must pass before opening the app renews it.
 *
 * Renewing on every request would mean writing to the session store on every
 * request. A third of the way through is often enough that nobody is ever
 * signed out mid-task and rare enough that it costs nothing.
 */
const SESSION_RENEW_AFTER = 1 / 3;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * The two access levels, and why there is no third.
 *
 * `surveyor` is the default and the only role public signup can produce. The
 * admin roles reach the monitoring console, which shows provenance trails and
 * AI prompt/response pairs across every project on the deployment — so they
 * are granted deliberately, by an existing admin or by deployment
 * configuration, and never by anything a stranger can put in a request body.
 */
export const ROLES = ['surveyor', 'developer', 'admin'];

/** The default, and the only role `register` can ever produce. */
export const DEFAULT_ROLE = 'surveyor';

/** The roles the admin console answers to. */
export const ADMIN_ROLES = ['developer', 'admin'];

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

/** Only an `admin` may change roles — a `developer` can read, not grant. */
export function canGrantRoles(role) {
  return role === 'admin';
}

// ---------------------------------------------------------------------------
// One-time tokens
// ---------------------------------------------------------------------------

/** How long an email verification link is good for. */
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a password reset link is good for.
 *
 * Much shorter than a verification link. A reset link is a live key to the
 * account for as long as it is valid, and it sits in an inbox — an inbox that
 * may itself be the thing that was compromised.
 */
export const RESET_TTL_MS = 60 * 60 * 1000;

/** What a one-time token is for. Stored with the token so the two cannot swap. */
export const TOKEN_PURPOSES = ['verify', 'reset'];

/**
 * Password rules.
 *
 * Length is the only requirement, because it is the only one that reliably
 * buys strength. Composition rules — a digit, a capital, a symbol — mostly
 * produce Password1! and a written-down note, so they are not imposed here.
 */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

/** How many failures before an account stops answering, and for how long. */
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Passwords common enough that length alone does not save them.
 *
 * A short list rather than a downloaded corpus: this catches the handful a
 * determined guesser tries first, and pretending to a complete list would be
 * worse than being clear that this is a floor, not a guarantee.
 */
const OBVIOUS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  '123456789', '1234567890', '12345678901', 'qwertyuiop', 'letmeinnow',
  'iloveyou1', 'welcome123', 'admin12345', 'surveyor12', 'changeme12',
]);

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * Hash a password for storage.
 *
 * The parameters travel with the hash. Without them a later change to the cost
 * would make every existing password unverifiable, and the usual fix — assume
 * the old values — is how a system ends up unable to raise its own cost.
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    Buffer.from(derived).toString('base64'),
  ].join('$');
}

/**
 * Whether a password matches a stored hash.
 *
 * Compared with `timingSafeEqual`, so the time taken does not vary with how
 * much of the hash was correct. A plain `===` on a hash leaks, one byte at a
 * time, what the right answer is.
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;

  const [scheme, n, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;

  const saltBytes = Buffer.from(salt, 'base64');
  const expectedBytes = Buffer.from(expected, 'base64');

  let derived;
  try {
    derived = Buffer.from(
      await scrypt(password.normalize('NFKC'), saltBytes, expectedBytes.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: SCRYPT.maxmem,
      }),
    );
  } catch {
    // A stored hash with parameters this build cannot honour is a failure to
    // verify, never a pass.
    return false;
  }

  return derived.length === expectedBytes.length && timingSafeEqual(derived, expectedBytes);
}

/**
 * What is wrong with a password, or null if nothing is.
 *
 * Checked on the server as well as in the browser. Client-side validation is
 * for telling someone early; it is not a control, because a request can be
 * made without ever loading the page.
 */
export function passwordProblem(password, email = '') {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. Length is what makes a password hard to guess.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `That is longer than ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (OBVIOUS.has(password.toLowerCase())) {
    return 'That is one of the first passwords anyone would try. Pick something else.';
  }

  const local = String(email).split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) {
    return 'Leave your email address out of your password.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * The stored form of an address.
 *
 * Lower-cased and trimmed so that one person cannot register twice with
 * different capitals and then be unable to work out which one they used.
 */
export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * A deliberately permissive check.
 *
 * The only authority on whether an address works is whether mail arrives at
 * it. A stricter pattern here would reject valid addresses — and plenty of
 * real ones look unusual — so this rejects what is obviously not an address
 * and leaves the rest.
 */
export function emailProblem(email) {
  const value = normaliseEmail(email);
  if (value.length === 0) return 'Enter your email address.';
  if (value.length > 254) return 'That address is too long.';
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
    return 'That does not look like an email address.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * A new session token, and the value to store for it.
 *
 * Only the hash is stored. Someone who reads the session table therefore
 * cannot use what they find to sign in as anybody — which is the difference
 * between a database leak and a total compromise.
 */
export function newSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, lookup: hashToken(token) };
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('base64url');
}

export function sessionCookie(token, { secure = true, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    // The browser must not be able to read it: an XSS that can read the
    // session cookie is an XSS that can become the user, anywhere, later.
    'HttpOnly',
    // Lax rather than Strict, so following a link into the app keeps you
    // signed in, while a cross-site form post still cannot carry the cookie.
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie({ secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const SESSION_COOKIE = 'surveyor_session';

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * The public shape of an account.
 *
 * Built by hand rather than by deleting fields from the stored record: a
 * denylist lets a newly added column leak by default, and the one column that
 * must never leave the server is the password hash.
 */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    role: user.role ?? DEFAULT_ROLE,
    emailVerified: user.emailVerified === true,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

/**
 * Create an account.
 *
 * Note what this function is *not* given: a role. It is not that the value is
 * validated and rejected — there is no parameter to put it in, so no request
 * body, however it is shaped, can reach the field. Roles arrive from
 * `adminEmails`, which is deployment configuration on the server, or later
 * from an existing admin through `setRole`.
 */
export async function register(
  store,
  { email, password, name },
  { now = Date.now(), adminEmails = [], requireVerification = false } = {},
) {
  const emailFault = emailProblem(email);
  if (emailFault) return { ok: false, status: 400, error: emailFault };

  const address = normaliseEmail(email);
  const passwordFault = passwordProblem(password, address);
  if (passwordFault) return { ok: false, status: 400, error: passwordFault };

  const existing = await store.findByEmail(address);
  if (existing) {
    /*
     * This one says plainly that the address is taken.
     *
     * It is the one place enumeration is not worth defending, and the reason
     * is arithmetic rather than principle: signup cannot create a duplicate,
     * so any wording at all tells the sender whether the address is free. A
     * vague message buys nothing and costs a real person — who typed their own
     * address and got a refusal that did not say why — a support request. The
     * paths where the defence *does* buy something, sign-in and password
     * reset, keep it.
     */
    return {
      ok: false,
      status: 409,
      error: 'An account with this email already exists. Sign in instead.',
      knownAddress: true,
    };
  }

  const user = {
    id: randomUUID(),
    email: address,
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : null,
    passwordHash: await hashPassword(password),
    /*
     * Granted by the deployment, not by the request.
     *
     * This is how the first admin comes into existence on a fresh install:
     * an operator who can set environment variables names their own address,
     * and from then on that account grants the rest through the console.
     */
    role: adminEmails.includes(address) ? 'admin' : DEFAULT_ROLE,
    // Unverified until proven otherwise, whether or not this deployment
    // insists on it — so turning verification on later does not retroactively
    // treat every existing account as confirmed.
    emailVerified: false,
    createdAt: new Date(now).toISOString(),
    lastLoginAt: null,
  };

  await store.createUser(user);
  await audit(store, {
    kind: 'signup',
    userId: user.id,
    email: address,
    role: user.role,
    at: now,
  });

  return { ok: true, user: publicUser(user), requireVerification };
}

export async function login(
  store,
  { email, password, remember },
  { now = Date.now(), requireVerification = false, ip = null } = {},
) {
  const address = normaliseEmail(email);
  const bucket = `login:${address}`;

  const lock = await store.getLockout(bucket);
  if (lock && lock.until > now) {
    const minutes = Math.ceil((lock.until - now) / 60000);
    return {
      ok: false,
      status: 429,
      error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      reason: 'locked-out',
    };
  }

  const user = await store.findByEmail(address);

  /*
   * A hash is verified even when there is no such account.
   *
   * Returning early on an unknown address makes the endpoint answer far faster
   * for addresses that do not exist, and that difference is measurable — it
   * turns sign-in into a way to enumerate who has an account.
   */
  const stored = user?.passwordHash ?? (await decoy());
  const correct = await verifyPassword(String(password ?? ''), stored);

  if (!user || !correct) {
    const attempts = await store.countAttempt(bucket, now, ATTEMPT_WINDOW_MS);
    if (attempts >= MAX_ATTEMPTS) {
      await store.setLockout(bucket, now + LOCKOUT_MS);
      await audit(store, { kind: 'lockout', email: address, ip, at: now });
    }
    await audit(store, {
      kind: 'login-failed',
      userId: user?.id ?? null,
      email: address,
      ip,
      at: now,
      // Which half was wrong is recorded for the console and never returned
      // to the browser — an operator debugging "I cannot get in" needs it, and
      // whoever is guessing must not have it.
      detail: user ? 'wrong-password' : 'no-such-account',
    });
    // One message for both causes, so a wrong guess never reveals which half
    // of it was right.
    return { ok: false, status: 401, error: 'Email or password is wrong.', reason: 'bad-credentials' };
  }

  await store.clearAttempts(bucket);

  /*
   * An unverified account is refused *after* the password is checked.
   *
   * The order is the point: telling someone their email is unverified before
   * checking the password would answer "does this address have an account
   * here" to anybody who asked. Refused with a specific, actionable message,
   * because unlike a wrong password there is something they can do about it.
   */
  if (requireVerification && user.emailVerified !== true) {
    await audit(store, {
      kind: 'login-blocked',
      userId: user.id,
      email: address,
      ip,
      at: now,
      detail: 'email-unverified',
    });
    return {
      ok: false,
      status: 403,
      error: 'Verify your email address to continue. Check your inbox for the link.',
      reason: 'unverified',
      email: address,
    };
  }

  const { token, lookup } = newSessionToken();
  const ttl = sessionLifetime(user, remember);
  await store.createSession({
    lookup,
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + ttl,
    // The ceiling travels with the session, so renewal has something to check
    // against that a renewed `expiresAt` cannot quietly push out.
    absoluteExpiresAt: now + SESSION_ABSOLUTE_TTL_MS,
    remember: remember === true,
  });

  await store.touchLogin(user.id, new Date(now).toISOString());
  await audit(store, {
    kind: 'login',
    userId: user.id,
    email: address,
    role: user.role ?? DEFAULT_ROLE,
    ip,
    at: now,
  });

  return { ok: true, user: publicUser(user), token, maxAgeMs: ttl };
}

/**
 * How long this person's session should last.
 *
 * An admin's is short and ignores "remember me", because what an admin session
 * opens is not one survey but everything the deployment knows about all of
 * them.
 */
function sessionLifetime(user, remember) {
  if (isAdminRole(user.role)) return SESSION_ADMIN_TTL_MS;
  return remember ? SESSION_TTL_MS : SESSION_SHORT_TTL_MS;
}

/**
 * A hash of a password nobody has.
 *
 * Verified against when the address is unknown, purely so that path costs the
 * same as a real one.
 *
 * Generated rather than written down. A hand-typed constant is one typo away
 * from decoding to the wrong number of bytes, and `verifyPassword` returns
 * early on a length mismatch — so the decoy would answer *faster* than a real
 * account, which is the exact timing signal it exists to remove. Built once
 * and cached, because building it per request would be a timing difference of
 * its own.
 */
let decoyHash = null;

async function decoy() {
  decoyHash ??= await hashPassword(randomBytes(32).toString('base64'));
  return decoyHash;
}

/**
 * Who is signed in, and whether their session was just extended.
 *
 * Returns `{ user, renewedFor }` — `renewedFor` is a new cookie lifetime when
 * the session was pushed out, and null when it was not.
 *
 * The renewal is what the architecture calls refresh, in the shape a
 * server-side session actually wants. A refresh token exists because a
 * stateless token cannot be extended without being reissued; a session row
 * can simply be given a later expiry. Adding a second token type here would be
 * two mechanisms doing one job, which is precisely the "half-implemented JWT
 * plus half-implemented cookie session" the architecture names as the most
 * common cause of being randomly signed out.
 */
export async function sessionUser(store, token, now = Date.now()) {
  const found = await resolveSession(store, token, now);
  return found ? found.user : null;
}

export async function resolveSession(store, token, now = Date.now()) {
  if (!token) return null;

  const lookup = hashToken(token);
  const session = await store.findSession(lookup);
  if (!session) return null;

  if (session.expiresAt <= now) {
    await store.deleteSession(session.lookup);
    return null;
  }

  /*
   * The ceiling, checked before the renewal that would otherwise raise it.
   *
   * Sessions written before this field existed have no ceiling. They are left
   * alone rather than assumed to have started at some guessed time: their own
   * expiry still ends them, and inventing a start date would sign people out
   * for having been here first.
   */
  if (session.absoluteExpiresAt !== undefined && session.absoluteExpiresAt <= now) {
    await store.deleteSession(session.lookup);
    return null;
  }

  const user = await store.findById(session.userId);
  if (!user) return null;

  const ttl = sessionLifetime(user, session.remember === true);
  const remaining = session.expiresAt - now;
  let renewedFor = null;

  if (remaining < ttl * (1 - SESSION_RENEW_AFTER)) {
    // Never past the ceiling, so a session that is used every day still ends
    // on the day the ceiling says it does.
    const capped = Math.min(
      now + ttl,
      session.absoluteExpiresAt ?? now + ttl,
    );
    if (capped > session.expiresAt) {
      await store.renewSession(session.lookup, capped);
      renewedFor = capped - now;
    }
  }

  return { user: publicUser(user), session, renewedFor };
}

export async function logout(store, token) {
  if (!token) return;
  await store.deleteSession(hashToken(token));
}

export async function changePassword(store, userId, { current, next }, now = Date.now()) {
  const user = await store.findById(userId);
  if (!user) return { ok: false, status: 401, error: 'Sign in again.' };

  if (!(await verifyPassword(String(current ?? ''), user.passwordHash))) {
    return { ok: false, status: 401, error: 'Your current password is wrong.' };
  }

  const fault = passwordProblem(next, user.email);
  if (fault) return { ok: false, status: 400, error: fault };

  await store.updatePassword(user.id, await hashPassword(next), new Date(now).toISOString());

  /*
   * Every other session ends.
   *
   * Changing a password is what someone does when they think another person
   * has it. Leaving that person signed in elsewhere would defeat the point of
   * the change entirely.
   */
  await store.deleteSessionsFor(user.id);
  await audit(store, { kind: 'password-changed', userId: user.id, email: user.email, at: now });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// One-time links: verification and password reset
// ---------------------------------------------------------------------------

/**
 * Mint a one-time token and store only its hash.
 *
 * Same reasoning as session tokens: whoever reads the store finds hashes, and
 * a hash is not a link anyone can click. The plain token is returned once,
 * to be put in an email, and never written down.
 */
async function issueToken(store, { userId, purpose, ttlMs, now }) {
  const token = randomBytes(32).toString('base64url');
  await store.createToken({
    lookup: hashToken(token),
    userId,
    purpose,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
    used: false,
  });
  return token;
}

/**
 * Spend a one-time token, or say precisely why it cannot be spent.
 *
 * Deleted rather than marked used, once it has been checked. A row that says
 * "used: true" is a row a later bug can read as still valid; a row that is
 * gone cannot be.
 */
async function spendToken(store, token, purpose, now) {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' };

  const record = await store.findToken(hashToken(token));
  // The purpose is checked, so a verification link cannot be presented as a
  // password reset — the two have very different consequences.
  if (!record || record.purpose !== purpose) return { ok: false, reason: 'unknown' };
  if (record.used === true) return { ok: false, reason: 'used' };
  if (record.expiresAt <= now) {
    await store.deleteToken(record.lookup);
    return { ok: false, reason: 'expired' };
  }

  await store.deleteToken(record.lookup);
  return { ok: true, userId: record.userId };
}

/**
 * Begin verifying an address.
 *
 * Returns the token for the caller to email. Any previous verification link
 * for the same account is dropped first, so "resend" cannot leave several live
 * links in several inboxes.
 */
export async function beginVerification(store, userId, now = Date.now()) {
  await store.deleteTokensFor(userId, 'verify');
  const token = await issueToken(store, { userId, purpose: 'verify', ttlMs: VERIFY_TTL_MS, now });
  return { token, expiresAt: now + VERIFY_TTL_MS };
}

export async function verifyEmail(store, token, now = Date.now()) {
  const spent = await spendToken(store, token, 'verify', now);
  if (!spent.ok) {
    return {
      ok: false,
      status: 400,
      error:
        spent.reason === 'expired'
          ? 'That link has expired. Sign in and we will send you a new one.'
          : 'That link is not valid. It may already have been used.',
    };
  }

  const user = await store.findById(spent.userId);
  if (!user) return { ok: false, status: 400, error: 'That link is not valid.' };

  await store.setEmailVerified(user.id, true);
  await audit(store, { kind: 'email-verified', userId: user.id, email: user.email, at: now });
  return { ok: true, user: publicUser({ ...user, emailVerified: true }) };
}

/**
 * Begin a password reset.
 *
 * Returns `{ token }` when there is an account to reset and `{ token: null }`
 * when there is not — and the caller must answer the browser identically
 * either way. That is the whole enumeration defence for this route: the
 * difference exists inside the server and never reaches the wire.
 */
export async function beginPasswordReset(store, email, now = Date.now()) {
  const address = normaliseEmail(email);
  const bucket = `reset:${address}`;

  /*
   * Rate limited per address, not per sender.
   *
   * The abuse this stops is not guessing — there is nothing here to guess. It
   * is using the reset form to bomb somebody else's inbox, which is aimed at
   * an address and is unaffected by a limit on whoever is sending.
   */
  const attempts = await store.countAttempt(bucket, now, RESET_REQUEST_WINDOW_MS);
  if (attempts > MAX_RESET_REQUESTS) return { ok: true, token: null, throttled: true };

  const user = await store.findByEmail(address);
  await audit(store, {
    kind: 'password-reset-requested',
    userId: user?.id ?? null,
    email: address,
    at: now,
    detail: user ? 'sent' : 'no-such-account',
  });
  if (!user) return { ok: true, token: null };

  await store.deleteTokensFor(user.id, 'reset');
  const token = await issueToken(store, { userId: user.id, purpose: 'reset', ttlMs: RESET_TTL_MS, now });
  return { ok: true, token, user };
}

export async function completePasswordReset(store, { token, password }, now = Date.now()) {
  const spent = await spendToken(store, token, 'reset', now);
  if (!spent.ok) {
    return {
      ok: false,
      status: 400,
      error:
        spent.reason === 'expired'
          ? 'That reset link has expired. Ask for a new one.'
          : 'That reset link is not valid. It may already have been used.',
    };
  }

  const user = await store.findById(spent.userId);
  if (!user) return { ok: false, status: 400, error: 'That reset link is not valid.' };

  const fault = passwordProblem(password, user.email);
  if (fault) {
    /*
     * A rejected password re-issues the link rather than burning it.
     *
     * Otherwise someone who types a too-short password has spent their one
     * reset and must start the whole thing again from their inbox — with no
     * explanation of why the link they just used stopped working.
     */
    const replacement = await issueToken(store, {
      userId: user.id,
      purpose: 'reset',
      ttlMs: Math.max(RESET_TTL_MS, 0),
      now,
    });
    return { ok: false, status: 400, error: fault, token: replacement };
  }

  await store.updatePassword(user.id, await hashPassword(password), new Date(now).toISOString());

  /*
   * Every session ends, including any the attacker holds.
   *
   * A reset is used precisely when someone believes their account is in
   * another person's hands. Leaving that person's session alive would make the
   * reset a formality.
   */
  await store.deleteSessionsFor(user.id);
  await store.deleteTokensFor(user.id, 'reset');

  /*
   * The reset also proves the address.
   *
   * They received mail at it and acted on it, which is the same evidence
   * verification asks for. Not marking it would leave someone able to reset
   * their password and still be refused at sign-in.
   */
  await store.setEmailVerified(user.id, true);
  await audit(store, { kind: 'password-reset', userId: user.id, email: user.email, at: now });

  return { ok: true, email: user.email };
}

/** How many reset emails one address can be sent, and over what window. */
const MAX_RESET_REQUESTS = 3;
const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;

/** How many accounts one sender can create, and over what window. */
export const MAX_SIGNUPS_PER_IP = 5;
export const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Change somebody's role.
 *
 * Only an `admin` may call this, and the check is the caller's *stored* role
 * read from the session — never a role named in the request. The last admin
 * cannot demote themselves, because a deployment with no admin has no way back
 * except an operator editing the database by hand.
 */
export async function setRole(store, { actor, userId, role }, now = Date.now()) {
  if (!canGrantRoles(actor.role)) {
    return { ok: false, status: 403, error: 'Only an administrator can change roles.' };
  }
  if (!ROLES.includes(role)) {
    return { ok: false, status: 400, error: 'That is not a role.' };
  }

  const user = await store.findById(userId);
  if (!user) return { ok: false, status: 404, error: 'No such account.' };

  const was = user.role ?? DEFAULT_ROLE;
  if (was === role) return { ok: true, user: publicUser(user), unchanged: true };

  if (was === 'admin' && role !== 'admin') {
    const admins = await store.countByRole('admin');
    if (admins <= 1) {
      return {
        ok: false,
        status: 409,
        error: 'That is the only administrator. Grant the role to someone else first.',
      };
    }
  }

  await store.setRole(user.id, role);

  /*
   * A role change ends that person's sessions.
   *
   * A session created as a surveyor should not silently become an admin
   * session — and, more importantly, one that has just *lost* the role must
   * stop reaching the console immediately rather than at its own expiry.
   */
  await store.deleteSessionsFor(user.id);

  await audit(store, {
    kind: 'role-changed',
    userId: user.id,
    email: user.email,
    role,
    actorId: actor.id,
    actorEmail: actor.email,
    at: now,
    detail: `${was} → ${role}`,
  });

  return { ok: true, user: publicUser({ ...user, role }) };
}

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

/**
 * Record something that happened to an account.
 *
 * Written at the point the thing happens, which is the only place it can be
 * written truthfully. The admin console reads these; reconstructing them later
 * from other tables would be guessing, and an audit trail that is a guess is
 * worse than none because it looks like evidence.
 *
 * Never allowed to fail a request. A sign-in that works must not be turned
 * into a sign-in that errors because the log was full — the log is a record of
 * the system, not a part of the transaction.
 */
export async function audit(store, event) {
  if (typeof store.recordEvent !== 'function') return;
  try {
    await store.recordEvent({
      id: randomUUID(),
      at: new Date(event.at ?? Date.now()).toISOString(),
      kind: event.kind,
      userId: event.userId ?? null,
      email: event.email ?? null,
      role: event.role ?? null,
      actorId: event.actorId ?? null,
      actorEmail: event.actorEmail ?? null,
      ip: event.ip ?? null,
      detail: event.detail ?? null,
    });
  } catch {
    /* see above */
  }
}

// ---------------------------------------------------------------------------
// Request guards
// ---------------------------------------------------------------------------

/**
 * The role gate the admin console is built on.
 *
 * Takes the session, reads the role the *server* has stored for that account,
 * and answers. Nothing the client sends is consulted — hiding a link in the
 * browser is a courtesy to the user, and this is the boundary.
 */
export async function requireAdmin(store, token, now = Date.now()) {
  const user = await sessionUser(store, token, now);
  if (!user) return { ok: false, status: 401, error: 'Sign in to continue.' };
  if (!isAdminRole(user.role)) {
    /*
     * 404, not 403.
     *
     * A signed-in surveyor who tries the admin URL should learn that there is
     * nothing at it, rather than that there is something they are not allowed
     * to see. The console is meant not to be discoverable by navigation.
     */
    return { ok: false, status: 404, error: 'No such page.' };
  }
  return { ok: true, user };
}

/**
 * Whether a state-changing request came from where it claims.
 *
 * `SameSite=Lax` already stops the cookie riding along with a cross-site form
 * post, and this is the second lock: the Origin header cannot be set by page
 * script, so a request from another site fails here even if the cookie rules
 * were somehow relaxed later.
 */
export function originAllowed(origin, allowed) {
  if (!origin) {
    // Same-origin requests from some clients omit it. The cookie rules are
    // still doing their job, so this is not treated as an attack.
    return true;
  }
  return allowed.includes(origin);
}
