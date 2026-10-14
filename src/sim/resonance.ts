/**
 * ResonanceModel — audio → modal response (guide §8).
 *
 * What is modelled:
 *  - a bank of circular-domain eigenmodes (rigid/free wall, from ./lab/resonance);
 *  - each mode behaves as a driven, damped oscillator: its amplitude grows
 *    toward a detuning-weighted target and decays when the drive leaves it,
 *    so a sustained tone lets a pattern emerge and stopping lets it decay;
 *  - the reconstructed pattern Σ Aᵢ·φᵢ is injected as an analytic forcing
 *    field — the dynamic field is never replaced by a static image.
 *
 * Frequency-dependent structure (the core functional fix): each mode carries
 * a DETERMINISTIC orientation phase φ(m,n) and the drive's log-frequency
 * selectivity is sharpened, so different excitation frequencies resolve to
 * genuinely different dominant (m, n) pairs — different angular orders give
 * different spoke counts, different radial orders give different ring
 * structures, and the superposition of the top 3–4 modes gives the
 * interference filaments real plates show. The response stays smooth (modes
 * cross-fade, never pop) and fully repeatable for the same input.
 *
 * What is NOT claimed: the frequency→mode mapping is the documented visual
 * simulation band of §lab/resonance.ts, not a measured property of a dish.
 */
import { BANKS, BANK_FREQ_MAX, BANK_FREQ_MIN, VESSEL, type Boundary, type CymaticMode } from '../lab/resonance';

export interface ModeSlot {
  /** angular order m */
  m: number;
  /** dimensionless wavenumber k·R (Bessel argument at the basin radius) */
  kR: number;
  /** signed, smoothed modal amplitude (≤ ~level) */
  amp: number;
  /** deterministic orientation of the nodal figure (radians) */
  phase: number;
}

/** Narrowest log-frequency response width, in ln(f) units — the vessel's
 *  quality factor at its most crowded. This is what stops four near-degenerate
 *  modes summing into concentric rings instead of a figure.
 *
 *  It is a FLOOR, not a constant: update() widens the response to the local
 *  mode spacing where the modes are sparse, so no part of the slider is dead. */
const BASE_BW = 0.035;

/**
 * How efficiently the drive couples to a mode of angular order m.
 *
 * No bandwidth can separate genuinely degenerate modes, and the bank is full of
 * them. The zeros are now solved exactly (lab/resonance.ts root-finds them
 * rather than approximating past the fourth order, which used to inject modes
 * that did not exist — see the audit in that file), so there are no phantom
 * duplicates left. But real physics still places several orders within a
 * fraction of a percent of one another in k·R, far inside any plausible Q: they
 * all genuinely respond, their sum is radially coherent, and the dish shows
 * concentric rings rather than a figure.
 *
 * Coupling is the physical lever. A real vessel is driven from below, or by a
 * broad pressure across its floor, and a mode of angular order m moves
 * progressively less net volume for the same drive: the m-fold cancellation
 * around the circumference grows with m. So high angular orders are driven less
 * efficiently, which is exactly why a real Chladni figure at a given tone is
 * named by a LOW order with a clear spoke count.
 *
 * This is a modelling choice, not a measurement, and it is stated as one — but
 * it is the standard way this degeneracy is resolved, and without it the whole
 * upper half of the band renders as circles.
 */
const COUPLING_PER_M = 0.085;

/** Deterministic orientation for a mode's angular phase (repeatable). */
function orientPhase(m: number, n: number): number {
  const h = Math.sin(m * 127.1 + n * 311.7) * 43758.5453;
  return (h - Math.floor(h)) * Math.PI * 2;
}

export class ResonanceModel {
  boundary: Boundary = 'rigid';
  /** UI harmonics control: also drive the mode nearest n×f_drive. */
  harm = 1;
  /** UI Response control 0..1 → how fast modes build and decay. */
  response = 0.5;
  /**
   * Snap-follow: amplitudes walk to their new targets in a couple of frames
   * instead of over a second.
   *
   * It is set by the UI, not inferred: in **Frequency mode** every slider
   * movement is an explicit instruction, so the figure must jump to it
   * immediately — with the smooth tau (0.44–1.25 s) the figure kept melting
   * toward the new shape for well over a second after the slider moved, which
   * reads as "not reacting" however responsive the mapping is. In **Tone mode**
   * this stays OFF: the audio path feeds a smoothed spectral centroid and the
   * gentle tau is what keeps that follow musical instead of twitchy.
   */
  snapFollow = false;

  private amps = new Map<string, number>();
  private bank: CymaticMode[] = BANKS.rigid;
  /** ln-frequency of each mode — the search is done in log space throughout. */
  private logF: number[] = [];
  /**
   * How far a mode has to reach to hand off to its neighbours on BOTH sides.
   *
   * This is the LARGER of the two neighbour gaps, and taking the larger one is
   * the whole point. Sizing it from the next mode up alone is what left the
   * bottom of the slider dead: m1@1.84 sits 50% (in log frequency) from the
   * mode below it in the bank but only 23% from the mode above, so the band
   * came out at 0.095 — far too narrow to reach either. A drive at 130 Hz then
   * excited NOTHING at all and the water sat dead flat.
   */
  private span: number[] = [];

  constructor() {
    this.bank = BANKS[this.boundary];
    this.index();
  }

  private index() {
    this.logF = this.bank.map((m) => Math.log(m.freq));
    this.span = this.logF.map((ln, i) => {
      const prev = i > 0 ? ln - this.logF[i - 1] : Infinity;
      const next = i < this.logF.length - 1 ? this.logF[i + 1] - ln : Infinity;
      const s = Math.max(prev, next);
      return Number.isFinite(s) ? s : BASE_BW;
    });
  }

  setBoundary(b: Boundary) {
    if (b === this.boundary) return;
    this.boundary = b;
    this.bank = BANKS[b];
    this.index();
    // amplitudes are keyed by mode identity — a different boundary is a
    // different physical system, so let the old pattern decay away
    this.amps.clear();
  }

  /**
   * Advance every modal amplitude one step toward its driven target.
   * Returns the strongest modes (max 4) for the forcing pass.
   */
  update(dt: number, freqHz: number, level: number): ModeSlot[] {
    // Clamp to the vessel's REAL resonance range, derived from the bank.
    const f = Math.min(BANK_FREQ_MAX, Math.max(BANK_FREQ_MIN, freqHz));
    const lnF = Math.log(Math.max(1e-3, f));
    const bw = this.bwFor(lnF);
    // Amplitude time constant. Snap-follow replaces it outright: 0.08 s walks
    // ~38% of the way per frame at 60 fps, so a slider move is fully drawn
    // within a few frames — instant to the eye — while a steady tone still
    // holds perfectly still once converged.
    const k = 1 - Math.exp(-dt / Math.max(0.05, this.tau()));

    const targets = new Map<string, number>();
    for (const mode of this.bank) {
      let w = resonanceWeight(mode.freq, f, bw) * coupling(mode.m);
      if (this.harm > 1) w = Math.max(w, 0.55 * resonanceWeight(mode.freq, f * this.harm, bw) * coupling(mode.m));
      if (w < 0.02) continue;
      targets.set(key(mode), level * w);
    }
    return this.settle(dt, k, targets);
  }

  /**
   * The MUSIC driver: a spectrum of contributions instead of one frequency.
   *
   * Each entry is one analysed audio band already mapped onto the sim band
   * (lab/resonance.ts bandToSim), carrying its own 0..1 loudness. Every band
   * places its own lobe, so a bassline and a cymbal ride sit in the bank at
   * the same time and the figure becomes a superposition that follows the
   * mix — bass modes decay as the kick stops, high orders rise as the top
   * end comes in. A mode's target is the SUM of what drives it, capped at 1,
   * which is also why a full mix does not simply slam flat: four bands rarely
   * peak together, and the cap keeps any crossover moment inside the range
   * the figure pass was tuned for.
   */
  updateSpectrum(dt: number, bands: Array<{ f: number; level: number }>): ModeSlot[] {
    const k = 1 - Math.exp(-dt / Math.max(0.05, this.tau()));
    const targets = new Map<string, number>();
    for (const { f: rawF, level } of bands) {
      if (!(level > 0.03)) continue; // a silent band places no lobe at all
      const f = Math.min(BANK_FREQ_MAX, Math.max(BANK_FREQ_MIN, rawF));
      const bw = this.bwFor(Math.log(Math.max(1e-3, f)));
      for (const mode of this.bank) {
        const w = resonanceWeight(mode.freq, f, bw) * coupling(mode.m);
        if (w < 0.04) continue;
        const kk = key(mode);
        targets.set(kk, Math.min(1, (targets.get(kk) ?? 0) + level * w));
      }
    }
    return this.settle(dt, k, targets);
  }

  /** Per-band time constant — shared by the single-frequency and spectral paths. */
  private tau(): number {
    return this.snapFollow ? 0.08 : 1.25 - this.response * 0.95;
  }

  /**
   * Log-frequency response width at the drive's position in the bank.
   *
   * A FIXED bandwidth is wrong at both ends of the band, in opposite
   * directions:
   *
   *  - at the top the modes are dense, and a narrow Q is what stops four
   *    near-degenerate modes summing into rings;
   *  - at the bottom they are far apart — f ∝ k^1.5 gives relative spacing
   *    that SHRINKS as k grows, so the first modes are 50% apart in log
   *    frequency. A fixed ln-bandwidth narrow enough to separate the dense
   *    ones is far narrower than the bottom gaps, so the lowest third of the
   *    slider drove nothing at all: 110 Hz and 165 Hz both returned m1@1.84,
   *    the figure was identical, and moving the slider looked broken.
   *
   * So the response width follows the LOCAL spacing: sharp where the modes
   * crowd (real Q), wide enough where they are sparse (so every drive lands
   * on a mode). A drive always excites its nearest neighbour, which is also
   * what a real dish does. `span` is the reach to the FURTHEST of a mode's two
   * neighbours, so the lobe always hands off on both sides — see this.span.
   */
  private bwFor(lnF: number): number {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < this.logF.length; i++) {
      const d = Math.abs(this.logF[i] - lnF);
      if (d < bd) { bd = d; bi = i; }
    }
    const span = this.span[bi] ?? BASE_BW;
    return Math.max(BASE_BW + (1 - this.response) * 0.025, span * 0.42);
  }

  /**
   * Walk all modal amplitudes toward their targets one step; return the
   * strongest slots for the forcing pass. Shared by both drive paths.
   */
  private settle(dt: number, k: number, targets: Map<string, number>): ModeSlot[] {
    // decay amplitudes of modes the drive no longer touches
    for (const [key, amp] of this.amps) {
      const target = targets.get(key) ?? 0;
      this.amps.set(key, amp + (target - amp) * k);
      if (Math.abs(this.amps.get(key)!) < 1e-4 && target === 0) this.amps.delete(key);
    }
    for (const [key, target] of targets) {
      if (!this.amps.has(key)) this.amps.set(key, 0);
    }

    const slots: ModeSlot[] = [];
    for (const mode of this.bank) {
      const amp = this.amps.get(key(mode)) ?? 0;
      if (Math.abs(amp) > 0.01) {
        slots.push({ m: mode.m, kR: mode.k * VESSEL.radius, amp, phase: orientPhase(mode.m, mode.n) });
      }
    }
    slots.sort((a, b) => Math.abs(b.amp) - Math.abs(a.amp));
    // Dominant + whoever is within 55% of it, up to four. The DOMINANT mode is
    // what names the figure (its m sets the spoke count, its n the ring
    // count); the weaker riders add the fine beating and cross-hatching.
    // With the sharper bandwidth above different drives resolve to different
    // leaders, so the spectrum "goes somewhere" as the slider walks it.
    const top = Math.abs(slots[0]?.amp ?? 0);
    return slots.filter((s) => Math.abs(s.amp) > top * 0.55).slice(0, 4);
  }

  /** Dominant mode name for diagnostics / debug overlay. */
  dominant(): string {
    let best: CymaticMode | null = null;
    let bestAmp = 0;
    for (const mode of this.bank) {
      const amp = Math.abs(this.amps.get(key(mode)) ?? 0);
      if (amp > bestAmp) { bestAmp = amp; best = mode; }
    }
    return best ? `m=${best.m} n=${best.n}` : '—';
  }

  reset() { this.amps.clear(); }
}

function key(mode: CymaticMode): string {
  return `${mode.m}_${mode.n}`;
}

/** Soft detuning response: 1 on resonance, → 0 as the drive leaves the mode. */
function resonanceWeight(fMode: number, fDrive: number, bw: number): number {
  const d = Math.log(fMode / Math.max(1e-3, fDrive));
  return Math.exp(-(d / bw) * (d / bw));
}

/** Drive efficiency against angular order — see COUPLING_PER_M. */
function coupling(m: number): number {
  return Math.exp(-m * COUPLING_PER_M);
}
