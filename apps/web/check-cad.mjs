import { chromium } from 'playwright';
const SHOTS = '/tmp/claude-0/-home-user-Surveyor/845b772d-a075-5a2f-a12b-bfb04b00d538/scratchpad';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript(() => window.localStorage.clear());
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const areaOf = async () => {
  const t = await page.textContent('body');
  const m = /([\d,]+(?:\.\d+)?)\s*m²/.exec(t ?? '');
  return m ? m[1] : null;
};
console.log('area before:', await areaOf());

// Select a boundary corner, then shift-click another to build a multi-selection.
const box = await page.locator('.canvas').boundingBox();
const pts = await page.locator('.element--point').all();
console.log('points on canvas:', pts.length);

const b0 = await pts[0].boundingBox();
await page.mouse.click(b0.x + b0.width / 2, b0.y + b0.height / 2);
await page.waitForTimeout(300);
console.log('contextbar after 1 click:', await page.locator('.contextbar').isVisible().catch(() => false));

const b1 = await pts[1].boundingBox();
await page.keyboard.down('Shift');
await page.mouse.click(b1.x + b1.width / 2, b1.y + b1.height / 2);
await page.keyboard.up('Shift');
await page.waitForTimeout(300);
const bar = await page.locator('.contextbar').innerText().catch(() => '(none)');
console.log('contextbar after shift-click:', bar.replace(/\n/g, ' | '));

// Open Edit and move the two corners exactly 5 m east.
await page.getByRole('button', { name: 'Edit', exact: true }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/cad-tools.png` });
await page.getByLabel('Move bearing in degrees').fill('90');
await page.getByLabel(/Move distance/).fill('5');
await page.getByRole('button', { name: 'Move', exact: true }).click();
await page.waitForTimeout(800);
console.log('area after moving 2 corners 5m east:', await areaOf());
await page.screenshot({ path: `${SHOTS}/cad-moved.png` });

// Undo must put it back exactly.
await page.keyboard.press('Control+z');
await page.waitForTimeout(600);
console.log('area after undo:', await areaOf());

// Offset the boundary inward by 3 m.
await page.getByRole('button', { name: 'Layers' }).click();
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.mouse.click(b0.x + b0.width / 2, b0.y + b0.height / 2);
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Edit', exact: true }).click();
await page.waitForTimeout(300);
await page.getByRole('tab', { name: 'Offset' }).click();
await page.waitForTimeout(300);
await page.getByLabel(/Setback distance/).fill('3');
await page.getByRole('button', { name: 'Inside' }).click();
await page.waitForTimeout(800);
const after = await page.textContent('body');
console.log('setback feature present:', /Setback 3/.test(after ?? ''));
await page.screenshot({ path: `${SHOTS}/cad-offset.png` });

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
