/**
 * Liquid surface — a subdivided circular mesh whose height, shading normal,
 * pigment colour, caustics and edge meniscus all come from the GPU
 * simulation fields (guide §6).
 *
 * Implementation note: instead of a hand-written look, the surface is a
 * MeshPhysicalMaterial extended through onBeforeCompile, so it keeps
 * three.js's full physically based shading — Fresnel, an energy-conserving
 * studio environment reflection and specular highlights that move because
 * the simulated normals move. That is what stops it reading as a glass plate.
 */
import * as THREE from 'three';

/** Liquid radius (world units) — sits just inside the dish inner wall. */
export const LIQUID_R = 0.870;
/** Rest surface height (world units). The dish's inner floor sits at y ≈ 0.020
 *  (see dish.ts PROFILE), so the pool is ~0.075 deep — a real volume of water
 *  with room for the refracted bowl to bend inside it. */
export const LIQUID_Y = 0.094;
/**
 * Optically-relevant depth of the pool. This is NOT cosmetic: the refraction
 * model displaces a ray laterally by roughly thickness·(1 − 1/ior), so a value
 * much larger than the actual water column throws the refracted ray clean out
 * of the vessel and it samples the white studio floor instead — which is what
 * produced hard-edged white polygons floating on the surface.
 */
export const LIQUID_THICKNESS = 0.055;

export interface LiquidUniforms {
  uField: { value: THREE.Texture | null };  // r = height, g = nodal shape, b = velocity
  uDye: { value: THREE.Texture | null };
  uTexel: { value: THREE.Vector2 };
  uR: { value: number };
  uAmp: { value: number };
  uNormalGain: { value: number };
  uWater: { value: THREE.Vector3 };
  uCaustics: { value: number };
  uCausticK: { value: number };
  uDepth: { value: number };
  uNodal: { value: number };
  uRefract: { value: number };
  uInkDensity: { value: THREE.Vector2 };
  uTime: { value: number };
  uMicro: { value: number };
  /** fraction of the shading relief the refracted path follows */
  uReliefMix: { value: number };
  /** caustic self-shadowing strength */
  uShadowMix: { value: number };
  uDebug: { value: number };
}

/** Polar disc: dense enough for smooth vertex displacement (guide §6).
 *  Topology is deliberately high (rings × segments) so the travelling
 *  ripples and the standing relief read as a continuous surface rather
 *  than a faceted polygon — the silhouette against the dish wall is what
 *  gives the water away if it is too coarse. */
export function createLiquidGeometry(radius = LIQUID_R, rings = 320, segments = 384): THREE.BufferGeometry {
  const positions = new Float32Array((rings + 1) * segments * 3);
  const normals = new Float32Array((rings + 1) * segments * 3);
  const index: number[] = [];
  let p = 0;
  for (let i = 0; i <= rings; i++) {
    const rr = radius * (i / rings);
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      positions[p] = Math.cos(a) * rr;
      positions[p + 1] = 0;
      positions[p + 2] = Math.sin(a) * rr;
      normals[p] = 0;
      normals[p + 1] = 1;
      normals[p + 2] = 0;
      p += 3;
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const jn = (j + 1) % segments;
      const a = i * segments + j;
      const b = i * segments + jn;
      const c = (i + 1) * segments + j;
      const d = (i + 1) * segments + jn;
      // wind counter-clockwise seen from above (+Y) so front faces point up
      if (i === 0) index.push(a, d, c);
      else index.push(a, d, c, a, b, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}

const COMMON_FRAG_PARS = /* glsl */ `
uniform sampler2D uField;    // r = height, g = nodal shape, b = velocity
uniform sampler2D uDye;
uniform vec2 uTexel;
uniform float uR;
uniform float uAmp;
uniform float uNormalGain;
uniform vec3 uWater;
uniform float uCaustics;
uniform float uCausticK;
uniform float uDepth;
uniform float uNodal;
uniform float uRefract;
uniform vec2 uInkDensity;    // (absorbance scale, mass scale) for Beer–Lambert
uniform float uTime;
uniform float uMicro;
uniform float uDebug;
uniform float uReliefMix;    // how much relief the refracted path follows
uniform float uShadowMix;    // caustic self-shadowing strength
// Caustic self-shadow, computed in the emissive chunk and consumed in the
// transmission chunk. A file-scope global is the only thing that survives
// between them — three.js injects each chunk separately into main().
float gShade = 0.0;
varying vec2 vLuv;
varying float vH;

float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float maxComp(vec3 v) { return max(v.x, max(v.y, v.z)); }

/**
 * Height gradient from the live field, wide-averaged so it stays smooth.
 *
 * Shared by the shading normal and the refraction on purpose. When these were
 * computed separately, the bowl seen THROUGH the water never agreed with the
 * ripples seen ON it, and the composite read as two unrelated images stapled
 * together. One function, one field, one answer.
 */
vec2 fieldGrad(vec2 uv, vec2 texel) {
  vec2 e = texel * 2.0;
  float hL = (texture2D(uField, uv - vec2(e.x, 0.0)).r + texture2D(uField, uv - vec2(texel.x, 0.0)).r) * 0.5;
  float hR = (texture2D(uField, uv + vec2(e.x, 0.0)).r + texture2D(uField, uv + vec2(texel.x, 0.0)).r) * 0.5;
  float hD = (texture2D(uField, uv - vec2(0.0, e.y)).r + texture2D(uField, uv - vec2(0.0, texel.y)).r) * 0.5;
  float hU = (texture2D(uField, uv + vec2(0.0, e.y)).r + texture2D(uField, uv + vec2(0.0, texel.y)).r) * 0.5;
  return vec2(hR - hL, hU - hD) * 0.5 / e.x;
}
`;

export function createLiquidMaterial(): {
  material: THREE.MeshPhysicalMaterial;
  uniforms: LiquidUniforms;
} {
  const uniforms: LiquidUniforms = {
    uField: { value: null },
    uDye: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
    uR: { value: LIQUID_R },
    // Displacement stays within a couple of mesh ring-spacings (past that the
    // surface folds and renders as hard wedges). Real cymatic relief is
    // millimetres deep; the figure is read from reflection and pigment.
    // Geometric displacement, in world units, for a unit of field height.
    // This must stay within roughly ONE ring spacing of the polar mesh or the
    // surface folds over itself and each triangle becomes its own facet: with
    // 320 rings over r≈0.87 a spacing is ~0.0027, and a displacement several
    // times that is what produced hard radial spokes through the refracted
    // image. The figure is read through the shading normal and caustics, not
    // through silhouette, so a small real displacement is correct here.
    uAmp: { value: 0.016 },
    // Optical normal gain lifts the shading slope to a legible level without
    // tipping the surface past vertical. With the studio's vertical gradient
    // this is where a crest reads as a bright swell and a trough as soft shade;
    // much higher and the same relief turns to hard chrome.
    // Optical normal gain. With the geometric displacement kept small (above),
    // this is what actually makes the figure legible: it amplifies the field's
    // slope into the shading normal without touching the mesh, so relief reads
    // in the reflections with no faceting.
    //
    // Six superposed modes push this much harder than the old two-mode field
    // did — the summed gradient is several times larger — so the gain comes
    // DOWN from 15. Too high and the surface stops reading as liquid and turns
    // into hard light/dark wedges with no reflection in between.
    uNormalGain: { value: 6.0 },
    // Clear shallow water over polished steel. Too dark a body and the liquid
    // reads as an opaque tinted disc; too white and it clips under the studio.
    // This sits just below the steel floor so pigment and caustics read.
    uWater: { value: new THREE.Vector3(0.62, 0.70, 0.78) },
    uCaustics: { value: 1 },
    uCausticK: { value: 6.2e-7 },
    uDepth: { value: 1 },
    uNodal: { value: 0 },
    uRefract: { value: 0.006 },
    // (absorbance scale, mass scale) for Beer–Lambert absorption. `mass` is now
    // the OPTICAL PATH LENGTH multiplier for pigment suspended in the water —
    // the colour is no longer painted on the surface, it is light that made it
    // through the liquid. Absorbance scale is kept below 1 so a pour stays
    // luminous; full-strength density saturates to black long before a real
    // volume of dye would.
    // Absorbance scale raised to reach full saturation in dense pours (measured:
// the reference has ~11% of its dish at maximum chroma, this render had none).
// Mass scale raised alongside so coverage tracks the deeper colour and dense
// regions read as real deposit rather than a tint.
uInkDensity: { value: new THREE.Vector2(2.3, 3.4) },
    uTime: { value: 0 },
    uMicro: { value: 0.020 },
    // Fraction of the shading relief the refracted path follows. High enough
    // that the bowl bends WITH the ripples (one coherent water), low enough
    // that rays stay inside the vessel instead of sampling the dark studio.
    uReliefMix: { value: 0.55 },
    // How strongly caustic crests shadow the troughs behind them.
    uShadowMix: { value: 1 },
    uDebug: { value: 0 },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    // Real TRANSMISSION, not a tinted opaque disc. Water is a dielectric: light
    // enters, travels through the liquid, picks up the pigment suspended in it
    // and exits. Refraction (ior 1.33) is what bends the polished steel bowl
    // seen through the surface — the single strongest "this is water" cue, and
    // the one an opaque surface can never produce.
    //
    // Kept below 1 deliberately. At full transmission the refracted ray swings
    // far on every ripple, misses the bowl entirely and samples the dark studio
    // surround instead — which is what painted hard black wedges across the
    // surface. A partial transmission keeps a fraction of the shading normal's
    // own response, so those regions still read as water with pigment in it.
    transmission: 0.62,
    thickness: LIQUID_THICKNESS,
    ior: 1.333,
    // Water itself is nearly colourless; this is the faint cool cast over a
    // long path, not the colour of the liquid.
    attenuationColor: new THREE.Color(0.82, 0.90, 0.96),
    attenuationDistance: 2.2,
    // Near-mirror surface so the studio's strips read as sharp highlights.
    // Not purely a look knob: three.js picks the mip level for the
    // transmission buffer FROM this roughness, so a perfectly smooth surface
    // samples the refracted image unfiltered and every ripple facet resolves
    // into a hard radial spoke. A small value dissolves that tessellation
    // while leaving the surface reflection itself sharp.
    roughness: 0.075,
    metalness: 0,
    envMapIntensity: 1.0,
    specularIntensity: 1.0,
    side: THREE.FrontSide,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uField;
uniform float uR;
uniform float uAmp;
varying vec2 vLuv;
varying float vH;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
{
  vec2 luv = position.xz / (2.0 * uR) + 0.5;
  float rr = length(luv - 0.5) * 2.0;
  float hgt = texture2D(uField, luv).r;
  vLuv = luv;
  vH = hgt;
  // simulated surface + a small capillary rise where it meets the wall
  transformed.y += hgt * uAmp + smoothstep(0.90, 1.0, rr) * 0.012;
}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON_FRAG_PARS}`)
      // ---- shading normal from the live height field --------------------
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
{
  vec2 luv = vLuv;
  // Shared with the refraction below — see fieldGrad(). One field, one answer.
  vec2 gradUv = fieldGrad(luv, uTexel); // ∂h/∂uv
  vec2 slope = gradUv * uAmp * uNormalGain / (2.0 * uR);
  // a real surface has a physical slope limit; clamping keeps a strong
  // optical gain from tipping the surface past vertical into CG-looking facets
  // A real surface has a physical slope limit. Clamping it also stops a steep
    // crest from catching a whole softbox in one flat patch — which is what
    // turns water into hard-edged white and tan blobs.
    // A real water surface cannot stand much past ~30° without breaking up.
    // This clamp is what keeps a strong optical gain from tipping whole lobes
    // past vertical, where they stop reflecting and become flat dark wedges.
    // Smoothly cap the total slope magnitude instead of clipping X/Y
    // components independently. A hard clamp creates broad regions with the
    // same normal, which appear as flat polygon facets in the reflection.
    // The asymptotic bound remains 0.34 (about 19°), so the liquid stays
    // shallow while its specular gradient remains continuous.
    slope = slope / sqrt(1.0 + dot(slope, slope) / (0.34 * 0.34));

  // Fine secondary ripple detail (guide §6.5) — a supporting layer only.
  // The epsilon must be SMALLER than the noise's own wavelength (1/34 ≈
  // 0.03 uv): a larger offset turns the "gradient" into amplified noise,
  // which samples into visible blocks across the whole basin.
  float epsN = 0.0025;
  float n0 = vnoise(luv * 26.0 + vec2(uTime * 0.35, -uTime * 0.25));
  float nx = vnoise((luv + vec2(epsN, 0.0)) * 26.0 + vec2(uTime * 0.35, -uTime * 0.25));
  float ny = vnoise((luv + vec2(0.0, epsN)) * 26.0 + vec2(uTime * 0.35, -uTime * 0.25));
  // Scaled down from the old value: the six-mode figure already supplies fine
  // structure, and this high-frequency noise is what turns the dye refraction
  // into coloured speckle.
  slope += vec2(nx - n0, ny - n0) / epsN * uMicro * 0.0018;

  vec3 nObj = normalize(vec3(-slope.x, 1.0, -slope.y));
  // meniscus: the surface leans inward where it climbs the basin wall
  float rr = length(luv - 0.5) * 2.0;
  vec2 rdir = normalize(luv - 0.5 + 1e-6);
  nObj = normalize(nObj + vec3(-rdir.x, 0.0, -rdir.y) * smoothstep(0.90, 1.0, rr) * 0.5);
  normal = normalize((viewMatrix * vec4(nObj, 0.0)).xyz);
}`,
      )
      // ---- pigment as matter inside the liquid -------------------------
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
vec2 luvC = vLuv;

// refraction: the ink layer shifts with the surface normal (guide §6.3)
vec2 dyeUv = clamp(luvC + vec2(0.0), vec2(0.001), vec2(0.999));
{
  // The SAME gradient the surface is shaded with (fieldGrad above), so the ink
  // seen through the water sits exactly where the ripple above it bends.
  // Clamped hard: the dye is 1024² while this gradient is estimated at 512²,
  // so even a modest offset walks across many texels of ink and tears
  // filaments into dashes.
  vec2 g = clamp(fieldGrad(luvC, uTexel), vec2(-0.28), vec2(0.28));
  dyeUv = clamp(luvC - g * uRefract, vec2(0.001), vec2(0.999));
}
vec4 dyeS = texture2D(uDye, dyeUv);
// Beer–Lambert absorption for pigment SUSPENDED IN THE WATER.
//
// The difference that matters: this is applied to the light that has already
// travelled THROUGH the liquid (below, after the transmission chunk), not to
// the surface's own colour. Colouring diffuseColor instead is what made the
// ink look like paint floating on top — it ignored the refracted bowl behind
// the surface entirely. Multiplying the transmitted radiance means the dye
// tints whatever is behind the water exactly as a real volume of ink would,
// and because absorbance accumulates additively, blue over yellow still
// transmits blue·green = green.
vec3 dyeAbsorb = exp(-dyeS.rgb * uInkDensity.x);
// Resurrect chroma: at depth every channel tends to saturate and the hue
// slides to neutral. Pulling transmission toward its strongest channel keeps
// a poured colour luminous instead of muddy.
dyeAbsorb += maxComp(dyeAbsorb) * 0.20 * (vec3(1.0) - dyeAbsorb);
// Drive deep concentrations to FULL saturation. Measured against the reference,
// that image carries ~11% of its dish at maximum chroma with a saturation
// spread of 0.32, while this render had essentially none — every pour decayed
// to a pale wash and no colour ever reached full strength. The chromatic
// channels are pushed apart only where the pigment is genuinely dense, so thin
// films stay subtle and only real deposits achieve the saturated core the
// reference shows.
{
  float depth = maxComp(dyeS.rgb);
  float push = smoothstep(0.35, 1.6, depth);
  // Push channels apart around the mean: this is what raises CHROMA without
  // changing luminance, which is exactly the difference between "saturated
  // colour" and "brighter colour".
  float meanCh = (dyeAbsorb.r + dyeAbsorb.g + dyeAbsorb.b) / 3.0;
  dyeAbsorb = clamp(meanCh + (dyeAbsorb - meanCh) * (1.0 + push * 1.35), 0.0, 1.0);
}
// How much liquid the eye is looking through here — a standing swell of dye
// is a longer optical path than a clear trough, so it reads as denser.
// The height is sampled from the field texture rather than taken from the
// varying: vH is interpolated across the polar mesh, so using it here makes
// the path length step ring by ring and the dye bands visibly along the
// tessellation. Texture sampling is smooth everywhere.
float pathLen = 1.0 + clamp(texture2D(uField, luvC).r, -1.0, 1.0) * 0.30 * uDepth;
dyeAbsorb = pow(dyeAbsorb, vec3(pathLen));
float cover = 1.0 - exp(-dyeS.a * uInkDensity.y);
// suspended micro-bubbles: a faint animated glitter inside dense pigment,
// the way a real pour holds countless tiny air bells that catch the light
float sparkleSrc = vnoise(luvC * 240.0 + vec2(uTime * 1.6, -uTime * 1.1));
float sparkle = smoothstep(0.80, 0.98, sparkleSrc) * cover * 0.10;
// Light scattered back OUT of the water by the pigment itself. Its colour is
// the dye's own transmitted hue, so a red pour scatters red — this is what
// keeps a colour readable even over a dark part of the bowl, and it is what
// makes the ink feel suspended IN something rather than painted ON it.
vec3 dyeScatter = dyeAbsorb * cover;
// The surface's own body is nearly colourless — with transmission on, this is
// only the small diffuse remainder, not the visible colour of the liquid.
diffuseColor.rgb = uWater;`,
      )
      // ---- caustics + nodal diagnostic ----------------------------------
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  vec2 luvE = vLuv;
  // Same wide, averaged stencil as the shading normal. A 1-texel Laplacian on
  // a six-mode field aliases per texel and, once clamped, paints the dish with
  // hard rectangular blocks instead of soft caustic light.
  vec2 ce = uTexel * 2.0;
  float hC = texture2D(uField, luvE).r;
  float hL = (texture2D(uField, luvE - vec2(ce.x, 0.0)).r + texture2D(uField, luvE - vec2(uTexel.x, 0.0)).r) * 0.5;
  float hR = (texture2D(uField, luvE + vec2(ce.x, 0.0)).r + texture2D(uField, luvE + vec2(uTexel.x, 0.0)).r) * 0.5;
  float hD = (texture2D(uField, luvE - vec2(0.0, ce.y)).r + texture2D(uField, luvE - vec2(0.0, uTexel.y)).r) * 0.5;
  float hU = (texture2D(uField, luvE + vec2(0.0, ce.y)).r + texture2D(uField, luvE + vec2(0.0, uTexel.y)).r) * 0.5;
  float div = hL + hR + hU + hD - 4.0 * hC;
  // curvature in physical units (∂²h/∂uv²) so the gain is resolution-independent
  float lapn = div / (ce.x * ce.x);
  // a crest focuses light: controlled highlight, not a repeated bright grid.
  // Kept as a gentle ADD only. An earlier trough-darkening counterpart
  // clipped hard (curvature scales with k², so it saturated across whole
  // lobes) and painted the dish as a black butterfly.
  // Curvature is computed in field units, not metres: div is divided by the
  // stencil width squared (≈1.5e-5), which puts realistic |lapn| in the 1e6
  // range. The gain below is calibrated against that scale — set it an order of
  // magnitude too high and every crest clips to solid white, which reads as
  // grey blobs floating on the surface rather than as focused light.
  float caustic = pow(clamp(-lapn * uCausticK, 0.0, 1.0), 1.2);

  // ---- caustics with self-shadowing and pigment scattering --------------
  // Merged from the PR's "keep focused light as a detail" work: the caustic is
  // weighted by pigment coverage and never clips to white chips, because the
  // stable nodal geometry has to stay visible through it. On a real Chladni
  // plate the bright lines ARE the settled powder catching light, so the
  // caustic only gains strength where dye has actually collected — which is
  // what makes the figure develop over time instead of appearing instantly.
  //
  // The self-shadowing march below is the other half: a crest blocks light
  // from reaching the trough behind it, and that contrast is most of what
  // sells the water as deep rather than as a pattern on a flat sheet.
  {
    vec2 toLight = normalize(vec2(-0.42, -0.91));   // studio key direction, in uv
    float shade = 0.0;
    // 5 taps along the light direction; if the surface rises above the line of
    // sight from this point, this texel is in that crest's shadow.
    for (int s = 1; s <= 5; s++) {
      float t = float(s) * 2.4;                    // texels of march
      vec2 sp = luvE + toLight * uTexel * t;
      float occl = texture2D(uField, sp).r - texture2D(uField, luvE).r;
      shade += smoothstep(0.0, 0.035, occl) * (1.0 - float(s) / 6.0);
    }
    shade = clamp(shade * 0.34 * uShadowMix, 0.0, 1.0);
    float shadeTerm = 1.0 - shade;
    float powder = clamp(cover * 1.4, 0.0, 1.0);
    vec3 lit = vec3(1.0, 0.99, 0.95) * caustic * uCaustics * shadeTerm;
    lit += dyeAbsorb * powder * caustic * 1.6 * uCaustics * shadeTerm;
    totalEmissiveRadiance += lit;
    // Store the shadow for the lighting stage — totalDiffuse does not exist
    // yet in this chunk, so the ambient occlusion it implies is applied after
    // transmission instead of here.
    gShade = shade;
  }
  // nodal map (debug): bright lines where the raw modal shape crosses zero
  float node = exp(-abs(texture2D(uField, luvE).g) * 11.0);
  totalEmissiveRadiance += vec3(0.16, 0.42, 0.85) * node * uNodal * 0.55;
}`,
      )
      // ---- the pigment lives INSIDE the water -------------------------
      // This runs after three.js has refracted the scene through the surface
      // (transmission_fragment), so `totalDiffuse` is the light that actually
      // travelled through the liquid. Attenuating it by the dye is what makes
      // colour behave like ink in water instead of paint on top: the steel bowl
      // stays visible through the pour, bent by the ripples, and the dye only
      // changes the colour of the light coming back out.
      .replace(
        '#include <transmission_fragment>',
        /* glsl */ `#include <transmission_fragment>
// The single most important correction in this file.
//
// three.js refracts using the SHADING normal, which here carries the whole
// cymatic relief. On a strongly rippled surface that ray swings far enough to
// miss the bowl entirely and sample the dark studio surround — the hard black
// wedges that kept appearing across the surface no matter how the gains were
// tuned. Real water in a shallow dish barely bends what is directly beneath
// it: the light path is short and the surface is near-horizontal.
//
// So the refraction is done against a DELIBERATELY FLAT normal. The relief
// still drives the shading normal above (which is what makes the figure read
// in the reflections) and still drives the caustics — only the transmitted
// light path is calmed down, which is both closer to physical reality for a
// shallow pool and the thing that keeps the bowl visible through the water.
{
  // UNIFYING THE TWO WATERS.
  //
  // three.js refracts using the shading normal, which here carries the whole
  // cymatic relief. Left alone, the refracted ray swings far enough on a
  // rippled surface to miss the bowl and sample the dark studio — the hard
  // black wedges that no amount of gain tuning could remove. A purely flat
  // normal fixes those but throws away the relief: the bowl under the water
  // stays rigid while the surface ripples, and the composite reads as two
  // unrelated images.
  //
  // So the refracted path follows the SAME relief as the shading, through the
  // SAME fieldGrad() the shading normal uses, at a fraction of the strength.
  // Surface and what lies beneath it now bend together and can never disagree,
  // while the reduced factor keeps rays inside the vessel.
  vec2 rg = clamp(fieldGrad(vLuv, uTexel) * uAmp * uNormalGain / (2.0 * uR) * uReliefMix,
                  vec2(-0.22), vec2(0.22));
  vec3 objN = normalize(vec3(-rg.x, 1.0, -rg.y));
  vec3 calmN = normalize(transformNormalByInverseViewMatrix(objN, viewMatrix));
  vec3 wp = vWorldPosition;
  vec3 vv = normalize(cameraPosition - wp);
  vec4 calm = getIBLVolumeRefraction(
    calmN, vv, material.roughness, material.diffuseContribution, material.specularColorBlended,
    material.specularF90, wp, modelMatrix, viewMatrix, projectionMatrix, material.dispersion,
    material.ior, material.thickness, material.attenuationColor, material.attenuationDistance);
  totalDiffuse = mix(totalDiffuse, calm.rgb, material.transmission);
}
totalDiffuse *= dyeAbsorb;
// Ambient occlusion from the caustic self-shadow computed earlier. A trough
// behind a crest receives less of everything, not just less caustic, and that
// ambient loss is most of what makes the relief read as depth rather than as
// a pattern drawn on a flat sheet.
totalDiffuse *= 1.0 - gShade * 0.45;
// A dense pour also scatters light back out of the liquid, which is why real
// ink in water is luminous rather than a flat cutout — and why a drop of
// colour is still readable where the refracted bowl behind it is dark.
totalDiffuse += dyeScatter * uWater * 1.4;`,
      )
      // ---- raw-field debug views (?debug=dye|mode|h) ---------------------
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
if (uDebug > 0.5) {
    vec3 dbg = vec3(0.5);
    if (uDebug > 4.5) {
      dbg = vec3(1.0, 0.0, 0.0);      // coverage probe: is the liquid drawn here?
    } else if (uDebug < 1.5) {
    vec4 d = texture2D(uDye, vLuv);
    dbg = mix(vec3(0.5), d.rgb / max(d.a, 1e-3), clamp(d.a * 1.4, 0.0, 1.0));
    } else if (uDebug < 2.5) {
      dbg = vec3(clamp(0.5 + texture2D(uField, vLuv).g * 0.8, 0.0, 1.0));
    } else {
      dbg = vec3(clamp(0.5 + texture2D(uField, vLuv).r * 0.7, 0.0, 1.0));
    }
    gl_FragColor = vec4(dbg, 1.0);
  }`,
      );

    // Fail loudly rather than silently.
    // String#replace on a three.js shader chunk that has been renamed or
    // removed is a no-op, and the symptom is not a crash — it is a flat,
    // featureless, untextured disc that looks exactly like a broken physics
    // model. This project lost hours to that once, so the injections are
    // asserted rather than assumed.
    const v = shader.vertexShader;
    const f = shader.fragmentShader;
    for (const [marker, where] of [
      ['vLuv = luv;', v],
      ['transformed.y += hgt', v],
      ['uniform sampler2D uField;', f],
      ['slope = gradUv', f],
      ['exp(-dyeS.rgb', f],
      ['totalDiffuse *= dyeAbsorb', f],
      ['uDebug > 0.5', f],
    ] as const) {
      if (!where.includes(marker)) {
        throw new Error(
          `liquid.ts: shader injection "${marker}" did not match any chunk — ` +
            `a three.js chunk name changed. The water will render as a flat disc.`,
        );
      }
    }
  };

  return { material, uniforms };
}
