/**
 * Bisect the washed-pigment regression: same heavy pour rendered three ways.
 *  A: direct engine.deposit stamps (bypass droplets) — tests if the trickle
 *     path delivers too-thin dye.
 *  B: normal droplet pour (current behaviour).
 *
 * If A renders saturated and B does not, the droplet/trickle path is starving
 * the dye field. If both wash out, the render path is at fault.
 *
 *   node scripts/mixbisect.mjs [url]
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

async function runCase(name, pourFn, waitMs) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(URL + '?drive=110&level=0.85', { waitUntil: 'networkidle0' });
  await sleep(2500);
  await page.evaluate(pourFn);
  await sleep(waitMs);
  await page.evaluate(() => {
    for (const s of ['.rail', '.ink-hint']) {
      document.querySelectorAll(s).forEach((el) => { el.style.display = 'none'; });
    }
  });
  await sleep(300);
  // centre-crop saturation, same metric as dyemeasure
  const clip = { x: 480, y: 280, width: 440, height: 340 };
  const b64 = await page.screenshot({ clip, encoding: 'base64' });
  const sat = await page.evaluate(async (b) => {
    const im = new Image();
    im.src = 'data:image/png;base64,' + b;
    await new Promise((r) => (im.onload = r));
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, mx = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, bb = d[i + 2] / 255;
      const hi = Math.max(r, gg, bb), lo = Math.min(r, gg, bb);
      const s = hi === 0 ? 0 : (hi - lo) / hi;
      sum += s; n++;
      if (s > mx) mx = s;
    }
    return { mean: +(sum / n).toFixed(3), max: +mx.toFixed(3) };
  }, b64);
  await page.screenshot({ path: `${OUT}\\bisect-${name}.png` });
  console.log(`${name}: meanSat=${sat.mean} maxSat=${sat.max}`);
  await page.close();
}

// A: fat direct stamps, no droplets involved
await runCase('direct', () => {
  const e = window.__lab;
  const cols = [[0.06, 0.22, 0.95], [0.95, 0.42, 0.06], [0.62, 0.10, 0.92], [0.05, 0.72, 0.86]];
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + k * 0.2;
      const r = 0.10 + (i % 3) * 0.08;
      e.deposit(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, 0.055, 0.95, cols[(i + k) % 4]);
    }
  }
}, 5000);

// B: the droplet path the UI actually uses
await runCase('droplets', () => {
  const e = window.__lab;
  const cols = [[0.06, 0.22, 0.95], [0.95, 0.42, 0.06], [0.62, 0.10, 0.92], [0.05, 0.72, 0.86]];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const r = 0.10 + (i % 3) * 0.09;
    e.dropIn(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, cols[i % cols.length], 0.6, 0.021);
  }
}, 6000);

await browser.close();