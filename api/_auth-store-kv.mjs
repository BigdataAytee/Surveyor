/**
 * An account store backed by Redis over HTTP.
 *
 * This is the one that works on a serverless deployment. The file store is a
 * real store and a good one, but on Vercel the filesystem is ephemeral and not
 * shared between invocations, so accounts written by one request are invisible
 * to the next and gone on the next deploy. That is why `api/auth.js` refuses
 * to start without a persistent store configured — and this is the persistent
 * store.
 *
 * Redis over its REST interface rather than a database driver, for one
 * reason: it needs nothing but `fetch`. A Postgres adapter would mean a
 * dependency, a connection pool, and a pool that behaves badly across
 * serverless invocations. Everything this store keeps is small, keyed, and
 * has a natural expiry, which is what Redis is for.
 *
 * Provisioning is a few clicks: add Upstash Redis (or Vercel KV) to the
 * project and the two environment variables below are injected for you.
 *
 *   KV_REST_API_URL / KV_REST_API_TOKEN            (Vercel KV)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (Upstash direct)
 *
 * It implements exactly the interface documented in `_auth-store-file.mjs`,
 * and is exercised by the same tests against a fake transport, so the two
 * cannot drift in behaviour without something failing.
 *
 * ---------------------------------------------------------------------------
 * The keys
 * ---------------------------------------------------------------------------
 *
 *   user:<id>            the user record, as JSON
 *   email:<address>      the id registered to that address — the uniqueness lock
 *   users                a set of every user id, for the console's list
 *   session:<lookup>     the session, as JSON, expiring with the session
 *   sessions:<userId>    a set of that user's session lookups
 *   token:<lookup>       a one-time link, expiring with itself
 *   tokens:<userId>:<p>  that user's live links for purpose `p`
 *   attempts:<bucket>    failed attempts and any lockout, expiring by itself
 *   events               a capped list of auth events, newest last
 *
 * `lookup` is the SHA-256 of the token, never the token. Someone who reads
 * every key in this store still cannot sign in as anybody, and cannot click
 * anybody's password reset link either.
 */

/** Long enough to cover a lockout many times over; short enough to expire. */
const ATTEMPT_TTL_SECONDS = 60 * 60;

/** How many auth events the console can look back over. */
const MAX_EVENTS = 5000;

/** And how many telemetry events, which arrive far more often. */
const MAX_TELEMETRY = 20000;

export function createKvStore({ url, token, transport = fetch }) {
  if (!url || !token) throw new Error('The account store needs a URL and a token.');

  const endpoint = url.replace(/\/+$/, '');

  /**
   * One Redis command.
   *
   * Errors are deliberately vague to the caller and specific to the log: a
   * store error can carry a key, and a key here contains an email address.
   */
  async function command(...args) {
    const response = await transport(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args.map((arg) => String(arg))),
    });

    if (!response.ok) {
      throw new Error(`The account store answered ${response.status}.`);
    }

    const payload = await response.json();
    if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
      throw new Error('The account store rejected a command.');
    }
    return payload?.result ?? null;
  }

  /** Redis returns strings; a missing key returns null. */
  async function getJson(key) {
    const raw = await command('GET', key);
    if (typeof raw !== 'string') return raw ?? null;
    try {
      return JSON.parse(raw);
    } catch {
      // A value we cannot parse is one we did not write, or one written by an
      // older shape. Treated as absent rather than crashing a sign-in.
      return null;
    }
  }

  const setJson = (key, value, ...rest) =>
    command('SET', key, JSON.stringify(value), ...rest);

  return {
    async findByEmail(email) {
      const id = await command('GET', `email:${email}`);
      return typeof id === 'string' ? this.findById(id) : null;
    },

    async findById(id) {
      return getJson(`user:${id}`);
    },

    async createUser(user) {
      /*
       * The address is claimed first, with NX, and that claim *is* the
       * uniqueness constraint — the same job the UNIQUE index does in the SQL
       * version. Checking before the write cannot rule out two registrations
       * racing for one address; only an atomic claim can.
       */
      const claimed = await command('SET', `email:${user.email}`, user.id, 'NX');
      if (claimed === null) throw new Error('That address is already registered.');

      await setJson(`user:${user.id}`, user);
      // The index the console lists from. Redis has no "scan by prefix" that
      // is safe to run on a live store, so membership is recorded as it goes.
      await command('SADD', 'users', user.id);
    },

    async updatePassword(id, passwordHash, changedAt) {
      const user = await this.findById(id);
      if (!user) return;
      await setJson(`user:${id}`, { ...user, passwordHash, passwordChangedAt: changedAt });
    },

    async touchLogin(id, at) {
      const user = await this.findById(id);
      if (!user) return;
      await setJson(`user:${id}`, { ...user, lastLoginAt: at });
    },

    async setEmailVerified(id, verified) {
      const user = await this.findById(id);
      if (!user) return;
      await setJson(`user:${id}`, { ...user, emailVerified: verified === true });
    },

    async setRole(id, role) {
      const user = await this.findById(id);
      if (!user) return;
      await setJson(`user:${id}`, { ...user, role });
    },

    async countByRole(role) {
      const ids = await command('SMEMBERS', 'users');
      let total = 0;
      for (const id of Array.isArray(ids) ? ids : []) {
        const user = await getJson(`user:${id}`);
        if (user && (user.role ?? 'surveyor') === role) total += 1;
      }
      return total;
    },

    async listUsers({ limit = 200, query = '' } = {}) {
      const needle = String(query).trim().toLowerCase();
      const ids = await command('SMEMBERS', 'users');
      const out = [];
      for (const id of Array.isArray(ids) ? ids : []) {
        if (out.length >= limit) break;
        const user = await getJson(`user:${id}`);
        if (!user) continue;
        if (needle !== '' && !String(user.email).includes(needle)) continue;
        const { passwordHash: _hash, ...rest } = user;
        out.push(rest);
      }
      return out;
    },

    async createSession(session) {
      // Expiring in the store as well as in the record. Redis drops the key on
      // its own, so a session cannot outlive its expiry even if a bug lets the
      // check through.
      const seconds = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
      await setJson(`session:${session.lookup}`, session, 'EX', seconds);

      // The index that makes "sign out everywhere" possible.
      await command('SADD', `sessions:${session.userId}`, session.lookup);
      await command('EXPIRE', `sessions:${session.userId}`, seconds);
    },

    async findSession(lookup) {
      return getJson(`session:${lookup}`);
    },

    async renewSession(lookup, expiresAt) {
      const session = await getJson(`session:${lookup}`);
      if (!session) return;
      const seconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
      await setJson(`session:${lookup}`, { ...session, expiresAt }, 'EX', seconds);
      // The index has to be pushed out too, or "sign out everywhere" stops
      // finding sessions that are still perfectly valid.
      await command('EXPIRE', `sessions:${session.userId}`, seconds);
    },

    async deleteSession(lookup) {
      const session = await this.findSession(lookup);
      await command('DEL', `session:${lookup}`);
      if (session?.userId) await command('SREM', `sessions:${session.userId}`, lookup);
    },

    async deleteSessionsFor(userId) {
      const members = await command('SMEMBERS', `sessions:${userId}`);
      for (const lookup of Array.isArray(members) ? members : []) {
        await command('DEL', `session:${lookup}`);
      }
      await command('DEL', `sessions:${userId}`);
    },

    /*
     * Read, modify, write — with a known limit.
     *
     * Two failed sign-ins landing in the same millisecond can lose a count,
     * so the lockout is approximate at the margin. That is acceptable for what
     * it is: a brake on guessing, not an accounting record. Making it exact
     * would need a Lua script or a transaction, which buys nothing an attacker
     * can use — they still cannot get more than a handful of tries.
     */
    async createToken(token) {
      const seconds = Math.max(1, Math.ceil((token.expiresAt - Date.now()) / 1000));
      await setJson(`token:${token.lookup}`, token, 'EX', seconds);
      const index = `tokens:${token.userId}:${token.purpose}`;
      await command('SADD', index, token.lookup);
      await command('EXPIRE', index, seconds);
    },

    async findToken(lookup) {
      return getJson(`token:${lookup}`);
    },

    async deleteToken(lookup) {
      const token = await getJson(`token:${lookup}`);
      await command('DEL', `token:${lookup}`);
      if (token) await command('SREM', `tokens:${token.userId}:${token.purpose}`, lookup);
    },

    async deleteTokensFor(userId, purpose) {
      const index = `tokens:${userId}:${purpose}`;
      const members = await command('SMEMBERS', index);
      for (const lookup of Array.isArray(members) ? members : []) {
        await command('DEL', `token:${lookup}`);
      }
      await command('DEL', index);
    },

    async countAttempt(bucket, now, windowMs) {
      const key = `attempts:${bucket}`;
      const record = (await getJson(key)) ?? { failures: [], lockedUntil: 0 };
      const failures = [
        ...record.failures.filter((at) => now - at < windowMs),
        now,
      ];
      await setJson(key, { ...record, failures }, 'EX', ATTEMPT_TTL_SECONDS);
      return failures.length;
    },

    async clearAttempts(bucket) {
      await command('DEL', `attempts:${bucket}`);
    },

    async getLockout(bucket) {
      const record = await getJson(`attempts:${bucket}`);
      const until = record?.lockedUntil ?? 0;
      return until > 0 ? { until } : null;
    },

    async setLockout(bucket, until) {
      const key = `attempts:${bucket}`;
      const record = (await getJson(key)) ?? { failures: [], lockedUntil: 0 };
      await setJson(key, { ...record, lockedUntil: until }, 'EX', ATTEMPT_TTL_SECONDS);
    },

    /*
     * Events go in a list, trimmed on write.
     *
     * `LPUSH` + `LTRIM` is the one shape Redis makes cheap and bounded: the
     * newest is at the head, the tail falls off, and nothing has to scan. The
     * alternative — a key per event and a scan to read them — is the thing
     * that quietly stops working once there are a lot of them.
     */
    async recordEvent(event) {
      await command('LPUSH', 'events', JSON.stringify(event));
      await command('LTRIM', 'events', 0, MAX_EVENTS - 1);
    },

    async listEvents({ limit = 200, kinds = null, since = null, userId = null } = {}) {
      /*
       * Read more rows than asked for, then filter.
       *
       * The filters are applied here rather than in Redis because a list has
       * no index to apply them with. Reading a bounded multiple keeps a narrow
       * filter — "role changes only" — from coming back empty merely because
       * the newest `limit` rows happened to be sign-ins.
       */
      const raw = await command('LRANGE', 'events', 0, Math.min(MAX_EVENTS, limit * 10) - 1);
      const out = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        if (out.length >= limit) break;
        let event;
        try {
          event = typeof item === 'string' ? JSON.parse(item) : item;
        } catch {
          continue;
        }
        if (!event) continue;
        if (kinds !== null && !kinds.includes(event.kind)) continue;
        if (since !== null && Date.parse(event.at) < since) continue;
        if (userId !== null && event.userId !== userId) continue;
        out.push(event);
      }
      return out;
    },

    /*
     * Telemetry, in its own list.
     *
     * Separate from the audit trail because they answer different questions
     * and deserve different retention: one is who did what to which account,
     * the other is how the pipeline and the assistant are behaving.
     */
    async recordTelemetry(event) {
      await command('LPUSH', 'telemetry', JSON.stringify(event));
      await command('LTRIM', 'telemetry', 0, MAX_TELEMETRY - 1);
    },

    async listTelemetry({ limit = 500, kinds = null, since = null, projectId = null } = {}) {
      const raw = await command(
        'LRANGE',
        'telemetry',
        0,
        Math.min(MAX_TELEMETRY, limit * 10) - 1,
      );
      const out = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        if (out.length >= limit) break;
        let event;
        try {
          event = typeof item === 'string' ? JSON.parse(item) : item;
        } catch {
          continue;
        }
        if (!event) continue;
        if (kinds !== null && !kinds.includes(event.kind)) continue;
        if (since !== null && Date.parse(event.at) < since) continue;
        if (projectId !== null && event.projectId !== projectId) continue;
        out.push(event);
      }
      return out;
    },
  };
}

/**
 * Build the store from the environment, or return null if it is not configured.
 *
 * Both naming conventions are accepted because both are injected by real
 * providers, and an operator who has added Upstash directly should not have to
 * discover that this code only reads Vercel's names for the same two values.
 */
export function kvStoreFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return createKvStore({ url, token });
}
