/**
 * One pause cycle under a microscope: sample state every 150 ms after the
 * pause click and detect a page reload via a planted marker.
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
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('console', (m) => console.log('[' + m.type() + ']', m.text().slice(0, 150)));
page.on('framenavigated', () => console.log('>>> NAVIGATION occurred'));

await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);
await page.click('[title^="Tone plays real sound"]');
await sleep(2500);
console.log('after tone:', JSON.stringify(await page.evaluate(() => ({
  probe: window.__audioProbe,
  paused: document.querySelector('audio')?.paused,
}))));
await page.click('.play'); // resume path
await sleep(1200);
await page.evaluate(() => { window.__marker = 42; });
await page.click('.play'); // pause
for (let i = 0; i < 12; i++) {
  await sleep(150);
  const s = await page.evaluate(() => ({
    marker: window.__marker ?? null,
    probe: window.__audioProbe ? { kind: window.__audioProbe.kind, level: +window.__audioProbe.level.toFixed(3) } : null,
    el: (() => { const a = document.querySelector('audio'); return a ? { paused: a.paused, t: +a.currentTime.toFixed(2) } : null; })(),
    react: (() => { const b = document.querySelector('.play'); return { label: b?.textContent?.trim(), on: b?.classList.contains('on') }; })(),
    err: document.querySelector('.ink-error')?.textContent ?? null,
  }));
  console.log('+' + (150 * (i+1)) + 'ms', JSON.stringify(s));
}
await browser.close();
