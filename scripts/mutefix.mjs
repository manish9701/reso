/**
 * THE MUTE BUG, reproduced and then healed:
 * everything looks alive (element advancing), but the AudioContext is
 * suspended — the user's pause+play was the only resume. Now frame()'s
 * self-heal re-drives resume() and the level must recover.
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

await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);
await page.click('[title^="Tone plays real sound"]'); // auto-start Zen
await sleep(3500);

const snap = () => page.evaluate(() => {
  const p = window.__audioProbe;
  const a = document.querySelector('audio');
  return {
    ctx: p?.ctx ?? null,
    level: p ? +p.level.toFixed(3) : null,
    elPaused: a?.paused,
    t: a ? +a.currentTime.toFixed(2) : null,
  };
});

const before = await snap();
console.log('playing normally:', JSON.stringify(before));

// THE BUG: suspend the context out from under a live session — exactly the
// state the user landed in (OS event, device change, re-check).
await page.evaluate(() => { window.__audioCtxProbe?.suspend(); });
await sleep(800);
const frozen = await snap();
console.log('after forced suspend:', JSON.stringify(frozen));

// now wait — the self-heal (frame loop, ~0.5 s throttle) must fix it
for (const w of [700, 700, 1400]) {
  await sleep(w);
  const s = await snap();
  console.log(`heal check (+${w}ms):`, JSON.stringify(s));
  if (s.ctx === 'running' && (s.level ?? 0) > 0.1) {
    console.log('SELF-HEALED: context resumed, sound returned');
    await browser.close();
    process.exit(0);
  }
}
console.log('FAILED: session stayed frozen');
await browser.close();
process.exit(1);
