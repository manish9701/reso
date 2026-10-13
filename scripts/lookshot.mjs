/**
 * lookshot — one fixed, deterministic screenshot of the dish for fast
 * look-development iteration (same viewport every time).
 *
 *   node scripts/lookshot.mjs [out-path] [--drive=432]
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.argv[3] ?? 'http://localhost:4173/';
const OUT = process.argv[2] ?? 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode\\look.png';
const DRIVE = /--drive=([\d.]+)/.exec(process.argv.join(' '))?.[1] ?? '432';
const DEBUG = /--debug=([\w]+)/.exec(process.argv.join(' '))?.[1] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 300)); });
await page.goto(`${BASE}?drive=${DRIVE}&level=0.85${DEBUG ? '&debug=' + DEBUG : ''}`, { waitUntil: 'networkidle0' });
await sleep(DEBUG ? 5000 : 7000);
await page.screenshot({ path: OUT });
await browser.close();
console.log('saved ' + OUT);
