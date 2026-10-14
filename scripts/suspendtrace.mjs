/** Catch the frozen instant: fast sampling right after the forced suspend. */
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
await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle0' });
await sleep(2500);
await page.click('[title^="Tone plays real sound"]');
await sleep(3000);

await page.evaluate(() => window.__audioCtxProbe.suspend());
const rows = [];
for (let i = 0; i < 10; i++) {
  await sleep(120);
  rows.push(await page.evaluate(() => {
    const pr = window.__audioProbe;
    return `${pr?.ctx ?? 'null'}: ${pr ? pr.level.toFixed(2) : '—'}`;
  }));
}
console.log('kick-каждые 120ms:', rows.join(' | '));
const fin = await page.evaluate(() => {
  const pr = window.__audioProbe;
  return { ctx: pr?.ctx, level: pr ? +pr.level.toFixed(3) : null };
});
console.log('final:', JSON.stringify(fin));
await browser.close();
