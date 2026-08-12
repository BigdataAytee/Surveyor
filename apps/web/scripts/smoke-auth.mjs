/**
 * Browser smoke test for signing in.
 *
 * Separate from the main smoke run because it needs a different build: the
 * shipped one has no accounts endpoint and must open straight into the
 * drawing, which is itself checked by `smoke.mjs`. This run covers the other
 * arrangement — a build that does have one — end to end against a real server
 * and a real cookie jar, because almost everything that goes wrong with
 * sessions goes wrong between the browser and the server rather than inside
 * either one.
 *
 * Usage:
 *   VITE_AUTH_ENDPOINT=http://127.0.0.1:8788/api/auth \
 *     npx vite build --outDir dist-auth
 *   npx vite preview --port 4174 --outDir dist-auth &
 *   npm run smoke:auth --workspace @surveyor/web
 *
 * The auth server is started by this script on a throwaway store, so each run
 * begins with nobody registered.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_AUTH_URL ?? 'http://127.0.0.1:4174/';
const AUTH_PORT = Number(process.env.AUTH_PORT ?? 8788);
const SHOTS = process.env.SMOKE_SHOTS ?? null;

const PHONE = { width: 393, height: 852 };
const problems = [];

function expect(condition, message) {
  if (!condition) problems.push(message);
}

// --- The server under test ---------------------------------------------------

const storeDir = await mkdtemp(join(tmpdir(), 'surveyor-auth-'));
const serverPath = fileURLToPath(new URL('../server/auth.mjs', import.meta.url));

const server = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    AUTH_PORT: String(AUTH_PORT),
    AUTH_STORE_PATH: join(storeDir, 'accounts.json'),
    // The preview origin has to be listed or every request is turned away as
    // cross-site — which is the point of the check, but not of this run.
    AUTH_ORIGINS: new URL(BASE).origin,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (chunk) => {
  problems.push(`auth server: ${String(chunk).trim()}`);
});

/*
 * A failed check throws out of a locator rather than returning, and a server
 * left holding port 8788 makes the next run fail for a reason that has nothing
 * to do with the code. So the child is killed on the way out however we leave.
 */
process.on('exit', () => server.kill());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.kill();
    process.exit(1);
  });
}

/** Wait for the port to answer rather than guessing at a sleep. */
async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${AUTH_PORT}/api/auth?action=me`);
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await delay(100);
  }
  return false;
}

if (!(await waitForServer())) {
  console.error(`auth smoke: the auth server never answered on ${AUTH_PORT}`);
  server.kill();
  await rm(storeDir, { recursive: true, force: true });
  process.exit(1);
}

// --- The browser -------------------------------------------------------------

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

/**
 * A browser context is one device. Each gets its own cookie jar, which is what
 * makes "signed in here, signed out there" testable at all.
 */
async function device(name) {
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true });
  const page = await context.newPage();
  page.on('console', (m) => {
    /*
     * The browser logs "Failed to load resource" for every response that is
     * not a 2xx, whether or not the page handled it. This suite provokes
     * refusals on purpose — a wrong password is a 401 — so that particular
     * line is noise here. Everything else is still a failure.
     */
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      problems.push(`${name}: console error — ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`${name}: page error — ${e.message}`));
  // Which puts the burden back here: anything other than the auth endpoint
  // failing to load is still a broken page.
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes('/api/auth')) {
      problems.push(`${name}: ${response.status()} loading ${response.url()}`);
    }
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  return { context, page };
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const EMAIL = 'field@practice.example';
const PASSWORD = 'correct horse battery';

async function fill(page, { email, password, name }) {
  if (name !== undefined) await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
}

const signedIn = (page) => page.locator('.topbar__title').isVisible().catch(() => false);

// --- A build with accounts asks before it opens ------------------------------

{
  const { context, page } = await device('gate');

  expect(
    await page.locator('.auth__card').isVisible(),
    'gate: a build with an accounts endpoint opened straight into the app',
  );
  expect(
    (await page.locator('.topbar__title').count()) === 0,
    'gate: the workspace rendered behind the sign-in screen',
  );

  const { scrollW, clientW } = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(scrollW <= clientW + 1, `gate: horizontal overflow on a phone (${scrollW} > ${clientW})`);
  await shot(page, 'auth-signin');

  await context.close();
}

// --- Creating an account -----------------------------------------------------

{
  const { context, page } = await device('register');
  await page.getByRole('button', { name: 'Create one' }).click();
  await page.waitForTimeout(200);

  // A password the server would refuse. The message has to come back and the
  // screen has to stay put — silently doing nothing reads as a broken button.
  await fill(page, { email: EMAIL, password: 'short', name: 'R. Surveyor' });
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForTimeout(600);
  expect(
    await page.locator('.auth__error').isVisible(),
    'register: a too-short password was not refused out loud',
  );
  expect(await page.locator('.auth__card').isVisible(), 'register: left the form on a refusal');
  await shot(page, 'auth-short-password');

  // And now one it accepts. Registering signs you in; making someone sign in
  // again immediately after choosing a password is a step with no purpose.
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForTimeout(1200);
  expect(await signedIn(page), 'register: creating an account did not open the app');
  await shot(page, 'auth-registered');

  // The session cookie must be out of reach of any script on the page.
  const visible = await page.evaluate(() => document.cookie);
  expect(
    !/surveyor_session/.test(visible),
    'register: the session cookie is readable by JavaScript',
  );

  // A reload is the ordinary case — closing a tab must not sign anyone out.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  expect(await signedIn(page), 'register: a reload signed the user out');

  // The account, and the way out of it, live in Profile.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.waitForTimeout(500);
  expect(
    new RegExp(EMAIL).test((await page.textContent('body')) ?? ''),
    'register: Profile does not say which account is signed in',
  );
  await shot(page, 'auth-profile');

  await page.getByRole('button', { name: 'Log out' }).first().click();
  await page.waitForTimeout(900);
  expect(
    await page.locator('.auth__card').isVisible(),
    'register: logging out did not return to the sign-in screen',
  );

  await context.close();
}

// --- A second device, signing in --------------------------------------------

{
  const { context, page } = await device('signin');

  // The wrong password, first. The answer must not reveal that the address is
  // one we know — the server is written that way and the screen must not undo
  // it by wording the two differently.
  await fill(page, { email: EMAIL, password: 'not the password' });
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  await page.waitForTimeout(900);
  const wrongPassword = (await page.locator('.auth__error').innerText()) ?? '';
  expect(wrongPassword.length > 0, 'signin: a wrong password was accepted or answered silently');

  await page.getByLabel('Email').fill('nobody@practice.example');
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  await page.waitForTimeout(900);
  const unknownAddress = (await page.locator('.auth__error').innerText()) ?? '';
  expect(
    unknownAddress === wrongPassword,
    `signin: an unknown address answers differently from a wrong password — "${unknownAddress}" vs "${wrongPassword}"`,
  );
  await shot(page, 'auth-refused');

  // And the real one.
  await fill(page, { email: EMAIL, password: PASSWORD });
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  await page.waitForTimeout(1200);
  expect(await signedIn(page), 'signin: the right password did not open the app');
  expect(
    (await page.locator('.element--point').count()) > 0,
    'signin: signed in, but the drawing did not load',
  );

  await context.close();
}

// --- The same address cannot be registered twice -----------------------------

{
  const { context, page } = await device('duplicate');
  await page.getByRole('button', { name: 'Create one' }).click();
  await page.waitForTimeout(200);
  await fill(page, { email: EMAIL, password: 'a different password', name: 'Someone Else' });
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForTimeout(1000);

  expect(
    (await page.locator('.auth__card').count()) > 0 && !(await signedIn(page)),
    'duplicate: registering an address that already exists took over the account',
  );
  await context.close();
}

// --- Working without an account ----------------------------------------------

{
  const { context, page } = await device('offline');
  await page.getByRole('button', { name: 'Work without an account' }).click();
  await page.waitForTimeout(900);
  expect(await signedIn(page), 'offline: the escape from the sign-in screen does not open the app');
  expect(
    (await page.locator('.element--point').count()) > 0,
    'offline: the drawing tools are not usable without an account',
  );
  await shot(page, 'auth-offline');

  // Not remembered. Skipping sign-in is a decision about right now, and a
  // reload is the next visit.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  expect(
    await page.locator('.auth__card').isVisible(),
    'offline: working without an account was remembered across a reload',
  );
  await context.close();
}

// --- The server being down is its own answer ---------------------------------

{
  const { context, page } = await device('unreachable');
  await context.route('**/api/auth**', (route) => route.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const text = (await page.textContent('body')) ?? '';
  expect(
    /not answering|Could not reach/i.test(text),
    `unreachable: a dead server is not explained — got "${text.slice(0, 120)}"`,
  );
  expect(
    await page.getByRole('button', { name: 'Work without an account' }).isVisible(),
    'unreachable: no way past a server that is down',
  );
  await shot(page, 'auth-unreachable');
  await context.close();
}

await browser.close();
server.kill();
await rm(storeDir, { recursive: true, force: true });

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('auth smoke: all checks passed');
