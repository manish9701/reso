/**
 * PLAY-OR-NOT reliability: the contract is binary â€” every start plays, every
 * pause pauses, every resume resumes, and repeated/flying clicks can never
 * leave a session half-alive or silently stopped.
 *
 *   node scripts/relaycheck.mjs <url>
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|three/i.test(m.text())) errors.push('console: ' + m.text().slice(0, 150)); });

await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(2500);

const state = () => page.evaluate(() => {
  const a = document.querySelector('audio');
  const p = window.__audioProbe;
  return {
    kind: p?.kind ?? null,
    live: p && p.level > 0.02,
    paused: a?.paused,
    banner: document.querySelector('.ink-error')?.textContent ?? null,
    btn: document.querySelector('.play')?.textContent?.trim(),
  };
});

// Flying clicks: a same-tick re-render can detach a button mid-click, so
// every click is retried against the live DOM instead of hard-failing.
const click = async (sel) => {
  for (let i = 0; i < 5; i++) {
    try { const el = await page.$(sel); if (el) { await el.click(); return; } } catch { /* detached â€” retry */ }
    await sleep(120);
  }
  throw new Error('click target vanished: ' + sel);
};

// 10 play/pause cycles — every one must end in the state the button said.
//
// Probe semantics (Cymatics.tsx): the analyser probe is CLEARED while the
// session is paused and repopulated while playing, so "playing" is verified
// by a live probe, "paused" by the element + button — never mixed.
// Tone is MANUAL: entering it must start nothing — idle element, no probe.
await click('[title^="Tone plays real sound"]');
await sleep(1500);
const idle = await state();
if (!(idle.kind === null && idle.paused === true && idle.btn === 'Play')) {
  errors.push(`tone entry is not silent/idle: ${JSON.stringify(idle)}`);
}
// The FIRST press of Play starts the track. Every later press pauses/resumes.
await click('.play'); await sleep(1200);
const start = await state();
if (!(start.kind === 'preset' && start.live && start.btn === 'Pause')) {
  errors.push(`manual start did not play: ${JSON.stringify(start)}`);
}
await click('.play'); await sleep(500);          // park on Pause for the cycles
let failures = 0;
for (let i = 0; i < 10; i++) {
  await click('.play'); await sleep(900);
  const up = await state();
  if (!(up.kind === 'preset' && up.live && !up.paused && !up.banner)) {
    failures++; errors.push(`cycle ${i} resume FAILED: ${JSON.stringify(up)}`);
  }
  await click('.play'); await sleep(500);
  const down = await state();
  if (!(down.paused && !down.live && down.btn === 'Play')) {
    failures++; errors.push(`cycle ${i} pause FAILED: ${JSON.stringify(down)}`);
  }
}

// flying double-click on the source chip: the session must survive with the
// same kind it had, and end consistent with what the button then says.
await click('.play'); await sleep(400);
await click('.src'); await sleep(60); await click('.src'); await sleep(1500);
const afterRace = await state();
if (!(afterRace.kind === 'preset' || afterRace.paused)) errors.push('double-click race broke the session: ' + JSON.stringify(afterRace));
if (afterRace.banner) errors.push('banner after race: ' + afterRace.banner);

// two fresh full mode round-trips: freq stops the session, tone is idle, and
// pressing Play there starts it again — manual every time.
for (let i = 0; i < 2; i++) {
  await page.evaluate(() => { [...document.querySelectorAll('.seg-btn')].find((b) => /freq/i.test(b.textContent || '')).click(); });
  await sleep(400);
  await page.evaluate(() => { [...document.querySelectorAll('.seg-btn')].find((b) => /tone/i.test(b.textContent || ''))?.click(); });
  await sleep(1200);
  const idle2 = await state();
  if (!(idle2.kind === null && idle2.btn === 'Play')) {
    failures++;
    errors.push(`round-trip ${i} did not land idle: ${JSON.stringify(idle2)}`);
  }
  await click('.play'); await sleep(1500);
  const s = await state();
  if (!(s.kind === 'preset' && !s.paused)) {
    failures++;
    errors.push(`round-trip ${i}: ${JSON.stringify(s)}`);
  }
}

console.log(JSON.stringify({ cycleFailures: failures, finalRace: afterRace, errors }, null, 1));
await browser.close();
if (failures > 0 || errors.length) process.exit(1);

