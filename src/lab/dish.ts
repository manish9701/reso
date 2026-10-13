/**
 * Vessel — a real cross-section lathed into a solid (guide §5).
 *
 * The reference for this build is a polished stainless dish: rounded bottom
 * edge, a rising outer wall, a thick rolled crown, an inner wall descending
 * to a shallow floor, and machined bevels everywhere a perfectly sharp edge
 * would read as computer-generated.
 *
 * Material: TRUE physically based metal — MeshPhysicalMaterial with
 * metalness 1.0 and a roughness tuned inside the 0.18–0.30 window. A metal
 * bowl is what a real cymatics rig uses, and it is what makes pigment read:
 * the polished wall mirrors the ink back into the composition. What stops a
 * metalness:1 surface from looking like featureless chrome is a generated
 * circumferential BRUSHED microtexture: anisotropy plus a fine, directional
 * roughness/bump map that follows the lathe (u wraps the circumference, so
 * the grain is streaked along u, exactly like real turned marks).
 */
import * as THREE from 'three';

/** Outer radius of the vessel (world units). */
export const DISH_R = 1.0;

/**
 * Cross-section: [radius, height], from the outer floor centre to the inner
 * floor centre. Substantial but not cauldron-like: the crown is a ~0.05·R
 * thick rolled lip with a rounded crown and a proper chamfer into the inner
 * wall, so reflections wrap around the rim instead of appearing painted on.
 */
const PROFILE: Array<[number, number]> = [
  [0.000, 0.000],
  [0.780, 0.000],
  [0.880, 0.002],
  [0.940, 0.012],
  [0.970, 0.034],
  [0.992, 0.072],
  [0.999, 0.108],
  [1.000, 0.132],
  [0.996, 0.156],
  [0.986, 0.172], // crown — outer shoulder
  [0.972, 0.178], // crown — rounded top (rolled lip)
  [0.958, 0.172],
  [0.946, 0.156], // crown — inner shoulder
  [0.940, 0.132],
  [0.936, 0.104], // inner wall head
  [0.926, 0.062],
  [0.912, 0.040],
  [0.895, 0.028],
  [0.876, 0.023],
  [0.860, 0.0215],
  [0.600, 0.020],
  [0.000, 0.019], // inner floor centre — the pool sits above this
];

/** Chaikin corner-cutting: rounds transitions into small machined bevels. */
function smoothProfile(pts: Array<[number, number]>, iterations = 3): Array<[number, number]> {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const out: Array<[number, number]> = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const [x0, y0] = cur[i];
      const [x1, y1] = cur[i + 1];
      out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      out.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

export function createDishGeometry(segments = 320): THREE.BufferGeometry {
  const profile = smoothProfile(PROFILE, 3).map(([r, h]) => new THREE.Vector2(r, h));
  const geo = new THREE.LatheGeometry(profile, segments);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Generated brushed-metal texture (roughness in the green channel + a bump
 * source). LatheGeometry unwraps the circumference along u, and real turning
 * marks run circumferentially — so the grain is noise STRETCHED along u
 * (one long streak per row) with only a slight per-strand variation, plus a
 * restrained fine grain that never reads as scratches.
 *
 * Deliberately subtle: the goal is "brushed", not "sanded". Values stay
 * within ±0.035 of the base roughness so the material keeps its coherent
 * PBR response and the reflections stay clean silver with soft edges.
 */
function brushedTexture(size = 1024, baseRough = 0.24): THREE.CanvasTexture {
  const cn = document.createElement('canvas');
  cn.width = cn.height = size;
  const ctx = cn.getContext('2d')!;
  const img = ctx.createImageData(size, size);

  // Deterministic value noise, heavily anisotropic in frequency so strands
  // run along u. Row-to-row continuity matters: with a coarse lattice (jumpy
  // per-row values) the lathe shows visible seams where u wraps at 0/1.
  const strand = new Float32Array(size);
  let s = 8873;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  // 1-D smooth noise per row (strand brightness), smoothed twice so rows
  // flow into each other like real grain
  for (let y = 0; y < size; y++) strand[y] = rnd() - 0.5;
  for (let pass = 0; pass < 2; pass++) {
    const t = strand.slice();
    for (let y = 0; y < size; y++) strand[y] = t[(y + size - 1) % size] * 0.25 + t[y] * 0.5 + t[(y + 1) % size] * 0.25;
  }

  for (let y = 0; y < size; y++) {
    // each strand is a row-complete line in uv space (wraps in u → seamless)
    const g = baseRough + strand[y] * 0.045;
    for (let x = 0; x < size; x++) {
      // fine intra-strand grain: barely-there variation along the streak
      const fx = Math.sin(x * 0.021 + y * 0.0007) * 0.012 + Math.sin(x * 0.007 - y * 0.0023) * 0.01;
      let r = g + fx;
      // vignette into the user-requested window: keep roughness sane
      r = Math.min(0.30, Math.max(0.18, r));
      // roughnessMap uses the GREEN channel; same texture doubles as a very
      // low-amplitude bump (luminance) for micro-parallax grazing response
      const lum = Math.round(((r - baseRough) / 0.06 + 0.5) * 255);
      const i = (y * size + x) * 4;
      img.data[i] = lum;
      img.data[i + 1] = Math.round(((r - 0.18) / 0.12) * 255);
      img.data[i + 2] = lum;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cn);
  tex.wrapS = THREE.RepeatWrapping;  // wrap the circumference seam
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1, 1);
  return tex;
}

/**
 * Vessel material — brushed stainless steel, not glass, not grey plastic.
 *
 * MeshPhysicalMaterial at metalness 1.0, roughness tuned inside the
 * 0.18–0.30 window the guide prescribes, mild anisotropy for the turned
 * grain, and the generated brushed map above. The material IS the metal's
 * albedo/roughness response — the reflected silver/charcoal/copper bands
 * come from the studio environment, not from anything painted here.
 */
export function createDishMaterial(): {
  material: THREE.MeshPhysicalMaterial;
  brushed: THREE.CanvasTexture;
} {
  const brushed = brushedTexture(1024, 0.24);
  const mat = new THREE.MeshPhysicalMaterial({
    // Neutral stainless. The colour of a metal is its specular tint; steel
    // reads as slightly cool. Warmth in the reference comes from the studio's
    // copper kickers reflecting in the wall, not from the material.
    color: new THREE.Color(0.90, 0.91, 0.93),
    metalness: 1.0,
    // Polished-but-not-mirror: with the baked studio this produces the
    // bright silver sweeps WITH soft edges, instead of a chrome ball.
    roughness: 0.235,
    roughnessMap: brushed,
    // Mild anisotropy fakes the turned grain's elongated reflections. Kept
    // small and aligned with the lathe's tangents — stronger anisotropy
    // turned the strip reflections into a radial sunburst (fake polish).
    anisotropy: 0.28,
    anisotropyRotation: 0,
    bumpMap: brushed,
    bumpScale: 0.0006,            // restrained microrelief, never coarse noise
    envMapIntensity: 1.25,
    side: THREE.FrontSide,        // the profile loop closes at the axis
    clearcoat: 0,                 // steel, not lacquer or plastic
    reflectivity: 0.9,
  });
  return { material: mat, brushed };
}
