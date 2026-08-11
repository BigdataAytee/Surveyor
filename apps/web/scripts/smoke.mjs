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

// --- Messy paste: a table wrapped in everything else a page has on it -------

{
  // Every one of these decorations used to be fatal on its own, because every
  // non-empty line was assumed to be a row of the table.
  const MESSY = [
    'BOUNDARY SURVEY — 25 High Street',
    'Surveyed 11/08/2026',
    '',
    'Pt No   Easting     Northing    Description',
    '-----   -------     --------    -----------',
    'P1      534800.00   182900.00   Corner, iron pin',
    'P2      534845.00   182900.00   Corner',
    'P3      534845.00   182935.00   Corner',
    'P4      534800.00   182935.00   Corner',
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
    [handle, ['P1,534800,182900', 'P2,534845,182900', 'P3,534845,182935', 'P4,534800,182935'].join('\n')],
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
  // used to answer about area and dimensions.
  const answer = await ask('create a new project');
  expect(/new project/i.test(answer), `guidance: no help starting a project — got "${answer.slice(0, 80)}"`);
  expect(
    await page.getByRole('button', { name: 'Start a new project' }).locator('visible=true').first().isVisible(),
    'guidance: told how to start a project but not offered the button',
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
