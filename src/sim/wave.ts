/**
 * WaveSimulation — the travelling-ripple grid for the basin (guide §7).
 *
 * State texture (RGBA16F, ping-pong): r = height, g = vertical velocity.
 *  - explicit update with a fixed substep (guide §13: never feed a large
 *    elapsed time into the solver; cap catch-up steps after a long frame);
 *  - Courant number stays under the 0.5 ceiling of the 5-point Laplacian;
 *  - the circular boundary is enforced inside the shader (no torus wrap);
 *  - energy enters ONLY as direct velocity kicks from pointer strikes, so the
 *    grid carries travelling waves that reflect and interfere at the wall.
 *
 * The resonant standing figure is NOT solved here: it is synthesized
 * analytically in FigureField. Driving this grid with a spatially non-
 * mean-zero modal field would pump its undamped zero mode into the rails —
 * see the header of ../sim/shaders.ts for the full note.
 */
import * as THREE from 'three';
import { FullscreenPass, makeTarget } from './pass';
import { STEP_FS } from './shaders';

export const SIM_SIZE = 512;

/** Fixed solver timestep (s) — 480 Hz keeps the explicit scheme stable. */
const FIXED_DT = 1 / 480;
/** Catch-up cap after a long frame (guide §13). */
const MAX_SUBSTEPS = 16;
/**
 * Wave-speed², in TEXEL units: the shader's Laplacian is the unscaled
 * 5-point stencil (≈ ∇² with dx = 1 texel), so the wave speed is
 * sqrt(C2) texels/s. The explicit scheme is stable while
 * c2·8·dt² < 4, i.e. c2 ≲ 115,000 — so this constant is nowhere near the
 * limit; it is chosen purely for feel.
 *
 * sqrt(32000) ≈ 179 texels/s → a strike ripple crosses the 512-wide basin
 * (radius 256) in ~1.4 s: fast enough to read as motion, slow enough that
 * the ring structure survives to the rim. The matching ripple frequency for
 * a typical kick (σ ≈ 0.05 uv) is ≈ 1 Hz — comfortably visible.
 */
const C2_BASE = 32000;

export interface WaveParams {
  /** 0..1 UI Surface Tension → wave speed */
  tension: number;
  /** 0..1 UI Damping → velocity decay rate (1/s) */
  damp: number;
  /** wall absorption (1/s) */
  wall: number;
}

export interface Impulse {
  x: number; y: number; amp: number; sigma2: number;
}

export class WaveSimulation {
  readonly size = SIM_SIZE;
  private targets: THREE.WebGLRenderTarget[];
  private idx = 0;
  private stepPass: FullscreenPass;
  private impulses: Impulse[] = [];
  private acc = 0;
  private zeroImp: THREE.Vector4[] = Array.from({ length: 8 }, () => new THREE.Vector4());
  private impUniform: THREE.Vector4[] = Array.from({ length: 8 }, () => new THREE.Vector4());

  constructor(renderer: THREE.WebGLRenderer) {
    this.targets = [makeTarget(SIM_SIZE, SIM_SIZE, THREE.HalfFloatType), makeTarget(SIM_SIZE, SIM_SIZE, THREE.HalfFloatType)];

    this.stepPass = new FullscreenPass(STEP_FS, {
      uState: { value: null },
      uTexel: { value: new THREE.Vector2(1 / SIM_SIZE, 1 / SIM_SIZE) },
      uDt: { value: FIXED_DT },
      uC2: { value: C2_BASE },
      uDamp: { value: 2 },
      uWall: { value: 1.5 },
      uImp: { value: this.zeroImp },
    });

    // Half-float render targets start with undefined contents — zero them.
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

  /** Queue a strike (velocity kick) — consumed by the next step(). */
  addImpulse(x: number, y: number, amp: number, sigma2: number): void {
    if (this.impulses.length >= 8) this.impulses.shift();
    this.impulses.push({ x, y, amp, sigma2 });
  }

  get texture(): THREE.Texture {
    return this.targets[this.idx].texture;
  }

  /** Advance the travelling-wave field with fixed substeps + capped catch-up. */
  step(renderer: THREE.WebGLRenderer, dt: number, p: WaveParams): void {
    this.acc = Math.min(this.acc + dt, FIXED_DT * MAX_SUBSTEPS * 2);
    let n = Math.floor(this.acc / FIXED_DT);
    if (n <= 0) return;
    n = Math.min(n, MAX_SUBSTEPS);
    this.acc -= n * FIXED_DT;

    const u = this.stepPass.material.uniforms;
    u.uC2.value = C2_BASE * (0.55 + 0.9 * p.tension);
    u.uDamp.value = p.damp;
    u.uWall.value = p.wall;

    for (let s = 0; s < n; s++) {
      // strikes land once, on the first substep of the frame
      if (s === 0 && this.impulses.length) {
        for (let i = 0; i < 8; i++) {
          const im = this.impulses[i];
          if (im) this.impUniform[i].set(im.x, im.y, im.amp, im.sigma2);
          else this.impUniform[i].set(0, 0, 0, 1);
        }
        u.uImp.value = this.impUniform;
        this.impulses = [];
      } else {
        u.uImp.value = this.zeroImp;
      }
      u.uDt.value = FIXED_DT;
      u.uState.value = this.targets[this.idx].texture;
      this.stepPass.render(renderer, this.targets[1 - this.idx]);
      this.idx = 1 - this.idx;
    }
  }

  /** Flatten the field back to rest (Clear / preset switch). */
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
    this.impulses = [];
    this.acc = 0;
  }

  dispose(): void {
    this.targets.forEach((t) => t.dispose());
    this.stepPass.dispose();
  }
}