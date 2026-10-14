/**
 * Prove the FIRST-PLAY REVIVE path deterministically:
 * stub the analyser's data line to zeros (the exact reading a frozen media
 * pipeline produces while the engine reports 'running' and the element runs).
 * The app must re-clock the element on its own (one warn, position kept).
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
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 250)));
page.on('console', (m) => { if (/re-clock/.test(m.text())) console.log('[app]', m.text()); });

await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);
await page.click('[title^="Tone plays real sound"]');
await sleep(1500);

// the dead line: every analyser read comes back zero from now on
await page.evaluate(() => {
  const orig = AnalyserNode.prototype.getFloatTimeDomainData;
  AnalyserNode.prototype.getFloatTimeDomainData = function (arr) {
    orig.call(this, arr);
    for (let i = 0; i < arr.length; i++) arr[i] = 0;
  };
});

const t0 = +await page.evaluate(() => document.querySelector('audio').currentTime);
console.log('dead line planted at element t=' + t0);
let sawWarn = false;
const deadline = Date.now() + 9000;
while (Date.now() < deadline) {
  await sleep(400);
  const warn = await page.evaluate(() => (window.__revived ?? false));
  if (warn) { sawWarn = true; break; }
  // window.__revived is not set by the app; rely on console instead
}
const fin = await page.evaluate(() => {
  const a = document.querySelector('audio');
  return { revived: window.__revived === true, paused: a?.paused, t: a ? +a.currentTime.toFixed(2) : 0 };
});
console.log('after revive window:', JSON.stringify(fin), '| position kept:', fin.t >= t0 ? 'yes' : 'NO');
console.log(fin.revived ? 'REVIVE FIRED' : 'NO REVIVE (dead line never re-clocked)');
await browser.close();
