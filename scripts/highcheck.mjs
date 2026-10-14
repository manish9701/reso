/**
 * Diagnose "not reacting to high notes".
 *
 *  A. what the tone path is live-feeding the engine (bands, scalar drive)
 *  B. whether the physics CAN light high-order modes at all (synthetic drives)
 *  C. whether the returned slots keep or throw away the high riders
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle0' });
await sleep(2500);
await page.click('[title^="Tone plays real sound"]'); // auto-starts Zen
await sleep(4000);

// A — live feed
const live = await page.evaluate(() => new Promise((resolve) => {
  const rows = [];
  const eng = window.__lab;
  const id = setInterval(() => {
    const a = window.__audioProbe;
    rows.push({
      bands: a ? a.bands.map((v) => +v.toFixed(3)) : null,
      scalarDrive: +eng.drive.freq.toFixed(2),
      spectrumLen: eng.driveSpectrum?.length ?? 0,
      dominant: eng.resonance.dominant(),
    });
    if (rows.length >= 6) { clearInterval(id); resolve(rows); }
  }, 900);
}));

// B+C — synthetic spectra straight through updateSpectrum (nothing to do with
// live audio): does a HIGH band alone produce visible slots? RESET between
// cases and run enough steps for the amplitudes to actually walk over.
const synth = await page.evaluate(() => {
  const eng = window.__lab;
  const b2s = (f) => {
    const lo = Math.log(80), hi = Math.log(3200);
    const t = Math.min(1, Math.max(0, (Math.log(f) - lo) / (hi - lo)));
    return 2.596 * Math.exp(t * Math.log(21.195 / 2.596));
  };
  const centers = [140, 500, 1800, 5500].map((f) => +b2s(f).toFixed(2));
  const run = (bands, steps) => {
    eng.resonance.reset();
    let slots = [];
    for (let i = 0; i < steps; i++) slots = eng.resonance.updateSpectrum(1 / 60, bands);
    return slots.filter((s) => true).map((s) => `m${s.m}n${s.n}:${Math.abs(s.amp).toFixed(3)}`);
  };
  return {
    centers,
    lowOnly: run([{ f: centers[0], level: 1 }], 120),
    highOnly: run([{ f: centers[2], level: 1 }, { f: centers[3], level: 1 }], 120),
    fullMix: run([{ f: centers[0], level: 1 }, { f: centers[1], level: 0.9 }, { f: centers[2], level: 0.8 }, { f: centers[3], level: 0.8 }], 120),
  };
});

console.log(JSON.stringify({ live, synth }, null, 1));
await browser.close();
