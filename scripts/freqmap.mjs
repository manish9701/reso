/**
 * Map the WHOLE frequency slider against the modal response.
 *
 * Six sample points hid the real bug: the low end of the slider was dead, so
 * 110 Hz and 165 Hz produced the same figure. This walks the slider in fine
 * steps and reports the dominant mode and how many modes answer, which is what
 * "does it change with the frequency" actually means.
 *
 *   node scripts/freqmap.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(2500);

// One real frame gives the engine's own UI Hz -> simulated Hz mapping. After
// that the modal state is stepped deterministically to convergence, so what we
// read is the SETTLED response rather than however far the animation loop got
// inside a sleep — which is what made the first version of this report a lie.
const out = [];
// seed with whatever the engine is already running, so the first row has to
// wait for a real change instead of accepting the initial drive
let lastSim = await page.evaluate(() => window.__lab.drive.freq);
// Sweep the MEASURED visible band: below 224 Hz and above 836 Hz the drive
// clamps by design — that dead range is off the slider — so the map covers
// exactly what a user can reach.
for (let hz = 224; hz <= 836; hz += 20) {
  await page.evaluate((f) => { window.__lab.forcedDrive = { freq: f, level: 0.85 }; }, hz);
  // Wait for the engine to actually apply it. A fixed sleep races the render
  // loop and silently re-reads the PREVIOUS frequency, which shows up as
  // identical sim-Hz on adjacent rows — a measurement artefact that reads as a
  // dead slider. (Done as an explicit poll: puppeteer's waitForFunction takes
  // options as the second argument, and passing a value there is silently
  // ignored, so the predicate never compares anything.)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const f = await page.evaluate(() => window.__lab.drive.freq);
    if (Math.abs(f - lastSim) > 1e-9) { lastSim = f; break; }
    await sleep(25);
  }

  const row = await page.evaluate(() => {
    const e = window.__lab;
    const fSim = e.drive.freq;
    const model = e.resonance;
    model.amps.clear();
    for (let i = 0; i < 500; i++) model.update(0.05, fSim, 0.85);
    const slots = model.update(0.05, fSim, 0.85);      // returns the top slots, with k·R
    const top = slots[0]?.amp || 1;
    return {
      fSim: +fSim.toFixed(3),
      n: slots.length,
      top: slots[0] ? `m${slots[0].m}@${slots[0].kR.toFixed(1)}` : '-',
      all: slots.map((s) => `m${s.m}@${s.kR.toFixed(1)}:${(s.amp / top).toFixed(2)}`).join(' '),
    };
  });
  out.push({ hz, ...row });
}

console.log('UI Hz | sim Hz | dominant   | n | relative amplitudes');
let prev = null, repeats = 0, dead = 0;
for (const r of out) {
  const same = r.top === prev;
  if (same) repeats++;
  if (r.top === '-') dead++;
  prev = r.top;
  console.log(`${String(r.hz).padStart(5)} | ${String(r.fSim).padStart(6)} | ${r.top.padEnd(10)} | ${r.n} | ${r.all}${same ? '   <-- unchanged' : ''}`);
}
const distinct = new Set(out.map((r) => r.top)).size;
console.log(`\ndistinct dominant modes: ${distinct}/${out.length}`);
console.log(`adjacent repeats: ${repeats}/${out.length - 1}   (slider did nothing here)`);
console.log(`silent: ${dead}`);
await browser.close();
process.exit(dead > 0 || repeats > 4 ? 1 : 0);