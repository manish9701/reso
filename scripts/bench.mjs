/**
 * Repeatable visual + performance benchmark.
 *
 * Every measurement this project makes about its own quality comes from here,
 * so a before/after comparison is actually like-for-like: same viewport, same
 * interaction, same simulated duration, same representative pigment colours.
 *
 *   node scripts/bench.mjs [url] [label]
 *
 * Writes to the temp folder:
 *   <label>-idle.png / <label>-active.png      screenshots
 *   <label>-bench.json                        frame-time statistics
 *
 * Two scenes are measured because they stress different things:
 *   IDLE   — standing figure only. Isolates simulation + shading cost.
 *   ACTIVE — droplets falling and landing, pigment advecting, waves running.
 *            This is the scene that has to hold 60fps in real use.
 *
 * Frame times are recorded per frame rather than averaged over a window,
 * because "60 FPS" and "60 FPS with a 40ms hitch every few seconds" are
 * completely different experiences and only the per-frame distribution shows
 * which one you have.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:5173/reso/';
const LABEL = process.argv[3] ?? 'current';
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';
const W = 1600;
const H = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Representative palette — the same six hues every run, so colours are comparable. */
const PIGMENT = [
  [0.06, 0.22, 0.95], [0.62, 0.10, 0.92], [0.05, 0.72, 0.86],
  [0.95, 0.42, 0.06], [0.95, 0.12, 0.42], [0.10, 0.45, 0.90],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    // Force a real GPU path where possible; SwiftShader results are recorded
    // separately so software-rendered numbers are never confused for hardware.
    '--enable-unsafe-swiftshader',
  ],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto(URL + '?drive=4.5&level=0.85', { waitUntil: 'networkidle0' });
await sleep(3500);

/** GPU identity, so results are attributable to real hardware or to SwiftShader. */
const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { renderer: 'none' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
  };
});
console.log('GPU:', gpu.renderer || 'unknown');
const software = /swiftshader|llvmpipe|software/i.test(gpu.renderer || '');

/**
 * Per-frame timing. Records every frame interval rather than a windowed
 * average, so long frames and drift are visible rather than averaged away.
 */
async function measure(ms) {
  return page.evaluate((duration) => new Promise((resolve) => {
    const frames = [];
    let last = performance.now();
    const t0 = last;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (now - t0 < duration) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  }), ms);
}

function stats(frames) {
  if (!frames.length) return null;
  const s = [...frames].sort((a, b) => a - b);
  const sum = frames.reduce((a, b) => a + b, 0);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    frames: frames.length,
    meanMs: +(sum / frames.length).toFixed(2),
    medianMs: +pct(0.5).toFixed(2),
    p90Ms: +pct(0.9).toFixed(2),
    p99Ms: +pct(0.99).toFixed(2),
    worstMs: +s[s.length - 1].toFixed(2),
    fpsMean: +(1000 / (sum / frames.length)).toFixed(1),
    // A "long frame" is anything that blows the 60fps budget (16.7ms). More
    // than a few percent of those and motion will visibly stutter.
    over16_7: frames.filter((f) => f > 16.7).length,
    over33: frames.filter((f) => f > 33.3).length,
  };
}

// ---------------- IDLE scene ----------------
const idleFrames = await measure(5000);
await page.screenshot({ path: `${OUT}\\${LABEL}-idle.png` });
const idle = stats(idleFrames);

// ---------------- ACTIVE scene ----------------
// Drops continuously for the duration so pigment, waves, caustics and droplet
// physics are all running at once — the real workload.
await page.evaluate((cols) => {
  const e = window.__lab;
  window.__benchDrops = setInterval(() => {
    const i = Math.floor(Math.random() * 6);
    const a = Math.random() * Math.PI * 2;
    const r = 0.08 + Math.random() * 0.26;
    e.dropIn(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, cols[i % cols.length], 0.55, 0.02);
  }, 220);
}, PIGMENT);

const activeFrames = await measure(6000);
await page.screenshot({ path: `${OUT}\\${LABEL}-active.png` });
const active = stats(activeFrames);
await page.evaluate(() => clearInterval(window.__benchDrops));

const out = {
  label: LABEL,
  viewport: `${W}x${H}`,
  gpu: gpu.renderer,
  softwareRendered: software,
  idle,
  active,
};
fs.writeFileSync(`${OUT}\\${LABEL}-bench.json`, JSON.stringify(out, null, 2));

const fmt = (s) => s
  ? `mean ${String(s.meanMs).padStart(6)}ms  median ${String(s.medianMs).padStart(6)}ms  p99 ${String(s.p99Ms).padStart(6)}ms  worst ${String(s.worstMs).padStart(7)}ms  -> ${String(s.fpsMean).padStart(5)} fps  (${s.over16_7}/${s.frames} frames >16.7ms)`
  : 'no frames';
console.log('\nIDLE  :', fmt(idle));
console.log('ACTIVE:', fmt(active));
if (software) {
  console.log('\nNOTE: software rendering (SwiftShader). These numbers are a floor,');
  console.log('      not a prediction of hardware performance.');
}
console.log('written:', `${OUT}\\${LABEL}-bench.json`);

await browser.close();