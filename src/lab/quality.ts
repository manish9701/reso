/**
 * Quality tiering — the app adapts to the GPU it actually finds.
 *
 * The same build has to run on a discrete NVIDIA GTX 1050 and on a 2018-era
 * integrated Intel UHD 630 (which is what the development machine reports:
 * `ANGLE (Intel, Intel(R) UHD Graphics 630 … Direct3D11)`). Those differ by
 * roughly an order of magnitude in fill rate, so a single setting is wrong
 * for one of them.
 *
 * Detection is explicit and conservative: read the unmasked renderer string
 * and treat only clearly-discrete families (NVIDIA / AMD Radeon / Apple) as
 * the high tier. Everything else — Intel, Apple software renderers,
 * SwiftShader, llvmpipe, unknown strings — gets the lean profile, because the
 * failure mode of guessing high is a 10 FPS slideshow, while guessing low
 * only costs a little resolution.
 *
 * What the profile controls:
 *  - render scale (device pixel ratio cap) — the dominant fill-rate knob
 *  - shadow-map size
 *  - pigment buffer size (the advection pass scales with texel count)
 *  - `lean`: skip the water shader's optional taps (see liquid.ts)
 *  - ground material: Lambert instead of Standard on the low tier, because the
 *    ground covers the whole frame and a matte sweep gains nothing from PBR
 *  - wave substep cap
 *
 * Nothing here changes the SIMULATION: the physics, the field resolution and
 * the figure are identical on both tiers, so a pattern looks the same at
 * either quality — only the sampling density changes.
 */

export type Tier = 'high' | 'low';

export interface QualityProfile {
  tier: Tier;
  /** device pixel ratio cap */
  dpr: number;
  shadowMap: number;
  /** pigment texture edge (px) */
  dye: number;
  /** 1 = skip optional per-pixel work in the water shader */
  lean: 0 | 1;
  /** max wave solver substeps per frame */
  substeps: number;
  /** matte ground: Lambert is enough and far cheaper than Standard */
  groundLambert: boolean;
  /** renderer string, kept for the diagnostics overlay */
  renderer: string;
}

const HIGH_DISCRETE = /(nvidia|geforce|quadro|rtx|radeon rx|radeon pro|apple m[0-9]|geforce force)/i;

export function detectTier(renderer: string): Tier {
  return HIGH_DISCRETE.test(renderer) ? 'high' : 'low';
}

export function profileFor(tier: Tier, renderer: string): QualityProfile {
  if (tier === 'high') {
    return {
      tier, renderer,
      dpr: 1.5,
      shadowMap: 2048,
      dye: 1024,
      lean: 0,
      substeps: 16,
      groundLambert: false,
    };
  }
  return {
    tier, renderer,
    dpr: 1.0,
    shadowMap: 1024,
    dye: 768,
    lean: 1,
    substeps: 10,
    groundLambert: true,
  };
}

/** Read the unmasked renderer string (empty when the extension is absent). */
export function readRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  } catch {
    return '';
  }
}