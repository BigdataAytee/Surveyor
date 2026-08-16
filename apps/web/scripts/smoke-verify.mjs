/**
 * Browser smoke test for the two flows that go through somebody's inbox.
 *
 * Email verification and password reset are the parts of authentication most
 * likely to be "implemented" and not actually work, because every step of them
 * crosses a boundary: the server mints a token, a mail provider carries it, a
 * browser arrives on a link, and a second request spends it. A unit test can
 * check each hop. Only this can check that they join up.
 *
 * The mail provider is a real HTTP server started here, which captures what
 * the app asks it to send. That is deliberately how the link is obtained —
 * the token never comes back over the API, by design, so the only honest way
 * to get one is to read the mail.
 *
 * Usage:
 *   node scripts/smoke-verify.mjs
 *
 * It builds, serves, and starts both servers itself.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_VERIFY_URL ?? 'http://127.0.0.1:4180/';
const AUTH_PORT = Number(process.env.AUTH_PORT ?? 8790);
const MAIL_PORT = Number(process.env.MAIL_PORT ?? 8791);

const problems = [];
const expect = (condition, message) => {
  if (!condition) problems.push(message);
};

// --- The mail provider -------------------------------------------------------

/** Everything the app has asked to be sent, newest last. */
const outbox = [];

const mail = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      outbox.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      problems.push('mail: a message body was not JSON');
    }
    response.writeHead(202, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
});
await new Promise((resolve) => mail.listen(MAIL_PORT, '127.0.0.1', resolve));

/** Wait for a message of a kind to arrive, and give back the link in it. */
async function linkFor(kind, to) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = [...outbox].reverse().find((item) => item.kind === kind && item.to === to);
    if (message) {
      const found = /https?:\/\/\S+/.exec(message.text);
      if (found) return found[0];
      return null;
    }
    await delay(100);
  }
  return null;
}

// --- The auth server ---------------------------------------------------------

const storeDir = await mkdtemp(join(tmpdir(), 'surveyor-verify-'));
const serverPath = fileURLToPath(new URL('../server/auth.mjs', import.meta.url));

const server = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    AUTH_PORT: String(AUTH_PORT),
    AUTH_STORE_PATH: join(storeDir, 'accounts.json'),
    AUTH_ORIGINS: new URL(BASE).origin,
    AUTH_MAIL_WEBHOOK: `http://127.0.0.1:${MAIL_PORT}/send`,
    APP_URL: BASE,
    // Explicit rather than inferred, because this run is about what happens
    // when it is on.
    AUTH_REQUIRE_VERIFICATION: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (chunk) => {
  const text = String(chunk).trim();
  if (/Error/.test(text)) problems.push(`auth server: ${text}`);
});

process.on('exit', () => {
  server.kill();
  mail.close();
});

for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${AUTH_PORT}/api/auth?action=me`)).ok) break;
  } catch {
    /* not up yet */
  }
  await delay(100);
}

// --- The browser -------------------------------------------------------------

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

async function device(name) {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`${name}: page error — ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      problems.push(`${name}: console error — ${message.text()}`);
    }
  });
  return { context, page };
}

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a different long one';

const signedIn = (page) => page.locator('.topbar__title').isVisible().catch(() => false);

// --- Registering does not sign you in ----------------------------------------

{
  const { context, page } = await device('register');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create one' }).click();
  await page.waitForTimeout(200);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForTimeout(1200);

  const text = (await page.textContent('body')) ?? '';
  /*
   * The state the architecture warns about is being signed in *and* waiting
   * to confirm — where the emailed link arrives at an account that is already
   * logged in and the two steps fight. So: not in the app, and told why.
   */
  expect(/Check your email/i.test(text), `verify: no "check your email" state — "${text.slice(0, 140)}"`);
  expect(!(await signedIn(page)), 'verify: registering signed the person in before confirming');

  const link = await linkFor('verify', EMAIL);
  expect(Boolean(link), 'verify: no confirmation email was sent');
  expect(link?.includes('verify='), `verify: the email link is not a verification link — ${link}`);

  await context.close();
}

// --- Signing in before confirming is refused, and says what to do ------------

{
  const { context, page } = await device('unconfirmed');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1200);

  const text = (await page.textContent('body')) ?? '';
  expect(/verify your email/i.test(text), `unconfirmed: no actionable message — "${text.slice(0, 140)}"`);
  expect(
    await page.getByRole('button', { name: /send the confirmation link again/i }).isVisible(),
    'unconfirmed: no way to have the link sent again',
  );
  expect(!(await signedIn(page)), 'unconfirmed: an unconfirmed account got into the app');

  // A wrong password says something different and offers nothing, because
  // there is nothing to offer — and a code would tell a guesser it got the
  // address right.
  await page.getByLabel('Password', { exact: true }).fill('nope nope nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1000);
  const wrong = (await page.textContent('body')) ?? '';
  expect(/email or password is wrong/i.test(wrong), `unconfirmed: wrong password said "${wrong.slice(0, 120)}"`);
  expect(
    !(await page.getByRole('button', { name: /send the confirmation link again/i }).isVisible()),
    'unconfirmed: a wrong password offered a confirmation resend, which reveals the account exists',
  );

  await context.close();
}

// --- Following the link confirms the address, and then sign-in works ---------

{
  const link = await linkFor('verify', EMAIL);
  const { context, page } = await device('confirm');
  await page.goto(link, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const text = (await page.textContent('body')) ?? '';
  expect(/confirmed/i.test(text), `confirm: the link did not confirm — "${text.slice(0, 140)}"`);

  /*
   * And the token is out of the address bar.
   *
   * A one-time token left in `location.href` goes into history, into any
   * screenshot, and into the Referer of the next request the page makes.
   */
  expect(
    !page.url().includes('verify='),
    `confirm: the token is still in the URL — ${page.url()}`,
  );

  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(400);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1500);
  expect(await signedIn(page), 'confirm: a confirmed account still could not sign in');

  await context.close();
}

// --- Forgotten password, end to end ------------------------------------------

{
  const { context, page } = await device('reset');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByRole('button', { name: /forgotten my password/i }).click();
  await page.waitForTimeout(1000);

  const said = (await page.textContent('body')) ?? '';
  // Conditional wording, because it is the only phrasing that is true whether
  // or not the address has an account — which is the whole defence here.
  expect(/if an account exists/i.test(said), `reset: unconditional wording — "${said.slice(0, 140)}"`);

  const link = await linkFor('reset', EMAIL);
  expect(Boolean(link), 'reset: no reset email was sent');
  expect(link?.includes('reset='), `reset: the link is not a reset link — ${link}`);

  await page.goto(link, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  expect(
    await page.getByLabel('New password').isVisible(),
    'reset: the link did not open the new-password screen',
  );
  expect(!page.url().includes('reset='), `reset: the token is still in the URL — ${page.url()}`);

  // A password the server will not take does not cost the link.
  await page.getByLabel('New password').fill('short');
  await page.getByRole('button', { name: /set my new password/i }).click();
  await page.waitForTimeout(1000);
  expect(
    await page.getByLabel('New password').isVisible(),
    'reset: a rejected password left no way to try again',
  );

  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: /set my new password/i }).click();
  await page.waitForTimeout(1200);
  const done = (await page.textContent('body')) ?? '';
  expect(/has been changed/i.test(done), `reset: no confirmation — "${done.slice(0, 140)}"`);

  await context.close();
}

// --- The old password is gone, the new one works -----------------------------

{
  const { context, page } = await device('after-reset');
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1300);
  expect(!(await signedIn(page)), 'after-reset: the old password still works');

  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1500);
  expect(await signedIn(page), 'after-reset: the new password does not work');

  await context.close();
}

// --- Nothing that was emailed ever came back over HTTP -----------------------

{
  /*
   * The property everything above rests on, checked directly rather than
   * inferred. If a token comes back to whoever asked, then anybody can
   * confirm any address and reset any password, and both flows are ceremony.
   */
  const tokens = outbox
    .map((message) => /[?&](?:verify|reset)=([\w-]+)/.exec(message.text)?.[1])
    .filter(Boolean);
  expect(tokens.length >= 2, 'leak-check: no tokens were sent at all, so nothing was checked');

  const responses = [];
  for (const [action, body] of [
    ['register', { email: 'new@example.com', password: PASSWORD }],
    ['request-reset', { email: EMAIL }],
    ['resend-verification', { email: 'new@example.com' }],
    ['login', { email: 'new@example.com', password: PASSWORD }],
  ]) {
    const response = await fetch(`http://127.0.0.1:${AUTH_PORT}/api/auth?action=${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(BASE).origin },
      body: JSON.stringify(body),
    });
    responses.push(await response.text());
  }

  const everything = responses.join('\n');
  for (const token of tokens) {
    expect(!everything.includes(token), 'leak-check: a token that was emailed also came back over HTTP');
  }
  // And the fresh ones minted by those calls did not come back either.
  const fresh = outbox
    .map((message) => /[?&](?:verify|reset)=([\w-]+)/.exec(message.text)?.[1])
    .filter(Boolean);
  for (const token of fresh) {
    expect(!everything.includes(token), 'leak-check: a newly minted token came back over HTTP');
  }
}

await browser.close();
server.kill();
mail.close();
await rm(storeDir, { recursive: true, force: true });

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('verification smoke: all checks passed');
