/**
 * FigureField — the resonant standing pattern, synthesized analytically.
 *
 * A circular-membrane eigenfunction φ = J_m(k·r)·cos(mθ) is an exact solution
 * of the wave equation, so the steady figure the dish settles into is written
 * straight into a texture each frame:
 *
 *     h(r, θ) = breathing(Φ) · Σᵢ Aᵢ · J_mᵢ(kᵢr) · cos(mᵢθ)
 *
 * Two reasons this is not "faking" the physics (guide §8/§13):
 *  - it is the closed-form solution of the very eigenproblem the mode bank
 *    solves on the CPU, so no PDE error is introduced;
 *  - the discrete grid's 4-point Laplacian has an undamped zero mode, so a
 *    spatially non-mean-zero forcing (every Bessel mode has one) would pump
 *    the field into its rails with no dissipation. Eigenfunction synthesis is
 *    bounded by construction.
 *
 * The travelling ripples from pointer strikes are solved separately on the
 * wave grid (WaveSimulation) and the two are summed in COMBINE_FS.
 */
import * as THREE from 'three';
import { FullscreenPass, makeTarget } from './pass';
import { FIGURE_FS } from './shaders';
import type { ModeSlot } from './resonance';

export const FIGURE_SIZE = 512;
const MAX_MODES = 6;

/** Peaks that actually reach the surface; slots beyond this are dropped.
 *  Kept modest — the standing figure should be a gentle swell you read
 *  through reflection and pigment, not a high-contrast mask that clips to
 *  black and white once the normal is lit hard. */
export const FIGURE_GAIN = 1.15;

export class FigureField {
  readonly size = FIGURE_SIZE;
  private target: THREE.WebGLRenderTarget;
  private pass: FullscreenPass;
  private slots: ModeSlot[] = [];

  constructor(renderer: THREE.WebGLRenderer) {
    this.target = makeTarget(FIGURE_SIZE, FIGURE_SIZE, THREE.HalfFloatType);
    this.pass = new FullscreenPass(FIGURE_FS, {
      uModes: { value: Array.from({ length: MAX_MODES }, () => new THREE.Vector4()) },
    });

    const prevColor = new THREE.Color();
    renderer.getClearColor(prevColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevColor, prevAlpha);
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /**
   * @param slots  strongest modal amplitudes from ResonanceModel
   * @param breath breathing phase Φ (rad) — advanced by the caller so every
   *               mode shares one coherent shimmer
   */
  render(renderer: THREE.WebGLRenderer, slots: ModeSlot[], breath: number): void {
    this.slots = slots;
    const arr = this.pass.material.uniforms.uModes.value as THREE.Vector4[];
    for (let i = 0; i < MAX_MODES; i++) {
      const s = slots[i];
      if (s) arr[i].set(s.m, s.kR, s.amp, breath);
      else arr[i].set(0, 0, 0, 0);
    }
    this.pass.render(renderer, this.target);
  }

  reset(renderer: THREE.WebGLRenderer): void {
    this.slots = [];
    const prevColor = new THREE.Color();
    renderer.getClearColor(prevColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevColor, prevAlpha);
  }

  dispose(): void {
    this.target.dispose();
    this.pass.dispose();
  }
}