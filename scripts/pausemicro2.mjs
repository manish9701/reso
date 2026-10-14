/**
 * Are pause clicks even reaching the button? Page-side capture logging,
 * plus synthetic (evaluate) clicks vs real mouse clicks, side by side.
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
await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);

await page.evaluate(() => {
  window.__log = [];
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('.play');
    window.__log.push(`click on <${e.target.tagName.toLowerCase()} class="${e.target.className}"> inPlay=${!!b}`);
  }, true);
});
await page.click('[title^="Tone plays real sound"]');
await sleep(2500); // auto-playing now

const probe = () => page.evaluate(() => ({
  paused: document.querySelector('audio')?.paused,
  label: document.querySelector('.play')?.textContent?.trim(),
  log: window.__log?.slice(-3),
}));

console.log('before real click:', JSON.stringify(await probe()));
await page.$eval('.play', (el) => { /* real click at its center */ });
const el = await page.$('.play');
const box = await el.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await sleep(700);
console.log('after REAL mouse click:', JSON.stringify(await probe()));

await page.evaluate(() => { document.querySelector('.play').click(); });
await sleep(700);
console.log('after synthetic click:', JSON.stringify(await probe()));
await browser.close();
