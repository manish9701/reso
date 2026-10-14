/**
 * Long-session test — does a running session stay alive for minutes, in every
 * phase a user actually goes through?
 *
 * A session is ended ONLY by the user (pause, source switch, leaving tone
 * mode). Nothing may end it by itself. The phases:
 *
 *   1. preset source, visible, 35 s               (control)
 *   2. generated piece, visible, 30 s             (the synth's scheduler)
 *   3. tab THROWN TO THE BACKGROUND for 25 s      (rAF frozen: the scheduler
 *      must keep being topped by the keep-alive interval, and on return the
 *      resync in pump() must NOT replay the elapsed time as an oscillator
 *      backlog storm)
 *   4. back in front, 30 s                        (session continues)
 *
 * Oscillator creation is counted per phase: the piece legitimately creates
 * ~2-4/s; a backlog storm would create the whole hidden duration at once.
 *
 *   node scripts/session.mjs [url]
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
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(3000);

await page.evaluate(() => {
  [...document.querySelectorAll('.seg-btn')].find((b) => /tone/i.test(b.textContent || ''))?.click();
});
await sleep(400);
await page.click('.src');
await sleep(4000);

const probe = () => page.evaluate(() => ({
  kind: window.__audioProbe?.kind ?? null,
  level: window.__audioProbe ? +window.__audioProbe.level.toFixed(3) : null,
  osc: window.__osc ?? 0,
  hidden: document.hidden,
  detail: JSON.stringify({
    el: (() => {
      const a = document.querySelector('audio');
      return a ? { paused: a.paused, ended: a.ended, t: +a.currentTime.toFixed(1), src: (a.currentSrc || 'none').split('/').pop(), err: a.error?.code ?? null, loop: a.loop, net: a.networkState, ready: a.readyState } : null;
    })(),
    banner: document.querySelector('.ink-error')?.textContent ?? null,
    play: document.querySelector('.play')?.textContent?.trim() ?? null,
    pressed: document.querySelector('.play')?.getAttribute('aria-pressed') ?? null,
    srcOn: document.querySelector('.src.on')?.textContent?.trim() ?? null,
    probe: window.__audioProbe ? { kind: window.__audioProbe.kind, level: +window.__audioProbe.level.toFixed(3) } : null,
  }),
}));

// What "the session is alive" means per phase. The rAF probe (window.__audioProbe)
// is written from the render loop, so a throttled headless tab freezes it — the
// harness must NOT read that as death. The signals that cannot lie:
//   - the element's own clock advancing (preset/file phases — it runs even while
//     the tab is hidden, because element playback is not rAF-bound),
//   - oscillator creations continuing (synth phases — the keep-alive interval
//     schedules even while rAF is frozen),
//   - no error banner, React still pressed-in.
let lastOsc = 0, lastElT = null;
const classify = (s) => {
  let banner = null;
  try { banner = JSON.parse(s.detail).banner; } catch { /* malformed banner state */ }
  if (banner) return 'DEAD';
  const oscFlowing = s.osc > lastOsc;
  const elT = (() => { try { return JSON.parse(s.detail).el?.t ?? null; } catch { return null; } })();
  const elFlowing = elT !== null && (lastElT === null || elT > lastElT);
  lastOsc = s.osc;
  lastElT = elT;
  return oscFlowing || elFlowing ? (s.hidden ? 'HIDDEN-ALIVE' : 'alive') : 'STALLED';
};
const bg = async () => {
  try {
    await page2.bringToFront();
    return true;
  } catch { return false; }
};

console.log('=== phase 1: preset, visible, 35 s ===');
let dead = 0, frozen = 0;
for (let i = 0; i < 7; i++) {
  await sleep(5000);
  const s = await probe();
  const verdict = classify(s);
  if (verdict === 'DEAD') dead++;
  else if (verdict === 'STALLED') dead++;
  else if (verdict === 'HIDDEN-ALIVE') frozen++;
  console.log(`${(i + 1) * 5}s  kind=${s.kind} level=${s.level} ${verdict}${verdict.startsWith('DEAD') || verdict === 'STALLED' ? ' ' + s.detail : ''}`);
}

console.log('=== phase 2: generated piece, visible, 30 s ===');
await page.evaluate(() => {
  // count every oscillator the piece schedules from here on
  window.__osc = 0;
  const OO = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function (...a) {
    window.__osc++;
    return OO.apply(this, a);
  };
  [...document.querySelectorAll('.src')].find((b) => /synth/i.test(b.textContent || ''))?.click();
});
await sleep(1000);
lastOsc = 0; lastElT = null;
const oscAt0 = (await probe()).osc;
for (let i = 0; i < 6; i++) {
  await sleep(5000);
  const s = await probe();
  const verdict = classify(s);
  if (verdict === 'DEAD' || verdict === 'STALLED') dead++;
  else if (verdict === 'HIDDEN-ALIVE') frozen++;
  console.log(`${(i + 1) * 5}s  kind=${s.kind} level=${s.level} ${verdict}${verdict === 'DEAD' || verdict === 'STALLED' ? ' ' + s.detail : ''}`);
}

console.log('=== phase 3: tab to the BACKGROUND, 25 s ===');
const page2 = await browser.newPage();
await page2.setContent('<p>other tab</p>');
const shown = await bg();
await sleep(25000);
const hidden = await page.evaluate(() => document.hidden);
console.log(`document.hidden=${hidden} (front-page switch worked: ${shown})`);
const oscHidden = (await probe()).osc;
await page.bringToFront();
await page2.close();
await sleep(500);

console.log('=== phase 4: back in front, 30 s — storm check + continuation ===');
lastOsc = (await probe()).osc; lastElT = null;
const oscBack0 = lastOsc;
let stormPeak = 0;
for (let i = 0; i < 6; i++) {
  await sleep(5000);
  const s = await probe();
  const oscPerSec = (s.osc - oscBack0) / (5 * (i + 1));
  stormPeak = Math.max(stormPeak, oscPerSec);
  const verdict = classify(s);
  if (verdict === 'DEAD' || verdict === 'STALLED') dead++;
  console.log(`+${(i + 1) * 5}s  kind=${s.kind} level=${s.level} osc/s=${oscPerSec.toFixed(1)} ${verdict}${verdict === 'DEAD' || verdict === 'STALLED' ? ' ' + s.detail : ''}`);
}
console.log(`oscillators/s created while hidden: ${((oscHidden - oscAt0) / 30).toFixed(2)} (legible rate is ~2-4/s; a backlog storm would spike)`);

const hiddenOscRate = (oscHidden - oscAt0) / 30;
const verdict = dead === 0 && errors.length === 0 && stormPeak < 25
  ? 'SESSION SURVIVED every phase and no backlog storm on return'
  : `FAIL: dead=${dead} errors=${errors.length} stormPeak=${stormPeak.toFixed(1)}/s`;
console.log('\n' + verdict + (errors.length ? ` | errors: ${errors.join(' | ')}` : ''));
await browser.close();
process.exit(verdict.startsWith('SESSION') ? 0 : 1);