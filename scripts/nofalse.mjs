/** The revive must NOT fire on a healthy session (no dead line, no warn). */
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
let reClocks = 0;
page.on('console', (m) => { if (/re-clock/.test(m.text())) reClocks++; });
await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);
await page.click('[title^="Tone plays real sound"]');
await sleep(2000);
await page.click('.play');
await sleep(1000);
await page.click('.play');
// 20 s of continuous playback through quiet and loud passages
await page.click('.play');
await sleep(20000);
let levels = [];
for (let i = 0; i < 6; i++) {
  const p = await page.evaluate(() => window.__audioProbe?.level ?? 0);
  levels.push(+(+p).toFixed(2));
  await sleep(500);
}
console.log(JSON.stringify({ reClocks, levels }, null, 1));
await browser.close();
if (reClocks > 0) { console.error('FALSE REVIVE on healthy audio'); process.exit(1); }
console.log('healthy audio: zero re-clocks');
