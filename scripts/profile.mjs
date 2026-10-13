/**
 * Cost attribution: measure frame time with individual subsystems disabled,
 * so optimisation targets the thing that actually costs rather than the thing
 * that looks expensive.
 *
 *   node scripts/profile.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:4173/reso/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(URL + '?drive=4.5&level=0.85', { waitUntil: 'networkidle0' });
await sleep(3000);

async function measure(ms = 3500) {
  return page.evaluate((duration) => new Promise((resolve) => {
    const frames = [];
    let last = performance.now();
    const t0 = last;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (now - t0 < duration) requestAnimationFrame(tick);
      else {
        const s = [...frames].sort((a, b) => a - b);
        resolve({
          median: +s[Math.floor(s.length / 2)].toFixed(1),
          mean: +(frames.reduce((a, b) => a + b, 0) / frames.length).toFixed(1),
        });
      }
    };
    requestAnimationFrame(tick);
  }), ms);
}

async function setMode(mode) {
  await page.evaluate((m) => {
    const e = window.__lab;
    if (!e.__saved) e.__saved = {
      transmission: e.liquid.material.transmission,
      liquidVisible: e.liquid.visible,
      dropVisible: e.droplets.group.visible,
      dishVisible: e.dish.visible,
    };
    const s = e.__saved;
    // reset everything to on first
    e.liquid.material.transmission = s.transmission;
    e.liquid.visible = s.liquidVisible;
    e.droplets.group.visible = s.dropVisible;
    e.dish.visible = s.dishVisible;
    e.noForce = false;
    e.__noDye = false;
    e.__noWave = false;

    if (m === 'noTransmission') e.liquid.material.transmission = 0;
    if (m === 'noLiquid') e.liquid.visible = false;
    if (m === 'noDroplets') e.droplets.group.visible = false;
    if (m === 'noDish') e.dish.visible = false;
    if (m === 'noFigure') e.noFigure = true;
    if (m === 'noPigment') e.__noDye = true;
    if (m === 'noWave') e.__noWave = true;
    if (m === 'empty') {
      e.liquid.visible = false;
      e.dish.visible = false;
      e.droplets.group.visible = false;
      e.noForce = true;
    }
  }, mode);
  await sleep(700);
}

const modes = [
  'baseline',
  'noTransmission',
  'noLiquid',
  'noDish',
  'noDroplets',
  'noFigure',
  'noPigment',
  'noWave',
  'empty',
];

console.log('mode            median    mean    delta');
console.log('--------------------------------------');
const base = await (async () => { await setMode('baseline'); return measure(); })();
console.log(`baseline        ${String(base.median).padStart(6)}ms ${String(base.mean).padStart(6)}ms`);
for (const m of modes.slice(1)) {
  await setMode(m);
  const r = await measure();
  const d = (base.median - r.median).toFixed(1);
  console.log(`${m.padEnd(15)} ${String(r.median).padStart(6)}ms ${String(r.mean).padStart(6)}ms  ${d > 0 ? '-' : '+'}${d}ms`);
}
await setMode('baseline');
await browser.close();