/**
 * Reproduce the driven-state corruption: turn the tone on with a real click,
 * let it run, then dump the drive chain and screenshot.
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const WAIT = Number(process.argv[3] ?? 12000);
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
    '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(3000);

const dump = () => page.evaluate(() => {
  const e = window.__lab;
  const S = 512;
  const raw = new Uint16Array(S * S * 4);
  e.studio.renderer.readRenderTargetPixels(e.fieldTarget, 0, 0, S, S, raw);
  const f16 = (w) => {
    const s = (w & 0x8000) ? -1 : 1;
    const ex = (w >> 10) & 0x1f, mn = w & 0x3ff;
    if (ex === 0) return s * mn * 5.96e-8;
    if (ex === 31) return mn ? NaN : s * Infinity;
    return s * (1 + mn / 1024) * Math.pow(2, ex - 15);
  };
  let nan = 0, inf = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < S * S; i++) {
    const v = f16(raw[i * 4]);
    if (Number.isNaN(v)) { nan++; continue; }
    if (!Number.isFinite(v)) { inf++; continue; }
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const ai = window.__audioProbe;
  return {
    driveFreq: +e.drive.freq.toFixed(4),
    driveLevel: +e.drive.level.toFixed(4),
    driveTarget: +e.driveTarget.toFixed(4),
    audioFrame: ai ? { freq: +ai.freq.toFixed(2), level: +ai.level.toFixed(4), kind: ai.kind } : 'no probe',
    slots: e.figure.slots.map((s) => `m${s.m}@${s.kR.toFixed(2)}:${s.amp.toFixed(3)}`),
    field: { nan, inf, min: +mn.toFixed(4), max: +mx.toFixed(4) },
    uNormalGain: +e.liquidUniforms.uNormalGain.value.toFixed(2),
  };
});

console.log('--- before play ---');
console.log(JSON.stringify(await dump()));

// switch to Tone mode, then start the audible piece
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.seg-btn')].find((b) => /tone/i.test(b.textContent || ''));
  btn?.click();
});
await sleep(500);
await page.click('.play-btn');
await sleep(WAIT);

console.log('--- after play ---');
console.log(JSON.stringify(await dump(), null, 1));
await page.screenshot({ path: OUT + '\\repro-tone-on.png' });

// now pour magenta ink, which is what the report shows
await page.evaluate(() => {
  const e = window.__lab;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    e.deposit(0.5 + Math.cos(a) * 0.18, 0.5 + Math.sin(a) * 0.18, 0.06, 0.95, [0.95, 0.2, 0.55]);
  }
});
await sleep(WAIT);
console.log('--- after pour (tone still on) ---');
console.log(JSON.stringify(await dump(), null, 1));
await page.screenshot({ path: OUT + '\\repro-tone-pour.png' });

// Dump the dye FIELD itself. If the speckle is here it is the advection pass;
// if it is smooth, the bug is in the water shader's use of it.
const dyeStat = await page.evaluate(() => {
  const e = window.__lab;
  const p = e.pigment;
  const n = p.size;
  const raw = new Uint16Array(n * n * 4);
  e.studio.renderer.readRenderTargetPixels(p.targets[p.idx], 0, 0, n, n, raw);
  const f16 = (w) => {
    const s = (w & 0x8000) ? -1 : 1;
    const ex = (w >> 10) & 0x1f, mn = w & 0x3ff;
    if (ex === 0) return s * mn * 5.96e-8;
    if (ex === 31) return mn ? NaN : s * Infinity;
    return s * (1 + mn / 1024) * Math.pow(2, ex - 15);
  };
  const at = (x, y) => f16(raw[((((y % n) + n) % n) * n + (((x % n) + n) % n)) * 4 + 3]);
  let hf = 0, cnt = 0, mx = 0;
  for (let y = 2; y < n - 2; y += 2) {
    for (let x = 2; x < n - 2; x += 2) {
      if (Math.hypot(x / n - 0.5, y / n - 0.5) * 2 > 0.9) continue;
      const a = at(x, y);
      hf += Math.abs(a - at(x + 1, y)); cnt++;
      if (a > mx) mx = a;
    }
  }
  return { size: n, meanTexelDelta: +(hf / cnt).toFixed(5), maxMass: +mx.toFixed(3) };
});
console.log('DYE FIELD', JSON.stringify(dyeStat));

await page.evaluate(() => { window.__lab.liquidUniforms.uDebug.value = 1; });
await sleep(700);
await page.screenshot({ path: OUT + '\\repro-dye-field.png' });

await browser.close();