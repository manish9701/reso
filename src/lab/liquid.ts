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
export const LIQUID_R = 0.862;
/** Rest surface height (world units) inside the basin. The dish's inner floor
 *  sits at y ≈ 0.067 (see dish.ts PROFILE); the liquid rests just above it. */
export const LIQUID_Y = 0.068;

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
  uDebug: { value: number };
}

/** Polar disc: dense enough for smooth vertex displacement (guide §6).
 *  Topology is deliberately high (rings × segments) so the travelling
 *  ripples and the standing relief read as a continuous surface rather
 *  than a faceted polygon — the silhouette against the dish wall is what
 *  gives the water away if it is too coarse. */
export function createLiquidGeometry(radius = LIQUID_R, rings = 200, segments = 288): THREE.BufferGeometry {
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
    uAmp: { value: 0.042 },
    // Optical normal gain lifts the shading slope to a legible level without
    // tipping the surface past vertical. With the studio's vertical gradient
    // this is where a crest reads as a bright swell and a trough as soft shade;
    // much higher and the same relief turns to hard chrome.
    uNormalGain: { value: 8.5 },
    // Clear shallow water over polished steel. Too dark a body and the liquid
    // reads as an opaque tinted disc; too white and it clips under the studio.
    // This sits just below the steel floor so pigment and caustics read.
    uWater: { value: new THREE.Vector3(0.48, 0.56, 0.66) },
    uCaustics: { value: 1 },
    uCausticK: { value: 3.6e-7 },
    uDepth: { value: 1 },
    uNodal: { value: 0 },
    uRefract: { value: 0.006 },
    // (absorbance scale, mass scale) for Beer–Lambert transmission. The mass
    // scale drives `cover`, which is what suppresses specular over dense
    // pigment. The absorbance scale is kept below 1 so ink stays luminous and
    // saturated — full-strength density drives transmission to black and the
    // colour dies into mud long before the mass builds to a real pour.
    uInkDensity: { value: new THREE.Vector2(0.85, 2.2) },
    uTime: { value: 0 },
    uMicro: { value: 0.020 },
    uDebug: { value: 0 },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    // Water is glossy — that sharp specular sweep IS how the figure reads.
    // Clearer water: tighter roughness for a harder, more mirror-like fist
    // of reflections, with the studio supplying the light and shade.
    roughness: 0.14,
    metalness: 0,
    clearcoat: 0.45,
    clearcoatRoughness: 0.14,
    // Glossy, because a glossy surface is what turns the studio's vertical
    // brightness gradient into visible light-and-shade across the ripples.
    // Kept BELOW the dish's intensity: a water-thin Fresnel layer should show
    // the dark studio between highlights, not mirror the whole room (that is
    // what washed the surface to milk in the first tuning pass).
    envMapIntensity: 0.75,
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
  // Wide, averaged central difference. A 1-texel difference amplifies the
  // field's texel noise straight into the shading normal, which is what makes
  // a surface look grainy rather than liquid. Averaging over a 2-texel span
  // low-passes it and gives the smooth, continuous surface water has.
  vec2 e = uTexel * 2.0;
  float hL = (texture2D(uField, luv - vec2(e.x, 0.0)).r + texture2D(uField, luv - vec2(uTexel.x, 0.0)).r) * 0.5;
  float hR = (texture2D(uField, luv + vec2(e.x, 0.0)).r + texture2D(uField, luv + vec2(uTexel.x, 0.0)).r) * 0.5;
  float hD = (texture2D(uField, luv - vec2(0.0, e.y)).r + texture2D(uField, luv - vec2(0.0, uTexel.y)).r) * 0.5;
  float hU = (texture2D(uField, luv + vec2(0.0, e.y)).r + texture2D(uField, luv + vec2(0.0, uTexel.y)).r) * 0.5;
  vec2 gradUv = vec2(hR - hL, hU - hD) * 0.5 / e.x; // ∂h/∂uv
  vec2 slope = gradUv * uAmp * uNormalGain / (2.0 * uR);
  // a real surface has a physical slope limit; clamping keeps a strong
  // optical gain from tipping the surface past vertical into CG-looking facets
  // A real surface has a physical slope limit. Clamping it also stops a steep
    // crest from catching a whole softbox in one flat patch — which is what
    // turns water into hard-edged white and tan blobs.
    slope = clamp(slope, vec2(-0.55), vec2(0.55));

  // Fine secondary ripple detail (guide §6.5) — a supporting layer only.
  // The epsilon must be SMALLER than the noise's own wavelength (1/34 ≈
  // 0.03 uv): a larger offset turns the "gradient" into amplified noise,
  // which samples into visible blocks across the whole basin.
  float epsN = 0.0025;
  float n0 = vnoise(luv * 26.0 + vec2(uTime * 0.35, -uTime * 0.25));
  float nx = vnoise((luv + vec2(epsN, 0.0)) * 26.0 + vec2(uTime * 0.35, -uTime * 0.25));
  float ny = vnoise((luv + vec2(0.0, epsN)) * 26.0 + vec2(uTime * 0.35, -uTime * 0.25));
  slope += vec2(nx - n0, ny - n0) / epsN * uMicro * 0.004;

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
  float hL = texture2D(uField, luvC - vec2(uTexel.x, 0.0)).r;
  float hR = texture2D(uField, luvC + vec2(uTexel.x, 0.0)).r;
  float hD = texture2D(uField, luvC - vec2(0.0, uTexel.y)).r;
  float hU = texture2D(uField, luvC + vec2(0.0, uTexel.y)).r;
  vec2 g = vec2(hR - hL, hU - hD) * 0.5 / uTexel.x;
  // clamp the refraction offset: an unbounded shift on a steep crest samples
  // across the ink and produces rainbow speckle
  g = clamp(g, vec2(-0.8), vec2(0.8));
  dyeUv = clamp(luvC - g * uRefract, vec2(0.001), vec2(0.999));
}
vec4 dyeS = texture2D(uDye, dyeUv);
// Beer–Lambert: the light reaching the eye is attenuated exponentially by the
// pigment's optical density. Because absorbance accumulates additively in the
// sim, this reproduces real subtractive pigment mixing for free — blue ink
// over yellow ink transmits blue·green, i.e. green, not grey.
vec3 trans = exp(-dyeS.rgb * uInkDensity.x);
float cover = 1.0 - exp(-dyeS.a * uInkDensity.y);
// Resurrect chroma: dense pigment slides toward neutral grey because every
// channel eventually saturates. Pulling transmission toward its strongest
// channel keeps the poured hue luminous at depth, like real ink viewed
// against a bright metal bowl.
trans += maxComp(trans) * 0.20 * (vec3(1.0) - trans);
vec3 waterCol = uWater;
// depth tint: cooler and slightly deeper under the pigment (guide §6.4) —
// kept gentle, too much here and the water reads as opaque paint instead
// of a transparent film over steel.
waterCol = mix(waterCol, vec3(0.58, 0.68, 0.80), uDepth * 0.22);
waterCol *= 1.0 - clamp(-vH, 0.0, 1.0) * 0.14 * uDepth;
// suspended micro-bubbles: a faint animated glitter inside dense pigment,
// the way a real ink pour holds countless tiny air bells that catch light
float sparkleSrc = vnoise(luvC * 240.0 + vec2(uTime * 1.6, -uTime * 1.1));
float sparkle = smoothstep(0.80, 0.98, sparkleSrc) * cover * 0.10;
diffuseColor.rgb = waterCol * trans + vec3(sparkle);`,
      )
      // ---- ink sits slightly rougher than clear water -------------------
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.38, cover);`,
      )
      // wet pigment is a matte film: killing its specular is what lets the
      // colour read instead of being washed white by the studio reflection
      .replace(
        '#include <lights_physical_fragment>',
        /* glsl */ `#include <lights_physical_fragment>
#ifdef USE_SPECULAR
    // denser pigment loses specular, but not all of it — a wet ink film is
    // still glossy, and that sheen is part of what keeps colour saturated
    material.specularColor = mix(material.specularColor, vec3(0.10), cover);
#endif`,
      )
      // ---- caustics + nodal diagnostic ----------------------------------
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  vec2 luvE = vLuv;
  // Same wide, averaged stencil as the shading normal. A 1-texel Laplacian on
  // a 512² field aliases per texel and, once clamped, paints the dish with
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
  totalEmissiveRadiance += vec3(1.0, 0.99, 0.95) * caustic * uCaustics * (1.0 - cover * 0.45);
  // nodal map (debug): bright lines where the raw modal shape crosses zero
  float node = exp(-abs(texture2D(uField, luvE).g) * 11.0);
  totalEmissiveRadiance += vec3(0.16, 0.42, 0.85) * node * uNodal * 0.55;
}`,
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
