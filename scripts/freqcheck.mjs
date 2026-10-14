/**
 * Is the water actually driven by the song, or is it fake?
 *
 * Feed two acoustically opposite test signals in through the app's real
 * upload path and sample the drive the engine uses to pick the figure:
 *
 *   A. a deep 120 Hz sine   -> brightness (spectral centroid) ~ 120 Hz
 *   B. bright white noise   -> centroid pinned at the 1500 Hz clamp
 *
 * If the drive frequency follows the INPUT, the water is real. If the two
 * series look the same, it is fake animation.
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:5174/';
const TMP = 'C:/Users/mj345/AppData/Local/Temp/opencode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- make the two test WAVs (16-bit PCM, 44.1 kHz, mono) -----------------
function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(44100 * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, samples[i] * 32767)), 44 + i * 2);
  return buf;
}
const sec = (t) => Math.floor(44100 * t);
const sineA = new Float32Array(sec(5));
for (let i = 0; i < sineA.length; i++) {
  sineA[i] = Math.sin(2 * Math.PI * 120 * i / 44100) * 0.6 * Math.sin(Math.PI * (i / sineA.length));
  sineA[i] += 0.2 * Math.sin(2 * Math.PI * 240 * i / 44100); // faint 2nd harmonic
}
const noiseB = new Float32Array(sec(5));
let lfsr = 22222;
for (let i = 0; i < noiseB.length; i++) {
  lfsr = (lfsr * 1103515245 + 12345) & 0x7fffffff;
  noiseB[i] = ((lfsr / 0x3fffffff) - 1) * 0.25 * Math.sin(Math.PI * (i / noiseB.length));
}
writeFileSync(`${TMP}/deep-sine.wav`, wav(sineA));
writeFileSync(`${TMP}/bright-noise.wav`, wav(noiseB));

// ---- run them through the app --------------------------------------------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // Signal-chain analysis (NOT the refusal repro): autoplay needs the
  // override because there is no human gesture from an evaluation.
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();

async function sample(file) {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(2000);
  // Switch to Tone mode FIRST, exactly as a user must — the drive loop only
  // reads the audio when tone is the active driver.
  await page.click('[title^="Tone plays real sound"]');
  await sleep(400);
  const input = await page.$('input[type=file]');
  await input.uploadFile(file);
  await sleep(4500);
  const state = await page.evaluate(() => ({
    err: document.querySelector('.ink-error')?.textContent ?? null,
    hint: document.querySelector('.ink-hint')?.textContent,
    audio: (() => { const a = document.querySelector('audio'); return a ? { paused: a.paused, err: a.error?.code, t: +a.currentTime.toFixed(2), src: (a.currentSrc || '').slice(-30) } : null; })(),
    probe: window.__audioProbe,
  }));
  console.log('state:', JSON.stringify(state));
  const series = await page.evaluate(() => new Promise((resolve) => {
    const rows = [];
    const id = setInterval(() => {
      const a = window.__audioProbe;
      const eng = window.__lab;
      rows.push(a && eng ? { probeFreq: +a.freq.toFixed(1), level: +a.level.toFixed(3), driveFreq: +eng.drive.freq.toFixed(2), driveLevel: +eng.drive.level.toFixed(3) } : null);
      if (rows.length >= 16) { clearInterval(id); resolve(rows.filter(Boolean)); }
    }, 250);
  }));
  const driveFreqs = series.map((s) => s.driveFreq);
  const probeFreqs = series.map((s) => s.probeFreq);
  const levels = series.map((s) => s.level);
  return {
    rows: series,
    summary: {
      probeFreq_med: probeFreqs.sort((x, y) => x - y)[7],
      driveFreq_min: Math.min(...driveFreqs),
      driveFreq_max: Math.max(...driveFreqs),
      driveLevel_med: levels.map((v) => v).sort((x, y) => x - y)[7],
    },
  };
}

const A = await sample(`${TMP}/deep-sine.wav`);
const B = await sample(`${TMP}/bright-noise.wav`);

console.log(JSON.stringify({
  deepSine: A.summary,
  brightNoise: B.summary,
  driveFreqDiffers: Math.abs(A.summary.driveFreq_max - B.summary.driveFreq_max) > 0.5
    || Math.abs(A.summary.driveFreq_min - B.summary.driveFreq_min) > 0.5,
  sampleRows: { deepSine: A.rows.slice(0, 6), brightNoise: B.rows.slice(0, 6) },
}, null, 1));
await browser.close();
