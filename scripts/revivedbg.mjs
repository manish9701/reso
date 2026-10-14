/**
 * Why didn't the revive fire? Dump the live probe while the data line is
 * zeroed, plus the internals the revive depends on.
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
page.on('console', (m) => console.log('[' + m.type() + ']', m.text().slice(0, 160)));

await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);
await page.click('[title^="Tone plays real sound"]');
await sleep(1500);

await page.evaluate(() => {
  const orig = AnalyserNode.prototype.getFloatTimeDomainData;
  AnalyserNode.prototype.getFloatTimeDomainData = function (arr) {
    orig.call(this, arr);
    for (let i = 0; i < arr.length; i++) arr[i] = 0;
  };
});

for (let i = 0; i < 14; i++) {
  await sleep(500);
  const s = await page.evaluate(() => {
    const p = window.__audioProbe;
    const a = document.querySelector('audio');
    return {
      probe: p ? { ctx: p.ctx, level: +p.level.toFixed(4), freq: +p.freq.toFixed(0) } : null,
      el: a ? { paused: a.paused, t: +a.currentTime.toFixed(2) } : null,
    };
  });
  console.log(JSON.stringify(s));
}
await browser.close();
