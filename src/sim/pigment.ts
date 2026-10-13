/**
 * PigmentSimulation — persistent dye advected by the simulated surface flow
 * (guide §9).
 *
 * Storage is OPTICAL DENSITY, not colour: rgb = per-channel absorbance,
 * a = pigment mass. Because absorbance adds linearly along a light path,
 * two inks overlaid mix subtractively and physically (blue over yellow
 * transmits blue·green = green). An RGB average — what a naive "mix the
 * colours" implementation does — always trends to mud.
 *
 * The surface renders it back with Beer–Lambert: T = exp(−A·d).
 */
import * as THREE from 'three';
import { FullscreenPass, makeTarget } from './pass';
import { DYE_FS } from './shaders';

/** 768² balances filament sharpness against the pass's fill cost: at 1024²
 *  the combined-drive frame (advect + 13-tap unsharp + field taps + deposits
 *  at one megapixel) no longer holds 60 FPS on mid GPUs — the advection/
 *  unsharp taps scale with texel count, and the figure's own 512² already
 *  carries the fine structure. */
export const DYE_SIZE = 768;

export interface DyeParams {
  gather: number;
  diffusion: number;
  relax: number;
  flow: number;
  swirl: number;
  /** ambient churn amplitude — tracks the drive, so tone agitates the water */
  stir: number;
  /** unsharp strength that fights semi-Lagrangian diffusion */
  sharpen: number;
  /** engine time, drives the ambient stir phase */
  time: number;
}

export interface Dab {
  x: number; y: number; radius: number; amount: number;
  /** per-channel optical density of the ink (0 = transparent) */
  absorbance: [number, number, number];
  erase?: boolean;
}

export class PigmentSimulation {
  readonly size = DYE_SIZE;
  private targets: THREE.WebGLRenderTarget[];
  private idx = 0;
  private pass: FullscreenPass;
  private queue: Dab[] = [];
  private depUniform: THREE.Vector4[] = Array.from({ length: 8 }, () => new THREE.Vector4());
  private depAbsUniform: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
  private zeroDep: THREE.Vector4[] = Array.from({ length: 8 }, () => new THREE.Vector4());
  private zeroAbs: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
  /** reused scratch: no per-frame allocation in the deposit path */
  private scratchErase = new THREE.Vector4(0.5, 0.5, 0.01, 0);

  constructor(renderer: THREE.WebGLRenderer) {
    // half-float: absorbance needs far more range/precision than 8-bit colour
    this.targets = [makeTarget(DYE_SIZE, DYE_SIZE, THREE.HalfFloatType), makeTarget(DYE_SIZE, DYE_SIZE, THREE.HalfFloatType)];
    this.pass = new FullscreenPass(DYE_FS, {
      uDye: { value: null },
      uField: { value: null },
      uTexel: { value: new THREE.Vector2(1 / DYE_SIZE, 1 / DYE_SIZE) },
      uDt: { value: 1 / 60 },
      uGather: { value: 0.3 },
      uDiffusion: { value: 0.02 },
      uRelax: { value: 0.999 },
      uFlow: { value: 0.01 },
      uSwirl: { value: 0.008 },
      uStir: { value: 0.002 },
      uSharpen: { value: 0.35 },
      uTime: { value: 0 },
      uDep: { value: this.zeroDep },
      uDepAbs: { value: this.zeroAbs },
      uErase: { value: new THREE.Vector4(0.5, 0.5, 0.01, 0) },
    });

    const prevColor = new THREE.Color();
    renderer.getClearColor(prevColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of this.targets) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevColor, prevAlpha);
  }

  /** Queue a deposit/erase; consumed by the next step (bounded per frame). */
  enqueue(dab: Dab): void {
    if (this.queue.length < 64) this.queue.push(dab);
  }

  get texture(): THREE.Texture {
    return this.targets[this.idx].texture;
  }

  step(
    renderer: THREE.WebGLRenderer,
    dt: number,
    p: DyeParams,
    fieldTex: THREE.Texture,
  ): void {
    const u = this.pass.material.uniforms;
    u.uDye.value = this.targets[this.idx].texture;
    u.uField.value = fieldTex;
    u.uDt.value = Math.min(dt, 1 / 30);
    u.uGather.value = p.gather;
    u.uDiffusion.value = p.diffusion;
    u.uRelax.value = p.relax;
    u.uFlow.value = p.flow;
    u.uSwirl.value = p.swirl;
    u.uStir.value = p.stir;
    u.uSharpen.value = p.sharpen;
    u.uTime.value = p.time;

    // consume up to 8 deposits (mixing erase ops into the same pass)
    let count = 0;
    const deps = u.uDep.value as THREE.Vector4[];
    const abs = u.uDepAbs.value as THREE.Vector3[];
    const erase = this.scratchErase;
    erase.set(0.5, 0.5, 0.01, 0);
    while (this.queue.length && count < 8) {
      const d = this.queue.shift()!;
      if (d.erase) {
        erase.set(d.x, d.y, d.radius, d.amount);
      } else {
        deps[count].set(d.x, d.y, d.radius, d.amount);
        abs[count].set(d.absorbance[0], d.absorbance[1], d.absorbance[2]);
        count++;
      }
    }
    for (let i = count; i < 8; i++) { deps[i].set(0, 0, 0.01, 0); abs[i].set(0, 0, 0); }
    (u.uErase.value as THREE.Vector4).copy(erase);

    this.pass.render(renderer, this.targets[1 - this.idx]);
    this.idx = 1 - this.idx;
  }

  reset(renderer: THREE.WebGLRenderer): void {
    const prevColor = new THREE.Color();
    renderer.getClearColor(prevColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of this.targets) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevColor, prevAlpha);
    this.queue = [];
  }

  dispose(): void {
    this.targets.forEach((t) => t.dispose());
    this.pass.dispose();
  }
}
