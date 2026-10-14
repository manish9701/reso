/** Screenshot the dish for the deep sine and the bright noise, for visual proof. */
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TMP = 'C:/Users/mj345/AppData/Local/Temp/opencode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();

async function shot(wav, out) {
  await page.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle0' });
  await sleep(2000);
  await page.click('[title^="Tone plays real sound"]');
  await sleep(300);
  await (await page.$('input[type=file]')).uploadFile(wav);
  await sleep(5000);
  // pour some ink so the figure is visible in both
  await page.mouse.move(520, 380);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(2500);
  const b64 = await page.evaluate(() => {
    // The canvas has preserveDrawingBuffer off, so toDataURL/ toBlob on it
    // return blank — engine.capture() renders and reads in the SAME tick.
    return window.__lab.capture();
  });
  writeFileSync(out, Buffer.from(b64.split(',')[1], 'base64'));
  console.log('saved', out);
}

await shot(`${TMP}/deep-sine.wav`, `${TMP}/dish-deep.png`);
await shot(`${TMP}/bright-noise.wav`, `${TMP}/dish-bright.png`);
await browser.close();
