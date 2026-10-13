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
  /** overall weight of the analytic refracted-basin term */
  uRefractGain: { value: number };
  uInkDensity: { value: THREE.Vector2 };
  uTime: { value: number };
  uMicro: { value: number };
  /** fraction of the shading relief the refracted path follows */
  uReliefMix: { value: number };
  /** caustic self-shadowing strength */
  uShadowMix: { value: number };
  uDebug: { value: number };
  /** 1 = lean/integrated tier: skip optional per-pixel work */
  uLean: { value: number };
}

/** Polar disc: dense enough for smooth vertex displacement (guide §6).
 *  Topology is deliberately high (rings × segments) so the travelling
 *  ripples and the standing relief read as a continuous surface rather
 *  than a faceted polygon — the silhouette against the dish wall is what
 *  gives the water away if it is too coarse. */
export function createLiquidGeometry(radius = LIQUID_R, rings = 256, segments = 320): THREE.BufferGeometry {
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
uniform float uRefractGain;
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
// Shared field neighbourhood: fetched ONCE in the shading-normal block and
// reused by the caustics and the dye refraction. File-scope because
// three.js injects each chunk separately into main().
float gHC = 0.0, gHL = 0.0, gHR = 0.0, gHD = 0.0, gHU = 0.0;
uniform float uLean;    // 1 = lean/integrated GPU tier: skip optional taps
varying vec2 vLuv;
varying float vH;
varying vec3 vWorldPos;

float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float maxComp(vec3 v) { return max(v.x, max(v.y, v.z)); }

/**
 * Soft-saturation reference for the surface slope.
 *
 * ~19°: past that a real water surface breaks up, and beyond a hard limit the
 * shading normal can tip far enough past vertical to read as flat dark wedges
 * instead of liquid.
 */
const float RELIEF_SOFT = 0.34;

/**
 * Height neighbourhood of the live field — ONE fetch set, shared by the
 * shading normal, the caustics and the refraction.
 *
 * Shared on purpose: when these were computed separately, what the eye sees
 * THROUGH the water never agreed with the ripples seen ON it, and the
 * composite read as two unrelated images stapled together. One field, one
 * neighbourhood, one answer.
 *
 * Returns (center, left, right, down, up). The lean tier takes the wide
 * stencil only (4 fetches instead of 8); the high tier averages a second,
 * narrower ring to suppress texel-scale ripple in the figure.
 */
void fieldNhood(vec2 uv, out float hC, out float hL, out float hR, out float hD, out float hU) {
  vec2 e = uTexel * 2.0;
  hC = texture2D(uField, uv).r;
  hL = texture2D(uField, uv - vec2(e.x, 0.0)).r;
  hR = texture2D(uField, uv + vec2(e.x, 0.0)).r;
  hD = texture2D(uField, uv - vec2(0.0, e.y)).r;
  hU = texture2D(uField, uv + vec2(0.0, e.y)).r;
  if (uLean < 0.5) {
    hL = (hL + texture2D(uField, uv - vec2(uTexel.x, 0.0)).r) * 0.5;
    hR = (hR + texture2D(uField, uv + vec2(uTexel.x, 0.0)).r) * 0.5;
    hD = (hD + texture2D(uField, uv - vec2(0.0, uTexel.y)).r) * 0.5;
    hU = (hU + texture2D(uField, uv + vec2(0.0, uTexel.y)).r) * 0.5;
  }
}

/** ∂h/∂uv from the same neighbourhood (shared with the caustics). */
vec2 nhoodGrad(float hL, float hR, float hD, float hU) {
  return vec2(hR - hL, hU - hD) * 0.5 / (uTexel.x * 2.0);
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
    uAmp: { value: 0.015 },
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
    uNormalGain: { value: 5.2 },
    // Clear shallow water over polished steel: nearly colourless, with the
    // faint cool cast a shallow depth of clean water gives. The bowl and its
    // colour now reach the eye THROUGH the surface instead of behind an
    // opaque tinted disc.
    // A cool, properly saturated water tint. This was near-white (0.75, 0.84,
    // 0.92), which is what made everything grey: the scatter term below is
    // scaled by this colour, so a near-white tint washed every mixed pigment
    // toward white and killed the subtractive mixing along with it.
    uWater: { value: new THREE.Vector3(0.75, 0.84, 0.92) },
    uCaustics: { value: 1 },
    uCausticK: { value: 4.8e-7 },
    uDepth: { value: 1 },
    uNodal: { value: 0 },
    uRefract: { value: 0.0045 },
    // Weight of the analytic refracted-basin radiance — the water's optical
    // body: the polished steel floor seen through the surface, bent by the
    // live relief, absorbed by the pigment.
    uRefractGain: { value: 0.5 },
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
uInkDensity: { value: new THREE.Vector2(2.6, 2.2) },
    uTime: { value: 0 },
    uMicro: { value: 0.006 },
    // Fraction of the shading relief the refracted path follows. High enough
    // that the bowl bends WITH the ripples (one coherent water), low enough
    // that rays stay inside the vessel instead of sampling the dark studio.
    uReliefMix: { value: 0.42 },
    // How strongly caustic crests shadow the troughs behind them. Deliberately
    // below 1: a full-contrast march read as huge shaded wedges; controlled
    // shading enriches the caustics without dominating the image.
    uShadowMix: { value: 0.45 },
    uDebug: { value: 0 },
    uLean: { value: 0 },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    // TRANSMISSION IS NOW ANALYTIC — see basinRadiance() in the shader.
    // three.js's screen-space transmission re-renders the entire opaque scene
    // into a mip-chained buffer every frame; measured on the target machine
    // that single pass dominated the whole frame (p95 350 ms → ~60 ms without
    // it) and its mip selection produced block seams across the pool. The
    // water's optical body is now computed directly: the polished steel basin
    // seen along the refracted-then-mirrored ray, absorbed through the water
    // column and the pigment, Fresnel-weighted against the surface reflection
    // that three.js already computes. Physically the better model for a
    // shallow pool over a mirror-finish basin, and a fraction of the cost.
    transmission: 0,
    thickness: LIQUID_THICKNESS,
    ior: 1.333,
    // Water itself is nearly colourless; this is the faint cool cast over a
    // long path, not the colour of the liquid.
    attenuationColor: new THREE.Color(0.80, 0.89, 0.95),
    attenuationDistance: 2.4,
    // Near-mirror surface so the studio's strips read as sharp highlights.
    // Not purely a look knob: three.js picks the mip level for the
    // transmission buffer FROM this roughness, so a perfectly smooth surface
    // samples the refracted image unfiltered and every ripple facet resolves
    // into a hard radial spoke. A small value dissolves that tessellation
    // while leaving the surface reflection itself sharp. Also the mip the
    // transmission buffer is sampled at: too coarse and the refracted image
    // shows blocky mip-boundary seams (the straight chords seen earlier).
    roughness: 0.055,
    metalness: 0,
    // The surface reflection is where the cymatic relief reads: the studio's
    // bright strips and dark flags move across the surface as the normals
    // tilt. Kept strong so fine (high-frequency) figures still separate.
    envMapIntensity: 2.4,
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
varying float vH;
varying vec3 vWorldPos;`,
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
  // world position for the analytic basin refraction below
  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
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
  // ONE fetch set, shared with the caustics and the dye refraction below.
  fieldNhood(luv, gHC, gHL, gHR, gHD, gHU);
  vec2 gradUv = nhoodGrad(gHL, gHR, gHD, gHU); // ∂h/∂uv
  vec2 slope = gradUv * uAmp * uNormalGain / (2.0 * uR);
  // A real surface has a physical slope limit — but a HARD clamp is exactly
  // why raising the frequency used to make the cymatics disappear: high modes
  // carry proportionally less slope at the same visual amplitude, so they hit
  // the limit first and every crest saturated to the same slope — flat,
  // identical, dead. A SOFT saturation (tanh) is monotonic and smooth, so a
  // finer figure is merely compressed, never flattened, and its highlights
  // still separate.
  slope = vec2(
    RELIEF_SOFT * tanh(slope.x / RELIEF_SOFT),
    RELIEF_SOFT * tanh(slope.y / RELIEF_SOFT)
  );

  // Fine secondary ripple detail (guide §6.5) — a supporting layer only, and
  // deliberately QUIET. The epsilon must be SMALLER than the noise's own
  // wavelength (1/34 ≈ 0.03 uv): a larger offset turns the "gradient" into
  // amplified noise, which samples into visible blocks across the basin.
  //
  // Crawl suppression (this was the "groan"): the earlier version animated
  // the noise phase every frame at full amplitude, which produced a restless
  // crawling grain over the whole surface. The phase now moves slowly, and
  // the amplitude is a fraction of the original — it reads as capillary
  // sparkle instead of rolling static.
  float epsN = 0.0025;
  float n0 = vnoise(luv * 26.0 + vec2(uTime * 0.10, -uTime * 0.07));
  float nx = vnoise((luv + vec2(epsN, 0.0)) * 26.0 + vec2(uTime * 0.10, -uTime * 0.07));
  float ny = vnoise((luv + vec2(0.0, epsN)) * 26.0 + vec2(uTime * 0.10, -uTime * 0.07));
  slope += vec2(nx - n0, ny - n0) / epsN * uMicro * 0.0007;

  vec3 nObj = normalize(vec3(-slope.x, 1.0, -slope.y));
  // meniscus: the surface leans inward where it climbs the basin wall
  float rr = length(luv - 0.5) * 2.0;
  vec2 rdir = normalize(luv - 0.5 + 1e-6);
  nObj = normalize(nObj + vec3(-rdir.x, 0.0, -rdir.y) * smoothstep(0.92, 1.0, rr) * 0.38);
  normal = normalize((viewMatrix * vec4(nObj, 0.0)).xyz);
}`,
      )
      // ---- pigment as matter inside the liquid -------------------------
      // ---- the analytic basin refraction -------------------------------
      // Defined out here (before main(), right after three.js declares the
      // environment helpers) because GLSL cannot nest function definitions.
      .replace(
        '#include <envmap_physical_pars_fragment>',
        /* glsl */ `#include <envmap_physical_pars_fragment>
      vec3 basinRadiance(vec3 worldPos, vec3 worldNormal, vec3 worldView, vec3 dyeAbsorb) {
        vec3 rDir = refract(worldView, worldNormal, 1.0 / 1.333);
        if (dot(rDir, rDir) < 1e-6) rDir = worldView;            // total-internal guard
        float depth = 0.075;                                      // water column (m)
        float t = depth / max(0.08, -rDir.y);                     // path to the floor
        vec3 floorPos = worldPos + rDir * t;

        // The floor is brushed steel: mirror the refracted ray off it and take
        // the studio's radiance along that direction.
        vec3 reflDir = reflect(rDir, vec3(0.0, 1.0, 0.0));
        vec3 floorRad = vec3(0.30);
        #ifdef USE_ENVMAP
          floorRad = textureCubeUV(envMap, envMapRotation * reflDir, 0.30).rgb;
        #endif
        floorRad *= 0.85 + 0.15 * vnoise(floorPos.xz * 120.0);   // the dish's turned grain

        // THE BASIN'S OWN STRUCTURE. The studio environment is smooth in the
        // directions a shallow pool looks into, so sampling it alone gave the
        // pool a flat pale wash. What the eye actually sees through water in a
        // steel dish is the machined floor — concentric turning rings — darkening
        // into the inner wall. Synthesising that analytically (three cheap terms,
        // no second scene render) gives the refracted image real structure, and
        // because it is sampled along the REFRACTED ray it shifts and bends with
        // the live relief: the figure shows up in the water body, not just in
        // the surface reflection.
        float rr = length(floorPos.xz) / 0.87;
        float rings = 0.96 + 0.04 * sin(rr * 90.0);           // turned rings
        float wallDark = mix(1.0, 0.42, smoothstep(0.72, 1.0, rr)); // inner wall
        floorRad *= rings * wallDark * 0.45;

        // Beer-Lambert down the water column, then the pigment over the same
        // path. NOTE: no pigment-coverage factor here — the refracted body is
        // present in CLEAR water too (that is the whole point of water); the
        // dye only changes its colour.
        vec3 sigma = (vec3(1.0) - uWater) * 3.0;
        vec3 transmitted = floorRad * exp(-sigma * t) * dyeAbsorb;

        // Fresnel: at grazing angles the surface reflects and transmission drops.
        float cosT = clamp(dot(-worldView, worldNormal), 0.0, 1.0);
        float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        return transmitted * (1.0 - F);
      }`,
      )      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
vec2 luvC = vLuv;

// refraction: the ink layer shifts with the surface normal (guide §6.3)
vec2 dyeUv = clamp(luvC + vec2(0.0), vec2(0.001), vec2(0.999));
{
  // The SAME neighbourhood the surface is shaded with (fieldNhood above), so the ink
  // seen through the water sits exactly where the ripple above it bends.
  // Clamped hard: the dye is 1024² while this gradient is estimated at 512²,
  // so even a modest offset walks across many texels of ink and tears
  // filaments into dashes.
  vec2 g = clamp(nhoodGrad(gHL, gHR, gHD, gHU) * 0.9, vec2(-0.28), vec2(0.28));
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
// Drive deep concentrations to chromatic, full saturation in the CORE of a
// pour while thin films stay translucent ramps — the hard photometric cliffs
// of exp(−A) at high density are what previously turned every deposit into a
// flat, razor-edged blob. The chromatic channels are pushed apart only where
// the pigment is genuinely dense.
{
  float depth = maxComp(dyeS.rgb);
  // Only the genuinely deep pigment is pushed, and gently.
  //
  // At 2.2x, once a pour was dense enough the channels were driven to their
  // extremes and clipped, which is what destroyed the mixing: over-saturated
  // primaries stop being combinable, so overlapping colours stopped reading
  // as subtractive mixes (blue over yellow going green) and just stacked as
  // flat clipped regions.
  float push = smoothstep(0.6, 1.8, depth);
  // Push channels apart around the mean: raises CHROMA without changing
  // luminance, which is the difference between "saturated" and "brighter".
  float meanCh = (dyeAbsorb.r + dyeAbsorb.g + dyeAbsorb.b) / 3.0;
  dyeAbsorb = clamp(meanCh + (dyeAbsorb - meanCh) * (1.0 + push * 0.8), 0.0, 1.0);
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
// Suspended micro-bubbles catching the light.
  //
  // This was the "random grainy layer that appears when you click the water".
  // At a spatial frequency of 240 across a ~900px dish, each noise cell lands
  // on roughly four pixels — far above the sampling rate, so it aliased into
  // crawling static rather than reading as bubbles. It was also scaled by
  // the cover term, so it was invisible on clear water and appeared exactly
  // where ink was deposited, which is what made it look like clicking caused it.
  //
  // Lowered to a frequency that is actually resolvable, and gated to only the
  // densest pigment so it stays a subtle sheen instead of a film.
  float sparkleSrc = vnoise(luvC * 46.0 + vec2(uTime * 0.9, -uTime * 0.6));
  float sparkle = smoothstep(0.74, 0.96, sparkleSrc) * cover * cover * 0.045;
// Light scattered back OUT of the water by the pigment itself. Its colour is
// the dye's own transmitted hue, so a red pour scatters red — this is what
// keeps a colour readable even over a dark part of the bowl, and it is what
// makes the ink feel suspended IN something rather than painted ON it.
// The colour a pour shows is its TRANSMITTED hue (dyeAbsorb, already
// chroma-separated above), normalised so a thin film still reads as its own
// colour instead of washing to near-white, and weighted by how much pigment
// is present. Note the sign discipline: the field stores ABSORBANCE, so the
// colour of the pigment is exp(-absorbance) — normalising the absorbance
// itself would show the complement (blue ink reading as orange).
vec3 dyeHue = dyeAbsorb / max(maxComp(dyeAbsorb), 1e-4);
vec3 dyeScatter = dyeHue * cover;
// The surface's own body is nearly colourless — with transmission on, this is
// only the small diffuse remainder, not the visible colour of the liquid.
// The surface's own body is nearly BLACK water: at a 52° view angle water
    // reflects only ~5% of what it receives, so a diffuse body large enough
    // to "see" is large enough to hide every highlight — the pool read as
    // milky pale-blue and the relief vanished with it. All of the water's
    // visible body now comes from the refracted basin below (the correct
    // source), and what is left here is just a faint scattering floor.
    diffuseColor.rgb = uWater * 0.18;`,
      )
      // ---- caustics + nodal diagnostic ----------------------------------
      // Reuses the SAME neighbourhood the shading normal already fetched (see
      // fieldNhood) instead of re-sampling the field, and the lean tier skips
      // the light-march entirely. The previous version spent 8 fetches here
      // plus a 3-tap march â€” the single heaviest block in the frame.
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  // curvature in field units: one Laplacian over the shared 4-tap stencil
  float div = gHL + gHR + gHU + gHD - 4.0 * gHC;
  float lapn = div / ((uTexel.x * 2.0) * (uTexel.x * 2.0));

  // SOFT KNEE instead of clamp(,0,1). A clamp turns every over-driven crest
  // into the same solid white patch â€” which is precisely the "white grain
  // waves" that raced across the surface when a drop kicked the field: the
  // ripple crests clipped to 1.0 everywhere and read as bright noise. The
  // rational knee L/(1+L) is monotonic and bounded: crests still focus light,
  // but the response compresses instead of clipping, so structure survives.
  float Lc = max(0.0, -lapn * uCausticK);
  float caustic = Lc / (1.0 + Lc);

  // Fade the caustics out at the SHORT-wavelength end: a drop ripple is a
  // travelling wave a few texels wide, and focusing light on grid-scale
  // roughness reads as grain rather than as caustics. Only the large-scale
  // standing structure should carry the highlight. The probe reuses the
  // neighbourhood the stencil already took.
  float rippleFade = smoothstep(0.0, 0.20, abs(gHR - gHL) + abs(gHU - gHD));
  caustic *= rippleFade;

  float shade = 0.0;
  if (uLean < 0.5) {
    // Caustic self-shadowing: a crest blocks light from reaching the trough
    // behind it, which is what turns veins into light-and-shade. High tier
    // only, with a WIDE march â€” marching at one-texel spacing tracked
    // grid-scale ripple curvature and painted the other half of the grain.
    vec2 toLight = normalize(vec2(-0.42, -0.91));
    for (int s = 1; s <= 2; s++) {
      float t = float(s) * 5.0;
      float occl = texture2D(uField, vLuv + toLight * uTexel * t).r - gHC;
      shade += smoothstep(0.0, 0.05, occl) * (1.0 - float(s) / 3.0);
    }
    shade = clamp(shade * 0.26 * uShadowMix, 0.0, 1.0);
  }
  float shadeTerm = 1.0 - shade;

  // Powder scattering: on a real Chladni plate the bright nodal lines ARE the
  // settled powder catching the light, so weighting the caustic by gathered
  // dye is what makes the figure DEVELOP rather than appear. Kept subtle â€” at
  // full strength it stamps saturated ink-shaped colour along the crests.
  float powder = clamp(cover * 1.4, 0.0, 1.0);
  vec3 lit = vec3(1.0, 0.99, 0.95) * caustic * uCaustics * shadeTerm;
  lit += dyeAbsorb * powder * caustic * 0.4 * uCaustics * shadeTerm;
  totalEmissiveRadiance += lit;
  gShade = shade;
  // nodal map (debug): bright lines where the raw modal shape crosses zero
  float node = exp(-abs(texture2D(uField, vLuv).g) * 11.0);
  totalEmissiveRadiance += vec3(0.16, 0.42, 0.85) * node * uNodal * 0.55;
}`,
      )
      // ---- the pigment lives INSIDE the water -------------------------
      // Runs right after three.js's transmission slot, i.e. after the standard
      // PBR lighting but BEFORE `outgoingLight` is assembled â€” so the surface's
      // own specular reflection (energy-conserving, from the same env map and
      // lights) is already computed, and only the light coming back UP through
      // the water is added: the basin floor's radiance along the refracted and
      // then mirrored ray, absorbed through the water column and the suspended
      // pigment, Fresnel-weighted against the reflection. That is what makes
      // colour behave like ink IN water instead of paint on top of it.
      .replace(
        '#include <transmission_fragment>',
        /* glsl */ `#include <transmission_fragment>


{
  // The shading normal arrives in view space; viewMatrix is orthonormal, so the
  // row-vector product recovers the world-space direction.
  vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 wV = normalize(vWorldPos - cameraPosition);
  vec3 basin = basinRadiance(vWorldPos, wN, wV, dyeAbsorb);

  // Caustic self-shadow (computed in the emissive chunk) dims the body too, so
  // troughs behind crests read as depth, not as a pattern on a flat sheet.
  basin *= 1.0 - gShade * 0.32;

  // light returning through the liquid
  totalDiffuse += basin * uRefractGain;
  // pigment scattered back out of the water: real ink is luminous rather than
  // a flat cutout, and it stays readable over a dark patch of the studio
  totalDiffuse += dyeScatter * uWater * 2.1;
}`,
      )
      // ---- raw-field debug views (?debug=dye|mode|h) ---------------------
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
if (uDebug > 0.5) {
    vec3 dbg = vec3(0.5);
    if (uDebug > 4.5 && uDebug < 5.5) {
      dbg = vec3(1.0, 0.0, 0.0);      // coverage probe: is the liquid drawn here?
    } else if (uDebug >= 5.5) {
      // shading-normal probe: red/green = the surface tilt, blue = flat
      dbg = vec3(normal.x * 0.5 + 0.5, normal.y * 0.5 + 0.5, normal.z * 0.5 + 0.5);
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
      ['totalDiffuse += basin', f],
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
