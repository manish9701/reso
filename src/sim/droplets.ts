/**
 * Droplets — real falling drops of coloured liquid.
 *
 * This replaces "colour appears under the cursor", which reads as a brush
 * stroke, with "you dropped something into water":
 *
 *  1. A drop FALLS under gravity from above the dish, keeping its colour and
 *     staying a compact volume — it is not painted on, it is a body of liquid.
 *  2. It STRETCHES as it accelerates: a falling drop goes teardrop, and that
 *     shape is most of what makes it read as a drop rather than a bead.
 *  3. On contact it IMPACTS — it drives a strike into the wave solver and
 *     releases its pigment at the contact point.
 *  4. The released pigment mixes by the existing Beer-Lambert physics, so a
 *     red drop landing in blue water mixes subtractively, as real dye does.
 *  5. The wave the drop made then carries that colour into the cymatic flow,
 *     so the drop's colour is carried by the figure rather than sitting on it.
 *
 * Physics is deliberately simple (ballistic fall + drag) because that is what
 * governs how a drop looks; the interesting mixing happens in the dye field.
 */

import * as THREE from 'three';
import { inkAbsorbance } from '../lab/engine';

/** Drops in flight at once. */
export const MAX_DROPS = 28;
/** Height a drop is released from, in world units above the water surface. */
const RELEASE_HEIGHT = 0.34;
/** World height of the water surface (kept in sync with LIQUID_Y in liquid.ts). */
const SURFACE_Y = 0.094;

interface Drop {
  live: boolean;
  /** disc position, uv 0..1 */
  x: number;
  y: number;
  /** world height above the surface (>= 0) */
  z: number;
  /** downward velocity, world units/s */
  vz: number;
  /** radius, world units */
  r: number;
  /** pigment volume released on landing */
  vol: number;
  /** per-channel absorbance (Beer-Lambert optical density) */
  absorbance: [number, number, number];
  /** rendered colour */
  color: THREE.Color;
  /** seconds since release */
  age: number;
}

/** A falling drop: a stretched sphere with a bright meniscus. */
function dropletMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.04,
    metalness: 0,
    // Real drops are small lenses of liquid: they refract, they are not flat.
    transmission: 0.55,
    thickness: 0.06,
    ior: 1.333,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.6,
    emissive: new THREE.Color(0, 0, 0),
  });
}

export class DropletSystem {
  readonly group = new THREE.Group();
  private drops: Drop[] = [];
  private mesh: THREE.InstancedMesh;
  private material: THREE.MeshPhysicalMaterial;
  private geom: THREE.IcosahedronGeometry;
  private dummy = new THREE.Object3D();

  constructor() {
    // Icosphere: a drop is small on screen, so a low-poly sphere is plenty,
    // and it keeps the vertex count trivial for 28 instances.
    this.geom = new THREE.IcosahedronGeometry(1, 2);
    this.material = dropletMaterial();
    this.mesh = new THREE.InstancedMesh(this.geom, this.material, MAX_DROPS);
    this.mesh.frustumCulled = false;
    // Per-instance colour must exist before the first setColorAt, or the drop
    // ignores its pigment and every instance renders white.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_DROPS * 3).fill(1), 3,
    );
    // Drops are drawn in world space just above the dish.
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);

    for (let i = 0; i < MAX_DROPS; i++) {
      this.drops.push({
        live: false, x: 0.5, y: 0.5, z: 0, vz: 0, r: 0,
        vol: 0, absorbance: [0, 0, 0], color: new THREE.Color(1, 1, 1), age: 0,
      });
    }
    this.hideAll();
  }

  private hideAll(): void {
    for (let i = 0; i < MAX_DROPS; i++) {
      this.dummy.position.set(0, -999, 0);
      this.dummy.scale.setScalar(0.0001);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Release a drop above (u, v) carrying `color`. */
  spawn(u: number, v: number, color: [number, number, number], volume: number, radius: number): void {
    const d = this.drops.find((k) => !k.live);
    if (!d) return;
    d.live = true;
    d.x = u;
    d.y = v;
    d.z = RELEASE_HEIGHT * (0.75 + Math.random() * 0.5);
    d.vz = 0;
    d.r = radius;
    d.vol = volume;
    d.absorbance = inkAbsorbance(color, 1.0);
    d.color.setRGB(color[0], color[1], color[2]);
    d.age = 0;
  }

  /** Live drop count — used by the tests and the hint text. */
  get inFlight(): number {
    return this.drops.reduce((n, d) => n + (d.live ? 1 : 0), 0);
  }

  /**
   * Advance every drop. `onLand` fires once per drop as it reaches the water,
   * carrying everything the dye field and wave solver need.
   */
  step(
    dt: number,
    uvToWorld: (u: number, v: number) => { x: number; z: number },
    onLand: (u: number, v: number, radius: number, volume: number, absorbance: [number, number, number]) => void,
  ): void {
    let anyVisible = false;
    for (let i = 0; i < MAX_DROPS; i++) {
      const d = this.drops[i];
      if (!d.live) {
        continue;
      }
      d.age += dt;

      // Ballistic fall with drag. Gravity is scaled down so the drop is
      // watchable rather than arriving in two frames — the fall is part of
      // the pleasure of using it, so it must be legible.
      const G = 3.2;
      d.vz -= G * dt;
      d.vz *= 1 - Math.min(0.85, 0.55 * dt);
      d.z += d.vz * dt;

      if (d.z <= 0) {
        // IMPACT
        onLand(d.x, d.y, d.r, d.vol, d.absorbance);
        d.live = false;
        continue;
      }

      anyVisible = true;
      const w = uvToWorld(d.x, d.y);
      // A falling drop stretches along its direction of travel: teardrop, not
      // bead. Stretch grows with speed and settles back once it slows.
      const speed = Math.abs(d.vz);
      const stretch = 1 + Math.min(1.6, speed * 0.55);
      this.dummy.position.set(w.x, SURFACE_Y + d.z, w.z);
      this.dummy.scale.set(d.r, d.r * stretch, d.r);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      // instanceColor carries the drop's real pigment
      this.mesh.setColorAt(i, d.color);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.count = MAX_DROPS;
    if (!anyVisible) this.mesh.visible = false;
    else this.mesh.visible = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }
}