/**
 * Measure what the dye field actually contains, so saturation tuning is
 * driven by numbers rather than impressions.
 * Run: node scripts/dyemeasure.mjs http://localhost:5173/reso/
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:5173/reso/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  defaultViewport: { width: 1024, height: 1024 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(URL + '?drive=4.5&level=0.9', { waitUntil: 'networkidle0' });
await sleep(3500);

// Match the compare harness: a dense, multi-hue pour across the dish. A
// sparse single-hue pour measures dilution, not what the dish looks like.
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

// GPU float readback of a HalfFloat target returns zeros under SwiftShader,
// so measure the RENDERED pixels instead — that is the saturation we actually
// need to fix, and it does not depend on the render-target format at all.
const clip = { x: 380, y: 380, width: 260, height: 260 };
const b64 = await page.screenshot({ clip, encoding: 'base64' });

const stats = await page.evaluate(async (b) => {
  const im = new Image();
  im.src = 'data:image/png;base64,' + b;
  await new Promise((r) => (im.onload = r));
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sumSat = 0, n = 0, maxSat = 0, minLum = 999, maxLum = -1, sumLum = 0;
  const hist = [0, 0, 0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
    sumSat += sat; sumLum += lum; n++;
    if (sat > maxSat) maxSat = sat;
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
    hist[Math.min(4, Math.floor(sat * 5))]++;
  }
  return {
    meanSaturation: +(sumSat / n).toFixed(3),
    maxSaturation: +maxSat.toFixed(3),
    meanLuminance: +(sumLum / n).toFixed(3),
    lumRange: [+minLum.toFixed(3), +maxLum.toFixed(3)],
    saturationHistogram: hist.map((h) => +(h / n).toFixed(3)),
  };
}, b64);

console.log(JSON.stringify(stats, null, 2));
console.log('\nreference image for comparison: run compare.mjs and inspect side-by-side');
await browser.close();