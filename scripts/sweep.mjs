/**
 * Parameter sweep harness.
 *
 * Every visual tuning decision so far was made by changing several values and
 * judging one screenshot, which made it impossible to attribute the result —
 * and is why several passes had to be reverted wholesale. This makes a single
 * parameter a controlled experiment instead of a guess.
 *
 * One fixed scene (identical pigment, identical settle time), one parameter
 * varied across a range, laid out as a labelled grid. What "this roughness
 * reads as steel" becomes a lookup rather than an opinion.
 *
 *   node scripts/sweep.mjs [url] [param] [min] [max] [steps]
 *
 * Examples:
 *   node scripts/sweep.mjs http://localhost:5173/reso/ uNormalGain 2 14 7
 *   node scripts/sweep.mjs http://localhost:5173/reso/ dishRough   0.02 0.40 7
 *   node scripts/sweep.mjs http://localhost:5173/reso/ causticK    1e-7 8e-7 7
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] ?? 'http://localhost:5173/reso/';
const PARAM = process.argv[3] ?? 'uNormalGain';
const MIN = Number(process.argv[4] ?? 2);
const MAX = Number(process.argv[5] ?? 14);
const STEPS = Number(process.argv[6] ?? 7);
const OUT = 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode';
const CELL = 340;
const COLS = Math.min(STEPS, 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How each sweepable parameter is read and written at runtime. */
const ACCESSORS = {
  // liquid shader uniforms
  uNormalGain: 'uniform',
  uAmp: 'uniform',
  uWaterR: 'uniformR', uWaterG: 'uniformG', uWaterB: 'uniformB',
  uInkA: 'inkA', uInkB: 'inkB',
  uCausticK: 'uniform',
  uCaustics: 'uniform',
  uReliefMix: 'uniform',
  uShadowMix: 'uniform',
  uRefract: 'uniform',
  uBowlTint: 'uniformRGB',
  // dish material
  dishRough: 'dishRough',
  dishColor: 'dishColor',
  dishEnv: 'dishEnv',
};

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

// Fixed, deterministic scene: same pigment, same place, every run.
await page.evaluate(() => {
  const e = window.__lab;
  const cols = [[0.06, 0.22, 0.95], [0.62, 0.10, 0.92], [0.05, 0.72, 0.86], [0.95, 0.42, 0.06]];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = 0.09 + (i % 3) * 0.10;
    e.dropIn(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, cols[i % cols.length], 0.6, 0.021);
  }
});
await sleep(7000);

// Hide the UI so the grid compares render only.
await page.evaluate(() => {
  for (const s of ['.rail', '.ink-hint']) {
    document.querySelectorAll(s).forEach((el) => { el.style.display = 'none'; });
  }
});

const setParam = (v) => page.evaluate((param, val) => {
  const e = window.__lab;
  const u = e.liquidUniforms;
  const dish = e.dish.material;
  const kind = ({
    uNormalGain: 'uniform', uAmp: 'uniform', uCausticK: 'uniform', uCaustics: 'uniform',
    uReliefMix: 'uniform', uShadowMix: 'uniform', uRefract: 'uniform',
    uWaterR: 'uniformR', uWaterG: 'uniformG', uWaterB: 'uniformB',
    uBowlTint: 'uniformRGB', uInkA: 'inkA', uInkB: 'inkB',
    dishRough: 'dishRough', dishColor: 'dishColor', dishEnv: 'dishEnv',
  })[param];
  if (!kind) throw new Error('unknown parameter ' + param);
  switch (kind) {
    case 'uniform': {
      const t = u[param];
      if (!t) throw new Error('no uniform ' + param);
      t.value = val;
      break;
    }
    case 'uniformR': u.uWater.value.x = val; break;
    case 'uniformG': u.uWater.value.y = val; break;
    case 'uniformB': u.uWater.value.z = val; break;
    case 'uniformRGB': u.uBowlTint.value.set(val, val, val); break;
    case 'inkA': u.uInkDensity.value.x = val; break;
    case 'inkB': u.uInkDensity.value.y = val; break;
    case 'dishRough': dish.roughness = val; dish.needsUpdate = true; break;
    case 'dishColor': dish.color.setRGB(val, val, val); break;
    case 'dishEnv': dish.envMapIntensity = val; break;
  }
  // Force the material to recompile if a define changed.
  e.liquid.material.needsUpdate = true;
}, PARAM, v);

const values = Array.from({ length: STEPS }, (_, i) => {
  const t = STEPS === 1 ? 0 : i / (STEPS - 1);
  return MIN * Math.pow(MAX / MIN, t);   // geometric, so small values get room
});

const shots = [];
for (const v of values) {
  await setParam(v);
  await sleep(700);
  const b64 = await page.screenshot({
    clip: { x: 1600 / 2 - CELL / 2, y: 900 / 2 - CELL / 2, width: CELL, height: CELL },
    encoding: 'base64',
  });
  shots.push({ v, b64 });
  process.stdout.write(`  ${PARAM} = ${v.toPrecision(3)}\n`);
}

// Compose the labelled grid.
const rows = Math.ceil(shots.length / COLS);
const grid = await page.evaluate(async (shots, cols, cell, param) => {
  const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s; });
  const imgs = await Promise.all(shots.map((s) => load(s.b64)));
  const rows = Math.ceil(shots.length / cols);
  const pad = 22;
  const c = document.createElement('canvas');
  c.width = cols * (cell + pad) + pad;
  c.height = rows * (cell + pad + 20) + pad;
  const g = c.getContext('2d');
  g.fillStyle = '#15171c';
  g.fillRect(0, 0, c.width, c.height);
  g.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  shots.forEach((s, i) => {
    const x = pad + (i % cols) * (cell + pad);
    const y = pad + Math.floor(i / cols) * (cell + pad + 20);
    g.drawImage(imgs[i], x, y, cell, cell);
    g.strokeStyle = '#2c313b';
    g.strokeRect(x, y, cell, cell);
    g.fillStyle = '#e8eaee';
    g.fillText(`${param} = ${Number(s.v).toPrecision(3)}`, x + 2, y + cell + 15);
  });
  return c.toDataURL('image/png');
}, shots, COLS, CELL, PARAM);

const outPath = `${OUT}\\sweep-${PARAM}.png`;
fs.writeFileSync(outPath, Buffer.from(grid.split(',')[1], 'base64'));
console.log('\ngrid written:', outPath);
console.log('open this and pick the cell that matches the reference.');

await browser.close();