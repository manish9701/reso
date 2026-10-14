/**
 * LabEngine — orchestration for the Resonant Ink dish.
 *
 * The scene is a real 3D set (guide §3/§4): a lathed glass vessel, a
 * subdivided liquid surface, a white studio with a baked reflection
 * environment, and a GPU simulation pipeline feeding both geometry and
 * shading:
 *
 *   audio → ResonanceModel (modal amplitudes)
 *         → forcing pass   (Σ Aᵢ·φᵢ)
 *         → wave solver    (ping-pong height/velocity field)
 *         → pigment solver (semi-Lagrangian advection from that field)
 *         → liquid material (displacement, normals, caustics, dye colour)
 *         → studio render   (glass, environment, ground, contact shadow)
 *
 * Responsibilities stay separated so the render never fakes the physics:
 * this file is plumbing only.
 */
import * as THREE from 'three';
import { Studio } from './studio';
import { createDishGeometry, createDishMaterial } from './dish';
import { createLiquidGeometry, createLiquidMaterial, LIQUID_R, LIQUID_Y, type LiquidUniforms } from './liquid';
import { ResonanceModel } from '../sim/resonance';
import { WaveSimulation, SIM_SIZE } from '../sim/wave';
import { FigureField, FIGURE_GAIN } from '../sim/figure';
import { PigmentSimulation } from '../sim/pigment';
import { DropletSystem } from '../sim/droplets';
import { FullscreenPass, makeTarget } from '../sim/pass';
import { COMBINE_FS } from '../sim/shaders';
import { BANKS, besselJ, resolveDrive, VESSEL, excitationToSim, type Boundary } from './resonance';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export interface LabOptions {
  reflections: boolean;
  /** (a former caustic toggle; the caustic/emissive term was removed — see liquid.ts) */
  caustics: boolean;
  depth: boolean;
  nodalMap: boolean;
  grain: boolean;
  glow: boolean;
}

export interface SimParams {
  damp: number;     // 0..1 → velocity decay rate
  tension: number;  // 0..1 → Courant number (wave speed)
  visc: number;     // 0..1 → pigment diffusion
  force: number;    // 0..1 strike force
  size: number;     // 0..1 tool radius
  amount: number;   // 0..1 deposit mass
  spread: number;   // 0..1 deposit radius
  persist: number;  // 0..1 mass persistence
}

/** Pointer strike → direct velocity kick (h_ring ≈ Δv/ω ≈ 0.3). */
const IMPULSE_GAIN = 5;
/**
 * Optical relief gain at the reference mode scale, and the exponent that
 * compensates it across the band.
 *
 * This is an OPTICAL gain, not geometry: the surface displacement stays
 * millimetric and the shading normal (which drives both the reflection and
 * the refracted basin) is what carries the relief.
 *
 * The exponent is NEGATIVE, and that is the whole point of the measurement.
 * The old law was `RELIEF_BASE · (kR/10)^0.42` — i.e. it RAISED the gain with
 * the mode's wavenumber. But the field gradient already grows with kR: a
 * higher mode packs the same amplitude into a shorter wavelength, so its
 * ∂h/∂u is larger before the gain is applied at all. Multiplying the two
 * compounds, and the result was a uniform ~10x overdrive.
 *
 * Measured with scripts/slope.mjs over twelve stops of the band:
 *
 *     kR        grad ∂h/∂u        gain needed      gain this used to apply
 *     p50   p90  (p90)            (p90 slope 0.20) (old law)
 *     1.8    0.84  1.11               19.6             19.8
 *     5.3    1.33  2.77                7.9             16.8
 *     9.3    1.36  3.16                6.9             21.4
 *    18.7    2.28  6.41                3.4             28.5
 *    33.9    2.20  6.31                3.5             36.4
 *    55.6    2.42  6.66                3.3             44.9
 *
 * So the required gain FALLS by roughly 6x across the band, while the old law
 * rose by 2.3x. `6.5 · (kR/10)^-0.52` fits the measured requirement to within
 * about 25% everywhere except the two lowest modes, where it sits low and the
 * figure reads as a gentler swell — which is the better failure.
 *
 * Why this mattered visually: at 432 Hz the old law put 82.9% of the dish past
 * the shader's slope clamp, and 87.7% at 790 Hz. A clamped region has a
 * CONSTANT normal, so it renders as one flat tone — the "weird" quilted,
 * hard-edged embossed pattern stamped across the water. Nothing to tune once
 * the clamp is soft (see liquid.ts); the gain simply has to be right.
 */
const RELIEF_BASE = 6.5;
const RELIEF_EXP = -0.52;
/** Hard bounds on the optical gain, so no mode can collapse or invert the relief. */
const RELIEF_MIN = 2.6;
const RELIEF_MAX = 20;

/**
 * Ink colour → optical density (Beer–Lambert). A pigment that *looks* like
 * colour c is a filter that transmits exp(−A); so A = −ln(c). Working in
 * absorbance is what makes two inks mix like real paint instead of averaging
 * toward mud.
 */
export function inkAbsorbance(rgbSrgb: [number, number, number], strength = 1): [number, number, number] {
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [
    -Math.log(Math.max(toLinear(rgbSrgb[0]), 0.015)) * strength,
    -Math.log(Math.max(toLinear(rgbSrgb[1]), 0.015)) * strength,
    -Math.log(Math.max(toLinear(rgbSrgb[2]), 0.015)) * strength,
  ];
}
/**
 * Temporal model (README "modal lock"): the audio frequency selects which
 * modes respond; the visible figure is the analytic standing pattern
 * (FigureField) breathing at a sub-visible rate, while the wave grid carries
 * genuine travelling ripples from strikes. A 432 Hz oscillation could never
 * be resolved by a 512² / 480 Hz solver anyway (it would alias), so the
 * *audio* rate drives which modes are lit, and the eye sees the envelope —
 * the same reasoning as visible-rate cymatics footage.
 */

export class LabEngine {
  canvas: HTMLCanvasElement;
  private studio: Studio;
  private dish: THREE.Mesh;
  private liquid: THREE.Mesh;
  private liquidUniforms: LiquidUniforms;
  private wave: WaveSimulation;
  private figure: FigureField;
  private combine: FullscreenPass;
  private fieldTarget: THREE.WebGLRenderTarget;
  private pigment: PigmentSimulation;
  private droplets: DropletSystem;
  private resonance = new ResonanceModel();
  private breath = 0;

  time = 0;
  dead = false;
  drive: { freq: number; level: number } = { freq: 220, level: 0 };
  /** Target drive level from the UI; engine.step smooths drive.level toward it. */
  driveTarget = 0;
  /**
   * The music spectrum (tone mode): analysed audio bands already mapped onto
   * the sim band by the UI. Non-null switches the resonance to the spectral
   * driver — see ResonanceModel.updateSpectrum; null always means the
   * single-frequency model, which is what the slider path sets.
   */
  driveSpectrum: Array<{ f: number; level: number }> | null = null;
  pointer = { x: 0.5, y: 0.5 };
  boundary: Boundary = 'rigid';
  harm = 1;
  sim: SimParams = { damp: 0.92, tension: 0.7, visc: 0.4, force: 0.6, size: 0.4, amount: 0.8, spread: 0.6, persist: 0.7 };
  opts: LabOptions = { reflections: true, caustics: false, depth: true, nodalMap: false, grain: false, glow: false };
  gather = 0.35;      // nodal streaming (Behavior)
  diffusion = 0.12;   // pigment diffusion (Behavior)
  /** QA override for the drive — see ?drive= in Cymatics.tsx. */
  forcedDrive: { freq: number; level: number } | null = null;
  noForce = false;
  noImp = false;
  /** Development/profiling switches — see scripts/profile.mjs. */
  __noWave = false;
  __noDye = false;
  noFigure = false;
  /** True when the standing figure needs re-rendering this frame. */
  figureDirty = true;
  /** Fingerprint of the modal state the figure last rendered, and the breath
   *  phase it was rendered at — the render-on-change keys for the figure
   *  pass (per-frame allocation-free comparison of the modal state). */
  private __lastFingerprint = '';
  /** Drive frequency the figure was last drawn for — see the 0b dirty check. */
  private __lastDriveFreq = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.studio = new Studio(canvas);

    // ---- vessel + liquid ------------------------------------------------
    // castShadow/receiveShadow: the vessel grounds on the set through the
    // studio's real key-light shadow map, and the water accepts the shadows
    // falling INTO it (a drop's shadow on the water sells the contact).
    const dishGeo = createDishGeometry();
    const { material: steel } = createDishMaterial();
    this.dish = new THREE.Mesh(dishGeo, steel);
    this.dish.castShadow = true;
    this.dish.receiveShadow = false;
    this.dish.position.y = 0;
    this.studio.scene.add(this.dish);
    // hand the vessel to the studio so the sweep can mirror it
    this.studio.attachVessel();

    const { material, uniforms } = createLiquidMaterial();
    this.liquidUniforms = uniforms;
    this.liquid = new THREE.Mesh(createLiquidGeometry(), material);
    this.liquid.position.y = LIQUID_Y;
    // Deliberately NOT a shadow receiver: measured on the target machine,
    // PCFSoft sampling inside the transmissive liquid shader cost ~120 ms
    // per frame as soon as the shadow map contained close-range geometry
    // (a falling drop). The water's contact shading comes from the field
    // and the environment; grounded shadows live on the ground plane.
    this.liquid.receiveShadow = false;
    this.liquid.frustumCulled = false;
    this.studio.scene.add(this.liquid);

    // ---- droplets --------------------------------------------------------
    // Falling drops of coloured liquid. They are a separate, CPU-integrated
    // system because their physics is ballistic and their rendering is a few
    // dozen small meshes — neither of which belongs in a ping-pong GPU pass.
    this.droplets = new DropletSystem();
    this.studio.scene.add(this.droplets.group);

    // ---- simulation ------------------------------------------------------
    const floatOK = this.studio.renderer.extensions.has('EXT_color_buffer_float')
      || this.studio.renderer.extensions.has('EXT_color_buffer_half_float');
    if (!floatOK) {
      this.dispose();
      throw new Error('This experiment needs WebGL2 with floating-point render targets.');
    }
    this.wave = new WaveSimulation(this.studio.renderer);
    this.figure = new FigureField(this.studio.renderer);
    // The pigment buffer follows the detected GPU tier (1024 on a discrete
    // GPU, 768 on the lean one). It did not: the engine called the
    // constructor bare and always got DYE_SIZE, so the advection pass ran at
    // full cost on an integrated GPU that quality.ts had already decided was
    // ten times too slow — the exact tiering failure the module documents.
    this.pigment = new PigmentSimulation(this.studio.renderer, this.studio.profile.dye);
    this.liquidUniforms.uLean.value = this.studio.profile.lean;
    this.fieldTarget = makeTarget(SIM_SIZE, SIM_SIZE, THREE.HalfFloatType);
    this.combine = new FullscreenPass(COMBINE_FS, {
      uFigure: { value: this.figure.texture },
      uWave: { value: this.wave.texture },
      uFigureGain: { value: FIGURE_GAIN },
      uWaveGain: { value: 1.0 },
    });

    this.liquidUniforms.uTexel.value.set(1 / SIM_SIZE, 1 / SIM_SIZE);
    this.applyOptions();

    const dbg = new URLSearchParams(window.location.search).get('debug');
    const DEBUG_MODES: Record<string, number> = {
      dye: 1, mode: 2, h: 3, cover: 5, sampler: 7, refract: 8,
    };
    this.liquidUniforms.uDebug.value = dbg ? (DEBUG_MODES[dbg] ?? 0) : 0;
  }

  /* ---------------------------------------------------------------- */
  /* geometry / optics                                                 */
  /* ---------------------------------------------------------------- */

  resize(): void {
    if (this.dead) return;
    const rect = this.canvas.getBoundingClientRect();
    this.studio.resize(rect.width, rect.height);
  }

  private applyOptions(): void {
    this.studio.setReflections(this.opts.reflections);
    this.liquidUniforms.uDepth.value = this.opts.depth ? 1 : 0;
    this.liquidUniforms.uNodal.value = this.opts.nodalMap ? 1 : 0;
  }

  /* ---------------------------------------------------------------- */
  /* interaction — canvas-normalised input → liquid-domain uv          */
  /* ---------------------------------------------------------------- */

  /**
 * Disc uv → world position on the liquid plane, for placing a falling drop.
 * The disc maps linearly onto the liquid mesh's xz extent, so this is just an
 * unproject — no raycast needed, and it stays correct as the dish is reframed.
 */
  private dropletUvToWorld = (u: number, v: number): { x: number; z: number } => ({
    x: (u - 0.5) * 2 * LIQUID_R,
    z: (v - 0.5) * 2 * LIQUID_R,
  });

  /** Map a canvas point (0..1) into the disc; null when it misses the dish. */
  private toDisc(cx: number, cy: number): { x: number; y: number } | null {
    const p = this.studio.pickLiquid(cx, cy);
    if (!p.hit) return null;
    let u = p.x / (2 * LIQUID_R) + 0.5;
    let v = p.y / (2 * LIQUID_R) + 0.5;
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.hypot(dx, dy);
    if (r > 0.505) return null;             // outside the dish entirely
    if (r > 0.495) {                         // allow painting right at the rim
      const k = 0.495 / r;
      u = 0.5 + dx * k;
      v = 0.5 + dy * k;
    }
    return { x: u, y: v };
  }

  /** One controlled travelling disturbance (guide §7). */
  strike(cx: number, cy: number, amp = 1): void {
    if (this.noImp) return;
    const p = this.toDisc(cx, cy);
    if (!p) return;
    const radius = 0.02 + this.sim.size * 0.06;
    const kick = amp * (0.35 + this.sim.force * 1.5) * IMPULSE_GAIN;
    this.wave.addImpulse(p.x, p.y, kick, radius * radius);
  }

  /** Queue a pigment dab (consumed by the next pigment pass). */
  deposit(cx: number, cy: number, radius: number, amount: number, color: [number, number, number]): void {
    const p = this.toDisc(cx, cy);
    if (!p) return;
    this.pigment.enqueue({
      x: p.x,
      y: p.y,
      radius: radius * (0.75 + this.sim.spread * 1.9),
      amount: amount * (0.2 + this.sim.amount * 0.85),
      absorbance: inkAbsorbance(color, 1.0),
    });
  }

  /**
   * Release a falling drop of `color` above a canvas point.
   *
   * This is the interaction the piece is built around: the colour is not
   * painted where you click, it is DROPPED there. The drop falls under
   * gravity, impacts the surface, and only then does its pigment enter the
   * water — where it mixes with whatever is already there and is then carried
   * by the cymatic flow.
   */
  dropIn(cx: number, cy: number, color: [number, number, number], volume = 0.5, radius = 0.018): void {
    const p = this.toDisc(cx, cy);
    if (!p) return;
    this.droplets.spawn(p.x, p.y, color, volume, radius);
  }

  /** Drops currently falling — surfaced for tests and the hint text. */
  get dropsInFlight(): number {
    return this.droplets.inFlight;
  }

  /**
   * A drop has reached the water. Release its pigment AND drive the surface.
   *
   * The impulse matters as much as the colour: it is what makes the drop feel
   * like it landed rather than faded in, and the resulting ring is what then
   * carries the fresh pigment outward into the standing figure.
   */
  private onDropLand = (
    u: number, v: number, radius: number, volume: number,
    absorbance: [number, number, number],
  ): void => {
    // Contact disturbance: a broad, SOFT ring travels outward from where the drop
    // landed.
    //
    // There is deliberately NO negative impulse here. An earlier version
    // pushed the surface DOWN first, on the reasoning that a drop's weight
    // makes a dimple — but that dimple persists as a visible circular crater
    // ringed on the water, which is exactly the artefact that looked wrong.
    // A drop landing on water reads as a quick expanding ripple, not a hole.
    //
    // The kick is kept LOW and WIDE (small amplitude, wide σ). A hot, narrow
    // kick injects grid-scale wavelengths the shading normals amplify into
    // the crawling white grain that used to race across the whole surface
    // after every drop; a broad, gentle impulse keeps the same travelling
    // ring, but as one smooth swell.
    this.wave.addImpulse(u, v, 0.45 * volume, Math.max(1e-6, (radius * 2.4) ** 2));
    // Only a first, dense slice of pigment is released at the contact frame;
    // the rest trickles out as the drop spreads. Dumping the whole volume in
    // one go drops a solid blob rather than laying down a core.
    this.releaseDrop(u, v, radius, volume * 0.35, absorbance);
  };

  /** A slice of a drop's pigment entering the water as it spreads. */
  private releaseDrop = (
    u: number, v: number, radius: number, volume: number,
    absorbance: [number, number, number],
  ): void => {
    if (volume <= 0) return;
    this.pigment.enqueue({
      x: u,
      y: v,
      // A falling drop carries a concentrated core and only a feathered edge.
      // Depositing dense and letting the flow spread it is what produces
      // branching filaments instead of a flat puddle.
      // Spread wider than the drop: the pour disperses on contact, and a wider
      // initial footprint is what lets neighbouring pours meet and mix instead of
      // sitting as isolated dots.
      radius: radius * 1.9,
      amount: volume,
      absorbance,
    });
  };

  /** The trickle phase: the rest of a drop's volume, released progressively. */
  private onDropRelease = (
    u: number, v: number, radius: number, volume: number,
    absorbance: [number, number, number],
  ): void => {
    this.releaseDrop(u, v, radius, volume, absorbance);
  };

  /** Remove pigment locally without touching the wave state. */
  eraseAt(cx: number, cy: number, radius: number): void {
    const p = this.toDisc(cx, cy);
    if (!p) return;
    this.pigment.enqueue({
      x: p.x,
      y: p.y,
      radius: radius * (0.4 + this.sim.size * 1.4),
      amount: 0.85,
      absorbance: [0, 0, 0],
      erase: true,
    });
  }

  /* ---------------------------------------------------------------- */
  /* mode / boundary control                                           */
  /* ---------------------------------------------------------------- */

  setBoundary(b: Boundary): void {
    if (this.boundary === b) return;
    this.boundary = b;
    this.resonance.setBoundary(b);
  }

  setHarm(h: number): void {
    this.harm = h;
    this.resonance.harm = h;
  }

  setResponse(r: number): void {
    this.resonance.response = r;
  }

  /**
   * Snap-follow: the silent driver's figure jumps to the slider instead of
   * melting toward it. Kept OFF for the tone driver, which needs the smooth
   * follow — see ResonanceModel.snapFollow.
   */
  setSnapFollow(v: boolean): void {
    this.resonance.snapFollow = v;
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  step(dt: number): void {
    if (this.dead) return;
    this.time += dt;
    const r = this.studio.renderer;

    // development override (?drive=432&level=0.8) — lets the visual QA harness
    // drive the figure deterministically without depending on audio autoplay.
    // The override carries the UI EXCITATION frequency (what the slider
    // shows), mapped through the same documented band transform the live
    // slider uses — QA never bypasses the frequency model.
    if (this.forcedDrive) {
      this.drive.freq = excitationToSim(this.forcedDrive.freq);
      this.driveTarget = this.forcedDrive.level;
    }

    // Smooth ramp prevents a step change in drive from looking like a shock
    // when the user unpauses. A 0.18 s time constant is fast enough to feel
    // responsive while removing the audible/visible click of an instant on/off.
    const target = this.forcedDrive ? this.driveTarget : Math.max(0, Math.min(1, this.driveTarget));
    this.drive.level += (target - this.drive.level) * Math.min(1, dt * 5.5);

    // 0. droplets fall first, so a landing this frame is picked up by the
    //    wave and pigment passes below in the same tick
    this.droplets.step(dt, this.dropletUvToWorld, this.onDropLand, this.onDropRelease);

    // 0b. THE FIGURE MUST BE RE-RENDERED WHILE THE SLIDER MOVES.
    //
    // This is the reported "the frequency isn't reflecting the changes" bug,
    // and it was caused by the render-on-change optimisation below. Moving the
    // slider changes drive.freq; the modal amplitudes then take a full time
    // constant (~1 s) to walk to their new targets. For that whole second the
    // coarse fingerprint barely moved, so the figure pass was skipped and the
    // OLD pattern stayed on screen while the readout named a different mode.
    // Moving the slider looked like it did nothing.
    //
    // The fingerprint check below now rounds harder, which makes this window
    // LONGER, so the fix is here: any real move of the drive marks the figure
    // dirty immediately. The pass is one analytic Bessel evaluation with no
    // solve, so a redundant draw is far cheaper than a stale figure.
    if (Math.abs(this.drive.freq - this.__lastDriveFreq) > 0.002) {
      this.__lastDriveFreq = this.drive.freq;
      this.figureDirty = true;
    }

    // 1. audio → modal amplitudes (built up / decayed continuously)
    //
    // Tone mode drives the vessel with the song's SPECTRUM (bass, mid,
    // presence, sparkle as separate contributions — see updateSpectrum), and
    // falls back to the single-frequency model when no spectrum was fed,
    // which is exactly what the frequency slider still uses.
    const slots = this.noForce
      ? []
      : this.driveSpectrum && this.driveSpectrum.length
        ? this.resonance.updateSpectrum(dt, this.driveSpectrum)
        : this.resonance.update(dt, this.drive.freq, Math.min(1, this.drive.level));

    // 2. analytic standing figure (exact eigenfunctions), one pass, coherent breath
    const dom = slots[0];
    if (dom) {
      const kR = dom.kR;                       // already k·R (set by ResonanceModel)
      const m = dom.m;
      const lambda = (2 * kR) * (2 * kR) + (2 * m) * (2 * m); // mode wavenumber²
      this.breath = (this.breath + Math.sqrt(Math.max(1, lambda)) * 0.22 * dt) % (Math.PI * 2);
    }
    // The figure field is recomputed only when the modal state has actually
    // moved: at a steady tone the amplitudes converge and the pattern stops
    // changing. The previous identity check (`slots !== this.__lastSlots`)
    // never fired because ResonanceModel returns a FRESH array every call —
    // so the 512² Bessel pass, one of the most expensive in the pipeline,
    // ran on every single frame. Fingerprinting (rounded m/kR/amp plus the
    // rendered breath phase) makes the render-on-change logic actually work;
    // the breath keeps advancing between renders.
    // AMP COARSE IS DELIBERATE.
    //
    // Rendering only when the amplitudes changed meant a converged drive
    // (the normal case once a tone is sustained) froze the pass — except the
    // code also re-rendered whenever the BREATH phase drifted > 0.55 rad. The
    // breath rate scales with the mode wavenumber, so on any high mode that
    // threshold is crossed every frame or two: the expensive analytic pass ran
    // ~30x/second for a pattern that had not changed and the frame budget
    // collapsed (measured 9 fps). Coarsening the amplitude rounding to 0.10
    // and gating on the coarse fingerprint means a steady state holds still,
    // and the pass fires only when the FIGURE genuinely differs.
    const fingerprint = slots.map((s) => `${s.m}|${s.kR.toFixed(3)}|${s.amp.toFixed(1)}`).join(';');
    if ((this.figureDirty || fingerprint !== this.__lastFingerprint) && !this.noFigure) {
      this.figure.render(r, slots, this.breath);
      this.figureDirty = false;
      this.__lastFingerprint = fingerprint;
    }
    // The breath is applied in the shader from uModes[0].w, which is only
    // written when the pass runs — so a held figure is genuinely static. That
    // is the correct trade: the figure is a standing pattern, and shimmer came
    // from the (now removed) per-frame redraw of an unchanged field.

    // 3. travelling-wave grid (strikes/drags; fixed substeps, capped catch-up)
    if (!this.__noWave) {
      this.wave.step(r, dt, {
        tension: this.sim.tension,
        damp: (1 - this.sim.damp) * 20 + 0.6,
        wall: 1.4,
        // Substep cap follows the GPU tier (16 discrete / 10 lean). Passing it
        // was missing, so WaveSimulation always used MAX_SUBSTEPS and the lean
        // tier's catch-up saving never applied.
        maxSubsteps: this.studio.profile.substeps,
      });
    }

    // 4. combine figure + ripples into the single field the surface samples
    (this.combine.material.uniforms.uWave as { value: THREE.Texture }).value = this.wave.texture;
    this.combine.render(r, this.fieldTarget);

    // 5. pigment transport through the same flow
    // The ambient churn tracks the tone: higher frequency visibly agitates
    // the water faster, so frequency is felt as well as seen.
    // Ambient churn. Measured against the reference: that dish is covered in ink
    // edge to edge with dense fine filaments, while this one showed a handful
    // of large smooth lobes surrounded by bare steel. The churn is what breaks
    // pigment into that fine structure — it was reduced earlier to stop
    // dilution, but with the absorbances now high enough to survive mixing,
    // the fine detail is worth the slight spread.
    // The ambient churn tracks the tone: higher frequency visibly agitates
    // the water faster, so frequency is felt as well as seen. Kept small —
    // this is seasoning, not the transport. At the old values the stir alone
    // smeared a pour across the whole basin in under ten seconds.
    // Scaled down further from the earlier tuning: at the previous amplitude
    // the curl noise shred dense pours into hard wandering ribbons that looked
    // like scratches instead of pigment dispersing, which is the "random lines
    // instead of natural mixing" report. Below ~0.0008 the churn is felt as
    // gentle motion and the flow organises the ink instead of tearing it.
    const stir = (0.00018 + Math.min(1, Math.log2(Math.max(1, this.drive.freq) / 2) / 3.4) * 0.0008
      + Math.min(1, this.drive.level) * 0.00055) * (0.4 + this.sim.visc);
    if (!this.__noDye) this.pigment.step(r, dt, {
      // Chladni migration — the term that DRAWS the figure. Stronger than the
      // curl so nodal collection is readable, never strong enough to freeze
      // the ink: the flow keeps slowly working everything all the time.
      gather: this.gather * 1.15,
      // A very small diffusion floor, and only because semi-Lagrangian
      // advection has no numerical diffusion of its own to fall back on now
      // that the MacCormack correction is bounded. Every frame of blur here
      // is permanent, so the floor stays as low as the artefact allows.
      diffusion: Math.max(0.004, Math.min(0.2, this.diffusion * (0.3 + this.sim.visc * 1.9) * 0.18)),
      // Pigment persists: real ink in water does not fade in seconds.
      relax: 0.99975 + this.sim.persist * 0.00024,
      // Curl transport: folds and tears pigment into wandering filaments.
      // These set the SHAPE of the flow; its overall speed is capped by
      // FLOW_MAX in DYE_FS, which is the single number that decides how fast
      // the ink actually moves across the dish.
      flow: 0.010,
      swirl: 0.016,
      stir,
      // Limited MacCormack correction for semi-Lagrangian diffusion. Safe to
      // apply every frame BECAUSE the shader clamps it to the neighbourhood's
      // own range — see DYE_FS. An unlimited value here reintroduces the
      // dash artefact within seconds.
      //
      // Lowered from 0.55: at that strength the limiter itself pulled local
      // minima in dense pours down hard enough to carve thin dark channels,
      // which is the other half of "random lines instead of natural mixing".
      // 0.32 still restores the edges advection blurs away while letting the
      // ink read as something that is dissolving.
      sharpen: 0.32,
      time: this.time,
    }, this.fieldTarget.texture);

    // 6. hand the live fields to the surface material
    this.liquidUniforms.uField.value = this.fieldTarget.texture;
    this.liquidUniforms.uDye.value = this.pigment.texture;
    this.liquidUniforms.uTime.value = this.time;

    // 7. frequency-compensated relief.
    //
    //    The optical normal gain is derived from the DOMINANT mode's wavenumber
    //    k·R so that the tilt the eye reads stays roughly constant as the slider
    //    walks the band. See RELIEF_BASE/RELIEF_EXP above for the measurement
    //    behind the exponent: the gradient itself grows with k, so the gain has
    //    to fall, and the old rising law over-drove the surface into its clamp.
    //    The change is smoothed, so sweeping the slider moves the relief
    //    continuously — no popping, and the simulation itself is untouched.
    if (dom) {
      const kR = Math.max(0.5, dom.kR);
      const targetNormal = clamp(RELIEF_BASE * Math.pow(kR / 10, RELIEF_EXP), RELIEF_MIN, RELIEF_MAX);
      const u = this.liquidUniforms;
      u.uNormalGain.value += (targetNormal - u.uNormalGain.value) * Math.min(1, dt * 3.0);
      u.uReliefMix.value = 0.42 + Math.min(0.28, Math.log2(kR / 10) * 0.16);
    }
  }

  render(): void {
    if (this.dead) return;
    this.applyOptions();
    this.studio.render();
  }

  /* ---------------------------------------------------------------- */
  /* state                                                             */
  /* ---------------------------------------------------------------- */

  clearDye(): void {
    this.pigment.reset(this.studio.renderer);
    this.wave.reset(this.studio.renderer);
    this.figure.reset(this.studio.renderer);
    this.resonance.reset();
  }

  /** Render + read the drawing buffer (Save button). */
  capture(): string {
    return this.studio.capture();
  }

  /** Greyscale readback of the dye field — development instrument (§18). */
  dyeStats(): { cells: number; mass: number } {
    const rt = (this.pigment as unknown as { targets: THREE.WebGLRenderTarget[]; idx: number });
    const target = rt.targets[rt.idx];
    // Read at the buffer's ACTUAL size — it is tier-dependent (768 lean /
    // 1024 discrete), not the DYE_SIZE default.
    const n = this.pigment.size;
    // The dye targets are HalfFloatType, so they have to be read as Uint16 and
    // decoded by hand.
    //
    // Reading them into a Float32Array is what this used to do, and it returns
    // ALL ZEROS: the read type has to match the attachment's, and three.js
    // silently produces a zero-filled buffer when it does not. The result was
    // that every "is there any pigment in here?" probe answered no — including
    // scripts/smoke.mjs, which read it as "clicking the water deposits nothing"
    // while the water was visibly full of ink.
    const raw = new Uint16Array(n * n * 4);
    this.studio.renderer.readRenderTargetPixels(target, 0, 0, n, n, raw);
    const h = (w: number): number => {
      const s = (w & 0x8000) ? -1 : 1;
      const ex = (w >> 10) & 0x1f;
      const mn = w & 0x3ff;
      if (ex === 0) return s * mn * 5.9604644775390625e-8;
      if (ex === 31) return mn ? NaN : s * Infinity;
      return s * (1 + mn / 1024) * Math.pow(2, ex - 15);
    };
    let cells = 0;
    let total = 0;
    for (let i = 0; i < n * n; i++) {
      const a = h(raw[i * 4 + 3]);
      if (a > 0.05) { cells++; total += a; }
    }
    return { cells, mass: total / (n * n) };
  }

  /** Nodal diagram of the resolved mode (preset thumbnails) — §18. */
  modeThumb(size = 96): string {
    const cn = document.createElement('canvas');
    cn.width = cn.height = size;
    const c2 = cn.getContext('2d')!;
    const img = c2.createImageData(size, size);
    const { a, b, wa, wb } = resolveDrive(this.drive.freq, BANKS[this.boundary]);
    const blend = wb / Math.max(0.001, wa + wb);
    const km = a.k * VESSEL.radius;
    const kn = b.k * VESSEL.radius;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / (size - 1)) * 2 - 1;
        const v = (y / (size - 1)) * 2 - 1;
        const rr = Math.hypot(u, v);
        const th = Math.atan2(v, u);
        const fa = besselJ(a.m, km * rr) * Math.cos(a.m * th);
        const fb = besselJ(b.m, kn * rr) * Math.cos(b.m * th);
        const val = Math.abs(fa + (fb - fa) * blend);
        const i = (y * size + x) * 4;
        const g = val < 0.06 ? 30 : 245 - Math.min(60, rr * 40);
        img.data[i] = g;
        img.data[i + 1] = g;
        img.data[i + 2] = g;
        img.data[i + 3] = 255;
      }
    }
    c2.putImageData(img, 0, 0);
    return cn.toDataURL();
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.wave?.dispose();
      this.figure?.dispose();
      this.combine?.dispose();
      this.fieldTarget?.dispose();
      this.pigment?.dispose();
      this.droplets?.dispose();
      this.dish?.geometry.dispose();
      (this.dish?.material as THREE.Material | undefined)?.dispose();
      this.liquid?.geometry.dispose();
      (this.liquid?.material as THREE.Material | undefined)?.dispose();
      this.studio?.dispose();
    } catch { /* context already lost */ }
  }
}
