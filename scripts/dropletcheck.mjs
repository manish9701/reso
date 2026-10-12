/** Verify droplets: spawn drops, confirm they fall, land, and mix into the dye.
 *  Run: node scripts/dropletcheck.mjs http://localhost:5173/reso/
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
  defaultViewport: { width: 1536, height: 1024 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(URL + '?drive=432&level=0.85', { waitUntil: 'networkidle0' });
await sleep(3000);

// Spawn a fan of coloured drops
await page.evaluate(() => {
  const e = window.__lab;
  const cols = [[0.9,0.1,0.2],[0.1,0.3,0.95],[0.95,0.5,0.05],[0.55,0.1,0.85],[0.05,0.7,0.8]];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const c = cols[i % cols.length];
    e.dropIn(0.5 + Math.cos(a) * 0.18, 0.5 + Math.sin(a) * 0.18, c, 0.6, 0.02);
  }
  return e.dropsInFlight;
});
console.log('drops spawned, inFlight =', await page.evaluate(() => window.__lab.dropsInFlight));

// mid-fall screenshot
await sleep(180);
const inflightMid = await page.evaluate(() => window.__lab.dropsInFlight);
await page.screenshot({ path: OUT + '\\drops-midfall.png' });
console.log('midfall inFlight =', inflightMid);

// wait for landing, then let them mix
await sleep(2500);
const inflightEnd = await page.evaluate(() => window.__lab.dropsInFlight);
await page.screenshot({ path: OUT + '\\drops-landed.png' });
await sleep(3000);
await page.screenshot({ path: OUT + '\\drops-mixed.png' });
console.log('after landing inFlight =', inflightEnd);

// centre pixel colour: did blue pigment actually enter the water?
const stats = await page.evaluate(() => {
  const e = window.__lab;
  return { dyeStats: e.dyeStats(), fieldRange: 'n/a' };
});
console.log('dye stats:', JSON.stringify(stats));

await browser.close();