/**
 * Mode-bank audit.
 *
 * The bank drives every figure in the app, so if it contains modes that do not
 * exist — duplicates created by the asymptotic Bessel formula falling back
 * inside the tabulated range — the dish rings in two identical shapes at two
 * nearly identical frequencies and the figure turns to interference mush that
 * does not change as the frequency moves.
 *
 * This checks the bank directly: for every mode, resolve its k·R against the
 * TRUE Bessel family by bisection on the actual function, and report any mode
 * whose tabulated/asymptotic value is not actually a zero of its family.
 */

const SIGMA = 0.072, RHO = 1000, G = 9.81;
const VESSEL = { radius: 0.085, depth: 0.006 };

const JP_ZERO = {
  0: [3.83171, 7.01559, 10.17347, 13.32369],
  1: [1.84118, 5.33144, 8.53632, 11.70596],
  2: [3.05424, 6.70613, 9.96516, 13.17037],
  3: [4.20119, 8.01524, 11.34592, 14.58585],
  4: [5.31755, 9.2824, 12.68191, 16.03399],
};
const J_ZERO = {
  0: [2.40483, 5.52008, 8.65373, 11.79153],
  1: [3.83171, 7.01559, 10.17347, 13.32369],
  2: [5.13562, 8.41724, 11.61984, 14.79595],
  3: [6.38016, 9.76102, 13.0152, 16.22347],
  4: [7.58834, 11.06471, 14.37254, 17.61665],
};

function zeroAt(table, m, n, derivative) {
  const row = table[m];
  if (row && n <= row.length) return row[n - 1];
  const beta = (n + m / 2 - (derivative ? 3 / 4 : 1 / 4)) * Math.PI;
  const corr = (4 * m * m + (derivative ? 3 : -1)) / (8 * beta);
  return beta - corr;
}

// --- true Bessel families, by bisection on the real functions ---------------
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
  if (m === 0) return -besselJ(1, x);
  return (besselJ(m - 1, x) - besselJ(m + 1, x)) / 2;
}
/** n-th zero of the family (1-based) by scanning + bisection. */
function trueZero(m, n, derivative, hi = 400) {
  const f = derivative ? besselJp : besselJ;
  const mm = Math.round(m);
  let lo = 0, prev = f(mm, lo);
  const roots = [];
  for (let x = 0.01; x < hi; x += 0.01) {
    const v = f(mm, x);
    if (prev === 0 || (prev < 0) !== (v < 0)) {
      let a = x - 0.01, b = x;
      for (let i = 0; i < 60; i++) {
        const mid = (a + b) / 2;
        (f(mm, mid) < 0) === (prev < 0) ? (a = mid) : (b = mid);
      }
      roots.push((a + b) / 2);
      if (roots.length >= n) break;
    }
    prev = v;
  }
  return roots[n - 1];
}

const MAX_M = 14, MAX_N = 12;

for (const boundary of ['rigid', 'free']) {
  const derivative = boundary === 'rigid';
  const T = derivative ? JP_ZERO : J_ZERO;
  console.log(`\n===== ${boundary} (${derivative ? "J'_m" : "J_m"}) =====`);
  const rows = [];
  for (let m = 0; m <= 6; m++) {
    for (let n = 1; n <= MAX_N; n++) {
      if (m === 0 && n > 7) continue;
      const z = zeroAt(T, m, n, derivative);
      const t = trueZero(m, n, derivative);
      rows.push({ m, n, z, t, err: t === undefined ? NaN : (z - t) / t });
    }
  }
  const bad = rows.filter((r) => !Number.isFinite(r.err) || Math.abs(r.err) > 0.002);
  console.log(`modes checked: ${rows.length}; outside 0.2%: ${bad.length}`);
  for (const r of bad.slice(0, 22)) {
    console.log(`  m=${r.m} n=${r.n}: kR=${r.z.toFixed(4)}  true=${r.t === undefined ? '??' : r.t.toFixed(4)}  err=${(r.err * 100).toFixed(1)}%`);
  }

  // duplicate k·R inside the whole bank => two modes that are literally the
  // same standing shape, which is what renders as permanent interference mush
  const all = [];
  for (let m = 0; m <= MAX_M; m++) {
    for (let n = 1; n <= MAX_N; n++) {
      if (m === 0 && n > 7) continue;
      all.push({ m, n, kR: zeroAt(T, m, n, derivative) });
    }
  }
  all.sort((a, b) => a.kR - b.kR);
  const dups = [];
  for (let i = 1; i < all.length; i++) {
    const d = (all[i].kR - all[i - 1].kR) / all[i].kR;
    if (d < 0.004) dups.push(`${all[i - 1].m}/${all[i - 1].n}@${all[i - 1].kR.toFixed(3)} ~ ${all[i].m}/${all[i].n}@${all[i].kR.toFixed(3)} (${(d * 100).toFixed(2)}%)`);
  }
  console.log(`near-identical k.R pairs: ${dups.length}`);
  for (const d of dups.slice(0, 20)) console.log('  ' + d);
}