/**
 * Tabulate scripts/slope.mjs output into the numbers that actually set the
 * optical relief gain: what gain each stop of the band NEEDS to put the shading
 * slope at a chosen target. Re-run both after touching RELIEF_BASE/RELIEF_EXP
 * in src/lab/engine.ts.
 *
 *   node scripts/slope.mjs http://127.0.0.1:5173/ "110,150,200,290,432,620,790" > slope.txt
 *   node scripts/slopefit.cjs slope.txt
 *
 * slope = grad * uAmp * gain / (2 * uR), so  gain = target / (grad * K)
 * with K = uAmp / (2 * uR) = 0.016 / 1.74.
 */
const fs = require('fs');
const file = process.argv[2] || 'C:\\Users\\mj345\\AppData\\Local\\Temp\\opencode\\slope2.txt';
const txt = fs.readFileSync(file, 'utf8');
const blocks = txt.split(/(?=\n\d+ Hz \{)/).filter((b) => /^\s*\d+ Hz/.test(b));
const pick = (s, k) => { const m = s.match(new RegExp('"' + k + '":\\s*(-?[\\d.e-]+)')); return m ? +m[1] : NaN; };
console.log('hz  slopeP50 slopeP90 slopeP99  overKnee%  gain  kR');
for (const b of blocks) {
  const hz = +b.match(/(\d+) Hz/)[1];
  const sl = b.slice(b.indexOf('"slope"'), b.indexOf('slopeClampedPct'));
  const modes = b.match(/"modes":\s*"([^"]*)"/)[1];
  const kR = modes.includes('@') ? modes.match(/@([\d.]+)/)[1] : '-';
  console.log(String(hz).padStart(4),
    String(pick(sl, 'p50')).padStart(9), String(pick(sl, 'p90')).padStart(9), String(pick(sl, 'p99')).padStart(9),
    String(pick(b, 'slopeClampedPct')).padStart(10), String(pick(b, 'uNormalGain')).padStart(7), String(kR).padStart(6));
}