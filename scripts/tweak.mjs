/**
 * Live-tweak probe: run an expression against window.__lab, then screenshot.
 * Lets a change be judged without a rebuild/reload cycle.
 *
 *   node scripts/tweak.mjs <tag> "<js expression>" [hz] [settleMs]
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5199/reso/';
const TAG = process.argv[3] ?? 'tweak';
const EXPR = process.argv[4] ?? 'null';
const HZ = Number(process.argv[5] ?? 432);
const SETTLE = Number(process.argv[6] ?? 3000);
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

await page.goto(`${URL}?drive=${HZ}&level=0.85`, { waitUntil: 'networkidle0' });
await sleep(2500);
if (HZ !== 432) { await page.evaluate((f) => { window.__lab.forcedDrive = { freq: f, level: 0.85 }; }, HZ); await sleep(1500); }

const res = await page.evaluate(`(()=>{ const e = window.__lab; return (${EXPR}); })()`);
console.log('RESULT', JSON.stringify(res));
await sleep(SETTLE);
await page.screenshot({ path: `${OUT}\\${TAG}.png` });
await browser.close();