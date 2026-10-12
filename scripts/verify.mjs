/**
 * Real-time visual verification for the Resonant Ink instrument.
 * Drives the running app with true gestures over real time, captures
 * console errors, frame rate and a screenshot at each stage.
 *
 *   node scripts/verify.mjs http://localhost:5173/
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:5173/';
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  defaultViewport: { width: 1536, height: 1024 },
});
const page = await browser.newPage();
const errors = [];
// THREE.WebGLProgram reports GLSL compile/link failures as console.error, not
// as a thrown exception, and the symptom is a silently flat, untextured
// surface — indistinguishable from a physics bug. They must be fatal here.
page.on('console', (m) => {
  const t = m.type();
  const text = m.text();
  // THREE.WebGLProgram reports GLSL compile/link failures as console.error, not
  // as a thrown exception, and the symptom is a silently flat, untextured
  // surface — indistinguishable from a physics bug. They must be fatal here.
  // Only genuine failures count: the driver also emits benign precision
  // warnings (e.g. X4122) through the same channel, and failing the run on
  // those would train everyone to ignore this guard.
  const isShaderFailure =
    /Shader Error|VALIDATE_STATUS false|not compiled/i.test(text) ||
    /(^|\n)\s*ERROR:\s*\d+:\d+/.test(text);
  if (isShaderFailure) {
    errors.push('SHADER: ' + text.slice(0, 900));
    console.log('[SHADER ERROR]', text.slice(0, 900));
    return;
  }
  if (t === 'error' || t === 'warning') console.log(`[${t}]`, text.slice(0, 300));
});
page.on('pageerror', (e) => { errors.push(String(e)); console.log('[pageerror]', String(e).slice(0, 300)); });

// Use the deterministic drive hook: headless audio autoplay is unreliable, and
// a tone that silently never starts makes every later assertion meaningless.
await page.goto(URL + '?drive=420&level=0.85', { waitUntil: 'networkidle0' });
await sleep(4000);

// prove the water is actually on screen and actually being driven
const health = await page.evaluate(() => {
  const e = window.__lab;
  const r = e.studio.renderer;
  const S = 512;
  const buf = new Uint16Array(S * S * 4);
  r.readRenderTargetPixels(e.fieldTarget, 0, 0, S, S, buf);
  const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1; const ex = (h >> 10) & 0x1f, m = h & 0x3ff; if (ex === 0) return s * m * 5.96e-8; if (ex === 31) return m ? NaN : s * Infinity; return s * (1 + m / 1024) * Math.pow(2, ex - 15); };
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < S * S; i++) { const v = h2f(buf[i * 4]); if (Number.isNaN(v)) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
  return {
    fieldRange: +(mx - mn).toFixed(3),
    modes: e.figure.slots.map((s) => `m${s.m}`).join(','),
    liquidVisible: e.liquid.visible && e.liquid.material.visible,
    liquidTris: e.liquid.geometry.index.count / 3,
  };
});
console.log('health:', JSON.stringify(health));
if (health.fieldRange < 0.05) errors.push('SIM: height field is flat — no figure is being produced');
if (!health.modes) errors.push('SIM: no active modes — drive level is zero');
if (!health.liquidVisible) errors.push('RENDER: liquid is not visible');
await page.screenshot({ path: OUT + '\\rt-1-idle.png' });

// frame rate probe (headless runs on SwiftShader — expect low numbers there)
const fps = await page.evaluate(() => new Promise((resolve) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve(n / 2); };
  requestAnimationFrame(tick);
}));
console.log('FPS:', fps.toFixed(1));

await sleep(6000);
await page.screenshot({ path: OUT + '\\rt-2-tone.png' });

// pour pigment across the dish and let the figure organise it
await page.evaluate(() => {
  const e = window.__lab;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.35;
    e.deposit(0.5 + Math.cos(a) * 0.21, 0.5 + Math.sin(a) * 0.21, 0.05, 0.9, [0.12, 0.3, 0.95]);
  }
  e.deposit(0.5, 0.5, 0.05, 0.8, [0.92, 0.24, 0.55]);
});
await sleep(6000);
await page.screenshot({ path: OUT + '\\rt-3-pigment.png' });

// sweep frequency — the figure must reorganise, with cell count rising
for (const hz of [180, 560, 900]) {
  await page.evaluate((f) => { window.__lab.forcedDrive = { freq: f, level: 0.85 }; }, hz);
  await sleep(3000);
  const m = await page.evaluate(() => window.__lab.figure.slots.map((s) => `m${s.m}@${s.kR.toFixed(1)}`).join(','));
  console.log(`${hz} Hz -> ${m}`);
  await page.screenshot({ path: `${OUT}\\rt-4-swept-${hz}.png` });
}

console.log('ERRORS:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
