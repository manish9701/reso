/**
 * Look shot — capture the dish at a given drive frequency, optionally after
 * pouring pigment, so a change can be judged by eye against another.
 *
 *   node scripts/lookshot.mjs <url> <tag> [hz=432,262,784] [pour=1]
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5199/reso/';
const TAG = process.argv[3] ?? 'look';
const HZ = (process.argv[4] ?? '432,262,784').split(',').map(Number);
const POUR = (process.argv[5] ?? '1') === '1';
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
    '--use-angle=d3d11', '--enable-gpu-compositing', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/Shader Error|VALIDATE_STATUS|not compiled|ERROR:\s*\d+:\d+/.test(t)) console.log('[SHADER]', t.slice(0, 600));
  else if (m.type() === 'error') console.log('[error]', t.slice(0, 300));
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

await page.goto(`${URL}?drive=432&level=0.85`, { waitUntil: 'networkidle0' });
await sleep(3500);

for (const hz of HZ) {
  await page.evaluate((f) => { window.__lab.forcedDrive = { freq: f, level: 0.85 }; }, hz);
  await sleep(2500);
  if (POUR) {
    await page.evaluate(() => {
      const e = window.__lab;
      const cols = [[0.10, 0.28, 0.95], [0.95, 0.20, 0.55], [0.10, 0.75, 0.92], [0.55, 0.25, 0.90]];
      for (let i = 0; i < cols.length; i++) {
        const a = (i / cols.length) * Math.PI * 2 + 0.4;
        e.deposit(0.5 + Math.cos(a) * 0.20, 0.5 + Math.sin(a) * 0.20, 0.055, 0.9, cols[i]);
      }
    });
    await sleep(4000);
  }
  const modes = await page.evaluate(() => window.__lab.figure.slots.map((s) => `m${s.m}@${s.kR.toFixed(1)}:${s.amp.toFixed(2)}`).join(' '));
  console.log(`${hz} Hz -> ${modes}`);
  await page.screenshot({ path: `${OUT}\\${TAG}-${hz}.png` });
}

await browser.close();