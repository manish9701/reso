/**
 * One-off check: the Tone-mode hint text (headphone note) and that playback
 * still starts cleanly after the hint/messages changes.
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5174/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(2500);

const before = await page.evaluate(() => document.querySelector('.ink-hint')?.textContent);
await page.click('[title^="Tone plays real sound"]');
await sleep(400);
const afterTone = await page.evaluate(() => document.querySelector('.ink-hint')?.textContent);
const zen = await page.$('.src');
await zen.click();
await sleep(6000);
const after = await page.evaluate(() => ({
  hint: document.querySelector('.ink-hint')?.textContent,
  toneTitle: document.querySelector('[title^="Tone plays real sound"]')?.getAttribute('title'),
  zenTitle: [...document.querySelectorAll('.src')].map((b) => b.getAttribute('title')),
  probe: window.__audioProbe,
  err: document.querySelector('.ink-error')?.textContent ?? null,
  el: (() => { const a = document.querySelector('audio'); return a ? { paused: a.paused, t: +a.currentTime.toFixed(2), err: a.error?.code ?? null } : null; })(),
}));
console.log(JSON.stringify({ before, afterTone, after }, null, 1));
await browser.close();
