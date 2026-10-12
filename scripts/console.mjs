/** Capture page console + WebGL shader errors while the liquid renders. */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:5175/reso/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars'],
  defaultViewport: { width: 1000, height: 760 },
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') console.log(`[${t}]`, m.text().slice(0, 1400));
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 600)));
await page.goto(URL + '?drive=4.5&level=0.9', { waitUntil: 'networkidle0' });
await sleep(5000);

const info = await page.evaluate(() => {
  const e = window.__lab;
  const m = e.liquid.material;
  return {
    hasProgram: !!m.program,
    programOk: m.program ? !!m.program.program : null,
    diagnostics: m.program?.diagnostics ?? null,
    version: m.version,
  };
});
console.log('material:', JSON.stringify(info, null, 2));
await browser.close();