/**
 * Zen-only first-click fix check: the media tap must be created BEFORE the
 * first play() ever happens (so the opening stream can't slip past it).
 * Also: the first click must actually play, no pause+play needed.
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

// order log across the whole session
await page.evaluateOnNewDocument(() => {
  window.__order = [];
  const cmes = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (el) {
    window.__order.push('createMediaElementSource');
    return cmes.call(this, el);
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    window.__order.push('play');
    return play.apply(this, a);
  };
});

await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);
const beforeClick = await page.evaluate(() => window.__order.slice());

// the FIRST click on Zen
await page.click('[title^="Tone plays real sound"]');
await sleep(300);
const zen = await page.$('.src');
await zen.click();
await sleep(2500);

const after = await page.evaluate(() => ({
  order: window.__order,
  probe: window.__audioProbe ? { kind: window.__audioProbe.kind, level: +window.__audioProbe.level.toFixed(3) } : null,
  paused: document.querySelector('audio')?.paused,
  banner: document.querySelector('.ink-error')?.textContent ?? null,
}));
const tapIdx = after.order.indexOf('createMediaElementSource');
const firstPlay = after.order.indexOf('play');
console.log(JSON.stringify({
  orderBeforeClick: beforeClick,
  orderAfterClick: after.order,
  tapBeforeFirstPlay: tapIdx !== -1 && tapIdx < firstPlay,
  firstClickPlays: after.paused === false && (after.probe?.level ?? 0) > 0.02,
  probe: after.probe,
  banner: after.banner,
}, null, 1));
await browser.close();
