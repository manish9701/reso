/**
 * Measure the combined field and the SHADING SLOPE the liquid shader derives
 * from it, so the relief gain can be set from numbers instead of by eye.
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5199/reso/';
const HZ = (process.argv[3] ?? '432,790').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 900, height: 640 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(`${URL}?drive=432&level=0.85`, { waitUntil: 'networkidle0' });
await sleep(3000);

for (const hz of HZ) {
  await page.evaluate((f) => { window.__lab.forcedDrive = { freq: f, level: 0.85 }; }, hz);
  await sleep(2500);
  const m = await page.evaluate(() => {
    const e = window.__lab;
    const S = 512;
    // HalfFloatType targets must be read as Uint16 and decoded by hand —
    // reading into a Float32Array silently returns all zeros here (the same
    // trap documented in LabEngine.dyeStats).
    const raw = new Uint16Array(S * S * 4);
    e.studio.renderer.readRenderTargetPixels(e.fieldTarget, 0, 0, S, S, raw);
    const f16 = (w) => {
      const s = (w & 0x8000) ? -1 : 1;
      const ex = (w >> 10) & 0x1f, mn = w & 0x3ff;
      if (ex === 0) return s * mn * 5.9604644775390625e-8;
      if (ex === 31) return mn ? NaN : s * Infinity;
      return s * (1 + mn / 1024) * Math.pow(2, ex - 15);
    };
    const h = (i) => f16(raw[i * 4]);
    const at = (x, y) => h(((y % S) + S) % S * S + (((x % S) + S) % S));

    const texel = 1 / S;
    const e2 = texel * 2;
    const grads = [];
    const slopes = [];
    const divs = [];
    let hmin = Infinity, hmax = -Infinity;
    for (let y = 4; y < S - 4; y += 2) {
      for (let x = 4; x < S - 4; x += 2) {
        const uu = x / S, vv = y / S;
        if (Math.hypot(uu - 0.5, vv - 0.5) * 2 > 0.95) continue;
        const hL = (at(x - 4, y) + at(x - 2, y)) * 0.5;
        const hR = (at(x + 4, y) + at(x + 2, y)) * 0.5;
        const hD = (at(x, y - 4) + at(x, y - 2)) * 0.5;
        const hU = (at(x, y + 4) + at(x, y + 2)) * 0.5;
        const gx = (hR - hL) * 0.5 / e2;
        const gy = (hU - hD) * 0.5 / e2;
        const g = Math.hypot(gx, gy);
        grads.push(g);
        const lu = window.__lab.liquidUniforms;
        slopes.push(g * lu.uAmp.value * lu.uNormalGain.value / (2 * lu.uR.value));
        // caustic probe: div over the 3/6-texel stencil, then lapn = div/ce^2
        const hC = (at(x, y) + at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1)) * 0.2;
        const H = (px, py) => 0.5 * (at(x + px * 6, y) + at(x + px * 3, y));
        const V = (px, py) => 0.5 * (at(x, y + py * 6) + at(x, y + py * 3));
        const div = H(-1, 0) + H(1, 0) + V(0, -1) + V(0, 1) - 4 * hC;
        divs.push(Math.abs(div));
        const val = h((y) * S + x);
        if (val < hmin) hmin = val;
        if (val > hmax) hmax = val;
      }
    }
    const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };
    const u = e.liquidUniforms;
    const ceil = e2 * e2; // ce.x^2
    return {
      field: [+hmin.toFixed(3), +hmax.toFixed(3)],
      gradUv: { p50: +q(grads, 0.5).toFixed(2), p90: +q(grads, 0.9).toFixed(2), p99: +q(grads, 0.99).toFixed(2), max: +q(grads, 0.999).toFixed(2) },
      slope: { p50: +q(slopes, 0.5).toFixed(3), p90: +q(slopes, 0.9).toFixed(3), p99: +q(slopes, 0.99).toFixed(3), max: +q(slopes, 0.999).toFixed(3) },
      slopeClampedPct: +(100 * slopes.filter((s) => s > 0.34).length / slopes.length).toFixed(1),
      causticL: { p50: +(q(divs, 0.5) / ceil * u.uCausticK.value).toFixed(5), p99: +(q(divs, 0.99) / ceil * u.uCausticK.value).toFixed(4) },
      uNormalGain: +u.uNormalGain.value.toFixed(2), uCausticK: u.uCausticK.value, uAmp: u.uAmp.value,
      modes: e.figure.slots.map((s) => `m${s.m}@${s.kR.toFixed(1)}`).join(' '),
    };
  });
  console.log(`${hz} Hz`, JSON.stringify(m, null, 1));
}

await browser.close();