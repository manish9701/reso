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
  [0.760, 0.000],
  [0.900, 0.006],
  [0.958, 0.030],
  [0.988, 0.068],
  [1.000, 0.112],
  [1.000, 0.148],
  [0.996, 0.170],
  [0.984, 0.184],
  [0.966, 0.190], // crown — outer half
  [0.949, 0.187], // crown — inner half (thin: 0.017 across)
  [0.936, 0.176],
  [0.928, 0.158],
  [0.922, 0.128],
  [0.914, 0.098],
  [0.900, 0.078],
  [0.876, 0.068],
  [0.820, 0.062],
  [0.400, 0.058],
  [0.000, 0.056],
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
    // Polished stainless, as in the reference render: bright silver body with
    // dark contrast in the reflections. The warmth comes from the copper
    // kickers in the studio env, not from the metal tint itself.
    color: new THREE.Color(0.78, 0.78, 0.80),
    metalness: 1,
    // Low roughness is what lets the studio's strip lights draw long, sharp
    // highlights down the wall; anisotropy stretches them circumferentially
    // so it reads as a spun/polished dish rather than a chrome ball.
    roughness: 0.16,
    anisotropy: 0.45,
    anisotropyRotation: Math.PI / 2,
    clearcoat: 0.5,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.35,
    side: THREE.FrontSide,
  });
  return mat;
}
