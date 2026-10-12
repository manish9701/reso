/**
 * Verify that the figure DEVELOPS over time as pigment migrates onto the
 * nodal lines, rather than appearing instantly.
 * Run: node scripts/develop.mjs http://localhost:5173/reso/
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
await page.goto(URL + '?drive=4.5&level=0.9', { waitUntil: 'networkidle0' });
await sleep(3000);

// pour a ring of colour, then let it migrate
await page.evaluate(() => {
  const e = window.__lab;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    e.dropIn(0.5 + Math.cos(a) * 0.22, 0.5 + Math.sin(a) * 0.22, [0.85, 0.15, 0.05], 0.6, 0.02);
  }
});

// wait for landing, then sample brightness of the centre crop over time as the
// figure develops
const brightnessOverTime = [];
for (const t of [3000, 4000, 5000, 6000]) {
  await sleep(t === 3000 ? 3000 : 2000);
  const clip = { x: 640, y: 380, width: 260, height: 260 };
  const b64 = await page.screenshot({ clip, encoding: 'base64' });
  const lum = await page.evaluate(async (b) => {
    const im = new Image();
    im.src = 'data:image/png;base64,' + b;
    await new Promise((r) => (im.onload = r));
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    return sum / (d.length / 4);
  }, b64);
  brightnessOverTime.push(lum);
  await page.screenshot({ path: `${OUT}\\develop-${t}.png` });
}
console.log('centre luminance over time:', brightnessOverTime.map((l) => l.toFixed(1)).join(' -> '));
console.log(brightnessOverTime[brightnessOverTime.length-1] > brightnessOverTime[0]
  ? 'BRIGHTENING: figure is developing as pigment migrates'
  : 'NOT BRIGHTENING: figure is static');

await browser.close();