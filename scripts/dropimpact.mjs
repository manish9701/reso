/**
 * Catch a droplet at each stage of its impact, to confirm no solid disc is
 * ever left lying on the water.
 *
 *   node scripts/dropimpact.mjs [url]
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
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(URL + '?drive=4.5&level=0.85', { waitUntil: 'networkidle0' });
await sleep(3000);

// Report the live instance scale of the drop we are about to release, sampled
// across its whole life. A solid disc shows up as a large horizontal scale
// while the drop is still opaque.
await page.evaluate(() => {
  window.__trace = [];
  const e = window.__lab;
  e.dropIn(0.5, 0.5, [0.9, 0.12, 0.35], 0.55, 0.02);
  const tick = () => {
    const ds = e.droplets;
    const d = ds.drops.find((k) => k.live);
    if (d) {
      const m = ds.dummy.matrix.clone();
      ds.mesh.getMatrixAt(0, m);
      // read scale straight out of the matrix basis vectors - no THREE needed
      const sx = Math.hypot(m.elements[0], m.elements[1], m.elements[2]);
      const sy = Math.hypot(m.elements[4], m.elements[5], m.elements[6]);
      const s = { x: sx, y: sy };
      window.__trace.push({ phase: d.phase, sx: +s.x.toFixed(4), sy: +s.y.toFixed(4) });
    }
    window.__raf = requestAnimationFrame(tick);
  };
  tick();
});

await sleep(1400);
const trace = await page.evaluate(() => {
  cancelAnimationFrame(window.__raf);
  return window.__trace;
});
await page.screenshot({ path: OUT + '\\drop-impact.png' });

// The widest horizontal scale reached after contact is the disc risk.
const after = trace.filter((t) => t.phase !== 'fall');
const widest = after.reduce((m, t) => Math.max(m, t.sx), 0);
const tallestAfter = after.reduce((m, t) => Math.max(m, t.sy), 0);
const falling = trace.filter((t) => t.phase === 'fall');
const widestFall = falling.reduce((m, t) => Math.max(m, t.sx), 0);

console.log(`frames sampled: ${trace.length}`);
console.log(`widest scale while FALLING: ${widestFall.toFixed(4)}`);
console.log(`widest scale AFTER contact: ${widest.toFixed(4)}`);
console.log(`thickest scale AFTER contact: ${tallestAfter.toFixed(4)}`);
const verdict = widest <= widestFall * 1.45;
console.log(verdict
  ? 'PASS - the drop never widens far beyond its falling size, so no disc is left'
  : `FAIL - the drop expands to ${(widest / widestFall).toFixed(2)}x its falling width on impact`);

await browser.close();
process.exit(verdict ? 0 : 1);