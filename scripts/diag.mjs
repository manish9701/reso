/** Quick page diagnostic: dump console + the app's own error state. */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:5173/';
const WAIT = Number(process.argv[3] ?? 5000);
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
    '--use-angle=d3d11', '--enable-gpu-compositing', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1536, height: 1024 },
});
const page = await browser.newPage();
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 2000)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e.stack ?? e).slice(0, 3000)));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });

await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(WAIT);

const info = await page.evaluate(() => ({
  lab: !!window.__lab,
  errorText: document.querySelector('.ink-error')?.textContent ?? null,
  html: document.querySelector('.ink-app')?.innerHTML?.slice(0, 400) ?? null,
}));
console.log('INFO', JSON.stringify(info, null, 2));
await page.screenshot({ path: OUT + '\\diag.png' });
await browser.close();