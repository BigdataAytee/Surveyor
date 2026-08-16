/**
 * A file-backed account store.
 *
 * This is the reference implementation of the store interface the auth core
 * is written against, and it is a real one — it is what a self-hosted install
 * or a local development run uses, and it is what the tests exercise.
 *
 * It is NOT suitable for a serverless deployment, and that is worth being
 * blunt about rather than discovering later: on Vercel, Lambda and the like
 * the filesystem is ephemeral and not shared between concurrent invocations,
 * so accounts written by one request would be invisible to the next and lost
 * on the next deploy. A deployment of that shape needs a store backed by a
 * database. The interface below is the whole contract for writing one.
 *
 * ---------------------------------------------------------------------------
 * The store interface
 * ---------------------------------------------------------------------------
 *
 *   findByEmail(email)        -> user | null
 *   findById(id)              -> user | null
 *   createUser(user)          -> void
 *   updatePassword(id, hash, at) -> void
 *   touchLogin(id, at)        -> void
 *   setEmailVerified(id, bool)-> void
 *   setRole(id, role)         -> void
 *   countByRole(role)         -> number
 *   listUsers({ limit, query })  -> user[]
 *
 *   createSession(session)    -> void
 *   findSession(lookup)       -> session | null
 *   renewSession(lookup, expiresAt) -> void
 *   deleteSession(lookup)     -> void
 *   deleteSessionsFor(userId) -> void
 *
 *   createToken(token)        -> void
 *   findToken(lookup)         -> token | null
 *   deleteToken(lookup)       -> void
 *   deleteTokensFor(userId, purpose) -> void
 *
 *   countAttempt(bucket, now, windowMs) -> number   (attempts in the window)
 *   clearAttempts(bucket)     -> void
 *   getLockout(bucket)        -> { until } | null
 *   setLockout(bucket, until) -> void
 *
 *   recordEvent(event)        -> void
 *   listEvents({ limit, kinds, since, userId }) -> event[]  (newest first)
 *
 * A user is `{ id, email, name, passwordHash, role, emailVerified, createdAt,
 * lastLoginAt }`.
 * A session is `{ lookup, userId, createdAt, expiresAt, absoluteExpiresAt,
 * remember }` — `lookup` is the SHA-256 of the token, never the token itself.
 * A token is `{ lookup, userId, purpose, createdAt, expiresAt, used }`, and
 * `lookup` is again a hash: a store full of reset links that could be clicked
 * would be worse than a store full of password hashes.
 *
 * `bucket` is an opaque rate-limit key, not an address — `login:<email>`,
 * `signup:<ip>`, `reset:<email>`. One mechanism, several things counted with
 * it, rather than a separate counter per rule that each drift on their own.
 *
 * Equivalent SQL, for whoever writes the database version:
 *
 *   CREATE TABLE users (
 *     id            uuid PRIMARY KEY,
 *     email         text UNIQUE NOT NULL,
 *     name          text,
 *     password_hash text NOT NULL,
 *     role          text NOT NULL DEFAULT 'surveyor',
 *     email_verified boolean NOT NULL DEFAULT false,
 *     created_at    timestamptz NOT NULL,
 *     last_login_at timestamptz
 *   );
 *   CREATE TABLE sessions (
 *     lookup     text PRIMARY KEY,
 *     user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 *     created_at timestamptz NOT NULL,
 *     expires_at timestamptz NOT NULL,
 *     absolute_expires_at timestamptz,
 *     remember   boolean NOT NULL DEFAULT false
 *   );
 *   CREATE INDEX ON sessions (user_id);
 *   CREATE TABLE auth_tokens (
 *     lookup     text PRIMARY KEY,
 *     user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 *     purpose    text NOT NULL,
 *     created_at timestamptz NOT NULL,
 *     expires_at timestamptz NOT NULL,
 *     used       boolean NOT NULL DEFAULT false
 *   );
 *   CREATE INDEX ON auth_tokens (user_id, purpose);
 *   CREATE TABLE login_attempts (
 *     bucket   text PRIMARY KEY,
 *     failures jsonb NOT NULL,
 *     locked_until timestamptz
 *   );
 *   CREATE TABLE auth_events (
 *     id      uuid PRIMARY KEY,
 *     at      timestamptz NOT NULL,
 *     kind    text NOT NULL,
 *     user_id uuid,
 *     email   text,
 *     role    text,
 *     actor_id uuid,
 *     actor_email text,
 *     ip      text,
 *     detail  text
 *   );
 *   CREATE INDEX ON auth_events (at DESC);
 *
 * The UNIQUE constraint on email matters: it is the last defence against two
 * simultaneous registrations for the same address, which no amount of checking
 * before the insert can rule out.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createFileStore(path) {
  let data = read(path);

  /*
   * Written whole, through a temporary file and a rename.
   *
   * A rename is atomic on every filesystem this runs on, so a process killed
   * mid-write leaves the previous file intact rather than a half-written one.
   * An account store truncated by bad timing is everyone locked out.
   */
  const flush = () => {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), 'utf8');
    renameSync(temporary, path);
  };

  return {
    async findByEmail(email) {
      return data.users.find((user) => user.email === email) ?? null;
    },

    async findById(id) {
      return data.users.find((user) => user.id === id) ?? null;
    },

    async createUser(user) {
      // Re-checked at the moment of writing, not only before it. Two
      // registrations racing for one address both pass the earlier check.
      if (data.users.some((existing) => existing.email === user.email)) {
        throw new Error('That address is already registered.');
      }
      data.users.push(user);
      flush();
    },

    async updatePassword(id, passwordHash, changedAt) {
      const user = data.users.find((candidate) => candidate.id === id);
      if (!user) return;
      user.passwordHash = passwordHash;
      user.passwordChangedAt = changedAt;
      flush();
    },

    async touchLogin(id, at) {
      const user = data.users.find((candidate) => candidate.id === id);
      if (!user) return;
      user.lastLoginAt = at;
      flush();
    },

    async setEmailVerified(id, verified) {
      const user = data.users.find((candidate) => candidate.id === id);
      if (!user) return;
      user.emailVerified = verified === true;
      flush();
    },

    async setRole(id, role) {
      const user = data.users.find((candidate) => candidate.id === id);
      if (!user) return;
      user.role = role;
      flush();
    },

    async countByRole(role) {
      return data.users.filter((user) => (user.role ?? 'surveyor') === role).length;
    },

    async listUsers({ limit = 200, query = '' } = {}) {
      const needle = String(query).trim().toLowerCase();
      return data.users
        .filter((user) => needle === '' || user.email.includes(needle))
        .slice(0, limit)
        // Never the password hash, even to an admin. The console has no use
        // for it, and a field that is never sent cannot be sent by accident.
        .map(({ passwordHash: _hash, ...rest }) => rest);
    },

    async createSession(session) {
      data.sessions.push(session);
      // Expired rows are dropped on write rather than by a scheduled job:
      // there is no scheduler here, and a store that only ever grows is a
      // store that eventually stops working.
      const now = Date.now();
      data.sessions = data.sessions.filter((candidate) => candidate.expiresAt > now);
      flush();
    },

    async findSession(lookup) {
      return data.sessions.find((session) => session.lookup === lookup) ?? null;
    },

    async renewSession(lookup, expiresAt) {
      const session = data.sessions.find((candidate) => candidate.lookup === lookup);
      if (!session) return;
      session.expiresAt = expiresAt;
      flush();
    },

    async deleteSession(lookup) {
      data.sessions = data.sessions.filter((session) => session.lookup !== lookup);
      flush();
    },

    async deleteSessionsFor(userId) {
      data.sessions = data.sessions.filter((session) => session.userId !== userId);
      flush();
    },

    async createToken(token) {
      data.tokens.push(token);
      const now = Date.now();
      data.tokens = data.tokens.filter((candidate) => candidate.expiresAt > now);
      flush();
    },

    async findToken(lookup) {
      return data.tokens.find((token) => token.lookup === lookup) ?? null;
    },

    async deleteToken(lookup) {
      data.tokens = data.tokens.filter((token) => token.lookup !== lookup);
      flush();
    },

    async deleteTokensFor(userId, purpose) {
      data.tokens = data.tokens.filter(
        (token) => !(token.userId === userId && token.purpose === purpose),
      );
      flush();
    },

    async countAttempt(bucket, now, windowMs) {
      const record = (data.attempts[bucket] ??= { failures: [], lockedUntil: 0 });
      record.failures = record.failures.filter((at) => now - at < windowMs);
      record.failures.push(now);
      flush();
      return record.failures.length;
    },

    async clearAttempts(bucket) {
      delete data.attempts[bucket];
      flush();
    },

    async getLockout(bucket) {
      const until = data.attempts[bucket]?.lockedUntil ?? 0;
      return until > 0 ? { until } : null;
    },

    async setLockout(bucket, until) {
      const record = (data.attempts[bucket] ??= { failures: [], lockedUntil: 0 });
      record.lockedUntil = until;
      flush();
    },

    async recordEvent(event) {
      data.events.push(event);
      /*
       * A cap, because this file grows forever otherwise.
       *
       * A self-hosted install with no log rotation would otherwise write a
       * single JSON file until the disk filled — and the failure would land on
       * a sign-in, since that is what writes here. The console shows a window
       * of recent activity, which is what it is for; anyone who needs a
       * permanent record should ship these somewhere that keeps them.
       */
      if (data.events.length > MAX_EVENTS) {
        data.events = data.events.slice(-MAX_EVENTS);
      }
      flush();
    },

    async listEvents({ limit = 200, kinds = null, since = null, userId = null } = {}) {
      return data.events
        .filter((event) => (kinds === null || kinds.includes(event.kind)))
        .filter((event) => (since === null || Date.parse(event.at) >= since))
        .filter((event) => (userId === null || event.userId === userId))
        .slice(-limit)
        .reverse();
    },

    /*
     * Product telemetry, kept apart from the audit trail on purpose.
     *
     * They answer different questions and deserve different treatment: the
     * audit trail is who did what to which account, and the telemetry is how
     * the pipeline and the assistant are behaving. Mixing them would mean one
     * retention policy for both, and the one that has to be kept longest would
     * win.
     */
    async recordTelemetry(event) {
      data.telemetry.push(event);
      if (data.telemetry.length > MAX_TELEMETRY) {
        data.telemetry = data.telemetry.slice(-MAX_TELEMETRY);
      }
      flush();
    },

    async listTelemetry({ limit = 500, kinds = null, since = null, projectId = null } = {}) {
      return data.telemetry
        .filter((event) => (kinds === null || kinds.includes(event.kind)))
        .filter((event) => (since === null || Date.parse(event.at) >= since))
        .filter((event) => (projectId === null || event.projectId === projectId))
        .slice(-limit)
        .reverse();
    },

    /** Test seam: forget everything, without touching the file on disk. */
    _reset() {
      data = { users: [], sessions: [], tokens: [], attempts: {}, events: [], telemetry: [] };
      flush();
    },
  };
}

/** How many auth events one file keeps. */
const MAX_EVENTS = 5000;

/** And how many telemetry events, which arrive far more often. */
const MAX_TELEMETRY = 20000;

function read(path) {
  const empty = {
    users: [],
    sessions: [],
    tokens: [],
    attempts: {},
    events: [],
    telemetry: [],
  };
  if (!path) return empty;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      // Absent in files written before one-time links and the audit trail
      // existed. An older store opens and works rather than being rejected.
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      telemetry: Array.isArray(parsed.telemetry) ? parsed.telemetry : [],
      attempts: parsed.attempts && typeof parsed.attempts === 'object' ? parsed.attempts : {},
    };
  } catch {
    // A missing file is the normal first run. A corrupt one is not something
    // to silently overwrite, but refusing to start would lock everybody out of
    // a self-hosted install over a stray byte, so it starts empty and the
    // previous file is left where an operator can find it.
    return empty;
  }
}
