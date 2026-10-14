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
  uDepth: { value: number };
  uNodal: { value: number };
  uRefract: { value: number };
  uInkDensity: { value: THREE.Vector2 };
  uTime: { value: number };
  uMicro: { value: number };
  /** fraction of the shading relief the refracted path follows */
  uReliefMix: { value: number };
  uDebug: { value: number };
  /** lean-tier toggle, surfaced from quality.ts (see the engine constructor) */
  uLean: { value: number };
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
uniform float uDepth;
uniform float uNodal;
uniform float uRefract;
uniform vec2 uInkDensity;    // (absorbance scale, mass scale) for Beer–Lambert
uniform float uTime;
uniform float uMicro;
uniform float uDebug;
uniform float uReliefMix;    // how much relief the refracted path follows
// File-scope globals are the only thing that survives between the separate
// chunks three.js injects into main(). gRefract is the raw transmission
// sample, kept for the ?debug=refract view.
vec3 gRefract = vec3(0.0);
varying vec2 vLuv;

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
    //
    // The value here is only the starting point: engine.step() drives it from
    // the dominant mode's wavenumber every frame, because the field gradient
    // itself grows with k and a fixed gain cannot serve the whole band. See
    // RELIEF_BASE / RELIEF_EXP in engine.ts for the measurement behind it.
    uNormalGain: { value: 6.5 },
    uDepth: { value: 1 },
    uNodal: { value: 0 },
    uRefract: { value: 0.006 },
    // Absorbance scale 2.3 -> 0.85, and this is the single change that makes the
    // water read as transparent with the colour living INSIDE it.
    //
    // inkAbsorbance() returns -ln(linear colour), so a deep ink's densest
    // channel is ~5-7. At a scale of 2.3 that is A·density ~14, and exp(-14) is
    // effectively zero: every pour transmitted no light at all, so ALL the
    // visible colour had to come from the additive scatter term instead. That
    // is the mechanism behind every colour complaint — the transmission path
    // was black, the scatter path was doing the work, and a scatter term cannot
    // darken on overlap, so the mixing was wrong.
    //
    // At 0.85 a single pour peaks around A·density ~5, i.e. exp(-5) ≈ 0.7 in the
    // transmitted channel and near zero in the ones it absorbs. That is a real
    // filter: most of the bowl still shows through, and what comes through is
    // the ink's own hue. Overlapping pours then add absorbance and go dark on
    // their own, with no correction needed.
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
uInkDensity: { value: new THREE.Vector2(3.6, 6.0) },
    uTime: { value: 0 },
    uMicro: { value: 0.0 },
    // Fraction of the shading relief the refracted path follows. High enough
    // that the bowl bends WITH the ripples (one coherent water), low enough
    // that rays stay inside the vessel instead of sampling the dark studio.
    uReliefMix: { value: 0.55 },
    uDebug: { value: 0 },
    // Set from the detected GPU tier in the engine constructor.
    uLean: { value: 0 },
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
    // NEAR transparent rather than perfectly clear. At exactly 1.0 the surface is
    // pure glass and the eye reads a still photograph; holding a few percent of
    // the material's own response gives the pool a faint luminous body, so there
    // is always a sense of liquid in the dish even where the figure is flat.
// Low enough not to reintroduce the opaque grey disc the transmission tint used
    // to produce (see the diffuseColor note below).
    transmission: 0.94,
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
    // 1.0 -> 1.45. The surface reflection is where the cymatic relief reads — the
    // studio's bright strips and dark flags sweep across the water as the
    // normals tilt. At 1.0 the dish interior mirrored the dark studio flags
    // almost exclusively, which is what turned the whole pool charcoal in
    // clear water and left the pigment as the only thing visible.
    envMapIntensity: 1.45,
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
    // A real water surface cannot stand much past ~30° without breaking up, so
  // the slope is bounded — but the bound is SOFT, above a knee, rather than a
  // hard clamp.
  //
  // The hard clamp this replaces was reached across 83% of the dish at 432 Hz
  // and 88% at 790 Hz (measured — see scripts/slope.mjs), because the gain was
  // an order of magnitude too high (fixed in engine.ts). A hard clamp there
  // means the normal is CONSTANT over most of the surface: the whole figure
  // collapses to one flat tone per lobe and renders as a hard-edged embossed
  // pattern stamped on the water instead of as relief.
  //
  // Below the knee the slope passes through untouched, so ordinary parts of the
  // figure keep their true slope. Above it the slope rolls off asymptotically
  // instead of clipping, so a steep crest stays a rounded swell with the
  // gradient still varying across it, and the surface keeps catching the studio
  // instruments in bands rather than freezing into flat facets.
  const float KNEE = 0.20;
  const float SLOPE_MAX = 0.52;
  vec2 s2 = abs(slope);
  if (s2.x > KNEE || s2.y > KNEE) {
    vec2 over = max(s2 - KNEE, vec2(0.0));
    s2 = min(s2, vec2(KNEE)) + (SLOPE_MAX - KNEE) * tanh(over / (SLOPE_MAX - KNEE));
  }
  slope = sign(slope) * s2;

  // Fine secondary ripple detail (guide §6.5) — a supporting layer only.
  // The epsilon must be SMALLER than the noise's own wavelength (1/34 ≈
  // 0.03 uv): a larger offset turns the "gradient" into amplified noise,
  // which samples into visible blocks across the whole basin.
  float epsN = 0.0025;
  float n0 = vnoise(luv * 26.0 + vec2(uTime * 0.10, -uTime * 0.07));
  float nx = vnoise((luv + vec2(epsN, 0.0)) * 26.0 + vec2(uTime * 0.10, -uTime * 0.07));
  float ny = vnoise((luv + vec2(0.0, epsN)) * 26.0 + vec2(uTime * 0.10, -uTime * 0.07));
  // Crawl suppression: the earlier version animated the phase every frame at
  // full amplitude, which produced a restless crawling grain over the whole
  // surface. The phase now moves slowly, and the amplitude is a fraction of
  // the original — it reads as capillary sparkle instead of rolling static.
  slope += vec2(nx - n0, ny - n0) / epsN * uMicro * 0.0007;

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
  //
  // Clamped HARD, and this clamp is load-bearing rather than defensive. The
  // field is 512² and the dye buffer is 768², so one texel of field gradient
  // is already more than a texel of dye. The offset below is in UV, applied to
  // a texture 1.5x finer than the gradient it came from — so a gradient of
  // only ±0.05 (perfectly normal on a ripple crest) walks across ~38 dye
  // texels. That is what tore every filament into vertical dashes: the ink was
  // being sampled from somewhere else entirely, and the wrong part of the
  // pattern was substituted wherever the surface tilted.
  //
  // Measured fix: the grain survives with this at 0 but not at 0.0045, which
  // puts the worst-case walk inside a dye texel. Below ~0.003 the ink visibly
  // detaches from the ripples it is supposed to be under.
  vec2 g = clamp(fieldGrad(luvC, uTexel) * 0.35, vec2(-0.28), vec2(0.28));
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
// NO CHROMA RESURRECTION, and no chroma push. This is the mixing bug.
//
// Both of those corrections pull the three channels back toward each other,
// and they were added to fight a symptom (dense pours reading muddy) that was
// actually caused by unbounded absorbance. Now that the pigment field bounds
// density (see the ABS_CEIL clamp in sim/shaders.ts), a genuine blue-over-
// yellow overlap transmits blue·yellow ≈ green·0.4 — a DARK green. The chroma
// helpers then "resurrected" that dark green toward its own strongest channel,
// and because green is green's strongest channel they lifted it back toward
// full brightness. The overlap ended up BRIGHTER than either parent: measured
// 0.877 against parents at 0.53 and 0.45, with only 3 green pixels in the whole
// overlap region instead of thousands.
//
// Subtractive mixing is already correct in the physics — absorbance is
// additive, so exp(-A_total) does the right thing by itself. Any correction
// that pushes the channels apart is fighting that. Leaving the transmission
// exactly as Beer-Lambert computed it is what makes overlap darken.
// Drive deep concentrations to FULL saturation. Measured against the reference,
// that image carries ~11% of its dish at maximum chroma with a saturation
// spread of 0.32, while this render had essentially none — every pour decayed
// to a pale wash and no colour ever reached full strength. The chromatic
// channels are pushed apart only where the pigment is genuinely dense, so thin
// films stay subtle and only real deposits achieve the saturated core the
// reference shows.
// How much liquid the eye is looking through here — a standing swell of dye
// is a longer optical path than a clear trough, so it reads as denser.
// The height is sampled from the field texture rather than taken from the
// varying: vH is interpolated across the polar mesh, so using it here makes
// the path length step ring by ring and the dye bands visibly along the
// tessellation. Texture sampling is smooth everywhere.
// Bounded path length, and applied to the ABSORBANCE rather than the
// transmission. A swell of dye is a longer optical path, so it reads denser —
// but pow() on a transmission value is a brightness curve that flattens toward
// 0 and toward 1, which is how the deepest pours ended up losing their colour
// (the reported "the colour goes dark after a few seconds"). Scaling the
// absorbance scales the optical path in the physically meaningful direction,
// and the exp() still does the compression.
float pathLen = 1.0 + clamp(texture2D(uField, luvC).r, -1.0, 1.0) * 0.28 * uDepth;
dyeAbsorb = exp(-dyeS.rgb * (uInkDensity.x * pathLen));
float cover = 1.0 - exp(-dyeS.a * uInkDensity.y);

// Light scattered back OUT of the water by suspended pigment volume:
vec3 dyeScatter = dyeAbsorb * cover;

// Clear dielectric water: the medium itself transmits essentially everything.
// Absorption is NOT done here — it is Beer–Lambert below (dyeAbsorb) plus the
// path attenuation three.js applies — so the medium's own albedo must be
// WHITE, not zero.
//
// This used to be vec3(0.0), chosen so no diffuse wash would cover the silver
// basin. That is the one value that cannot be used, because three.js derives
// the transmission tint from it:
//
//     material.diffuseContribution = diffuseColor.rgb * (1 - metalness);
//     transmittance    = diffuseColor * volumeAttenuation(path, ...);
//     transmittedLight *= transmittance;
//
// A zero albedo therefore multiplies the refracted image by ZERO. The water
// rendered as an opaque black disc carrying nothing but a specular sheen, and
// no amount of studio, dish or caustic tuning could change it — which is
// exactly the "flat, featureless disc that looks like a broken physics model"
// this file has been fighting all along. Isolated by hiding the dish and the
// ground, painting the background a strong blue (the water stayed black), and
// reading the transmission sample back through ?debug=refract.
//
// White is both correct (water is nearly colourless) and necessary. The diffuse
// wash it was meant to avoid never appears anyway: transmission REPLACES
// totalDiffuse outright a few chunks later.
diffuseColor.rgb = vec3(1.0);`,
      )
      // ---- nodal diagnostic ------------------------------------------------
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  // The caustic/emissive block that used to live here is GONE, and that is a
  // deliberate removal rather than a retune.
  //
  // It measured curvature with a 12-texel Laplacian of the height field and
  // added it as emissive light. Two things were wrong with that:
  //
  //  1. It drew CONCENTRIC RINGS. The probe is radially symmetric about the
  //     dish centre, so the highlights it produced came out as circles —
  //     visible in clear water as "lines coming out of the colour", which is
  //     exactly what was reported.
  //  2. Its gain was pathological. The engine drove uCausticK from a base
  //     roughly 150x below the value the shader needs, which left the term
  //     contributing nothing at some settings and hard clipping at others,
  //     so it was pure aliasing risk with no reliable visual payoff. The
  //     project's own history records repeated attempts to tune it away.
  //
  // Real cymatic relief is seen as REFLECTION, not as glow: the surface tilts
  // and the studio instruments sweep across it. That is carried by the
  // shading normal, which now works correctly (see engine.ts RELIEF_BASE), so
  // nothing is lost by deleting this.

  // Nodal map — a debug overlay, off unless requested.
  vec2 luvE = vLuv;
  float node = exp(-abs(texture2D(uField, luvE).g) * 11.0);
  totalEmissiveRadiance += vec3(0.16, 0.42, 0.85) * node * uNodal * 0.55;
}`,
      )
      // ---- pigment absorption + the raw-field debug views ---------------
      // Debug views (?debug=dye|mode|h) are applied at the very END of the
      // chain, in the dithering chunk, so they still work if any of the
      // physical blocks above is changed or removed.
      .replace(
        '#include <transmission_fragment>',
        /* glsl */ `#include <transmission_fragment>
{
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
  gRefract = calm.rgb;

  // NO extra environment term here.
  //
  // This used to add a textureCubeUV lookup of the overhead softbox along a
  // single fixed direction, scaled by 0.35, applied to every pixel of the pool. It was there to stop the water going dark, but it adds a
  // large, nearly CONSTANT term across the whole dish, and a constant term is
  // exactly what flattens an image: it swamps the refracted steel bowl beneath
  // (which is bright, structured, and the single best cue that this is water in
  // a metal dish) and leaves one flat warm grey with the relief only faintly
  // visible on top. Removing it restores the bowl and the caustic-like
  // structure; the pool is now lit by what is actually under and over it.
}

// Physical light transport through water with suspended ink:
// 1. Transmitted light filtered by Beer-Lambert absorption:
vec3 transmittedRadiance = totalDiffuse * dyeAbsorb;

// 2. Pigment volume backscatter. Light that entered the film, scattered and
//    came back out carries the pigment's HUE, at a brightness set by how much
//    light survived the trip.
//
//    The old version normalised the colour toward FULL saturation and FULL
//    brightness — pigmentChroma / max(pigmentChroma) mixed in at 38% — which
//    quietly divides by whatever the colour's largest channel happens to be.
//    For any NEUTRAL ink that is catastrophic: pure black has zero chroma and
//    one equal non-zero value, so it normalises to (1, 1, 1) and mixing 38%
//    toward that lifted a black pour to mid grey. That is the reported "black
//    behaves weird — it turns white". Taking the hue from the ratio and the
//    BRIGHTNESS from dyeAbsorb keeps neutrals dark and still gives saturated
//    inks their colour.
vec3 pigmentHue = dyeAbsorb / max(maxComp(dyeAbsorb), 1e-3);
vec3 backscatter = pigmentHue * dyeAbsorb * 2.0;

// 3. Volume: light through the film, plus what the film itself scatters back.
totalDiffuse = transmittedRadiance + backscatter * cover;

// 4. Dense pigment is MATTE. The specular lobe is not part of the transmitted
//    path, so it was surviving untouched and being added on top of the ink —
//    which is why every dark pour, black most of all, came back looking washed
//    out and pale rather than like ink. A film of pigment sitting on the
//    surface destroys the mirror underneath it, so the reflection is absorbed
//    by the same filter the transmitted light is. Clear water (cover -> 0) is
//    unaffected and keeps its full studio reflection.
totalSpecular *= mix(vec3(1.0), dyeAbsorb, clamp(cover * 1.2, 0.0, 1.0));`,
      )
      // ---- raw-field debug views (?debug=dye|mode|h) ---------------------
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
if (uDebug > 0.5) {
    vec3 dbg = vec3(0.5);
    if (uDebug > 7.5) {
      dbg = vec3(clamp(gRefract, 0.0, 1.0));   // ?debug=refract — what the water actually transmits
    } else if (uDebug > 6.5) {
      dbg = vec3(0.0, 1.0, 0.0);               // ?debug=sampler — is the transmission buffer bound at all?
    } else if (uDebug > 4.5) {
      dbg = vec3(1.0, 0.0, 0.0);               // ?debug=cover — is the liquid drawn here?
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
      ['vec3 transmittedRadiance = totalDiffuse * dyeAbsorb', f],
      ['totalDiffuse = transmittedRadiance + backscatter * cover', f],
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
