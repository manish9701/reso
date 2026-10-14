/**
 * Who is calling play()/pause()? Trace every call on the media element with
 * a stack, around one pause click from the PLAYING state.
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
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)));
await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);

await page.evaluate(() => {
  const trace = (name) => {
    const st = new Error().stack ?? '';
    const lines = st.split('\n').filter((l) => !/pptp|audit|AudioInput\.bindMedia|participant/.test(l));
    return `${new Error().stack.includes(name) ? '' : ''}[${name}] elapsed=${(performance.now() / 1000).toFixed(2)}s\n` +
      lines.slice(1, 5).map((l) => '    ' + l.trim().slice(0, 110)).join('\n');
  };
  window.__flog = [];
  const origPlay = HTMLMediaElement.prototype.play;
  const origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.play = function (...args) {
    window.__flog.push(trace('play'));
    return origPlay.apply(this, args).catch?.((e) => { window.__flog.push('[play REJECTED] ' + (e?.name ?? e)); throw e; });
  };
  HTMLMediaElement.prototype.pause = function () {
    window.__flog.push(trace('pause'));
    return origPause.apply(this);
  };
});
await page.click('[title^="Tone plays real sound"]');
await sleep(2500);

await page.$eval('.play', () => {});
const el = await page.$('.play');
const box = await el.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await sleep(1200);
console.log('=== trace from first play-click ===');
console.log((await page.evaluate(() => window.__flog.join('\n'))) ?? '(empty)');

const el2 = await page.$('.play');
const box2 = await el2.boundingBox();
await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2); // pause from playing
await sleep(1500);
console.log('=== trace after pause-click ===');
console.log((await page.evaluate(() => window.__flog.join('\n'))) ?? '(empty)');
console.log('state:', JSON.stringify(await page.evaluate(() => ({
  paused: document.querySelector('audio')?.paused,
  label: document.querySelector('.play')?.textContent?.trim(),
  probe: window.__audioProbe ? +window.__audioProbe.level.toFixed(3) : null,
}))));
await browser.close();
