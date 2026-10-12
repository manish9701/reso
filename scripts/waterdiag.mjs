/** Diagnose why the water shows no figure/ink under tone. */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:5175/reso/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1000, height: 800 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(URL + '?drive=4.5&level=0.9', { waitUntil: 'networkidle0' });
await sleep(2000);
await sleep(4000);
await page.evaluate(() => {
  window.__lab.deposit(0.5, 0.5, 0.09, 1.0, [0.15, 0.35, 0.95]);
});
await sleep(1500);

const out = await page.evaluate(() => {
  const e = window.__lab;
  const r = e.studio.renderer;
  const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1; const ex = (h >> 10) & 0x1f, m = h & 0x3ff; if (ex === 0) return s * m * 5.96e-8; if (ex === 31) return m ? NaN : s * Infinity; return s * (1 + m / 1024) * Math.pow(2, ex - 15); };
  const stat = (rt, size, ch) => {
    const buf = new Uint16Array(size * size * 4);
    r.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    let min = Infinity, max = -Infinity, sum = 0;
    for (let i = 0; i < size * size; i++) { const v = h2f(buf[i * 4 + ch]); if (Number.isNaN(v)) continue; if (v < min) min = v; if (v > max) max = v; sum += v; }
    return { min: +min.toFixed(3), max: +max.toFixed(3), mean: +(sum / (size * size)).toFixed(4) };
  };
  const u = e.liquidUniforms;
  // figure module slots
  const figSlots = e.figure.slots ? e.figure.slots.map((s) => `m${s.m}/kR${s.kR.toFixed(1)}/a${s.amp.toFixed(2)}`) : null;
  return {
    drive: { ...e.drive },
    figureR: stat(e.figure.target, e.figure.size, 0),
    fieldR: stat(e.fieldTarget, 512, 0),
    dyeMass: stat(e.pigment.targets[e.pigment.idx], e.pigment.size, 3),
    figSlots,
    uniforms: {
      uAmp: u.uAmp.value, uNormalGain: u.uNormalGain.value,
      uInkDensity: u.uInkDensity.value.toArray(),
      env: e.studio.scene.environmentIntensity,
    },
    matParams: (() => { const m = e.liquid.material; return { rough: m.roughness, env: m.envMapIntensity, spec: m.specularIntensity }; })(),
  };
});
console.log(JSON.stringify(out, null, 2));
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';
await page.screenshot({ path: OUT + '\\diag-normal.png' });
await page.evaluate(() => { window.__lab.liquidUniforms.uDebug.value = 3; });
await sleep(600);
await page.screenshot({ path: OUT + '\\diag-height.png' });
await page.evaluate(() => { window.__lab.liquidUniforms.uDebug.value = 1; });
await sleep(600);
await page.screenshot({ path: OUT + '\\diag-dye.png' });
await browser.close();