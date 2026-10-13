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
import { PigmentSimulation, DYE_SIZE } from '../sim/pigment';
import { DropletSystem } from '../sim/droplets';
import { FullscreenPass, makeTarget } from '../sim/pass';
import { COMBINE_FS } from '../sim/shaders';
import { BANKS, besselJ, resolveDrive, VESSEL, excitationToSim, type Boundary } from './resonance';

export interface LabOptions {
  reflections: boolean;
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
  pointer = { x: 0.5, y: 0.5 };
  boundary: Boundary = 'rigid';
  harm = 1;
  sim: SimParams = { damp: 0.92, tension: 0.7, visc: 0.4, force: 0.6, size: 0.4, amount: 0.8, spread: 0.6, persist: 0.7 };
  opts: LabOptions = { reflections: true, caustics: true, depth: true, nodalMap: false, grain: false, glow: false };
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
  private __lastBreath = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.studio = new Studio(canvas);

    // ---- vessel + liquid ------------------------------------------------
    // castShadow/receiveShadow: the vessel grounds on the set through the
    // studio's real key-light shadow map, and the water accepts the shadows
    // falling INTO it (a drop's shadow on the water sells the contact).
    const dishGeo = createDishGeometry();
    const { material: glass } = createDishMaterial();
    this.dish = new THREE.Mesh(dishGeo, glass);
    this.dish.castShadow = true;
    this.dish.receiveShadow = false;
    this.dish.position.y = 0;
    this.studio.scene.add(this.dish);

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
    this.pigment = new PigmentSimulation(this.studio.renderer);
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
    this.liquidUniforms.uDebug.value = dbg === 'dye' ? 1 : dbg === 'mode' ? 2 : dbg === 'h' ? 3 : 0;
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
    this.liquidUniforms.uCaustics.value = this.opts.caustics ? 1 : 0;
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
// Contact disturbance: a narrow ring travels outward from where the drop
    // landed.
    //
    // There is deliberately NO negative impulse here. An earlier version
    // pushed the surface DOWN first, on the reasoning that a drop's weight
    // makes a dimple — but that dimple persists as a visible circular crater
    // ringed on the water, which is exactly the artefact that looked wrong.
    // A drop landing on water reads as a quick expanding ripple, not a hole.
    this.wave.addImpulse(u, v, 1.15 * volume, Math.max(1e-6, (radius * 1.15) ** 2));
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
      radius: radius * 1.55,
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
      this.drive.level = this.forcedDrive.level;
    }

    // 0. droplets fall first, so a landing this frame is picked up by the
    //    wave and pigment passes below in the same tick
    this.droplets.step(dt, this.dropletUvToWorld, this.onDropLand, this.onDropRelease);

    // 1. audio → modal amplitudes (built up / decayed continuously)
    const slots = this.noForce
      ? []
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
    const fingerprint = slots.map((s) => `${s.m}|${s.kR.toFixed(3)}|${s.amp.toFixed(2)}`).join(';');
    const breathMoved = Math.abs(this.breath - this.__lastBreath) > 0.55;
    if ((this.figureDirty || breathMoved) && !this.noFigure) {
      this.figure.render(r, slots, this.breath);
      this.figureDirty = false;
      this.__lastBreath = this.breath;
      this.__lastFingerprint = fingerprint;
    }

    // 3. travelling-wave grid (strikes/drags; fixed substeps, capped catch-up)
    if (!this.__noWave) {
      this.wave.step(r, dt, {
        tension: this.sim.tension,
        damp: (1 - this.sim.damp) * 20 + 0.6,
        wall: 1.4,
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
    // the water faster, so frequency is felt as well as seen.
    const stir = (0.0008 + Math.min(1, Math.log2(Math.max(1, this.drive.freq) / 2) / 3.4) * 0.0040
      + Math.min(1, this.drive.level) * 0.0024) * (0.4 + this.sim.visc);
    if (!this.__noDye) this.pigment.step(r, dt, {
      // Chladni migration — the term that DRAWS the figure. Stronger than the
      // curl so nodal collection is readable, never strong enough to freeze
      // the ink: the flow keeps slowly working everything all the time.
      gather: this.gather * 1.15,
      // a small diffusion FLOOR suppresses the texel-level noise that
      // advection + unsharp would otherwise amplify into rainbow speckle;
      // it also bleeds the compression ridges the settled flow builds back
      // into soft mass
      diffusion: Math.max(0.008, Math.min(0.6, this.diffusion * (0.3 + this.sim.visc * 1.9) * 0.3)),
      // Pigment persists: real ink in water does not fade in seconds.
      relax: 0.9993 + this.sim.persist * 0.00068,
      // Curl transport: folds and tears pigment into wandering filaments, but
      // kept SUBTLE — the curl noise stamps one rotation centre per noise
      // cell, and too much of it decorates the bath with shell spirals
      // instead of the fine tearing real stirring produces.
      flow: 0.008,
      swirl: 0.016,
      stir,
      sharpen: 0.10,
      time: this.time,
    }, this.fieldTarget.texture);

    // 6. hand the live fields to the surface material
    this.liquidUniforms.uField.value = this.fieldTarget.texture;
    this.liquidUniforms.uDye.value = this.pigment.texture;
    this.liquidUniforms.uTime.value = this.time;
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
    // The dye targets are HalfFloatType. Reading them into a Uint8Array returns
    // garbage (the driver reinterprets the float bits as bytes), so a Uint8
    // probe silently reports ~zero mass and looks exactly like "no pigment".
    const buf = new Float32Array(DYE_SIZE * DYE_SIZE * 4);
    this.studio.renderer.readRenderTargetPixels(target, 0, 0, DYE_SIZE, DYE_SIZE, buf);
    let cells = 0;
    let total = 0;
    for (let i = 0; i < DYE_SIZE * DYE_SIZE; i++) {
      const a = buf[i * 4 + 3];
      if (a > 0.05) { cells++; total += a; }
    }
    return { cells, mass: total / (DYE_SIZE * DYE_SIZE) };
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
