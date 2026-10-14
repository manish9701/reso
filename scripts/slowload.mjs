/**
 * Slow-network proof: throttle the mp3 to ~1 MB/s (the file is 2.3 MB), click
 * Zen ONCE, and require: canplay fires BEFORE play, and the session ends up
 * audible with no second click.
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

await page.evaluateOnNewDocument(() => {
  window.__order = [];
  for (const ev of ['canplay', 'loadeddata', 'playing']) {
    document.addEventListener(ev, () => window.__order.push(ev), true);
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    window.__order.push('play');
    return play.apply(this, a);
  };
});

await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(1500);

// throttle everything after boot
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency: 250, downloadThroughput: 900 * 1024, uploadThroughput: 900 * 1024,
});

await page.click('[title^="Tone plays real sound"]');
await sleep(200);
const t0 = Date.now();
const zen = await page.$('.src');
await zen.click();

let out = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const s = await page.evaluate(() => ({
    order: window.__order,
    readyState: document.querySelector('audio')?.readyState,
    paused: document.querySelector('audio')?.paused,
    lvl: window.__audioProbe?.level ?? 0,
    banner: document.querySelector('.ink-error')?.textContent ?? null,
  }));
  if (s.paused === false && s.lvl > 0.02) { out = s; break; }
}
const s = out ?? await page.evaluate(() => ({
  order: window.__order,
  readyState: document.querySelector('audio')?.readyState,
  paused: document.querySelector('audio')?.paused,
  lvl: window.__audioProbe?.level ?? 0,
  banner: document.querySelector('.ink-error')?.textContent ?? null,
}));
const canplay = s.order.indexOf('canplay');
const play = s.order.indexOf('play');
console.log(JSON.stringify({
  waitedMs: Date.now() - t0,
  order: s.order,
  canplayBeforePlay: canplay !== -1 && play !== -1 && canplay < play,
  firstClickAudible: s.paused === false && s.lvl > 0.02,
  level: +(s.lvl ?? 0).toFixed(3),
  banner: s.banner,
}, null, 1));
await browser.close();