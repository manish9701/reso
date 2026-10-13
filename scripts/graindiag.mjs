/**
 * Grain diagnosis: render the dish with NO pigment and NO strikes, so any
 * visible structure can only come from the figure field + caustics + studio
 * reflection. Captures the normal view plus the ?debug=h raw-field view.
 *
 *   node scripts/graindiag.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:5173/reso/';
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  defaultViewport: { width: 1400, height: 900 },
});

async function shot(qs, name, waitMs) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(URL + qs, { waitUntil: 'networkidle0' });
  await sleep(waitMs);
  await page.evaluate(() => {
    for (const s of ['.rail', '.ink-hint']) {
      document.querySelectorAll(s).forEach((el) => { el.style.display = 'none'; });
    }
  });
  await sleep(300);
  await page.screenshot({ path: `${OUT}\\${name}.png` });
  await page.close();
}

// driven figure, no pigment, no strikes — like the user's screenshot
await shot('?drive=110&level=0.85', 'grain-figonly', 6000);
// raw height field — shows whether the rings live in the field itself
await shot('?drive=110&level=0.85&debug=h', 'grain-debug-h', 6000);
// no drive at all (level 0) — shows what the water looks like at rest
await shot('?drive=110&level=0', 'grain-rest', 4000);

console.log('written: grain-figonly.png, grain-debug-h.png, grain-rest.png');
await browser.close();