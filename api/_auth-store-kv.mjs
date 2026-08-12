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
 *   session:<lookup>     the session, as JSON, expiring with the session
 *   sessions:<userId>    a set of that user's session lookups
 *   attempts:<address>   failed sign-ins and any lockout, expiring by itself
 *
 * `lookup` is the SHA-256 of the token, never the token. Someone who reads
 * every key in this store still cannot sign in as anybody.
 */

/** Long enough to cover a lockout many times over; short enough to expire. */
const ATTEMPT_TTL_SECONDS = 60 * 60;

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
    },

    async updatePassword(id, passwordHash, changedAt) {
      const user = await this.findById(id);
      if (!user) return;
      await setJson(`user:${id}`, { ...user, passwordHash, passwordChangedAt: changedAt });
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
    async recordFailure(email, now, windowMs) {
      const key = `attempts:${email}`;
      const record = (await getJson(key)) ?? { failures: [], lockedUntil: 0 };
      const failures = [
        ...record.failures.filter((at) => now - at < windowMs),
        now,
      ];
      await setJson(key, { ...record, failures }, 'EX', ATTEMPT_TTL_SECONDS);
      return failures.length;
    },

    async clearFailures(email) {
      await command('DEL', `attempts:${email}`);
    },

    async getLockout(email) {
      const record = await getJson(`attempts:${email}`);
      const until = record?.lockedUntil ?? 0;
      return until > 0 ? { until } : null;
    },

    async setLockout(email, until) {
      const key = `attempts:${email}`;
      const record = (await getJson(key)) ?? { failures: [], lockedUntil: 0 };
      await setJson(key, { ...record, lockedUntil: until }, 'EX', ATTEMPT_TTL_SECONDS);
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
