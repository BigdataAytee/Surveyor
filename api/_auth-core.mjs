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
    createdAt: user.createdAt,
  };
}

export async function register(store, { email, password, name }, now = Date.now()) {
  const emailFault = emailProblem(email);
  if (emailFault) return { ok: false, status: 400, error: emailFault };

  const address = normaliseEmail(email);
  const passwordFault = passwordProblem(password, address);
  if (passwordFault) return { ok: false, status: 400, error: passwordFault };

  const existing = await store.findByEmail(address);
  if (existing) {
    /*
     * The same answer whether or not the address is taken.
     *
     * Saying "that email is already registered" turns this endpoint into a
     * way to ask whether someone has an account here, which for a professional
     * tool is a question worth not answering. The person who genuinely owns
     * the address is told to sign in instead, which is the advice they need
     * either way.
     */
    return {
      ok: false,
      status: 409,
      error: 'That address cannot be registered. If the account is yours, sign in instead.',
    };
  }

  const user = {
    id: randomUUID(),
    email: address,
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : null,
    passwordHash: await hashPassword(password),
    createdAt: new Date(now).toISOString(),
  };

  await store.createUser(user);
  return { ok: true, user: publicUser(user) };
}

export async function login(store, { email, password, remember }, now = Date.now()) {
  const address = normaliseEmail(email);

  const lock = await store.getLockout(address);
  if (lock && lock.until > now) {
    const minutes = Math.ceil((lock.until - now) / 60000);
    return {
      ok: false,
      status: 429,
      error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
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
    const attempts = await store.recordFailure(address, now, ATTEMPT_WINDOW_MS);
    if (attempts >= MAX_ATTEMPTS) {
      await store.setLockout(address, now + LOCKOUT_MS);
    }
    // One message for both causes, so a wrong guess never reveals which half
    // of it was right.
    return { ok: false, status: 401, error: 'Email or password is wrong.' };
  }

  await store.clearFailures(address);

  const { token, lookup } = newSessionToken();
  const ttl = remember ? SESSION_TTL_MS : SESSION_SHORT_TTL_MS;
  await store.createSession({
    lookup,
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + ttl,
  });

  return { ok: true, user: publicUser(user), token, maxAgeMs: ttl };
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

export async function sessionUser(store, token, now = Date.now()) {
  if (!token) return null;

  const session = await store.findSession(hashToken(token));
  if (!session) return null;

  if (session.expiresAt <= now) {
    await store.deleteSession(session.lookup);
    return null;
  }

  const user = await store.findById(session.userId);
  return user ? publicUser(user) : null;
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
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Request guards
// ---------------------------------------------------------------------------

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
