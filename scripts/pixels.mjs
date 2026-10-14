/**
 * Read the real framebuffer and report where the brightness actually is.
 * Uses engine.capture() (renders + reads in the same tick) because the canvas
 * has preserveDrawingBuffer off, so drawImage() on it returns blank.
 *
 *   node scripts/pixels.mjs <url> <hz> [tag]
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const HZ = Number(process.argv[3] ?? 432);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(`${URL}?drive=${HZ}&level=0.85`, { waitUntil: 'networkidle0' });
await sleep(3500);

const out = await page.evaluate(async () => {
  const dataUrl = window.__lab.capture();
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const c = cv.getContext('2d');
  c.drawImage(img, 0, 0);
  const d = c.getImageData(0, 0, cv.width, cv.height).data;
  const lum = (x, y) => {
    const i = (y * cv.width + x) * 4;
    return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  };
  const cy = Math.round(cv.height / 2);
  const cx = Math.round(cv.width / 2);

  // horizontal scan through the dish centre
  const scan = [];
  for (let f = 0.02; f <= 0.98; f += 0.02) {
    const x = Math.round(f * (cv.width - 1));
    scan.push({ f: +f.toFixed(2), lum: Math.round(lum(x, cy)) });
  }

  // vertical scan through the centre
  const vscan = [];
  for (let f = 0.02; f <= 0.98; f += 0.02) {
    const y = Math.round(f * (cv.height - 1));
    vscan.push({ f: +f.toFixed(2), lum: Math.round(lum(cx, y)) });
  }

  // whole-frame histogram
  let clipped = 0, total = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; total++;
    if (l > 250) clipped++;
  }
  return { w: cv.width, h: cv.height, scan, vscan, meanLum: +(sum / total).toFixed(1), clippedPct: +(100 * clipped / total).toFixed(2) };
});

console.log(`frame ${out.w}x${out.h}  meanLum ${out.meanLum}  clipped(>250) ${out.clippedPct}%`);
console.log('\nhorizontal scan through centre (f = fraction of width, from left):');
console.log(out.scan.map((s) => `${s.f}:${s.lum}`).join('  '));
console.log('\nvertical scan through centre (f = fraction of height, from top):');
console.log(out.vscan.map((s) => `${s.f}:${s.lum}`).join('  '));

await browser.close();