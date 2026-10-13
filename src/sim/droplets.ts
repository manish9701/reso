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

/**
 * Impact state machine.
 *
 *   MERGE   the drop reaches the surface, flattens onto it and starts to spread
 *   SPREAD  it thins along the surface while releasing pigment progressively
 *   DONE    gone — by then it is a film, not a body
 *
 * The previous behaviour was a single frame in which a full sphere vanished
 * and its entire pigment mass appeared at once. That reads as a teleport: the
 * drop blinks out of existence and leaves a coloured blob behind. Spreading it
 * over a handful of frames costs nothing and is the whole difference between a
 * drop that lands and one that vanishes.
 */
type Phase = 'fall' | 'merge' | 'spread' | 'done';
/** Seconds flattened on the surface before it has fully merged away. */
const MERGE_TIME = 0.055;
const SPREAD_TIME = 0.32;
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
  /** impact state */
  phase: Phase;
  /** seconds spent in the current phase */
  phaseT: number;
  /** pigment already released, so the pour is progressive not lumpy */
  released: number;
}

/**
 * A falling drop.
 *
 * Deliberately NOT MeshPhysicalMaterial. The previous version used a physical
 * material with `transmission`, which put every droplet into the scene's
 * transmission pass — the single most expensive thing in the frame — to render
 * objects a few dozen pixels across. It also looked wrong: a hard mirror-
 * specular sphere reads as a glass bead or a capsule, never as a drop of ink.
 *
 * A drop of coloured water is a small volume of pigment: it is strongly
 * coloured, mostly opaque at the core, wet on the surface, and lit by a soft
 * studio rather than by hard highlights. MeshStandardMaterial gives all of
 * that for a fraction of the cost, and the per-instance colour carries the
 * pigment through untouched.
 */
function dropletMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    // Wet, but not a mirror. A very low roughness gives a single hard specular
    // dot that reads as a bead; a little roughness spreads it into the soft
    // elongated highlight a real drop shows against a softbox.
    roughness: 0.13,
    metalness: 0,
    envMapIntensity: 1.05,
    // A touch of self-lit colour so a drop still reads as coloured when it
    // passes in front of a dark part of the dish.
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.08,
  });
}

export class DropletSystem {
  readonly group = new THREE.Group();
  private drops: Drop[] = [];
  private mesh: THREE.InstancedMesh;
  private material: THREE.MeshStandardMaterial;
  private geom: THREE.IcosahedronGeometry;
  private dummy = new THREE.Object3D();

  constructor() {
    // Detail 3 gives a smooth silhouette: at detail 2 the icosahedron's facets
    // are visible on the outline of a falling drop, which reads as faceted
    // plastic rather than liquid. 1280 triangles for 28 instances is still
    // nothing next to the water mesh.
    this.geom = new THREE.IcosahedronGeometry(1, 3);
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
        phase: 'done', phaseT: 0, released: 0,
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
    d.phase = 'fall';
    d.phaseT = 0;
    d.released = 0;
  }

  /** Live drop count — used by the tests and the hint text. */
  get inFlight(): number {
    return this.drops.reduce((n, d) => n + (d.live ? 1 : 0), 0);
  }

  /**
   * Advance every drop.
   *
   * `onLand` fires once at the moment of contact (driving the surface impulse
   * and the first pigment), then `onRelease` trickles the remaining volume
   * out over the following frames as the drop spreads into a film.
   */
  step(
    dt: number,
    uvToWorld: (u: number, v: number) => { x: number; z: number },
    onLand: (u: number, v: number, radius: number, volume: number, absorbance: [number, number, number]) => void,
    onRelease: (u: number, v: number, radius: number, volume: number, absorbance: [number, number, number]) => void,
  ): void {
    let anyVisible = false;
    for (let i = 0; i < MAX_DROPS; i++) {
      const d = this.drops[i];
      if (!d.live) {
        // Collapse the instance rather than skipping it. Skipping left the
        // matrix from the drop's last frame in place, so a finished drop stayed
        // frozen on screen — releasing a new one then appeared alongside the
        // stale ones instead of alone.
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      d.age += dt;

      if (d.phase === 'fall') {
        // Ballistic fall with drag. Gravity is scaled so the fall stays
        // watchable rather than completing in two frames — the fall is part
        // of the pleasure of using it, so it has to be legible.
        const G = 3.2;
        d.vz -= G * dt;
        d.vz *= 1 - Math.min(0.85, 0.55 * dt);
        d.z += d.vz * dt;

        if (d.z <= 0) {
          // CONTACT. Kick a ring out from the impact; the drop then sinks
          // straight into the water (merging), and its pigment trickles into
          // the dye field separately.
          d.z = 0;
          d.phase = 'merge';
          d.phaseT = 0;
          onLand(d.x, d.y, d.r, d.vol, d.absorbance);
        }
      } else {
        d.phaseT += dt;
        // Release the pigment progressively. Pouring the whole volume on the
        // contact frame drops a solid blob; trickling it out as the drop
        // flattens lays down the denser core first and lets the flow carry it,
        // which is what produces branching filaments instead of a puddle.
        const want = Math.min(1, d.phaseT / SPREAD_TIME);
        const chunk = Math.max(0, want - d.released);
        if (chunk > 0) {
          d.released = want;
          onRelease(d.x, d.y, d.r, chunk * d.vol, d.absorbance);
        }
        if (d.phaseT >= SPREAD_TIME) {
          d.live = false;
          // Collapse this frame's matrix too, or the last spread frame lingers.
          this.dummy.position.set(0, -999, 0);
          this.dummy.scale.setScalar(0);
          this.dummy.updateMatrix();
          this.mesh.setMatrixAt(i, this.dummy.matrix);
          continue;
        }
      }

      anyVisible = true;
      const w = uvToWorld(d.x, d.y);

      // Shape by phase. Falling: a teardrop stretched along travel. On contact
      // it squashes hard against the surface, sinks INTO the water and is gone
      // — the spreading you afterwards see is the PIGMENT carried by the dye
      // field, not a coloured body lying on the surface.
      //
      // This replaces the earlier behaviour that kept a flat, fully coloured
      // disc Sitting on top of the water through the whole 'spread' phase:
      // users saw a separate circle of the drop's colour stranded on the
      // surface instead of the same pigment mixing into the bath.
      let sx = d.r;
      let sy = d.r;
      let sz = d.r;
      let lift = d.z;
      let visible = true;

      if (d.phase === 'fall') {
        const speed = Math.abs(d.vz);
        sy = d.r * (1 + Math.min(1.6, speed * 0.55));
        // A faster drop is a longer drop, not just a bigger one.
        sx = sz = d.r * (1 - Math.min(0.28, speed * 0.085));
      } else if (d.phase === 'merge') {
        const mt = Math.min(1, d.phaseT / MERGE_TIME);
        // squash flat and sink below the surface
        sy = d.r * (1 - 0.95 * mt);
        sx = sz = d.r * (1 + 0.30 * mt);
        // as it sinks, the body slides under the water line...
        lift = -sy * 0.6 * mt;
        // ...and once fully sunk the MESH disappears; only the pigment,
        // which the dye field releases progressively, remains.
        if (mt >= 1) {
          visible = false;
          this.dummy.position.set(0, -999, 0);
          this.dummy.scale.setScalar(0);
          this.dummy.updateMatrix();
          this.mesh.setMatrixAt(i, this.dummy.matrix);
          continue;
        }
      } else if (d.phase === 'spread') {
        // No visible body after merge — the drop has joined the water vat.
        // Pigment release continues through onRelease below.
        visible = false;
      }

      if (!visible) {
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }

      this.dummy.position.set(w.x, SURFACE_Y + lift + sy * 0.5, w.z);
      this.dummy.scale.set(sx, sy, sz);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      // falling drops keep their real pigment colour
      this.mesh.setColorAt(i, d.color);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.count = MAX_DROPS;
    this.mesh.visible = anyVisible;
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }
}