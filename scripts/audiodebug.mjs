/**
 * Reproduce the "browser cannot play this" error the way a real browser does:
 * a genuine click, and WITHOUT the autoplay-policy override that the other
 * harnesses pass (which is exactly what has been hiding this).
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // NOTE: deliberately NOT passing --autoplay-policy=no-user-gesture-required.
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('response', (r) => {
  if (r.url().includes('zen-tones')) {
    console.log(`[http] ${r.status()} ${r.headers()['content-type']} len=${r.headers()['content-length']} accept-ranges=${r.headers()['accept-ranges']}`);
  }
});

await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(2500);

// install error listeners before anything touches the element
await page.evaluate(() => {
  const el = document.querySelector('audio');
  window.__ev = [];
  el.addEventListener('error', () => {
    const e = el.error;
    window.__ev.push({
      what: 'error',
      code: e ? e.code : null,
      message: e ? e.message : null,
      src: (el.currentSrc || el.src || '').split('/').pop(),
    });
  });
  for (const ev of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'stalled', 'abort', 'emptied']) {
    el.addEventListener(ev, () => window.__ev.push({ what: ev, ready: el.readyState, t: +el.currentTime.toFixed(2) }));
  }
  // surface the play() rejection reason verbatim
  const orig = el.play.bind(el);
  el.play = (...a) => orig(...a).catch((err) => {
    window.__ev.push({ what: 'play-rejected', name: err && err.name, message: String(err && err.message) });
    throw err;
  });
});

await page.evaluate(() => {
  [...document.querySelectorAll('.seg-btn')].find((b) => /tone/i.test(b.textContent || ''))?.click();
});
await sleep(400);

// a REAL trusted click on the Zen source
const zen = await page.$('.src');
await zen.click();
await sleep(6000);

const out = await page.evaluate(() => {
  const el = document.querySelector('audio');
  return {
    events: window.__ev,
    probe: window.__audioProbe,
    err: document.querySelector('.ink-error')?.textContent ?? null,
    el: {
      src: (el.currentSrc || el.src || '').split('/').pop(),
      paused: el.paused,
      networkState: el.networkState,
      readyState: el.readyState,
      duration: +(el.duration || 0).toFixed(2),
      currentTime: +el.currentTime.toFixed(2),
      error: el.error ? { code: el.error.code, message: el.error.message } : null,
    },
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();