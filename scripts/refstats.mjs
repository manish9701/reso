/**
 * Measure the reference image's colour statistics, so the render can be tuned
 * toward measured targets instead of impressions.
 *
 *   node scripts/refstats.mjs [referencePng]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REFERENCE = process.argv[2] ?? 'D:\\Desktop\\reso\\resonant-ink-reference.png';
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars'],
});
const page = await browser.newPage();

// Decode through a Blob URL rather than a base64 data URI: a 2 MB data URI
// can fail to decode in headless Chrome, and onerror leaves the promise
// unresolved so every statistic comes back NaN instead of a clear failure.
const dataUrl = 'data:image/png;base64,' + fs.readFileSync(REFERENCE).toString('base64');
await page.goto('data:text/html,<canvas id=c></canvas>');
const stats = await page.evaluate(async (b) => {
  const blob = await (await fetch(b)).blob();
  const bmp = await createImageBitmap(blob);
  const im = bmp;
  // Crop to the dish only — the UI panels around it would skew the numbers.
  // The dish occupies roughly the left-centre of the reference frame, so take
  // a centred square sized to fit entirely within the image.
  const S = 700;
  const side = Math.min(im.width, im.height);
  const ox = Math.round((im.width - side) * 0.30);
  const oy = Math.round((im.height - side) * 0.02);
  const span = Math.min(S, side);
  const c = document.createElement('canvas');
  c.width = span; c.height = span;
  const g = c.getContext('2d');
  g.drawImage(im, ox, oy, span, span, 0, 0, span, span);
  const d = g.getImageData(0, 0, span, span).data;
  let sumSat = 0, n = 0, maxSat = 0, sumLum = 0, minLum = 9, maxLum = -9;
  const hist = [0, 0, 0, 0, 0];
  let satSumWeighted = 0, satSq = 0;
  for (let i = 0; i < d.length; i += 4) {
    // Only skip genuinely transparent pixels. The reference is an opaque RGB
    // PNG, and requiring alpha 255 rejected every pixel of it.
    if (d.length % 4 === 0 && d[i + 3] === 0) continue;
    const r = d[i] / 255, gg = d[i + 1] / 255, bb = d[i + 2] / 255;
    const mx = Math.max(r, gg, bb), mn = Math.min(r, gg, bb);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    const lum = 0.299 * r + 0.587 * gg + 0.114 * bb;
    sumSat += sat; satSq += sat * sat; n++;
    sumLum += lum;
    if (sat > maxSat) maxSat = sat;
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
    hist[Math.min(4, Math.floor(sat * 5))]++;
  }
  const mean = sumSat / n;
  return {
    meanSaturation: +mean.toFixed(3),
    saturationStdDev: +Math.sqrt(satSq / n - mean * mean).toFixed(3),
    maxSaturation: +maxSat.toFixed(3),
    meanLuminance: +(sumLum / n).toFixed(3),
    lumRange: [+minLum.toFixed(3), +maxLum.toFixed(3)],
    saturationHistogram: hist.map((h) => +(h / n).toFixed(3)),
  };
}, dataUrl);

console.log('REFERENCE (dish crop only):');
console.log(JSON.stringify(stats, null, 2));
await page.screenshot({ path: OUT + '\\ref-measured.png', clip: { x: 0, y: 0, width: 760, height: 760 } }).catch(() => {});
await browser.close();