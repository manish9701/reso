/**
 * End-to-end mute bug: freeze the pipeline the way Chromium does
 * (element still "playing", dead line at the analyser) — recovery must be
 * automatic (self-heal resume + first-play revive), with NO click.
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
page.on('console', (m) => { if (/re-clock/.test(m.text())) console.log('[app]', m.text()); });

await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);
await page.click('[title^="Tone plays real sound"]'); // auto-start Zen (first play!)
await sleep(3000);

await page.evaluate(() => window.__audioCtxProbe.suspend()); // the freeze
const rows = [];
for (let i = 0; i < 22; i++) {
  await sleep(300);
  const s = await page.evaluate(() => {
    const p = window.__audioProbe;
    const a = document.querySelector('audio');
    return `${p?.ctx?.slice(0, 3) ?? '—'}/${p ? p.level.toFixed(2) : '?'}/${a ? a.currentTime.toFixed(1) : '?'}`;
  });
  rows.push(s);
}
console.log('ctx/level/element-t every 300 ms:\n  ' + rows.join('\n  '));
const fin = await page.evaluate(() => {
  const p = window.__audioProbe;
  return { ctx: p?.ctx, level: p ? +p.level.toFixed(3) : null, banner: document.querySelector('.ink-error')?.textContent ?? null };
});
console.log('final:', JSON.stringify(fin));
const ok = fin.ctx === 'running' && (fin.level ?? 0) > 0.1 && !fin.banner;
console.log(ok ? 'RECOVERED WITHOUT ANY CLICK' : 'STILL BROKEN');
await browser.close();
if (!ok) process.exit(1);
