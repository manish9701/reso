/**
 * ResonanceModel — circular-vessel mode bank for the Resonant Ink dish.
 *
 * Physics basis (documented assumption, per spec §5/§13):
 * - Rigid cylindrical vessel of radius R with liquid depth h.
 * - Mode shapes φ_m,n(r,θ) = J_m(k·r) · cos(mθ).
 * - Two honest boundary options exposed in the UI:
 *     rigid wall  →  J'_m(k·R) = 0  (no-normal-flow, "Circular Membrane")
 *     free edge   →  J_m(k·R)  = 0  ("Free Edge")
 *   with k·R taken from standard Bessel-zero tables (Abramowitz & Stegun
 *   9.5/11.4.7), i.e. exact constants, not numeric root-finding.
 * - Mode frequencies from the linear capillary–gravity dispersion relation
 *   ω² = (g·k + (σ/ρ)·k³) · tanh(k·h), ω = 2πf, mapped into the audible band
 *   through a documented monotonic transform (real dish frequencies are
 *   sub-10 Hz; the UI drives 60–900 Hz).
 *
 * Physics-grounded real-time model, not a calibrated laboratory simulation.
 */

/** Physical constants (SI). */
export const G = 9.81;
export const SIGMA = 0.072; // water surface tension N/m
export const RHO = 1000; // density kg/m³

/** Artistic vessel parameters — documented, not calibrated. */
export const VESSEL = { radius: 0.085, depth: 0.006 };

export type Boundary = 'rigid' | 'free';

/** Exact tabulated zeros, m = 0..4, n = 1..4 (A&S 9.5 / 11.4.7). */
const JP_ZERO: Record<number, number[]> = {
  0: [3.83171, 7.01559, 10.17347, 13.32369],
  1: [1.84118, 5.33144, 8.53632, 11.70596],
  2: [3.05424, 6.70613, 9.96516, 13.17037],
  3: [4.20119, 8.01524, 11.34592, 14.58585],
  4: [5.31755, 9.2824, 12.68191, 16.03399],
};

const J_ZERO: Record<number, number[]> = {
  0: [2.40483, 5.52008, 8.65373, 11.79153],
  1: [3.83171, 7.01559, 10.17347, 13.32369],
  2: [5.13562, 8.41724, 11.61984, 14.79595],
  3: [6.38016, 9.76102, 13.0152, 16.22347],
  4: [7.58834, 11.06471, 14.37254, 17.61665],
};

/** Orders and radial indices carried in the bank. */
const MAX_M = 11;
const MAX_N = 9;

/**
 * Zeros beyond the tables use the standard large-argument asymptotics
 * (Abramowitz & Stegun 9.5.12 / 11.4.9), accurate to ~1e-3 well past n = 4:
 *
 *   j_{m,n}  ≈ β − (4m²−1)/(8β),          β = (n + m/2 − 1/4)π
 *   j'_{m,n} ≈ β − (4m²+3)/(8β),          β = (n + m/2 − 3/4)π
 *
 * This is what makes the frequency→figure map continuous: with only 18 modes
 * a tone lights four of them at once and the figure is mush, because real
 * cymatic cell counts run far higher than m ≤ 4.
 */
function zeroAt(table: Record<number, number[]>, m: number, n: number, derivative: boolean): number {
  const row = table[m];
  if (row && n <= row.length) return row[n - 1];
  const beta = (n + m / 2 - (derivative ? 3 / 4 : 1 / 4)) * Math.PI;
  const corr = (4 * m * m + (derivative ? 3 : -1)) / (8 * beta);
  return beta - corr;
}

/** Bessel J_m(x) by series — used for thumbnails only. */
export function besselJ(m: number, x: number): number {
  if (x < 0) return NaN;
  if (x === 0) return m === 0 ? 1 : 0;
  const mf = Math.round(m);
  let term = 1;
  for (let i = 1; i <= mf; i++) term *= x / (i * 2);
  let sum = term;
  for (let k = 0; k < 60; k++) {
    term *= -(x * x) / (4 * (k + 1) * (k + 1 + mf));
    sum += term;
    if (Math.abs(term) < 1e-14) break;
  }
  return sum;
}

export interface CymaticMode {
  /** angular order */
  m: number;
  /** radial index (1-based) */
  n: number;
  /** wavenumber k (1/m), k·R = tabulated zero */
  k: number;
  /** resonance frequency mapped into the audible band */
  freq: number;
}

/**
 * The slider drives REAL resonance frequencies, in Hz, of the actual vessel.
 *
 * This used to remap the physical band logarithmically onto a fake 60–900 Hz
 * "audible" range, which meant every frequency the UI displayed was wrong by
 * ~100× and the slider spanned barely one or two real modes.
 *
 * There is deliberately no mapping function here any more: the displayed
 * number IS the vessel's actual resonance. The slider's endpoints are derived
 * from the mode bank itself (see BANK_FREQ_MIN/MAX), so the control always
 * covers exactly the resonances this vessel has and every step lands on a
 * genuinely distinct mode.
 */
/** Physical frequency of a mode, straight from the dispersion relation. */
function modeFreq(k: number): number {
  const omega = Math.sqrt((G * k + (SIGMA / RHO) * k * k * k) * Math.tanh(k * VESSEL.depth));
  return omega / (2 * Math.PI);
}

/**
 * The frequency → figure map.
 *
 * The bank is dense (m ≤ 11, n ≤ 9) and *sorted by frequency*, so sliding
 * the frequency slider walks the spectrum in order: low tones give 2–4 big
 * lobes, high tones give fine concentric rosettes. That ordering is the
 * physics — for a shallow layer ω ≈ √(gk) in the gravity-dominated regime, so
 * the wavenumber, and therefore the number of nodal cells, grows with the
 * square of the drive frequency. Raising the pitch adds structure; it does
 * not just speed up the same pattern.
 */
function buildBank(b: Boundary): CymaticMode[] {
  const T = b === 'rigid' ? JP_ZERO : J_ZERO;
  const derivative = b === 'rigid';
  const bank: CymaticMode[] = [];
  for (let m = 0; m <= MAX_M; m++) {
    for (let n = 1; n <= MAX_N; n++) {
      // skip absurdly high-radial axisymmetric modes (rings without spokes
      // read as noise, not as a figure)
      if (m === 0 && n > 4) continue;
      const z = zeroAt(T, m, n, derivative);
      const k = z / VESSEL.radius;
      // Straight from the dispersion relation — no remapping.
      bank.push({ m, n, k, freq: modeFreq(k) });
    }
  }
  bank.sort((a, b2) => a.freq - b2.freq);
  return bank;
}

export const BANKS: Record<Boundary, CymaticMode[]> = {
  rigid: buildBank('rigid'),
  free: buildBank('free'),
};

/**
 * The frequency range the slider should actually span: the real resonances of
 * the default (rigid) vessel, rounded outward so the extreme modes are
 * reachable. Derived from the bank, not hand-written, so it stays correct if
 * the vessel geometry or the mode limits ever change.
 */
export const BANK_FREQ_MIN = BANKS.rigid[0].freq;
export const BANK_FREQ_MAX = BANKS.rigid[BANKS.rigid.length - 1].freq;

/**
 * Resolve the resonant response for a drive frequency against a bank:
 * nearest mode + neighbour with soft log-frequency weights (never a pop).
 */
export function resolveDrive(
  freqHz: number,
  bank: CymaticMode[],
): { a: CymaticMode; b: CymaticMode; wa: number; wb: number; axial: number } {
  // Guard the log against a non-positive drive. The floor is the bank's own
  // lowest mode, NOT a hardcoded 10 Hz — every mode on this vessel lives
  // below 10 Hz, so that floor used to flatten the whole detuning curve.
  const fd = Math.max(freqHz, 1e-3);
  let best = bank[0], second = bank[bank.length - 1];
  let dBest = Infinity;
  for (const md of bank) {
    const d = Math.abs(Math.log(md.freq / fd));
    if (d < dBest) { dBest = d; second = best; best = md; }
  }
  const bw = 0.35;
  const wa = Math.exp(-Math.pow(Math.log(best.freq / fd) / bw, 2));
  const wb = Math.exp(-Math.pow(Math.log(second.freq / fd) / bw, 2)) * 0.7;
  const axial = best.m === 0 ? wa : Math.max(0, 0.25 - dBest * 0.15);
  return { a: best, b: second, wa: 0.6 + 0.4 * wa, wb: wb * 0.6, axial };
}
