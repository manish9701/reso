/**
 * Side-by-side harness: the reference render next to a live render at matched
 * resolution, so visual tuning stops being guesswork.
 *
 * This exists because every previous tuning decision was made from headless
 * SwiftShader frames judged in isolation. Seeing the reference and the render
 * at the same scale, side by side, is what makes "too pale" or "too contrasty"
 * an observation instead of an opinion.
 *
 *   node scripts/compare.mjs <url> [referencePng]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:5173/reso/';
const REFERENCE = process.argv[3] ?? 'D:\\Desktop\\reso\\resonant-ink-reference.png';
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';
const W = 1024;
const H = 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(URL + '?drive=4.5&level=0.9', { waitUntil: 'networkidle0' });
await sleep(3500);

// Pour a representative mix so both images have comparable content.
await page.evaluate(() => {
  const e = window.__lab;
  const cols = [
    [0.06, 0.22, 0.95], [0.62, 0.10, 0.92], [0.05, 0.72, 0.86],
    [0.95, 0.42, 0.06], [0.95, 0.12, 0.42], [0.10, 0.45, 0.90],
  ];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const r = 0.10 + (i % 3) * 0.09;
    e.dropIn(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, cols[i % cols.length], 0.6, 0.021);
  }
});
await sleep(6000);

const shot = `${OUT}\\compare-live.png`;
// Hide the UI chrome so the comparison is render-only, like the reference.
await page.evaluate(() => {
  for (const sel of ['.rail', '.ink-hint', '.ink-brand']) {
    document.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; });
  }
});
await sleep(300);
await page.screenshot({ path: shot });

if (!fs.existsSync(REFERENCE)) {
  console.log('no reference at', REFERENCE, '- live shot written to', shot);
} else {
  // Compose reference | live side by side in the page itself.
  const b64ref = fs.readFileSync(REFERENCE).toString('base64');
  const b64live = fs.readFileSync(shot).toString('base64');
  const composed = await page.evaluate(async (a, b) => {
    const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas');
    c.width = ia.width + ib.width; c.height = Math.max(ia.height, ib.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(ia, 0, 0); g.drawImage(ib, ia.width, 0);
    return c.toDataURL('image/png');
  }, b64ref, b64live);
  const outPath = `${OUT}\\compare-side-by-side.png`;
  fs.writeFileSync(outPath, Buffer.from(composed.split(',')[1], 'base64'));
  console.log('side-by-side written:', outPath);
  console.log('left = reference, right = live render');
}
console.log('live shot:', shot);
await browser.close();