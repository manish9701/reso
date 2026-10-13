/**
 * itershoot — the fixed-condition comparison harness for the render overhaul.
 *
 *   node scripts/itershoot.mjs http://localhost:4173/ [outdir]
 *
 * Captures, all at one fixed viewport (1600x1000) and the same drive level:
 *   - after-idle.png        dish at 432 Hz excitation, no pigment
 *   - after-pigment.png     same drive, five-ink pour
 *   - freq-<f>.png          the SAME pigment field reorganised at six
 *                           excitation frequencies (the pattern comparison),
 *                           with the resolved mode fingerprint recorded
 *   - detail-*.png          clipped crops: rim reflections, water
 *                           transparency, contact shadow, pigment detail
 *   - comparison.md + comparison.json   the frequency table
 *   - FPS measured at idle and mid-motion (reported, not assumed)
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.argv[2] ?? 'http://localhost:4173/';
const OUT = process.argv[3] ?? 'docs/after';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FREQS = [110, 165, 262, 349, 523, 784];

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
    '--use-angle=d3d11', '--enable-gpu-compositing', '--ignore-gpu-blocklist',
  ],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200)); });

const rows = [];

// ---- idle ---------------------------------------------------------------
await page.goto(`${BASE}?drive=432&level=0.85`, { waitUntil: 'networkidle0' });
await sleep(9000);
await page.screenshot({ path: `${OUT}/after-idle.png` });
console.log('idle captured');

const fpsIdle = await page.evaluate(() => new Promise((resolve) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve(n / 2); };
  requestAnimationFrame(tick);
}));

// ---- pigment pour (matches the interaction: drops, not stamps) ----------
await page.evaluate(() => {
  const l = window.__lab;
  const pour = (cx, cy, c) => {
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; l.deposit(cx + Math.cos(a) * 0.035, cy + Math.sin(a) * 0.035, 0.035, 0.75, c); }
  };
  pour(0.36, 0.44, [0.07, 0.25, 0.95]);
  pour(0.62, 0.40, [0.65, 0.10, 0.55]);
  pour(0.48, 0.62, [0.95, 0.45, 0.18]);
  pour(0.60, 0.60, [0.45, 0.12, 0.85]);
  pour(0.40, 0.58, [0.12, 0.65, 0.85]);
});
await sleep(9000);
await page.screenshot({ path: `${OUT}/after-pigment.png` });
console.log('pigment captured');

const fpsDye = await page.evaluate(() => new Promise((resolve) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve(n / 2); };
  requestAnimationFrame(tick);
}));

// ---- the six-frequency comparison: SAME pigment, reorganised -------------
for (const f of FREQS) {
  await page.evaluate((hz) => { window.__lab.forcedDrive = { freq: hz, level: 0.85 }; }, f);
  await sleep(6000);
  const info = await page.evaluate(() => ({
    simFreq: +window.__lab.drive.freq.toFixed(2),
    modes: window.__lab.figure.slots.map((s) => `m${s.m}@kR${s.kR.toFixed(1)}`).join(', '),
  }));
  rows.push({ excitationHz: f, simFreqHz: info.simFreq, modes: info.modes, shot: `freq-${f}.png` });
  console.log(`${f} Hz -> sim ${info.simFreq} Hz | ${info.modes}`);
  await page.screenshot({ path: `${OUT}/freq-${f}.png` });
}
const uniqueFigures = new Set(rows.map((r) => r.modes)).size;

// ---- detail crops --------------------------------------------------------
const clip = (x, y, w, h) => ({ x, y, width: w, height: h });
await page.screenshot({ path: `${OUT}/detail-rim-reflections.png`, clip: clip(360, 180, 480, 340) });
await page.screenshot({ path: `${OUT}/detail-water-transparency.png`, clip: clip(620, 300, 480, 340) });
await page.screenshot({ path: `${OUT}/detail-contact-shadow.png`, clip: clip(340, 700, 560, 260) });
await page.screenshot({ path: `${OUT}/detail-pigment.png`, clip: clip(560, 260, 420, 320) });

fs.writeFileSync(`${OUT}/comparison.json`, JSON.stringify({ rows, fpsIdle, fpsDye }, null, 2));
const md = [
  '# Frequency comparison (same viewport, same drive level, same pigment field)',
  '',
  '| Excitation (UI) | Simulated drive | Resolved modes | Screenshot |',
  '|---:|---:|---|---|',
  ...rows.map((r) => `| ${r.excitationHz} Hz | ${r.simFreqHz} Hz | ${r.modes || '—'} | freq-${r.excitationHz}.png |`),
  '',
  `Distinct figure fingerprints across the six stops: **${uniqueFigures}/6**`,
  '',
  `FPS (headless, GPU flags): idle ${fpsIdle.toFixed(1)}, with dye ${fpsDye.toFixed(1)}`,
];
fs.writeFileSync(`${OUT}/comparison.md`, md.join('\n'));
console.log(md.join('\n'));
await browser.close();
