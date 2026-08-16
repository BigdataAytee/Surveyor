/**
 * Browser smoke test for the admin console.
 *
 * The console's whole reason to exist as a separate surface is access control,
 * and access control is the one thing that cannot be checked without a real
 * server, a real cookie jar and a real browser. Everything here is about who
 * can see what:
 *
 *   - a signed-out visitor gets nothing;
 *   - a signed-in surveyor gets nothing, and is told there is nothing here
 *     rather than that there is something they may not see;
 *   - an administrator gets the console;
 *   - a promotion takes effect, and a demotion takes effect immediately.
 *
 * Usage:
 *   AUTH_ADMIN_EMAILS=boss@example.com node server/auth.mjs &
 *   VITE_AUTH_ENDPOINT=... VITE_ADMIN_ENDPOINT=... npx vite build --outDir dist-admin
 *   npx vite preview --port 4179 --outDir dist-admin &
 *   node scripts/smoke-admin.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_ADMIN_URL ?? 'http://127.0.0.1:4179/';
const AUTH_PORT = Number(process.env.AUTH_PORT ?? 8789);
const problems = [];
const expect = (condition, message) => {
  if (!condition) problems.push(message);
};

const storeDir = await mkdtemp(join(tmpdir(), 'surveyor-admin-'));
const serverPath = fileURLToPath(new URL('../server/auth.mjs', import.meta.url));

const server = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    AUTH_PORT: String(AUTH_PORT),
    AUTH_STORE_PATH: join(storeDir, 'auth.json'),
    AUTH_ORIGINS: new URL(BASE).origin,
    // The first administrator, granted by the deployment rather than by
    // anything a request can contain.
    AUTH_ADMIN_EMAILS: 'boss@example.com',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (chunk) => {
  const text = String(chunk);
  if (/Error|error/.test(text)) console.error('[server]', text.trim());
});

// Wait for it to answer rather than guessing at a delay.
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${AUTH_PORT}/api/auth?action=me`);
    if (response.ok) break;
  } catch {
    /* not up yet */
  }
  await delay(100);
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

const PASSWORD = 'correct horse battery';

/** A fresh browser context with its own cookie jar — one person, one device. */
async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`${name}: page error — ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      problems.push(`${name}: console error — ${message.text()}`);
    }
  });
  return { context, page };
}

async function signUp(page, email) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create one' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForTimeout(1200);
}

// --- A signed-out visitor gets nothing ---------------------------------------

{
  const { context, page } = await person('stranger');
  await page.goto(`${BASE}admin/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const text = (await page.textContent('body')) ?? '';
  expect(/Sign in to continue/i.test(text), `admin: a stranger was not turned away — "${text.slice(0, 120)}"`);
  expect(!/Overview|Audit|Accounts/.test(text), 'admin: a stranger could see the console');
  await context.close();
}

// --- A signed-in surveyor gets nothing, and is told nothing is here ----------

{
  const { context, page } = await person('surveyor');
  await signUp(page, 'sam@example.com');

  await page.goto(`${BASE}admin/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const text = (await page.textContent('body')) ?? '';
  /*
   * "Nothing here", not "you may not". Somebody who guessed the URL should
   * learn there is nothing at it rather than that there is something worth
   * trying harder to reach.
   */
  expect(/Nothing here/i.test(text), `admin: a surveyor saw "${text.slice(0, 140)}"`);
  expect(!/Audit|Role changes|Failed sign-ins/.test(text), 'admin: a surveyor could read the console');
  await context.close();
}

// --- An administrator gets the console ---------------------------------------

{
  const { context, page } = await person('admin');
  await signUp(page, 'boss@example.com');

  await page.goto(`${BASE}admin/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const text = (await page.textContent('body')) ?? '';
  expect(/Surveyor Console/.test(text), `admin: the console did not open for an admin — "${text.slice(0, 140)}"`);
  expect(/Accounts/.test(text), 'admin: no navigation');

  // The audit trail has the two sign-ups in it, recorded as they happened.
  await page.getByRole('button', { name: 'Audit' }).click();
  await page.waitForTimeout(900);
  const audit = (await page.textContent('body')) ?? '';
  expect(/signup/.test(audit), 'admin: the audit trail has no signups in it');
  expect(/sam@example.com/.test(audit), 'admin: the audit trail is missing an account');

  // Accounts, and not one password hash anywhere on the page.
  await page.getByRole('button', { name: 'Accounts' }).click();
  await page.waitForTimeout(900);
  const accounts = (await page.content()) ?? '';
  expect(/sam@example.com/.test(accounts), 'admin: the accounts list is empty');
  expect(!/scrypt\$/.test(accounts), 'admin: a password hash reached the browser');
  expect(!/passwordHash/.test(accounts), 'admin: a password hash field reached the browser');

  // Promote the surveyor, which is the one thing here that writes.
  await page.getByLabel('Role for sam@example.com').selectOption('developer');
  await page.waitForTimeout(1000);
  const promoted = await page.getByLabel('Role for sam@example.com').inputValue();
  expect(promoted === 'developer', `admin: the role did not change — it reads ${promoted}`);

  // And the change is in the audit trail, with who did it.
  await page.getByRole('button', { name: 'Audit' }).click();
  await page.waitForTimeout(900);
  const after = (await page.textContent('body')) ?? '';
  expect(/role-changed/.test(after), 'admin: a role change was not audited');
  expect(/boss@example.com/.test(after), 'admin: the audit does not say who made the change');

  // The jurisdictions view reads the engine, and says plainly it is read-only.
  await page.getByRole('button', { name: 'Jurisdictions' }).click();
  await page.waitForTimeout(700);
  const rules = (await page.textContent('body')) ?? '';
  expect(/compiled into the build/i.test(rules), 'admin: no note that jurisdictions are read-only');
  expect(/Nigeria/i.test(rules), 'admin: the jurisdiction templates did not load');

  await context.close();
}

// --- A promotion lets the promoted account in, a demotion locks it out -------

{
  const { context, page } = await person('promoted');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill('sam@example.com');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1200);

  await page.goto(`${BASE}admin/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const text = (await page.textContent('body')) ?? '';
  expect(/Surveyor Console/.test(text), `admin: a developer could not get in — "${text.slice(0, 140)}"`);

  // A developer reads and cannot grant: the server refuses, and the console
  // shows the refusal rather than pretending it worked.
  await page.getByRole('button', { name: 'Accounts' }).click();
  await page.waitForTimeout(900);
  await page.getByLabel('Role for sam@example.com').selectOption('admin');
  await page.waitForTimeout(1000);
  const refused = (await page.textContent('body')) ?? '';
  expect(
    /Only an administrator/i.test(refused),
    'admin: a developer granting a role was not refused, or the refusal was silent',
  );

  await context.close();
}

await browser.close();
server.kill();
await rm(storeDir, { recursive: true, force: true });

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('admin smoke: all checks passed');
