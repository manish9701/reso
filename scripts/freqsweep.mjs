/**
 * Frequency→figure QA: sweep the tone across the band and capture the dish
 * at each stop, so the mode map can be checked for distinct, countable
 * cymatic figures that grow in complexity with pitch.
 *
 *   node scripts/freqsweep.mjs http://localhost:5175/reso/
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.argv[2] ?? 'http://localhost:5175/reso/';
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  defaultViewport: { width: 1000, height: 760 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 400)); });

// The ?drive hook makes each stop deterministic — audio autoplay in headless is
// unreliable, and a silent tone silently invalidates the whole sweep.
// STOPS are EXCITATION frequencies (the UI slider's world); the engine maps
// them through the documented band transform (lab/resonance.ts).
await page.goto(BASE + '?drive=432&level=0.85', { waitUntil: 'networkidle0' });
await sleep(3000);

const STOPS = [110, 147, 220, 294, 415, 554, 740, 880];
for (const f of STOPS) {
  // set the drive, wait for the resonance model to settle on the new mode
  await page.evaluate((hz) => { window.__lab.forcedDrive = { freq: hz, level: 0.85 }; }, f);
  await sleep(2600);
  // fresh pigment at each stop: let it organise under this frequency's figure
  await page.evaluate(() => {
    const e = window.__lab;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.35;
      e.deposit(0.5 + Math.cos(a) * 0.21, 0.5 + Math.sin(a) * 0.21, 0.05, 0.9, [0.12, 0.3, 0.95]);
    }
    e.deposit(0.5, 0.5, 0.05, 0.8, [0.92, 0.24, 0.55]);
  });
  await sleep(3000);

  const dom = await page.evaluate(() => {
    const e = window.__lab;
    return {
      modes: e.figure.slots.map((s) => `m${s.m}(kR${s.kR.toFixed(1)},a${s.amp.toFixed(2)})`).join(' '),
    };
  });
  await page.screenshot({ path: `${OUT}\\sweep-${String(f).padStart(3, '0')}.png` });
  console.log(`${String(f).padStart(3)} Hz excitation -> ${dom.modes || '(no modes)'}`);
}
await browser.close();