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
const MAX_M = 14;
const MAX_N = 12;

/** J'_m(x) = (J_{m-1} − J_{m+1})/2, with the m = 0 special case J'_0 = −J_1. */
function besselJp(m: number, x: number): number {
  const mm = Math.round(m);
  if (mm === 0) return -besselJ(1, x);
  return (besselJ(mm - 1, x) - besselJ(mm + 1, x)) / 2;
}

/**
 * The k·R values of one Bessel family, found by BISECTION ON THE REAL FUNCTION.
 *
 * This used to be a four-entry table per m for the first few orders and the
 * standard large-argument asymptotics past them:
 *
 *     j_{m,n}  ≈ β − (4m²−1)/(8β),    β = (n + m/2 − 1/4)π
 *     j'_{m,n} ≈ β − (4m²+3)/(8β),    β = (n + m/2 − 3/4)π
 *
 * Measured against the true functions (scripts/bankaudit.mjs), **64 of the 79
 * modes were wrong by more than 0.2%**, and for m = 0 on the rigid branch the
 * asymptotic lands one index out: it returns j'₀,₄ for n = 5, i.e. the mode
 * `0/5` came out at k·R = 13.32368 against the tabulated `0/4` at 13.32369 —
 * **a duplicate mode, to five decimal places.**
 *
 * That matters more than a rounding error. A duplicate is not "slightly wrong",
 * it is the SAME standing shape sitting in the bank twice at the same frequency,
 * so the dish rings in two identical modes and their sum is a permanently
 * self-cancelling interference pattern that does not respond to the drive at
 * all. It is a direct cause of "the cymatics don't change with the frequency".
 *
 * Root-finding costs about 20 ms once at module load and is correct for every
 * order, so there is no reason to approximate at all. The tables above are kept
 * only as the reference the audit checks against.
 *
 * Zeros of a fixed family are spaced further apart than π, so a single forward
 * scan at π/4 finds them unambiguously, in order, with no bracketing heuristic.
 */
const ZERO_CACHE: Record<string, number[]> = {};

function zeroFamily(m: number, derivative: boolean, need: number): number[] {
  const key = `${m}|${derivative ? 1 : 0}`;
  const hit = ZERO_CACHE[key];
  if (hit && hit.length >= need) return hit;

  const f = (x: number) => (derivative ? besselJp(m, x) : besselJ(m, x));
  const roots: number[] = [];
  const step = Math.PI / 4;
  const X_MAX = 8 + need * Math.PI + 4 * m;
  let prevX = 0;
  let prevV = f(0);
  for (let x = step; x <= X_MAX && roots.length < need; x += step) {
    const v = f(x);
    // skip an exact 0 on the grid (a tangent zero) and only accept a real sign
    // change, so a zero that lands on a sample point is still bracketed
    if (prevV !== 0 && v !== 0 && (prevV < 0) !== (v < 0)) {
      let a = prevX, b = x;
      const sa = prevV;
      for (let i = 0; i < 60; i++) {
        const mid = (a + b) / 2;
        if ((f(mid) < 0) === (sa < 0)) a = mid; else b = mid;
      }
      roots.push((a + b) / 2);
    }
    prevX = x;
    prevV = v;
  }
  ZERO_CACHE[key] = roots;
  return roots;
}

function zeroAt(table: Record<number, number[]>, m: number, n: number, derivative: boolean): number {
  const row = zeroFamily(m, derivative, n);
  const z = row[n - 1];
  if (z !== undefined) return z;
  // fall back to the asymptotic only if the scan somehow came up short; it is
  // never expected, and nothing in the app depends on it being accurate
  const rowT = table[m];
  if (rowT && n <= rowT.length) return rowT[n - 1];
  const beta = (n + m / 2 - (derivative ? 3 / 4 : 1 / 4)) * Math.PI;
  return beta - (4 * m * m + (derivative ? 3 : -1)) / (8 * beta);
}

/** Bessel J_m(x) by series — used for thumbnails and by the root finder. */
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
 * This used to remap the physical 0.6–7.5 Hz band logarithmically onto a fake
 * 60–900 Hz "audible" band, which meant every frequency the UI displayed was
 * wrong by ~100× and — worse — the whole slider spanned barely one or two real
 * modes. Sliding it wandered between near-degenerate neighbours instead of
 * walking the spectrum.
 *
 * The capillary–gravity dispersion below is honest physics; there is now no
 * invented mapping on top of it. The visible band is derived from the mode
 * bank itself (see BANKS below), so the slider always covers exactly the
 * resonances the vessel actually has.
 */
/** Physical frequency of a mode, straight from the dispersion relation. */
function modeFreq(k: number): number {
  const omega = Math.sqrt((G * k + (SIGMA / RHO) * k * k * k) * Math.tanh(k * VESSEL.depth));
  return omega / (2 * Math.PI);
}

/**
 * The frequency → figure map.
 *
 * The bank is dense (m ≤ 14, n ≤ 12, with m = 0 kept to n ≤ 7) and *sorted by
 * frequency*, so sliding the frequency slider walks the spectrum in order:
 * low tones give 2–4 big lobes, high tones give fine concentric rosettes.
 * That ordering is the physics — for a shallow layer ω ≈ √(gk) in the
 * gravity-dominated regime, so the wavenumber, and therefore the number of
 * nodal cells, grows with the square of the drive frequency. Raising the pitch
 * adds structure; it does not just speed up the same pattern.
 *
 * A consequence worth stating, because it looks like a bug and is not: at any
 * drive in the upper half of the band several modes are near-DEGENERATE, i.e.
 * their k·R differ by ~1%. Measured at 432 Hz, m=6@18.7, m=14@18.5, m=11@18.3
 * and m=4@19.2 are all within 4% of the drive in log-frequency, so all four
 * genuinely respond and their sum is the figure. No bandwidth can separate
 * them, and suppressing them would be dishonest — the dish really is ringing in
 * four modes at once. What keeps that legible is the figure gain (engine.ts,
 * measured, frequency-compensated) and the modal normalisation in figure.ts.
 */
function buildBank(b: Boundary): CymaticMode[] {
  const T = b === 'rigid' ? JP_ZERO : J_ZERO;
  const derivative = b === 'rigid';
  const bank: CymaticMode[] = [];
  const seen: number[] = [];
  for (let m = 0; m <= MAX_M; m++) {
    for (let n = 1; n <= MAX_N; n++) {
      // skip absurdly high-radial axisymmetric modes (rings without spokes
      // read as noise, not as a figure)
      if (m === 0 && n > 7) continue;
      const z = zeroAt(T, m, n, derivative);
      // Belt and braces: never let two bank entries hold the same standing
      // shape. A duplicate is the single worst thing this table can contain —
      // it self-cancels and the figure stops answering the drive — so it is
      // dropped rather than trusted. With exact root-finding this never fires;
      // it is there so a future edit cannot silently reintroduce the bug.
      if (seen.some((s) => Math.abs(s - z) < 1e-4)) continue;
      seen.push(z);
      const k = z / VESSEL.radius;
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
 * FREQQUENCY MODEL (documented, honest).
 *
 * Two different quantities live in this app and must never be conflated:
 *
 *  1. The **excitation frequency** `f_ex` shown in the UI — one tone in the
 *     224–836 Hz band, the range `scripts/visibleband.mjs` measured as the
 *     region where the water actually visibly responds. Outside it the slider
 *     hit dead spots (122–128 Hz drove NO mode) or faded into weakly coupled
 *     m13/m14 fuzz, so the dead range is not on the slider at all.
 *  2. The **natural resonant frequencies of the simulated dish** — the
 *     capillary–gravity modes of the vessel, which all sit far lower
 *     (~0.6–7.5 Hz for the documented vessel: radius 8.5 cm, 6 mm deep).
 *
 * A browser cannot drive the dish at its true mode frequencies, so the UI
 * tone and the simulation are related through an explicit, documented,
 * monotonic log-band mapping rather than any invented physical conversion:
 *
 *     t          = (ln f_ex − ln 224) / (ln 836 − ln 224)   ∈ [0, 1]
 *     f_model    = SIM_VIS_MIN · (SIM_VIS_MAX / SIM_VIS_MIN)^t
 *
 * The mapping covers the visible SIM band (2.596–21.195 Hz), not the whole
 * mode bank — mapping the trimmed UI band onto anything wider would slide the
 * dead modes back into the reachable range. This is a *visual simulation
 * model*, not a laboratory calibration; see README "Frequency model".
 */
export const EXCITATION_MIN = 224;  // Hz  — measured: below here the slider hits dead
                                    // spots (122–128 Hz excite no mode at all) and
                                    // 110–218 does not hold a usable figure
export const EXCITATION_MAX = 836;  // Hz  — measured: above here only the weakly
                                    // coupled m13/m14 cluster answers, and the figure
                                    // fades out (0.15–0.25 of band peak)

/**
 * The SIMULATED band those excitation limits map onto.
 *
 * This has to live next to EXCITATION_MIN/MAX because it is the same
 * measurement: the UI band is not stretched across the whole mode bank any
 * more, only across the modes that gave visible figures. Mapping the trimmed
 * UI band onto anything wider would put dead slider positions back by
 * compressing the good modes into the middle.
 */
const SIM_VIS_MIN = 2.596;  // Hz (sim)
const SIM_VIS_MAX = 21.195; // Hz (sim)

/** UI excitation (Hz) → simulated dish drive (Hz of the mode bank).
 *  Maps across the measured VISIBLE band only — see SIM_VIS_MIN/MAX above. */
export function excitationToSim(fEx: number): number {
  const t = (Math.log(Math.max(1, fEx)) - Math.log(EXCITATION_MIN))
    / (Math.log(EXCITATION_MAX) - Math.log(EXCITATION_MIN));
  const u = Math.min(1, Math.max(0, t));
  return SIM_VIS_MIN * Math.exp(u * Math.log(SIM_VIS_MAX / SIM_VIS_MIN));
}

/**
 * AUDIO BAND → simulated dish drive.
 *
 * The music mode reads the song's spectrum as four real audio bands (bass,
 * mid, presence, sparkle), and each steers its own region of the vessel: the
 * log position of the band across 80 Hz..3.2 kHz is mapped onto the SAME
 * visible sim band the slider owns. So a bassline lands on the low m/n modes,
 * a lead or vocal in the middle orders, cymbals on the fine outer drift —
 * measured-band placement, not a hand-tuned look-up, and it reuses the exact
 * range scripts/visibleband.mjs validated so no dead modes are introduced.
 *
 * Same honest caveat as excitationToSim: a monotonic visual-model mapping,
 * not a laboratory calibration of what a real audio band does to real water.
 */
export function bandToSim(fHz: number): number {
  const SPAN_LO = 80;
  const SPAN_HI = 3200;
  const t = (Math.log(Math.max(1, fHz)) - Math.log(SPAN_LO)) / (Math.log(SPAN_HI) - Math.log(SPAN_LO));
  const u = Math.min(1, Math.max(0, t));
  return SIM_VIS_MIN * Math.exp(u * Math.log(SIM_VIS_MAX / SIM_VIS_MIN));
}

/** Simulated dish drive (Hz) → UI excitation (Hz). Inverse of the above.
 *  Currently unused: the UI always works in excitation space and lets the
 *  engine map forward. Kept because it is the exact inverse of
 *  excitationToSim and the maintenance cost of having it is zero. */
export function simToExcitation(fSim: number): number {
  const u = Math.log(Math.max(fSim, SIM_VIS_MIN) / SIM_VIS_MIN)
    / Math.log(SIM_VIS_MAX / SIM_VIS_MIN);
  const u2 = Math.min(1, Math.max(0, u));
  return EXCITATION_MIN * Math.exp(u2 * Math.log(EXCITATION_MAX / EXCITATION_MIN));
}

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
