/**
 * Tests for the Redis-backed account store.
 *
 * A store adapter is not a detail. It is the thing standing between someone's
 * account and the deployment losing it, and the failure mode of getting one
 * subtly wrong — two people registered to one address, a session that outlives
 * "sign out everywhere" — is silent until it matters.
 *
 * So these run the *real* auth core against this adapter, exercising the same
 * behaviours the file store is held to. Redis itself is faked, because what is
 * being checked is whether this adapter asks for the right things, not whether
 * Redis can store a string.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changePassword,
  hashToken,
  login,
  logout,
  register,
  sessionUser,
} from './_auth-core.mjs';
import { createKvStore, kvStoreFromEnv } from './_auth-store-kv.mjs';

/**
 * Just enough Redis, over the same HTTP shape Upstash speaks.
 *
 * Expiry is not enforced: the core checks a session's `expiresAt` itself, and
 * a fake that also expired keys would be testing the fake. What is enforced is
 * `NX`, because that is the uniqueness constraint the whole registration path
 * leans on.
 */
function fakeRedis() {
  const keys = new Map();
  const sets = new Map();
  const seen = [];

  async function transport(_url, init) {
    const [name, ...args] = JSON.parse(init.body);
    seen.push([name, ...args]);

    const result = (() => {
      switch (name) {
        case 'SET': {
          const [key, value, ...rest] = args;
          if (rest.includes('NX') && keys.has(key)) return null;
          keys.set(key, value);
          return 'OK';
        }
        case 'GET':
          return keys.get(args[0]) ?? null;
        case 'DEL':
          keys.delete(args[0]);
          sets.delete(args[0]);
          return 1;
        case 'SADD': {
          const [key, member] = args;
          if (!sets.has(key)) sets.set(key, new Set());
          sets.get(key).add(member);
          return 1;
        }
        case 'SREM':
          sets.get(args[0])?.delete(args[1]);
          return 1;
        case 'SMEMBERS':
          return [...(sets.get(args[0]) ?? [])];
        case 'EXPIRE':
          return 1;
        default:
          return null;
      }
    })();

    return { ok: true, status: 200, json: async () => ({ result }) };
  }

  return { transport, keys, sets, seen };
}

const build = () => {
  const redis = fakeRedis();
  return {
    redis,
    store: createKvStore({ url: 'https://redis.example', token: 'x', transport: redis.transport }),
  };
};

const PASSWORD = 'correct horse battery';

test('a registered account can sign in and be identified by its session', async () => {
  const { store } = build();

  const created = await register(store, {
    email: 'Field@Practice.Example',
    password: PASSWORD,
    name: 'R. Surveyor',
  });
  assert.equal(created.ok, true, created.error);

  const signedIn = await login(store, { email: 'field@practice.example', password: PASSWORD });
  assert.equal(signedIn.ok, true, signedIn.error);

  const who = await sessionUser(store, signedIn.token);
  assert.equal(who?.email, 'field@practice.example');
});

test('the password never reaches the store in a readable form', async () => {
  const { redis, store } = build();
  await register(store, { email: 'field@practice.example', password: PASSWORD, name: null });

  const everything = [...redis.keys.values()].join('\n') + JSON.stringify(redis.seen);
  assert.ok(!everything.includes(PASSWORD), 'the password is recoverable from the store');
});

test('the session token is never stored, only its hash', async () => {
  const { redis, store } = build();
  await register(store, { email: 'field@practice.example', password: PASSWORD, name: null });
  const signedIn = await login(store, { email: 'field@practice.example', password: PASSWORD });

  const everything = [...redis.keys.values()].join('\n') + JSON.stringify(redis.seen);
  assert.ok(!everything.includes(signedIn.token), 'the raw session token is in the store');
  assert.ok(
    everything.includes(hashToken(signedIn.token)),
    'the session was not stored under its hash',
  );
});

test('a second registration for one address is refused', async () => {
  const { store } = build();
  const first = await register(store, {
    email: 'field@practice.example',
    password: PASSWORD,
    name: null,
  });
  assert.equal(first.ok, true);

  const second = await register(store, {
    email: 'field@practice.example',
    password: 'a completely different one',
    name: null,
  });
  assert.equal(second.ok, false, 'the address was registered twice');

  // And the first account still works — a refused duplicate must not have
  // overwritten it.
  const signedIn = await login(store, { email: 'field@practice.example', password: PASSWORD });
  assert.equal(signedIn.ok, true, 'the original account stopped working');
});

test('the address claim is atomic, not a check followed by a write', async () => {
  const { redis, store } = build();
  await register(store, { email: 'field@practice.example', password: PASSWORD, name: null });

  const claim = redis.seen.find(
    ([name, key]) => name === 'SET' && key === 'email:field@practice.example',
  );
  assert.ok(claim, 'the address was never claimed');
  assert.ok(
    claim.includes('NX'),
    'the address was claimed without NX — two registrations racing would both win',
  );
});

test('logging out ends that session and no other', async () => {
  const { store } = build();
  await register(store, { email: 'field@practice.example', password: PASSWORD, name: null });

  const phone = await login(store, { email: 'field@practice.example', password: PASSWORD });
  const laptop = await login(store, { email: 'field@practice.example', password: PASSWORD });

  await logout(store, phone.token);

  assert.equal(await sessionUser(store, phone.token), null, 'the ended session still works');
  assert.ok(await sessionUser(store, laptop.token), 'logging out on one device ended the other');
});

test('changing a password ends every session', async () => {
  const { store } = build();
  await register(store, { email: 'field@practice.example', password: PASSWORD, name: null });

  const phone = await login(store, { email: 'field@practice.example', password: PASSWORD });
  const laptop = await login(store, { email: 'field@practice.example', password: PASSWORD });

  const who = await sessionUser(store, phone.token);
  const changed = await changePassword(store, who.id, {
    current: PASSWORD,
    next: 'an entirely new passphrase',
  });
  assert.equal(changed.ok, true, changed.error);

  assert.equal(await sessionUser(store, phone.token), null, 'the session that changed it survived');
  assert.equal(await sessionUser(store, laptop.token), null, 'another device stayed signed in');

  const again = await login(store, {
    email: 'field@practice.example',
    password: 'an entirely new passphrase',
  });
  assert.equal(again.ok, true, 'the new password does not work');
});

test('guessing is locked out after enough failures', async () => {
  const { store } = build();
  await register(store, { email: 'field@practice.example', password: PASSWORD, name: null });

  // The core's own threshold is private to it, so this simply guesses more
  // times than any policy would allow rather than importing a number.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await login(store, { email: 'field@practice.example', password: `guess ${attempt}` });
  }

  const correct = await login(store, { email: 'field@practice.example', password: PASSWORD });
  assert.equal(correct.ok, false, 'the correct password opened a locked account');
});

test('a store with no credentials configured is absent, not broken', () => {
  assert.equal(kvStoreFromEnv({}), null);
  assert.ok(
    kvStoreFromEnv({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }),
    'Vercel KV credentials were not recognised',
  );
  assert.ok(
    kvStoreFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }),
    'Upstash credentials were not recognised',
  );
});

test('a store that answers with an error does not look like a missing account', async () => {
  const store = createKvStore({
    url: 'https://redis.example',
    token: 'x',
    transport: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });

  await assert.rejects(
    () => store.findByEmail('field@practice.example'),
    /account store answered 500/i,
    'a broken store was reported as "no such account"',
  );
});
