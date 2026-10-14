/**
 * Visible-band measurement — find where the slider actually moves the water.
 *
 * "Visual change" needs two properties, and both are measured here:
 *  1. RESPONSE — the figure must be strong enough to see (the drive reaches a
 *     mode with enough coupled amplitude).
 *  2. DISCRIMINATION — a step along the slider must change the figure;
 *     otherwise adjacent slider positions look identical and the user is
 *     sliding a dead region.
 *
 * The band reported here is the widest contiguous run satisfying both, and its
 * results are what EXCITATION_MIN/MAX (and the UI→sim mapping) are set from.
 *
 * Pure Node: re-runs the mode bank (bisection) and the modal response model
 * exactly as sim/resonance.ts does. No server needed.
 */
const SIGMA = 0.072, RHO = 1000, G = 9.81;
const VESSEL = { radius: 0.085, depth: 0.006 };

function besselJ(m, x) {
  if (x < 0) return NaN;
  if (x === 0) return m === 0 ? 1 : 0;
  const mf = Math.round(m);
  let term = 1;
  for (let i = 1; i <= mf; i++) term *= x / (i * 2);
  let sum = term;
  for (let k = 0; k < 80; k++) {
    term *= -(x * x) / (4 * (k + 1) * (k + 1 + mf));
    sum += term;
    if (Math.abs(term) < 1e-15) break;
  }
  return sum;
}
function besselJp(m, x) {
  const mm = Math.round(m);
  if (mm === 0) return -besselJ(1, x);
  return (besselJ(mm - 1, x) - besselJ(mm + 1, x)) / 2;
}
function zeros(m, derivative, need) {
  const f = (x) => (derivative ? besselJp(m, x) : besselJ(m, x));
  const roots = [];
  const step = Math.PI / 4;
  let prevX = 0, prevV = f(0);
  for (let x = step; x <= 70 && roots.length < need; x += step) {
    const v = f(x);
    if (prevV !== 0 && v !== 0 && (prevV < 0) !== (v < 0)) {
      let a = prevX, b = x;
      for (let i = 0; i < 60; i++) {
        const mid = (a + b) / 2;
        if ((f(mid) < 0) === (prevV < 0)) a = mid; else b = mid;
      }
      roots.push((a + b) / 2);
    }
    prevX = x;
    prevV = v;
  }
  return roots;
}

// --- bank, exactly as lab/resonance.ts builds it ---------------------------
const MAX_M = 14, MAX_N = 12;
const bank = [];
const zeroCache = new Map();
const zget = (m, n, d) => {
  const k = `${m}|${d ? 1 : 0}`;
  if (!zeroCache.has(k)) zeroCache.set(k, zeros(m, d, 40));
  return zeroCache.get(k)[n - 1];
};
for (let m = 0; m <= MAX_M; m++) {
  for (let n = 1; n <= MAX_N; n++) {
    if (m === 0 && n > 7) continue;
    const z = zget(m, n, true);
    if (bank.some((e) => Math.abs(e.kR - z) < 1e-4)) continue;
    const k = z / VESSEL.radius;
    const omega = Math.sqrt((G * k + (SIGMA / RHO) * k * k * k) * Math.tanh(k * VESSEL.depth));
    bank.push({ m, n, kR: z, freq: omega / (2 * Math.PI) });
  }
}
bank.sort((a, b) => a.freq - b.freq);
const F_MIN = bank[0].freq, F_MAX = bank[bank.length - 1].freq;

// --- response model, exactly as sim/resonance.ts computes it ---------------
const BASE_BW = 0.035, COUPLING_PER_M = 0.085;
const logF = bank.map((b) => Math.log(b.freq));
const span = logF.map((ln, i) => {
  const prev = i > 0 ? ln - logF[i - 1] : Infinity;
  const next = i < logF.length - 1 ? logF[i + 1] - ln : Infinity;
  const s = Math.max(prev, next);
  return Number.isFinite(s) ? s : BASE_BW;
});
const toSim = (hz) => {
  const t = (Math.log(Math.max(1, hz)) - Math.log(110)) / (Math.log(880) - Math.log(110));
  return F_MIN * Math.exp(Math.min(1, Math.max(0, t)) * Math.log(F_MAX / F_MIN));
};
const LEVEL = 0.85;
function converge(hz) {
  const f = toSim(hz);
  const lnF = Math.log(f);
  let bi = 0, bd = Infinity;
  for (let i = 0; i < logF.length; i++) {
    const d = Math.abs(logF[i] - lnF);
    if (d < bd) { bd = d; bi = i; }
  }
  const bw = Math.max(BASE_BW + 0.025 * 0.5, span[bi] * 0.42);
  const amps = [];
  for (const md of bank) {
    const d = Math.abs(logF[bank.indexOf(md)] - lnF);
    const w = Math.exp(-((d / bw) ** 2)) * Math.exp(-md.m * COUPLING_PER_M);
    if (w >= 0.02) amps.push({ m: md.m, kR: md.kR, amp: LEVEL * w });
  }
  amps.sort((a, b) => b.amp - a.amp);
  const top = amps[0]?.amp ?? 0;
  const fig = amps.filter((a) => a.amp > top * 0.55).slice(0, 4)
    .map((a) => `m${a.m}@${a.kR.toFixed(1)}`).join(',');
  return { top, fig, nfig: amps.filter((a) => a.amp > top * 0.55).length };
}

// --- sweep ------------------------------------------------------------------
const STEP = 6;                       // Hz between probes
const rows = [];
for (let hz = 110; hz <= 880; hz += STEP) rows.push({ hz, ...converge(hz) });
const maxTop = Math.max(...rows.map((r) => r.top));

// response is "visible" if it reaches 30% of the band's strongest drive;
// discrimination if stepping +-6 Hz changes the figure.
const VIS = 0.30 * maxTop;
const good = rows.map((r, i) => {
  const nb = rows[Math.min(rows.length - 1, i + 1)];
  const pb = rows[Math.max(0, i - 1)];
  const changes = r.fig !== nb.fig || r.fig !== pb.fig;
  return { hz: r.hz, ok: r.top >= VIS && changes, top: r.top, fig: r.fig };
});

// widest contiguous run
let best = { lo: 0, hi: 0 }, cur = null;
good.forEach((g, i) => {
  if (g.ok) { if (!cur) cur = { lo: g.hz, hi: g.hz }; else cur.hi = g.hz; }
  if ((!g.ok || i === good.length - 1) && cur) {
    if (cur.hi - cur.lo > best.hi - best.lo) best = cur;
    cur = null;
  }
});
console.log(`band strongest response: ${maxTop.toFixed(3)}; visibility floor ${VIS.toFixed(3)}`);
console.log(`measured usable band: ${best.lo} – ${best.hi} UI Hz`);
console.log(`sim range at those edges: ${toSim(best.lo).toFixed(3)} – ${toSim(best.hi).toFixed(3)} Hz`);
console.log(`(full slider today: 110 – 880 -> sim ${F_MIN.toFixed(3)} – ${F_MAX.toFixed(3)})`);
console.log('');
console.log('weak / non-changing regions excluded:');
for (const g of good) {
  if (g.hz >= best.lo && g.hz <= best.hi) continue;
  console.log(`  ${String(g.hz).padStart(3)} Hz  top=${g.top.toFixed(3)}  figure: ${g.fig || 'none'}`);
}
process.exit(0);