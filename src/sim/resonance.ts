/**
 * ResonanceModel — audio → modal response (guide §8).
 *
 * What is modelled:
 *  - a bank of circular-domain eigenmodes (rigid/free wall, from ./lab/resonance);
 *  - each mode behaves as a driven, damped oscillator: its amplitude grows
 *    toward a detuning-weighted target and decays when the drive leaves it,
 *    so a sustained tone lets a pattern emerge and stopping lets it decay;
 *  - the reconstructed pattern Σ Aᵢ·φᵢ is injected into the wave solver as
 *    a forcing field — the dynamic field is never replaced by a static image.
 *
 * What is NOT claimed: the frequency→mode mapping is an illustrative
 * calibration (documented in README), not a measured property of a real dish.
 */
import { BANKS, FREQ_MAX, FREQ_MIN, VESSEL, type Boundary, type CymaticMode } from '../lab/resonance';

export interface ModeSlot {
  /** angular order m */
  m: number;
  /** dimensionless wavenumber k·R (Bessel argument at the basin radius) */
  kR: number;
  /** signed, smoothed modal amplitude (≤ ~level) */
  amp: number;
}

/** log-frequency bandwidth of a mode's response, in ln(f) units.
 *  Narrow enough that a tuned tone lights up 1–3 neighbouring modes —
 *  the figure reads as a pattern, not as interference soup. */
const BASE_BW = 0.055;

export class ResonanceModel {
  boundary: Boundary = 'rigid';
  /** UI harmonics control: also drive the mode nearest n×f_drive. */
  harm = 1;
  /** UI Response control 0..1 → how fast modes build and decay. */
  response = 0.5;

  private amps = new Map<string, number>();
  private bank: CymaticMode[] = BANKS.rigid;

  constructor() {
    this.bank = BANKS[this.boundary];
  }

  setBoundary(b: Boundary) {
    if (b === this.boundary) return;
    this.boundary = b;
    this.bank = BANKS[b];
    // amplitudes are keyed by mode identity — a different boundary is a
    // different physical system, so let the old pattern decay away
    this.amps.clear();
  }

  /**
   * Advance every modal amplitude one step toward its driven target.
   * Returns the strongest modes (max 4) for the forcing pass.
   */
  update(dt: number, freqHz: number, level: number): ModeSlot[] {
    const f = Math.min(FREQ_MAX, Math.max(FREQ_MIN, freqHz));
    const bw = BASE_BW + (1 - this.response) * 0.018;
    const tau = 1.25 - this.response * 0.95; // response: snappy ↔ slow build
    const k = 1 - Math.exp(-dt / Math.max(0.05, tau));

    const targets = new Map<string, number>();
    for (const mode of this.bank) {
      // Keep the driven mode coherent. A small amount of the second nearest
      // mode can enrich the pattern, but broad overlapping modes turn the
      // standing figure into a pale interference sheet with no clear nodes.
      const w = resonanceWeight(mode.freq, f, bw);
      if (w < 0.035) continue;
      targets.set(key(mode), level * w);
    }
    // Harmonics are intentionally not added as a second frequency family
    // here: the minimal UI has one frequency control and should read as one
    // crisp resonance at a time rather than a stack of unrelated modes.

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
      if (Math.abs(amp) > 0.01) slots.push({ m: mode.m, kR: mode.k * VESSEL.radius, amp });
    }
    slots.sort((a, b) => Math.abs(b.amp) - Math.abs(a.amp));
    // One selected mode keeps the frequency-to-pattern relationship legible.
    // The travelling-wave solver remains responsible for the transient,
    // interference and natural variation caused by pointer strikes.
    const top = Math.abs(slots[0]?.amp ?? 0);
    const kept = slots.filter((s) => Math.abs(s.amp) > top * 0.78);
    return kept.slice(0, 1);
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
  const d = Math.log(fMode / Math.max(10, fDrive));
  return Math.exp(-(d / bw) * (d / bw));
}
