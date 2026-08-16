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

/*
 * The classifier block needs a build with `VITE_ASSISTANT_ENDPOINT` set, which
 * every other block would then also route through. So the two runs are
 * exclusive: the default pass covers the shipped build, and `--classifier`
 * covers the model path against a stub.
 */
const CLASSIFIER_ONLY = process.argv.includes('--classifier');

const problems = [];
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

const PHONE = { width: 393, height: 852 };
const TABLET = { width: 820, height: 1180 };
const LANDSCAPE = { width: 852, height: 393 };
const DESKTOP = { width: 1440, height: 900 };

async function open(name, viewport, before) {
  const page = await browser.newPage({ viewport, hasTouch: true });
  // A hook for anything that has to be in place before the first load —
  // stubbing a third-party request, most usefully.
  if (before) await before(page);
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

if (!CLASSIFIER_ONLY) {
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
    ['A,544800,718900', 'B,544840,718900', 'C,544840,718930', 'D,544800,718930'].join('\n'),
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

// --- Messy paste: a table wrapped in everything else a page has on it -------

{
  // Every one of these decorations used to be fatal on its own, because every
  // non-empty line was assumed to be a row of the table.
  const MESSY = [
    'BOUNDARY SURVEY — PLOT 15 ADEOLA CLOSE',
    'Surveyed 11/08/2026',
    '',
    'Pt No   Easting     Northing    Description',
    '-----   -------     --------    -----------',
    'P1      544800.00   718900.00   Corner, iron pin',
    'P2      544845.00   718900.00   Corner',
    'P3      544845.00   718935.00   Corner',
    'P4      544800.00   718935.00   Corner',
    'Total: 4 points',
  ].join('\n');

  const page = await open('messy-paste', PHONE);
  await page.getByRole('button', { name: 'Data' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('tab', { name: 'Paste table' }).click();
  await page.waitForTimeout(300);

  await page.locator('.importer__input').fill(MESSY);
  await page.waitForTimeout(400);

  const text = (await page.textContent('body')) ?? '';
  expect(/4 points read/.test(text), 'messy paste: the table inside the page was not found');
  expect(
    /skipped .* lines/.test(text),
    'messy paste: the lines outside the table were not accounted for',
  );
  expect(
    !/Does that look right/.test(text),
    'messy paste: headings were present, so the column order should not be in doubt',
  );
  await shot(page, 'messy-paste');
  await page.close();
}

// --- Pasting survey data into the assistant ---------------------------------

{
  const page = await open('chat-paste', PHONE);
  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.waitForTimeout(400);

  const input = page.getByLabel('Ask the assistant, or paste survey data').locator('visible=true').first();
  await input.click();

  // A real clipboard event: a single-line input strips the newlines out of a
  // pasted table, and the rows are most of what the extractor reads.
  const handle = await input.elementHandle();
  await page.evaluate(
    ([element, text]) => {
      const transfer = new DataTransfer();
      transfer.setData('text', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    [handle, ['P1,544800,718900', 'P2,544845,718900', 'P3,544845,718935', 'P4,544800,718935'].join('\n')],
  );
  await page.waitForTimeout(500);

  const card = page.locator('.extraction').locator('visible=true').first();
  expect(await card.isVisible(), 'chat paste: pasted data was not read');
  expect(
    /4 points read/.test((await card.innerText()) ?? ''),
    'chat paste: the points were not reported back',
  );
  await shot(page, 'chat-paste');

  const use = page.getByRole('button', { name: /Use these points/ }).locator('visible=true').first();
  expect(await use.isVisible(), 'chat paste: no way to accept the points');
  await use.click();
  await page.waitForTimeout(800);

  // Accepting must produce a drawn plan, not just a message saying so.
  expect(
    (await page.locator('.element--point').count()) >= 4,
    'chat paste: accepting did not put the points on the drawing',
  );
  expect(
    /m²/.test((await page.textContent('body')) ?? ''),
    'chat paste: no area after accepting a closed boundary',
  );
  await shot(page, 'chat-paste-applied');
  await page.close();
}

// --- Starting a new project -------------------------------------------------

{
  // This used to be at the foot of the Layers panel, under a toggle for the
  // grid, where nobody found it.
  const page = await open('new-project', PHONE);

  const projectButton = page.getByRole('button', { name: 'Project settings and new project' });
  expect(await projectButton.isVisible(), 'new project: no way into the project from the title bar');
  await projectButton.click();
  await page.waitForTimeout(400);

  expect(
    await page.getByLabel('Site name or address').locator('visible=true').first().isVisible(),
    'new project: the site cannot be named',
  );
  await shot(page, 'project');

  // Two taps, because it replaces the survey.
  await page.getByRole('button', { name: 'Start a new project' }).locator('visible=true').first().click();
  await page.waitForTimeout(300);
  const confirm = page.getByRole('button', { name: 'Yes, start a new project' }).locator('visible=true').first();
  expect(await confirm.isVisible(), 'new project: destructive action was not confirmed');
  await confirm.click();
  await page.waitForTimeout(700);

  expect(
    (await page.locator('.element--point').count()) === 0,
    'new project: the old survey is still on the drawing',
  );
  await shot(page, 'project-empty');
  await page.close();
}

// --- The map uses a converted copy, and the survey is untouched -------------

{
  /*
   * The whole workflow, end to end in the app: the survey stays in Minna, the
   * map gets a WGS 84 copy, and opening the map changes nothing. The last part
   * is the one worth driving in a browser — a conversion that quietly wrote
   * back would be invisible in the engine tests and obvious here, because the
   * plan's own coordinates would move.
   */
  /** Every tile URL either layer asked for, so the switch can be checked. */
  const tileRequests = [];

  const page = await open('map', PHONE, async (target) => {
    /*
     * A one-pixel PNG for every tile. This suite must not depend on a tile
     * provider being reachable, and what is being checked is the grid — which
     * tiles were asked for and where they were put — not the imagery.
     */
    // On the context, not the page: the service worker fetches these, and a
    // page-level route does not see a request the worker made.
    const PIXEL = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    for (const host of ['**/tile.openstreetmap.org/**', '**/server.arcgisonline.com/**']) {
      await target.context().route(host, (route) => {
        tileRequests.push(route.request().url());
        return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      });
    }
  });

  /*
   * The stored *survey*, not the stored bytes.
   *
   * Comparing the whole serialised project was wrong twice over. The library
   * stamps `updatedAt` and records the computed area on the ordinary autosave,
   * neither of which has anything to do with the map; and local storage does
   * not enumerate its keys in a stable order once they have been rewritten, so
   * the join itself moved. What must not change is the survey — the
   * coordinates, the boundary, the features and the system they are on — so
   * that is what this reads, from keys in a fixed order.
   */
  const readSurvey = () =>
    page.evaluate(() =>
      Object.keys(window.localStorage)
        .filter((key) => key.startsWith('surveyor.project.'))
        // Sorted. `Object.keys` on local storage is not order-stable across
        // rewrites, and an unsorted join reported the same survey as changed
        // roughly one run in six — a flake that reads exactly like the defect
        // this check exists to catch.
        .sort()
        .map((key) => {
          try {
            const stored = JSON.parse(window.localStorage.getItem(key) ?? '{}');
            return JSON.stringify({
              crs: stored.model?.crs,
              points: stored.model?.points,
              boundary: stored.model?.boundary,
              features: stored.model?.siteFeatures,
            });
          } catch {
            return 'unreadable';
          }
        })
        .join(''),
    );

  const gridBefore = await readSurvey();
  expect(/544800/.test(gridBefore), 'map: the sample is not stored in Minna grid coordinates');

  /*
   * Opened from the drawing itself, not through the menu. That button is the
   * point of this check: the map was three taps away behind a drawer, which
   * for something a surveyor reaches for repeatedly is three too many.
   */
  const mapButton = page.getByRole('button', {
    name: 'Show on a map, and switch between streets and satellite',
  });
  expect(await mapButton.isVisible(), 'map: no map button on the drawing interface');
  await mapButton.click();
  await page.waitForTimeout(1200);

  const shown = (await page.textContent('body')) ?? '';
  expect(/Minna to WGS 84/.test(shown), 'map: the transformation is not named on screen');
  expect(/±3 m/.test(shown), 'map: the accuracy of the conversion is not stated');
  expect(
    (await page.locator('.tilemap__ring').count()) > 0,
    'map: the parcel was not drawn over the map',
  );

  // Tiles, from the stub. Their URLs are the check that the tile grid computed
  // sane indices — a wrong zoom or a negative index is a 404 on somebody
  // else's server rather than a visible fault here.
  const tiles = await page.locator('.tilemap__tile').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('src')),
  );
  expect(tiles.length > 0, 'map: no tiles were requested');
  for (const src of tiles) {
    const parts = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(src ?? '');
    expect(parts !== null, `map: a tile URL was not filled in — "${src}"`);
    if (parts) {
      const [z, x, y] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      expect(z >= 15 && z <= 21, `map: a 30 m parcel was fitted at zoom ${z}`);
      expect(x >= 0 && x < 2 ** z && y >= 0 && y < 2 ** z, `map: tile ${z}/${x}/${y} is off the grid`);
    }
  }

  // The attribution is a licence condition, not decoration.
  expect(
    /OpenStreetMap/.test((await page.locator('.tilemap__attribution').innerText()) ?? ''),
    'map: the tile source is not credited',
  );

  // Dragging moves the map and nothing else.
  const box = await page.locator('.tilemap__viewport').boundingBox();
  const beforeDrag = await page.locator('.tilemap__tile').first().getAttribute('style');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2 - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect(
    (await page.locator('.tilemap__tile').first().getAttribute('style')) !== beforeDrag,
    'map: dragging did not move the map',
  );
  await shot(page, 'map-wgs84');

  // What the table shows must be degrees, not eastings.
  const table = (await page.locator('.mapview__table').innerText()) ?? '';
  expect(/6\.5\d{5}/.test(table), `map: no latitudes in the converted table — "${table.slice(0, 80)}"`);
  expect(!/544800/.test(table), 'map: a Minna easting reached the map table');

  // --- The layer switcher ---------------------------------------------------

  // 1. OpenStreetMap is still the default, and it is what loaded.
  expect(
    tileRequests.some((url) => url.includes('tile.openstreetmap.org')),
    'layers: OpenStreetMap was not the layer that loaded',
  );
  const toggle = page.locator('.tilemap__layer-toggle');
  expect(
    /Map imagery: Streets/.test((await toggle.getAttribute('aria-label')) ?? ''),
    'layers: the map does not say which layer it is showing',
  );
  expect(
    /Streets/.test((await toggle.innerText()) ?? ''),
    'layers: the switch does not name the layer on screen',
  );
  expect(
    /Switch to Satellite/.test((await toggle.getAttribute('aria-label')) ?? ''),
    'layers: the switch does not say what it switches to',
  );

  /*
   * 3. The parcel must not move. Captured as the exact SVG geometry before the
   * switch and compared with it afterwards — a shift of even one pixel would
   * mean the two layers disagree about where the world is, which is the whole
   * risk in offering a second one.
   */
  const before = {
    ring: await page.locator('.tilemap__ring').first().getAttribute('points'),
    points: await page.locator('.tilemap__point').evaluateAll((nodes) =>
      nodes.map((node) => `${node.getAttribute('cx')},${node.getAttribute('cy')}`),
    ),
    attribution: await page.locator('.tilemap__attribution').innerText(),
  };
  expect(before.points.length >= 4, 'layers: the beacons were not drawn before switching');

  const osmCount = tileRequests.length;
  await toggle.click();
  await page.waitForTimeout(1200);

  // 2. Satellite imagery loads, from the imagery host and nowhere else.
  const satellite = tileRequests.slice(osmCount);
  expect(satellite.length > 0, 'layers: switching to satellite requested no imagery');
  expect(
    satellite.every((url) => url.includes('arcgisonline.com')),
    'layers: the satellite layer fetched something other than imagery',
  );
  // Esri puts the row before the column; a swapped pair fetches a real tile of
  // somewhere else, which is invisible unless the path is checked.
  for (const url of satellite) {
    expect(
      /\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(url),
      `layers: an imagery URL is not in {z}/{y}/{x} form — "${url}"`,
    );
  }
  expect(
    (await page.locator('.tilemap__tile').count()) > 0,
    'layers: no tiles are drawn on the satellite layer',
  );
  await shot(page, 'map-satellite');

  const after = {
    ring: await page.locator('.tilemap__ring').first().getAttribute('points'),
    points: await page.locator('.tilemap__point').evaluateAll((nodes) =>
      nodes.map((node) => `${node.getAttribute('cx')},${node.getAttribute('cy')}`),
    ),
    attribution: await page.locator('.tilemap__attribution').innerText(),
  };

  expect(after.ring === before.ring, 'layers: the boundary moved when the layer changed');
  expect(
    JSON.stringify(after.points) === JSON.stringify(before.points),
    'layers: the survey points moved when the layer changed',
  );
  // The credit has to follow the imagery, or the wrong people are being
  // credited for it.
  expect(/Esri/.test(after.attribution), 'layers: the imagery source is not credited');
  expect(
    !/OpenStreetMap/.test(after.attribution),
    'layers: OpenStreetMap is credited for imagery it did not provide',
  );

  expect(
    /Map imagery: Satellite/.test((await toggle.getAttribute('aria-label')) ?? ''),
    'layers: the switch does not say it is now on satellite',
  );
  expect(
    /Satellite/.test((await toggle.innerText()) ?? ''),
    'layers: the switch still names the old layer after switching',
  );

  // And back, to be sure the first layer is still there rather than replaced.
  await toggle.click();
  await page.waitForTimeout(1000);
  expect(
    /OpenStreetMap/.test((await page.locator('.tilemap__attribution').innerText()) ?? ''),
    'layers: OpenStreetMap could not be returned to',
  );
  expect(
    (await page.locator('.tilemap__ring').first().getAttribute('points')) === before.ring,
    'layers: switching back did not restore the boundary to where it was',
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  // The plan is still in Minna, on screen and on disk.
  await page.locator('.topbar__title').click();
  await page.waitForTimeout(600);
  expect(
    /Minna \/ UTM zone 31N/.test((await page.textContent('body')) ?? ''),
    'map: the survey stopped being on Minna after being mapped',
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  const gridAfter = await readSurvey();
  // 4. Nothing the map did — converting, panning, zooming or switching layer —
  // touched the survey.
  expect(/544800/.test(gridAfter), 'map: the stored survey no longer holds its Minna coordinates');
  expect(
    gridAfter === gridBefore,
    'map: the stored survey coordinates changed while it was being mapped',
  );
  expect(
    !/"easting":3\.40|"easting":6\.50/.test(gridAfter),
    'map: degrees were written back into the survey',
  );
  await page.close();
}

// --- Logging out of a device actually empties it ----------------------------

{
  /*
   * Reported as "it's still not logging out", and it was right. Erasing the
   * device cleared storage and the app immediately re-seeded the sample
   * survey and autosaved it back into the library — so the plan reappeared,
   * Projects refilled, and the screen after was identical to the screen
   * before. There is no way to tell that apart from a button that does
   * nothing.
   */
  const page = await open('logout', PHONE);

  await page.locator('.topbar__title').click();
  await page.waitForTimeout(600);
  await page.getByLabel('Site name or address').fill('Alpha Farm');
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Logout' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Log out and erase this device' }).click();
  await page.waitForTimeout(2500);

  const title = (await page.locator('.topbar__title').innerText()) ?? '';
  expect(!/Alpha Farm/.test(title), 'logout: the erased project came back');
  expect(
    !/Adeola|Ikeja/.test(title),
    `logout: the sample survey was seeded over the erase — "${title.trim()}"`,
  );

  // Nothing of ours left on the device, and nothing written straight back.
  const left = await page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) => key.startsWith('surveyor.')),
  );
  expect(
    left.length === 0,
    `logout: ${left.length} key(s) survived or were rewritten — ${left.join(', ')}`,
  );

  // And it says so, because a blank sheet is not by itself evidence.
  expect(
    /erased/i.test((await page.textContent('body')) ?? ''),
    'logout: nothing on screen confirms the device was erased',
  );
  await shot(page, 'logout-erased');

  // The library has to be empty too, not merely the canvas.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.waitForTimeout(700);
  const library = (await page.locator('.projects').innerText().catch(() => '')) ?? '';
  expect(!/Alpha Farm/.test(library), 'logout: the erased project is still in the library');
  await page.close();
}

// --- The assistant as a way through the app ---------------------------------

{
  const page = await open('guidance', PHONE);
  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.waitForTimeout(400);

  const input = page.getByLabel('Ask the assistant, or paste survey data').locator('visible=true').first();
  const send = page.getByRole('button', { name: 'Send' }).locator('visible=true').first();

  async function ask(question) {
    await input.fill(question);
    await send.click();
    await page.waitForTimeout(900);
    return page.locator('.ai__message--assistant').locator('visible=true').last().innerText();
  }

  // The report this exists for: asked to start a new project, the assistant
  // used to answer about area and dimensions. It now asks what to do with the
  // open plan first, which is the same requirement one step further on — the
  // open survey must not be thrown away without being asked about.
  const answer = await ask('create a new project');
  expect(
    /blank sheet/i.test(answer) && /keep/i.test(answer),
    `guidance: no help starting a project — got "${answer.slice(0, 80)}"`,
  );
  expect(
    await page
      .getByRole('button', { name: 'Save it, then start fresh' })
      .locator('visible=true')
      .first()
      .isVisible(),
    'guidance: asked about the open plan but not offered a way to keep it',
  );

  const dataAnswer = await ask('how do I get my points in?');
  expect(/paste|photograph|Data/i.test(dataAnswer), 'guidance: no help getting data in');

  // Asked in the words someone used, which the old patterns missed by one
  // word — `size of the land` matched, `size of this land` did not.
  const sizeAnswer = await ask('how many meters is the size of this land');
  expect(/m²/.test(sizeAnswer), `guidance: no size in "${sizeAnswer.slice(0, 80)}"`);
  expect(/perimeter/i.test(sizeAnswer), 'guidance: asked in metres, answered without any lengths');
  await shot(page, 'guidance');
  await page.close();
}

// --- Annotations: the title block, the scale bar and free text --------------

/*
 * The annotation layer end to end, through the interface rather than the
 * reducer. Three things are worth a browser to check and cannot be checked
 * anywhere else:
 *
 *   - the assistant offers the heading once, and its card and the typed
 *     command land in the same place;
 *   - the scale bar is drawn at the drawing's real scale, so measuring it on
 *     a printed sheet gives the number the plan claims;
 *   - none of it touches the survey.
 */

{
  const page = await open('annotations', PHONE);

  /** Everything about the stored survey that is not annotation or metadata. */
  const survey = () =>
    page.evaluate(() => {
      const out = {};
      // Sorted, because `Object.keys(localStorage)` is not order-stable once
      // keys have been rewritten — an unsorted read compares two orderings
      // and reports a change that never happened.
      for (const key of Object.keys(localStorage).sort()) {
        try {
          const plan = JSON.parse(localStorage.getItem(key));
          if (!plan?.points) continue;
          out[key] = JSON.stringify({
            points: plan.points,
            boundary: plan.boundary,
            siteFeatures: plan.siteFeatures,
            crs: plan.crs,
          });
        } catch {
          /* not a stored plan */
        }
      }
      return out;
    });

  const before = await survey();
  expect(Object.keys(before).length > 0, 'annotations: no stored survey to compare against');

  // The offer, on the assistant's own initiative once the boundary validates.
  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.waitForTimeout(900);
  const offer = page.getByRole('button', { name: 'Add the whole heading' }).locator('visible=true');
  expect((await offer.count()) > 0, 'annotations: no offer to put the heading on the plan');

  // The typed command, which must reach the same handler as that button.
  const input = page
    .getByLabel('Ask the assistant, or paste survey data')
    .locator('visible=true')
    .first();
  await input.fill('add the heading');
  await page.getByRole('button', { name: 'Send' }).locator('visible=true').first().click();
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  /*
   * Separate lines, not a box.
   *
   * A survey plan states its heading as distinct underlined lines above the
   * drawing — title, scale, bar, origin, area — and each is its own object to
   * show, move and tap. This drew them inside one bordered plate at the
   * bottom left, which is a CAD habit rather than how a lodged plan looks.
   */
  expect(
    (await page.locator('.annotation__plate').count()) === 0,
    'annotations: the heading is drawn inside a box',
  );
  expect(
    (await page.locator('.annotation--title').count()) >= 2,
    'annotations: the heading is one object rather than separate lines',
  );
  expect(
    (await page.locator('.annotation__rule').count()) >= 2,
    'annotations: the heading lines are not underlined',
  );

  // The title came from the plan, because nobody has typed one.
  const titleText = await page
    .locator('.annotation--title text')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent));
  expect(
    titleText.some((line) => /Adeola Close/.test(line ?? '')),
    `annotations: title block does not name the plan — ${JSON.stringify(titleText)}`,
  );

  /*
   * The heading sits above the drawing and never touches it, at any zoom.
   *
   * It was laid out growing *downward* from an anchor placed a survey-unit
   * margin above the boundary — but its height is text, which is pixels, so
   * the margin shrank as you zoomed out while the heading did not. The AREA
   * line ended up written across a boundary dimension. It now grows upward
   * from the anchor, which is what makes this hold at every zoom rather than
   * at the one it was checked at.
   */
  for (const [label, clicks, control] of [
    ['fitted', 0, null],
    ['zoomed out', 4, 'Zoom out'],
    ['zoomed in', 3, 'Zoom in'],
  ]) {
    await page.getByRole('button', { name: 'Fit plan to screen' }).first().click();
    await page.waitForTimeout(250);
    for (let step = 0; step < clicks; step += 1) {
      await page.getByRole('button', { name: control }).first().click();
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(300);

    const clearance = await page.evaluate(() => {
      const heading = [...document.querySelectorAll('.annotation--title')].map((node) =>
        node.getBoundingClientRect(),
      );
      const survey = [...document.querySelectorAll('.layer--boundary *, .layer--dimensions *')]
        .map((node) => node.getBoundingClientRect())
        .filter((box) => box.width > 0 || box.height > 0);
      if (heading.length === 0 || survey.length === 0) return null;
      return (
        Math.min(...survey.map((box) => box.top)) -
        Math.max(...heading.map((box) => box.bottom))
      );
    });

    expect(
      clearance !== null && clearance > 0,
      `annotations: the heading overlaps the drawing when ${label} (${clearance}px)`,
    );
  }

  await page.getByRole('button', { name: 'Fit plan to screen' }).first().click();
  await page.waitForTimeout(400);

  // A free text note, added, named and formatted.
  await page.getByRole('button', { name: '+ Add' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Text note' }).locator('visible=true').first().click();
  await page.waitForTimeout(600);

  const field = page.getByLabel('Text box contents').locator('visible=true').first();
  expect(
    await field.isVisible().catch(() => false),
    'annotations: adding a note did not open the panel for typing what it says',
  );
  await field.fill('Fence in poor repair');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Bold' }).locator('visible=true').first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Done' }).locator('visible=true').first().click();
  await page.waitForTimeout(800);

  const note = await page
    .locator('.annotation--text text')
    .evaluateAll((nodes) => nodes.map((node) => [node.textContent, node.style.fontWeight]));
  expect(
    note.some(([text, weight]) => text === 'Fence in poor repair' && weight === '700'),
    `annotations: the note is not on the drawing as typed and formatted — ${JSON.stringify(note)}`,
  );

  // Selecting an annotation names it for what it is, rather than "1 objects".
  await page.locator('.annotation--text').first().click();
  await page.waitForTimeout(500);
  if (await page.locator('.contextbar').isVisible()) {
    const said = await page.locator('.contextbar__title').first().innerText();
    expect(/Text note/i.test(said), `annotations: a selected note is called "${said}"`);
  } else {
    problems.push('annotations: tapping a note did not select it');
  }

  /*
   * Each line is its own object: tapping one selects that one, and dragging
   * it moves that one.
   */
  const barBox = await page.locator('.annotation--bar').first().boundingBox();
  expect(Boolean(barBox), 'annotations: no scale bar to select');

  if (barBox) {
    const cx = barBox.x + barBox.width / 2;
    const cy = barBox.y + barBox.height / 2;
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(500);

    const said = await page.locator('.contextbar__title').first().innerText().catch(() => '');
    expect(
      /Scale bar/.test(said),
      `annotations: tapping the scale bar selected "${said.replace(/\n/g, ' ')}"`,
    );

    const positions = () =>
      page.locator('.annotation--title').evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { id: node.getAttribute('data-id'), x: Math.round(box.x), y: Math.round(box.y) };
        }),
      );

    const wasAt = await positions();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 40, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const nowAt = await positions();

    for (const now of nowAt) {
      const was = wasAt.find((row) => row.id === now.id);
      if (!was) continue;
      const shifted = Math.abs(now.x - was.x) > 4 || Math.abs(now.y - was.y) > 4;
      const isBar = now.id?.endsWith(':bar') ?? false;
      expect(
        shifted === isBar,
        isBar
          ? 'annotations: dragging the scale bar did not move it'
          : `annotations: dragging the scale bar also moved ${now.id}`,
      );
    }
  }

  /*
   * The scale bar against the drawing itself.
   *
   * The bar says "10 m" and is some number of pixels wide. Two survey points
   * whose separation on the ground is known are some other number of pixels
   * apart. If those two ratios disagree, the bar is a measuring stick that
   * lies — which is the one failure a scale bar must not have, and the reason
   * this is checked on screen rather than in a unit test.
   */
  const bar = await page.evaluate(() => {
    const line = document.querySelector('.annotation__bar line');
    const labels = [...document.querySelectorAll('.annotation__bar-label')];
    const markers = [...document.querySelectorAll('.element__marker')].map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    return {
      width: line ? line.getBBox().width : null,
      label: labels.at(-1)?.textContent ?? null,
      markers,
    };
  });

  expect(bar.width > 10, 'annotations: no scale bar drawn');
  expect(/^\d+(\.\d+)?\s*m$/.test(bar.label ?? ''), `annotations: scale bar label reads "${bar.label}"`);
  expect(bar.markers.length >= 2, 'annotations: no survey points to measure the bar against');

  if (bar.width > 10 && bar.markers.length >= 2) {
    // PT1→PT2 in the sample plan: 544800,718900 → 544832.4,718903.1.
    const GROUND = Math.hypot(32.4, 3.1);
    const [a, b] = bar.markers;
    const onScreen = Math.hypot(b.x - a.x, b.y - a.y);
    const fromDrawing = GROUND / onScreen;
    const fromBar = Number.parseFloat(bar.label) / bar.width;
    const disagreement = Math.abs(fromBar - fromDrawing) / fromDrawing;
    expect(
      disagreement < 0.02,
      `annotations: the scale bar disagrees with the drawing by ${(disagreement * 100).toFixed(1)}%` +
        ` (bar ${fromBar.toFixed(4)} m/px, drawing ${fromDrawing.toFixed(4)} m/px)`,
    );
  }

  await shot(page, 'annotations');

  // And after all of that, the survey is byte-for-byte what it was.
  const after = await survey();
  expect(
    JSON.stringify(after) === JSON.stringify(before),
    'annotations: annotating the plan changed the survey data',
  );
  await page.close();
}
}

// --- The classifier, end to end ---------------------------------------------

/*
 * The endpoint is inlined at build time, so a build with none configured can
 * never exercise the model path. This block runs against a build made with
 * `VITE_ASSISTANT_ENDPOINT` pointing at a stub, which the harness serves:
 *
 *   VITE_ASSISTANT_ENDPOINT=/__classify npm run build
 *   npm run smoke -- --classifier
 *
 * What it proves is the half that is ours — the request carries the
 * conversation, a classification is validated before it is believed,
 * confidence decides between answering and asking, and the figure in the reply
 * comes from the engine rather than from the reply that suggested it.
 */
if (CLASSIFIER_ONLY) {
  const page = await open('classifier', PHONE);
  const seen = [];

  await page.route('**/__classify', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    seen.push(body);

    const unsure = /which|either|something/i.test(body.question);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        unsure
          ? {
              understanding: 'They could mean the parcel or the house.',
              scope: 'ambiguous',
              capability: 'none',
              argument: '',
              confidence: 'low',
              message: '',
              clarification_question: 'Do you mean the parcel, or the house?',
              clarification_options: [
                { label: 'The parcel', capability: 'parcel-size', argument: '' },
                { label: 'The house', capability: 'site-features', argument: '' },
              ],
              actions: [],
            }
          : {
              understanding: 'They want to know how big the parcel is.',
              scope: 'in-scope',
              capability: 'parcel-size',
              argument: '',
              confidence: 'high',
              // Deliberately wrong. The engine writes the answer; if this
              // string reaches the screen, the guarantee has been broken.
              message: 'The land is about 5 square metres.',
              clarification_question: '',
              clarification_options: [],
              actions: [],
            },
      ),
    });
  });

  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.waitForTimeout(400);
  const input = page.getByLabel('Ask the assistant, or paste survey data').locator('visible=true').first();
  const send = page.getByRole('button', { name: 'Send' }).locator('visible=true').first();

  await input.fill('how many meters is the size of this land');
  await send.click();
  await page.waitForTimeout(1200);

  const answered = await page.locator('.ai__message--assistant').locator('visible=true').last().innerText();
  expect(seen.length === 1, 'classifier: the endpoint was not called');
  expect(Array.isArray(seen[0]?.history), 'classifier: the conversation was not sent');
  expect(/m²/.test(answered), `classifier: no figure from the engine — "${answered.slice(0, 80)}"`);
  expect(
    !/5 square metres/.test(answered),
    'classifier: a figure written by the model reached the reply',
  );
  await shot(page, 'classifier-answer');

  await input.fill('how big is it, and which one do you mean');
  await send.click();
  await page.waitForTimeout(1200);

  const asked = await page.locator('.ai__message--assistant').locator('visible=true').last().innerText();
  expect(/Do you mean the parcel/.test(asked), 'classifier: an unsure reading did not ask');
  expect(!/m²/.test(asked), 'classifier: a question should not also answer itself');
  expect(
    await page.getByRole('button', { name: 'The parcel' }).locator('visible=true').first().isVisible(),
    'classifier: the readings were not offered as buttons',
  );
  await shot(page, 'classifier-clarify');
  await page.close();
}

// --- CAD editing ------------------------------------------------------------

{
  // The claim this whole layer makes is that a drawing is geometry rather
  // than a picture, so the check is the coordinate, not the pixels.
  const page = await open('cad', DESKTOP);

  async function eastingOfPT1() {
    await page.getByRole('button', { name: 'Data' }).click();
    await page.waitForTimeout(400);
    const value = await page.getByLabel(/PT1 easting/).inputValue();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForTimeout(300);
    return Number(value);
  }

  const before = await eastingOfPT1();

  const points = await page.locator('.element--point').all();
  expect(points.length >= 3, 'cad: no survey points to edit');

  const first = await points[0].boundingBox();
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await page.waitForTimeout(300);

  // Shift-click builds a set; every editing operation works on one.
  const second = await points[1].boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.click(second.x + second.width / 2, second.y + second.height / 2);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  expect(
    /2 objects/.test((await page.locator('.contextbar').innerText()) ?? ''),
    'cad: shift-click did not extend the selection',
  );

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByLabel('Move bearing in degrees').fill('90');
  await page.getByLabel(/Move distance/).fill('5');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await page.waitForTimeout(700);

  // Exactly five metres. "About five" is the defect this replaces.
  const moved = await eastingOfPT1();
  expect(
    Math.abs(moved - before - 5) < 1e-9,
    `cad: a 5 m move moved ${(moved - before).toFixed(6)} m`,
  );
  await shot(page, 'cad-moved');

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  expect(
    Math.abs((await eastingOfPT1()) - before) < 1e-9,
    'cad: undo did not restore the coordinate exactly',
  );

  // An offset is calculated from the boundary, so it is a real setback line
  // rather than a hand-drawn approximation of one.
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('tab', { name: 'Offset' }).click();
  await page.waitForTimeout(300);
  await page.getByLabel(/Setback distance/).fill('3');
  await page.getByRole('button', { name: 'Inside' }).click();
  await page.waitForTimeout(700);

  expect(
    /Setback 3/.test((await page.textContent('body')) ?? ''),
    'cad: the setback line was not created',
  );
  await shot(page, 'cad-offset');
  await page.close();
}

// --- Drawing entities -------------------------------------------------------

{
  // The things a site plan carries besides the parcel outline. Each has a
  // conventional way of being drawn, which is the point of naming the kind
  // rather than putting a grey line on the drawing.
  const page = await open('entities', DESKTOP);

  async function add(kind, fill) {
    await page.keyboard.press('a');
    await page.waitForTimeout(400);
    await page.getByLabel('Feature kind').selectOption(kind);
    await page.waitForTimeout(250);
    if (fill) await fill();
    await page.getByRole('button', { name: 'Add to the drawing' }).click();
    await page.waitForTimeout(600);
  }

  await add('tree', async () => {
    await page.getByLabel(/Feature name/).fill('Oak');
    await page.getByLabel(/Radius in/).fill('4');
  });
  await add('level', async () => {
    await page.getByLabel(/Level in/).fill('45.20');
  });
  await add('wall', async () => {
    await page.getByLabel(/Feature name/).fill('Boundary wall');
    await page.getByLabel(/Length in/).fill('12');
  });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  const text = (await page.textContent('body')) ?? '';
  expect(/Oak/.test(text), 'entities: the tree was not labelled');
  // The level is rendered from the elevation attribute, not typed as a label,
  // so correcting the figure corrects the plan.
  expect(/45\.20/.test(text), 'entities: the spot height was not shown');
  expect(/Boundary wall/.test(text), 'entities: the wall was not labelled');
  expect(
    (await page.locator('.element--level').count()) > 0,
    'entities: the level was drawn as a generic dot rather than a cross',
  );
  await shot(page, 'entities');
  await page.close();
}

// --- The project library ----------------------------------------------------

{
  // The bug this exists to fix: the app held one project, so starting a second
  // destroyed the first. That is what the check is.
  const page = await open('library', DESKTOP);

  async function openProjectSheet() {
    await page.getByRole('button', { name: 'Project settings and new project' }).click();
    await page.waitForTimeout(400);
  }

  await openProjectSheet();
  await page.getByLabel('Site name or address').fill('Alpha Farm');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(500);

  await openProjectSheet();
  await page.getByRole('button', { name: 'Start a new project' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Yes, start a new project' }).click();
  await page.waitForTimeout(900);

  await openProjectSheet();
  await page.getByLabel('Site name or address').fill('Beta Field');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'All projects' }).click();
  await page.waitForTimeout(700);

  const library = (await page.locator('.projects').innerText()) ?? '';
  expect(/Alpha Farm/.test(library), 'library: starting a project destroyed the previous one');
  expect(/Beta Field/.test(library), 'library: the new project was not saved');
  await shot(page, 'library');

  // Reopening has to bring the survey back, not just the name.
  // `exact` matters: the header's menu button is labelled "Open menu", and a
  // loose match picks that instead — it sits earlier in the document.
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await page.waitForTimeout(900);
  expect(
    /Alpha Farm/.test((await page.locator('.topbar__title').innerText()) ?? ''),
    'library: reopening did not switch project',
  );
  expect(
    (await page.locator('.element--point').count()) >= 3,
    'library: the reopened project came back without its survey',
  );
  await page.close();
}

// --- Traverse entry ---------------------------------------------------------

{
  const page = await open('traverse', PHONE);
  await page.getByRole('button', { name: 'Data' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('tab', { name: 'Traverse' }).click();
  await page.waitForTimeout(300);

  // A deed traverse that closes exactly: 30 x 20 walked round.
  await page.locator('.importer__input').fill(
    [
      'PT1 PT2 N 90°00\'00" E 30.00',
      'PT2 PT3 N 00°00\'00" E 20.00',
      'PT3 PT4 S 90°00\'00" W 30.00',
      'PT4 PT1 S 00°00\'00" E 20.00',
    ].join('\n'),
  );
  await page.waitForTimeout(500);

  const text = (await page.textContent('body')) ?? '';
  expect(/4 legs read/.test(text), 'traverse: legs not counted');
  expect(/Closure/.test(text), 'traverse: closure not shown while typing');
  expect(/0\.000 m/.test(text), 'traverse: a closing traverse should report no misclosure');
  await shot(page, 'traverse');

  await page.getByRole('button', { name: 'Use this traverse' }).click();
  await page.waitForTimeout(700);

  const after = (await page.textContent('body')) ?? '';
  expect(/600 m²/.test(after), 'traverse: expected a 600 m² parcel after applying');
  await shot(page, 'traverse-applied');
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
