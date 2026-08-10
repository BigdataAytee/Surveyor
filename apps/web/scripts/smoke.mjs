/**
 * Browser smoke test for the workspace.
 *
 * Drives the flows that span the whole system — the trust loop, the export
 * gate, editing survey data — and fails on console errors or horizontal
 * overflow at any breakpoint. Every check here exists because it caught a real
 * bug: label collisions at screen scale, an overflowing top bar, and a
 * boundary that silently closed over a deleted corner.
 *
 * Usage:
 *   npm run build --workspace @surveyor/web
 *   npx vite preview --port 4173 &
 *   npm run smoke --workspace @surveyor/web
 */

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/';
const SHOTS = process.env.SMOKE_SHOTS ?? null;

const problems = [];
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

const PHONE = { width: 393, height: 852 };
const TABLET = { width: 820, height: 1180 };
const LANDSCAPE = { width: 852, height: 393 };
const DESKTOP = { width: 1440, height: 900 };

async function open(name, viewport) {
  const page = await browser.newPage({ viewport, hasTouch: true });
  // Each check starts from the sample project, not whatever a previous one
  // persisted, or the tests would depend on the order they ran in. The
  // sentinel keeps this to the first load: the persistence check reloads the
  // page and needs what it saved to still be there.
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('smoke-initialised')) {
      window.localStorage.clear();
      window.sessionStorage.setItem('smoke-initialised', '1');
    }
  });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${name}: console error — ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${name}: page error — ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  return page;
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function expectNoOverflow(page, name) {
  const { scrollW, clientW } = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  if (scrollW > clientW + 1) {
    problems.push(`${name}: horizontal overflow (${scrollW} > ${clientW})`);
  }
}

function expect(condition, message) {
  if (!condition) problems.push(message);
}

// --- Layout holds at every breakpoint ---------------------------------------

for (const [name, viewport] of [
  ['phone', PHONE],
  ['tablet', TABLET],
  ['landscape', LANDSCAPE],
  ['desktop', DESKTOP],
]) {
  const page = await open(name, viewport);
  await expectNoOverflow(page, name);
  await shot(page, `layout-${name}`);
  await page.close();
}

// --- Labels do not collide at canvas scale ----------------------------------

{
  const page = await open('labels', PHONE);
  const boxes = await page.$$eval('.label__text', (nodes) =>
    nodes.map((n) => n.getBoundingClientRect()).map((r) => ({
      x: r.x, y: r.y, w: r.width, h: r.height,
    })),
  );
  expect(boxes.length > 0, 'labels: none rendered');

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      // A couple of pixels of slack: the engine sizes text by estimate, so
      // exact glyph metrics differ slightly from what it planned for.
      if (overlapX > 3 && overlapY > 3) {
        problems.push(`labels: two labels overlap on screen (${i}, ${j})`);
      }
    }
  }
  await page.close();
}

// --- Trust loop: propose, preview, accept -----------------------------------

{
  const page = await open('trust-loop', PHONE);
  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Building', exact: true }).click();
  await page.waitForTimeout(500);

  expect(
    await page.getByRole('button', { name: 'Accept' }).isVisible(),
    'trust loop: no Accept offered for a suggestion',
  );
  await shot(page, 'trust-suggestion');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  expect(
    (await page.locator('.preview__shape').count()) === 1,
    'trust loop: suggestion not previewed on the canvas',
  );
  await shot(page, 'trust-preview');

  // An unaccepted suggestion must be excluded from the plan, and said so.
  await page.getByRole('button', { name: 'Export' }).last().click();
  await page.waitForTimeout(1800);
  const exportText = (await page.textContent('body')) ?? '';
  expect(/unconfirmed/i.test(exportText), 'export: no warning about the pending suggestion');
  expect(/Your plan is ready/i.test(exportText), 'export: plan never became ready');
  await shot(page, 'export-ready');
  await page.close();
}

{
  const page = await open('accept', PHONE);
  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Building', exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  expect(
    (await page.locator('.preview__shape').count()) === 0,
    'trust loop: preview survived acceptance instead of becoming geometry',
  );
  const text = (await page.textContent('body')) ?? '';
  expect(/Garage/.test(text), 'trust loop: accepted building was not labelled');
  await shot(page, 'trust-accepted');
  await page.close();
}

// --- Editing survey data ----------------------------------------------------

{
  const page = await open('edit', PHONE);
  await page.getByRole('button', { name: 'Data' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Delete PT3' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(600);

  // Removing a corner must leave a boundary that still encloses something.
  const text = (await page.textContent('body')) ?? '';
  expect(!/0 m²/.test(text), 'edit: deleting a corner produced a zero-area boundary');
  expect(/m²/.test(text), 'edit: no area reported after deleting a corner');
  await shot(page, 'edit-after-delete');
  await page.close();
}

// --- Drawing and measuring --------------------------------------------------

{
  const page = await open('tools', PHONE);
  const before = await page.locator('.element--point').count();

  await page.getByRole('tab', { name: 'Draw' }).click();
  await page.waitForTimeout(300);

  const canvas = await page.locator('.canvas').boundingBox();
  await page.mouse.click(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.75);
  await page.waitForTimeout(400);

  expect(
    (await page.locator('.element--point').count()) === before + 1,
    'draw: tapping the canvas did not add a corner',
  );
  // A corner added to a valid boundary must leave a valid boundary: appending
  // it to the end of the ring order folds the shape over itself.
  expect(
    !(await page.locator('.banner').isVisible()),
    'draw: adding a corner broke the boundary',
  );
  await shot(page, 'tool-draw');

  await page.getByRole('tab', { name: 'Measure' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.4);
  await page.waitForTimeout(200);
  await page.mouse.click(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.4);
  await page.waitForTimeout(300);

  const readout = await page.locator('.measure__readout').textContent();
  expect(Boolean(readout), 'measure: no reading shown after two taps');
  expect(/\d+\.\d{2}/.test(readout ?? ''), `measure: reading looks wrong (${readout})`);
  await shot(page, 'tool-measure');
  await page.close();
}

// --- Properties -------------------------------------------------------------

{
  const page = await open('properties', PHONE);
  const canvas = await page.locator('.canvas').boundingBox();

  // Select the building by tapping its middle, then rename it.
  await page.mouse.click(canvas.x + canvas.width * 0.45, canvas.y + canvas.height * 0.5);
  await page.waitForTimeout(400);

  if (await page.locator('.contextbar').isVisible()) {
    await page.getByRole('button', { name: 'Properties' }).click();
    await page.waitForTimeout(500);
    expect(
      (await page.locator('.panel').count()) > 0,
      'properties: sheet did not open for a selection',
    );
    await shot(page, 'properties');
  } else {
    problems.push('properties: tapping an object did not select it');
  }
  await page.close();
}

// --- Import -----------------------------------------------------------------

{
  const page = await open('import', PHONE);
  await page.getByRole('button', { name: 'Data' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('tab', { name: 'Paste table' }).click();
  await page.waitForTimeout(300);

  // Headerless, so the extractor must ask about the coordinate order.
  await page.locator('.importer__input').fill(
    ['A,534800,182900', 'B,534840,182900', 'C,534840,182930', 'D,534800,182930'].join('\n'),
  );
  await page.waitForTimeout(400);

  const importText = (await page.textContent('body')) ?? '';
  expect(/4 points read/.test(importText), 'import: point count not reported');
  expect(
    /Does that look right/.test(importText),
    'import: headerless coordinate order was assumed without asking',
  );
  await shot(page, 'import');

  // The confirm button must be reachable, not hidden under a pinned footer.
  const confirm = page.getByRole('button', { name: /Confirm and use/ });
  expect(await confirm.isVisible(), 'import: confirm button is not visible');
  await confirm.click();
  await page.waitForTimeout(700);

  const afterText = (await page.textContent('body')) ?? '';
  expect(/m²/.test(afterText), 'import: no area after importing a closed boundary');
  await shot(page, 'import-applied');
  await page.close();
}

// --- Persistence ------------------------------------------------------------

{
  const page = await open('persistence', PHONE);
  await page.getByRole('tab', { name: 'Draw' }).click();
  await page.waitForTimeout(300);

  const canvas = await page.locator('.canvas').boundingBox();
  await page.mouse.click(canvas.x + canvas.width * 0.25, canvas.y + canvas.height * 0.8);
  await page.waitForTimeout(900); // beyond the save debounce

  const count = await page.locator('.element--point').count();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  expect(
    (await page.locator('.element--point').count()) === count,
    'persistence: work did not survive a reload',
  );
  await page.close();
}

await browser.close();

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('smoke: all checks passed');
