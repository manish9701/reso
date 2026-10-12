/**
 * Vessel — a real cross-section lathed into a solid (guide §5).
 *
 * The reference for this build is a polished stainless dish: rounded bottom
 * edge, a rising outer wall, a thick rolled crown and an inner wall
 * descending to a shallow floor. Tiny bevels everywhere — a perfectly sharp
 * edge reads as computer-generated.
 */
import * as THREE from 'three';

/** Outer radius of the vessel (world units). */
export const DISH_R = 1.0;

/**
 * Cross-section: [radius, height], from the outer floor centre to the inner
 * floor centre. The wall and crown are kept deliberately THIN (the crown is
 * ~0.02 of radius across) so the vessel reads as a pressed stainless dish —
 * a heavy-walled bowl looks like a cauldron and eats the composition.
 */
const PROFILE: Array<[number, number]> = [
  [0.000, 0.000],
  [0.790, 0.000],
  [0.910, 0.004],
  [0.958, 0.022],
  [0.986, 0.050],
  [0.997, 0.082],
  [1.000, 0.108],
  [0.998, 0.126],
  [0.991, 0.140],
  [0.979, 0.147], // crown — outer edge
  [0.970, 0.148], // crown — top
  [0.963, 0.146], // crown — inner edge (0.016 across: a thin pressed plate)
  [0.956, 0.138],
  [0.949, 0.122],
  [0.941, 0.100],
  [0.931, 0.076],
  [0.919, 0.056],
  [0.906, 0.042],
  [0.894, 0.032],
  [0.878, 0.026],
  [0.850, 0.023],
  [0.600, 0.020],
  [0.000, 0.019], // inner floor centre — the pool sits above this
];

/** Chaikin corner-cutting: rounds transitions into small machined bevels. */
function smoothProfile(pts: Array<[number, number]>, iterations = 2): Array<[number, number]> {
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

export function createDishGeometry(segments = 256): THREE.BufferGeometry {
  const profile = smoothProfile(PROFILE, 2).map(([r, h]) => new THREE.Vector2(r, h));
  const geo = new THREE.LatheGeometry(profile, segments);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Vessel material — brushed stainless steel, not glass.
 *
 * A metal bowl is what a real cymatics rig uses, and it is what makes the
 * pigment read: the polished wall mirrors the ink back into the composition,
 * giving the warm copper bounce and dark rim contrast seen in the reference.
 * Anisotropy fakes the turned/brushed circumferential grain that stops a
 * metal from looking like a chrome ball.
 */
export function createDishMaterial(): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    // Polished stainless, as in the reference render: a mirror that carries
    // bright silver bands, dark reflected contrast and warm copper streaks.
    // The warmth comes from the studio's copper kickers, not from the tint.
    color: new THREE.Color(0.92, 0.92, 0.94),
    metalness: 1,
    // True mirror roughness. At 0.16 the wall still scattered the strip lights
    // into a soft grey haze and read as satin; below ~0.08 the lathe reflects
    // the environment sharply and the dish looks pressed and polished.
    roughness: 0.085,
    anisotropy: 0.35,
    anisotropyRotation: Math.PI / 2,
    envMapIntensity: 1.35,
    side: THREE.FrontSide,
  });
  return mat;
}
