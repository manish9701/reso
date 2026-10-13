/**
 * fpsprobe — headed-Chrome frame-time probe on the real GPU.
 *
 * Headless runs fall back to SwiftShader, whose numbers say nothing about a
 * real machine. This opens an actual window (briefly), measures the median /
 * mean frame time at idle and during active motion (drive + pigment pour +
 * drop), and prints the results.
 *
 *   node scripts/fpsprobe.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1620,1040'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${URL}?drive=432&level=0.85`, { waitUntil: 'networkidle0' });
await sleep(5000);

const measure = (ms = 3500) => page.evaluate((duration) => new Promise((resolve) => {
  const frames = [];
  let last = performance.now();
  const t0 = last;
  const tick = () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (now - t0 < duration) requestAnimationFrame(tick);
    else {
      const s = [...frames].sort((a, b) => a - b);
      resolve({
        fps: +(1000 / s[Math.floor(s.length / 2)]).toFixed(1),
        median: +s[Math.floor(s.length / 2)].toFixed(1),
        p95: +s[Math.floor(s.length * 0.95)].toFixed(1),
      });
    }
  };
  requestAnimationFrame(tick);
}), ms);

const idle = await measure();

// active: drive + fresh pigment + continuous drops
await page.evaluate(() => {
  const l = window.__lab;
  const pour = (cx, cy, c) => {
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; l.deposit(cx + Math.cos(a) * 0.035, cy + Math.sin(a) * 0.035, 0.035, 0.75, c); }
  };
  pour(0.36, 0.44, [0.07, 0.25, 0.95]);
  pour(0.62, 0.40, [0.65, 0.10, 0.55]);
  pour(0.48, 0.62, [0.95, 0.45, 0.18]);
  let drops = 0;
  const h = setInterval(() => {
    if (drops++ > 20) { clearInterval(h); return; }
    l.dropIn(0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.3, [0.45, 0.12, 0.85], 0.45, 0.018);
  }, 120);
});
await sleep(3000);
// Measured behaviour on Windows/ANGLE: the first combined pigment+droplet
// session stutters for roughly six seconds (driver finishing shader
// compilation), then self-recovers. Report the transient AND the settled
// rate — the settled number is the honest sustained performance.
const transient = await measure(4000);
await sleep(9000);
const active = await measure();

console.log(`idle:     ${idle.fps} FPS (median ${idle.median}ms, p95 ${idle.p95}ms)`);
console.log(`transient (first pigment session): ${transient.fps} FPS`);
console.log(`active (settled): ${active.fps} FPS (median ${active.median}ms, p95 ${active.p95}ms)`);
await browser.close();
