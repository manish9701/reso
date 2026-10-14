/**
 * Tone-mode auto-play check: clicking Tone alone must start Zen automatically,
 * and the transport must pause/continue it — like a music app.
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // Real autoplay policy: Tone is clicked by a real trusted click, so the
  // auto-start must earn the browser's permission through that gesture.
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle0' });
await sleep(2500);

// 1. click Tone ONLY — no Zen button
const toneBtn = await page.$('[title^="Tone plays real sound"]');
await toneBtn.click();
await sleep(3500);
const step1 = await page.evaluate(() => {
  const a = document.querySelector('audio');
  return {
    probe: window.__audioProbe,
    el: a ? { paused: a.paused, t: +a.currentTime.toFixed(2), err: a.error?.code ?? null } : null,
    err: document.querySelector('.ink-error')?.textContent ?? null,
    playing: document.querySelector('.play')?.classList.contains('on') ?? null,
  };
});

// 2. the FIRST press of Play starts the track manually (tone is idle before it)
await page.click('.play');
await sleep(1400);
const step2 = await page.evaluate(() => {
  const a = document.querySelector('audio');
  return { probe: window.__audioProbe, elPaused: a?.paused, t: +(a?.currentTime ?? 0).toFixed(2), btn: document.querySelector('.play-txt')?.textContent };
});

// 3. press again: pause
await page.click('.play');
await sleep(600);
const step3 = await page.evaluate(() => {
  const a = document.querySelector('audio');
  return { probe: window.__audioProbe, elPaused: a?.paused, btn: document.querySelector('.play-txt')?.textContent };
});

// 4. continue once more
await page.click('.play');
await sleep(1200);
const step4 = await page.evaluate(() => {
  const a = document.querySelector('audio');
  return { probe: window.__audioProbe, elPaused: a?.paused, t: +(a?.currentTime ?? 0).toFixed(2), btn: document.querySelector('.play-txt')?.textContent };
});

// 5. leave to Frequency and come back: tone must land IDLE (manual contract)
await page.evaluate(() => { [...document.querySelectorAll('.seg-btn')].find((b) => /freq/i.test(b.textContent || '')).click(); });
await sleep(400);
await page.evaluate(() => { [...document.querySelectorAll('.seg-btn')].find((b) => /tone/i.test(b.textContent || ''))?.click(); });
await sleep(2000);
const step5 = await page.evaluate(() => {
  const a = document.querySelector('audio');
  return { probe: window.__audioProbe, elPaused: a?.paused, btn: document.querySelector('.play-txt')?.textContent };
});

console.log(JSON.stringify({ step1, step2, step3, step4, step5 }, null, 1));
await browser.close();
