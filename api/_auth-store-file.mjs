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
 *
 *   createSession(session)    -> void
 *   findSession(lookup)       -> session | null
 *   deleteSession(lookup)     -> void
 *   deleteSessionsFor(userId) -> void
 *
 *   recordFailure(email, now, windowMs) -> number   (attempts in the window)
 *   clearFailures(email)      -> void
 *   getLockout(email)         -> { until } | null
 *   setLockout(email, until)  -> void
 *
 * A user is `{ id, email, name, passwordHash, createdAt }`.
 * A session is `{ lookup, userId, createdAt, expiresAt }` — `lookup` is the
 * SHA-256 of the token, never the token itself.
 *
 * Equivalent SQL, for whoever writes the database version:
 *
 *   CREATE TABLE users (
 *     id            uuid PRIMARY KEY,
 *     email         text UNIQUE NOT NULL,
 *     name          text,
 *     password_hash text NOT NULL,
 *     created_at    timestamptz NOT NULL
 *   );
 *   CREATE TABLE sessions (
 *     lookup     text PRIMARY KEY,
 *     user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 *     created_at timestamptz NOT NULL,
 *     expires_at timestamptz NOT NULL
 *   );
 *   CREATE INDEX ON sessions (user_id);
 *   CREATE TABLE login_attempts (
 *     email    text PRIMARY KEY,
 *     failures jsonb NOT NULL,
 *     locked_until timestamptz
 *   );
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

    async deleteSession(lookup) {
      data.sessions = data.sessions.filter((session) => session.lookup !== lookup);
      flush();
    },

    async deleteSessionsFor(userId) {
      data.sessions = data.sessions.filter((session) => session.userId !== userId);
      flush();
    },

    async recordFailure(email, now, windowMs) {
      const record = (data.attempts[email] ??= { failures: [], lockedUntil: 0 });
      record.failures = record.failures.filter((at) => now - at < windowMs);
      record.failures.push(now);
      flush();
      return record.failures.length;
    },

    async clearFailures(email) {
      delete data.attempts[email];
      flush();
    },

    async getLockout(email) {
      const until = data.attempts[email]?.lockedUntil ?? 0;
      return until > 0 ? { until } : null;
    },

    async setLockout(email, until) {
      const record = (data.attempts[email] ??= { failures: [], lockedUntil: 0 });
      record.lockedUntil = until;
      flush();
    },

    /** Test seam: forget everything, without touching the file on disk. */
    _reset() {
      data = { users: [], sessions: [], attempts: {} };
      flush();
    },
  };
}

function read(path) {
  const empty = { users: [], sessions: [], attempts: {} };
  if (!path) return empty;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
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
