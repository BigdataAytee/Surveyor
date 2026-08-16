/**
 * Browser smoke test for working offline.
 *
 * This one has to be a browser test. Every claim in it is about something no
 * unit test can reach: whether a service worker installed, whether the app
 * opens with the network genuinely cut, whether a photograph taken with no
 * signal survives a reload, and whether it is read once signal returns. The
 * unit tests cover the decisions; this covers whether the browser does what
 * those decisions assume.
 *
 * Usage — note the endpoint, which is not optional. Half of this run is about
 * a photograph waiting for signal, and a build with no extract endpoint has
 * nothing to wait for: it refuses the photo up front and the queue checks all
 * fail together, which reads like a broken queue rather than a wrong build.
 *
 *   VITE_EXTRACT_ENDPOINT=/__extract npx vite build --outDir dist-offline
 *   npx vite preview --port 4173 --outDir dist-offline &
 *   npm run smoke:offline --workspace @surveyor/web
 */

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/';
const SHOTS = process.env.SMOKE_SHOTS ?? null;
const PHONE = { width: 393, height: 852 };

const problems = [];
function expect(condition, message) {
  if (!condition) problems.push(message);
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

async function device(name) {
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: page error — ${e.message}`));
  page.on('console', (m) => {
    // A failed resource is the *point* of some of these checks.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      problems.push(`${name}: console error — ${m.text()}`);
    }
  });
  return { context, page };
}

/**
 * A reload that reports instead of hanging.
 *
 * With no working offline shell an offline navigation never completes, so
 * every reload in this suite is bounded — otherwise the exact defect these
 * checks exist to catch is the one that stops them running.
 */
async function reload(page) {
  return page
    .reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Wait for the worker to be installed and in control, not merely registered. */
async function serviceWorkerReady(page) {
  return page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const registration = await navigator.serviceWorker.ready;
    return registration.active ? 'active' : 'inactive';
  });
}

// --- The app opens with the network cut -------------------------------------

{
  const { context, page } = await device('shell');
  await page.goto(BASE, { waitUntil: 'networkidle' });

  const state = await serviceWorkerReady(page);
  expect(state === 'active', `shell: no service worker took control (${state})`);

  // Give the precache time to finish before pulling the plug on it.
  await page.waitForTimeout(1500);

  /*
   * Genuinely offline, at the browser level: `context.setOffline` makes every
   * request fail the way a dead radio does, and flips `navigator.onLine`.
   * Routing requests to abort would test something weaker.
   */
  await context.setOffline(true);
  /*
   * Bounded, and a failure here is the finding rather than a crash. With no
   * working offline shell this navigation never completes at all — the page
   * sits on a dead socket — so an unbounded reload turns the defect this check
   * exists to catch into a test that hangs instead of one that reports.
   */
  const opened = await reload(page);
  await page.waitForTimeout(1500);

  expect(
    opened && (await page.locator('.topbar__title').isVisible()),
    'shell: the app did not open with no network — the offline shell is not working',
  );
  expect(
    (await page.locator('.element--point').count()) > 0,
    'shell: the app opened offline but the drawing did not render',
  );
  await shot(page, 'offline-shell');

  // And it says so, rather than leaving someone to wonder.
  expect(
    /Offline/.test((await page.locator('.sync').innerText().catch(() => '')) ?? ''),
    'shell: nothing on screen says the connection is gone',
  );

  await context.setOffline(false);
  await context.close();

  /*
   * Everything below assumes the app can open offline. If it cannot, the rest
   * of this suite is a long series of interactions with a page that never
   * loaded, each waiting out its own timeout — which reads as a hang rather
   * than as the single failure that matters. So it stops here and says so.
   */
  if (problems.length > 0) {
    await browser.close();
    console.error(`${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
}

// --- The assistant answers offline, without waiting ---------------------------

{
  const { context, page } = await device('assistant');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await context.setOffline(true);

  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.waitForTimeout(400);

  const input = page
    .getByLabel('Ask the assistant, or paste survey data')
    .locator('visible=true')
    .first();
  const send = page.getByRole('button', { name: 'Send' }).locator('visible=true').first();

  const started = Date.now();
  await input.fill('how big is this parcel?');
  await send.click();
  await page.waitForSelector('.ai__message--assistant >> nth=-1', { timeout: 10_000 });
  await page.waitForTimeout(600);
  const took = Date.now() - started;

  const answer = await page.locator('.ai__message--assistant').locator('visible=true').last().innerText();
  expect(/m²|square|boundary|points/i.test(answer), `assistant: no useful offline answer — "${answer.slice(0, 90)}"`);
  expect(took < 8000, `assistant: took ${took}ms offline — it waited on the network`);
  await shot(page, 'offline-assistant');

  await context.setOffline(false);
  await context.close();
}

// --- A photograph taken with no signal is kept, then read ---------------------

{
  const { context, page } = await device('queue');

  /*
   * The extraction service is stubbed rather than real: what is being tested
   * is the queue, not a model. It answers only when the page believes it is
   * online, which is what makes the "read it later" half meaningful.
   */
  let transcribeCalls = 0;
  await context.route('**/__extract', async (route) => {
    transcribeCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        text: 'P1 100.000 200.000\nP2 140.000 200.000\nP3 140.000 240.000\nP4 100.000 240.000',
      }),
    });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await context.setOffline(true);

  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.waitForTimeout(400);

  // A one-pixel JPEG is enough: the queue does not care what is in the image.
  await page.setInputFiles(
    'input[type=file][accept*="image"] >> visible=false >> nth=0',
    {
      name: 'levels.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
          'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
          'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
        'base64',
      ),
    },
  );
  await page.waitForTimeout(1500);

  /*
   * Every message rather than the last one. The sheet is mounted more than
   * once for different breakpoints, so "the last message on the page" is the
   * other copy's opening line, not the reply to what just happened.
   */
  const said = (await page.locator('.ai__message--assistant').allInnerTexts()).join('\n');
  expect(/kept the photo/i.test(said), `queue: an offline photo was refused — "${said.slice(-140)}"`);
  expect(transcribeCalls === 0, 'queue: the service was called with no network');
  expect(
    /waiting/i.test((await page.locator('.sync').innerText().catch(() => '')) ?? ''),
    'queue: nothing says work is waiting to be sent',
  );
  await shot(page, 'offline-queued');

  // The whole point: it survives the tab being closed.
  const reopened = await reload(page);
  await page.waitForTimeout(1500);
  expect(
    reopened && /waiting/i.test((await page.locator('.sync').innerText().catch(() => '')) ?? ''),
    'queue: the photograph did not survive a reload',
  );

  // Signal comes back.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(2500);

  expect(transcribeCalls === 1, `queue: the service was called ${transcribeCalls} times, expected 1`);

  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.waitForTimeout(1200);

  const body = (await page.textContent('body')) ?? '';
  expect(
    /read the photo you took offline/i.test(body),
    'queue: the transcription was never delivered',
  );
  expect(
    (await page.locator('.extraction').count()) > 0,
    'queue: the transcription arrived but not as something to confirm',
  );
  await shot(page, 'offline-delivered');

  await context.close();
}

await browser.close();

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('offline smoke: all checks passed');
