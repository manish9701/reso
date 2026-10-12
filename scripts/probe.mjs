/**
 * Field probe: are the simulation textures actually alive?
 *   node scripts/probe.mjs http://localhost:5175/reso/
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
page.on('console', (m) => console.log('[' + m.type() + ']', m.text().slice(0, 500)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)));

await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(3000);

const probe = await page.evaluate(() => {
  const e = (window).__lab;
  if (!e) return { error: 'no engine' };
  const r = e.studio.renderer;
  const read = (rt, size, type) => {
    const n = size * size * 4;
    const buf = type === 'f16' ? new Uint16Array(n) : new Uint8Array(n);
    r.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    // half-float decode
    let min = Infinity, max = -Infinity, sum = 0, nan = 0;
    const h2f = (h) => {
      const s = (h & 0x8000) ? -1 : 1;
      const ex = (h >> 10) & 0x1f, m = h & 0x3ff;
      if (ex === 0) return s * m * 5.9604644775390625e-8;
      if (ex === 31) return m ? NaN : s * Infinity;
      return s * (1 + m / 1024) * Math.pow(2, ex - 15);
    };
    for (let i = 0; i < n; i++) {
      const v = type === 'f16' ? h2f(buf[i]) : buf[i];
      if (Number.isNaN(v)) { nan++; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, mean: sum / n, nan };
  };
  const w = e.wave;
  const f = e.figure;
  const p = e.pigment;
  return {
    figure: read(f.target, f.size, 'f16'),
    height: read(w.targets[w.idx], w.size, 'f16'),
    dye: read(p.targets[p.idx], p.size, 'u8'),
    slots: e.resonance?.lastSlots ?? null,
    drive: { ...e.drive },
    liquidUniforms: {
      uField: !!e.liquidUniforms.uField.value,
      uDye: !!e.liquidUniforms.uDye.value,
    },
    liquidVisible: e.liquid.visible,
    liquidPos: e.liquid.position.toArray(),
    liquidRadius: e.liquid.geometry.boundingSphere?.radius,
    pick: e.studio.pickLiquid(0.5, 0.5),
    toDisc05: e.toDisc?.(0.5, 0.5) ?? 'private',
  };
});
console.log(JSON.stringify(probe, null, 2));

// deposit directly in liquid space and re-probe
await page.evaluate(() => {
  const e = (window).__lab;
  e.deposit(0.5, 0.5, 0.08, 1.0, [0.08, 0.28, 0.9]);
  e.strike(0.5, 0.5, 1.0);
});
await sleep(2500);
const after = await page.evaluate(() => {
  const e = (window).__lab;
  const r = e.studio.renderer;
  const p = e.pigment;
  const buf = new Uint8Array(p.size * p.size * 4);
  r.readRenderTargetPixels(p.targets[p.idx], 0, 0, p.size, p.size, buf);
  let cells = 0, alpha = 0;
  for (let i = 0; i < p.size * p.size; i++) { const a = buf[i * 4 + 3]; if (a > 8) { cells++; alpha += a; } }
  const w = e.wave;
  const hbuf = new Uint16Array(w.size * w.size * 4);
  r.readRenderTargetPixels(w.targets[w.idx], 0, 0, w.size, w.size, hbuf);
  const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1; const ex = (h >> 10) & 0x1f, m = h & 0x3ff; if (ex === 0) return s * m * 5.9604644775390625e-8; if (ex === 31) return m ? NaN : s * Infinity; return s * (1 + m / 1024) * Math.pow(2, ex - 15); };
  let hmin = Infinity, hmax = -Infinity;
  for (let i = 0; i < w.size * w.size; i++) { const v = h2f(hbuf[i * 4]); if (v < hmin) hmin = v; if (v > hmax) hmax = v; }
  return { dyeCells: cells, dyeAlpha: alpha, hmin, hmax };
});
console.log('after deposit:', JSON.stringify(after));

await page.screenshot({ path: OUT + '\\probe-1.png' });
await browser.close();
