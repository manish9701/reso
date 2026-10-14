/**
 * Does the water follow the MUSIC? Play the bundled Zen track and sample the
 * four band energies + the dominant mode the dish is ringing in, over time.
 * If the m/n of the leader actually walks with the song, the spectrum driver
 * is doing its job.
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // Real policy: Tone is auto-started by a trusted click in the page.
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle0' });
await sleep(2500);
await page.click('[title^="Tone plays real sound"]'); // auto-starts Zen now
await sleep(3000);

await page.evaluate(() => {
  const eng = window.__lab;
  // pour some ink so the figure is visible in captures
  eng.deposit(0.45, 0.5, 0.07, 0.6, { r: 0.1, g: 0.32, b: 0.94 });
});
await sleep(1500);

const rows = await page.evaluate(() => new Promise((resolve) => {
  const out = [];
  const eng = window.__lab;
  const id = setInterval(() => {
    const a = window.__audioProbe;
    out.push({
      bands: a ? a.bands.map((v) => +v.toFixed(2)) : null,
      dominant: eng.resonance.dominant(),
    });
    if (out.length >= 14) { clearInterval(id); resolve(out); }
  }, 1400);
}));
for (const r of rows) console.log(JSON.stringify(r));
await browser.close();
