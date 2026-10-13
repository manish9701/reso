/**
 * Studio — the white photographic set the dish lives in (guide §11).
 *
 *  - a procedural studio environment baked through PMREM so metal, water and
 *    droplets have real reflections: broad BRIGHT panels for the silver
 *    sweeps, narrow charcoal FLAG bands for contrast, warm-white and copper
 *    instruments for the toning in the reference, and a clean white floor
 *    bounce. An all-white environment makes metal read as pale plastic; an
 *    all-dark one makes it harsh chrome. The reference look lives between.
 *  - a shadow-casting key light (real shadow map, softly filtered) so the
 *    vessel grounds on the set, plus soft fill and rim;
 *  - RectAreaLight instruments — the physically correct soft-rectangle
 *    sources for broad highlights on the rim and water;
 *  - a matte white ground with a soft grounded contact shadow for the
 *    ambient-occlusion core the shadow map deliberately blurs away;
 *  - a single elevated three-quarter camera framed so the dish stays hero.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { LIQUID_Y } from './liquid';

export const FOV = 30;
export const ELEVATION_DEG = 52;

function panel(
  w: number,
  h: number,
  color: THREE.Color,
  pos: [number, number, number],
  look: [number, number, number],
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.lookAt(look[0], look[1], look[2]);
  return mesh;
}

/**
 * Baked studio reflection environment (HDR intensities preserved).
 *
 * Bright white studio with CONTRAST INSTRUMENTS, matching the reference:
 * the rim carries bright silver sweeps (softbox + strips over a white
 * surround), charcoal flags create the dark bands that reveal the metal's
 * curvature, warm-white and copper kickers produce the rose/amber toning,
 * and a white floor bounce keeps the water's troughs from clipping black.
 * The dark end is a mid-charcoal — near-black flags would clip every glossy
 * trough to pure black and read as harsh chrome.
 */
function buildEnvironment(pmrem: THREE.PMREMGenerator): THREE.Texture {
  const env = new THREE.Scene();

  // white-room walls (the base of every broad silver reflection) — the basin
  // interior mirrors these, so they set how bright the dish reads through
  // the water
  env.add(panel(44, 44, new THREE.Color(0.80, 0.81, 0.84), [0, 6, 0], [0, 0, 0]));
  env.add(panel(36, 36, new THREE.Color(0.85, 0.86, 0.90), [0, 0.02, 0], [0, 1, 0])); // floor

  // overhead softbox — broad bright sweep along the crown of the rim
  env.add(panel(9, 5.2, new THREE.Color(3.6, 3.65, 3.8), [0.5, 6.0, 0.8], [0, 0, 0]));
  // two elongated strip lights → signature longitudinal highlights
  env.add(panel(1.1, 10, new THREE.Color(4.6, 4.7, 5.0), [-5.2, 3.6, 0.6], [0, 0.5, 0]));
  env.add(panel(0.8, 10, new THREE.Color(3.0, 3.1, 3.4), [5.2, 3.6, -0.5], [0, 0.5, 0]));
  // bright warm-white kicker near the camera so the rim facing us stays lit
  env.add(panel(5.5, 4.4, new THREE.Color(2.0, 1.95, 1.9), [0.6, 2.6, 7.2], [0, 0.6, 0]));

  // charcoal flags — narrow dark bands that let the wall curvature read.
  // Small and pushed back: these reflect into the basin interior too, and a
  // wide dark panel dominates the water's mirror as a huge black wedge.
  env.add(panel(1.6, 3.0, new THREE.Color(0.10, 0.105, 0.115), [-3.0, 2.6, -3.6], [0, 0.7, 0]));
  env.add(panel(1.4, 2.8, new THREE.Color(0.12, 0.125, 0.135), [3.4, 2.4, 3.4], [0, 0.7, 0]));
  // a low charcoal band behind the dish keeps the lower wall from going white
  env.add(panel(9, 1.6, new THREE.Color(0.17, 0.175, 0.185), [0, 1.0, -6.4], [0, 0.8, 0]));

  // copper / warm toning kickers — the rose bands wrapping the outer wall
  env.add(panel(10, 1.4, new THREE.Color(2.6, 1.10, 0.50), [0, 0.6, -6.0], [0, 0.5, 0]));
  env.add(panel(9, 1.0, new THREE.Color(2.0, 1.05, 0.62), [0, 0.4, 5.9], [0, 0.4, 0]));
  // cool counterpoint so the rim carries both warm and cool streaks
  env.add(panel(4.0, 0.8, new THREE.Color(1.0, 1.45, 2.6), [-3.4, 0.55, -5.4], [0, 0.4, 0]));

  const rt = pmrem.fromScene(env, 0.035);
  env.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (m.material as THREE.Material).dispose();
  });
  return rt.texture;
}

/** Matte white sweep: bright under the dish, very slightly darker outward. */
function groundTexture(): THREE.CanvasTexture {
  const size = 512;
  const cn = document.createElement('canvas');
  cn.width = cn.height = size;
  const ctx = cn.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#fafafa');
  g.addColorStop(0.45, '#f3f3f1');
  g.addColorStop(0.8, '#e9eaeb');
  g.addColorStop(1, '#dde0e2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cn);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Soft, grounded contact shadow — deliberately light. The shadow MAP now
 * supplies the directional grounded shadow; this baked sprite is the tight
 * ambient-occlusion core right under the foot that a blurred shadow map
 * cannot produce. Heavy paint reads as a black hole and flattens the set.
 */
function contactShadowTexture(): THREE.CanvasTexture {
  const size = 512;
  const cn = document.createElement('canvas');
  cn.width = cn.height = size;
  const ctx = cn.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  let g = ctx.createRadialGradient(size / 2, size / 2, size * 0.14, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, 'rgba(40, 47, 60, 0.16)');
  g.addColorStop(0.55, 'rgba(40, 47, 60, 0.07)');
  g.addColorStop(1, 'rgba(40, 47, 60, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.27);
  g.addColorStop(0, 'rgba(28, 34, 47, 0.20)');
  g.addColorStop(0.7, 'rgba(28, 34, 47, 0.09)');
  g.addColorStop(1, 'rgba(28, 34, 47, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(cn);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Studio {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private pmrem: THREE.PMREMGenerator;
  private envTexture: THREE.Texture;
  private ground: THREE.Mesh;
  private shadow: THREE.Mesh;
  private target = new THREE.Vector3(0, 0.14, 0);
  private composer: EffectComposer;
  private disposables: Array<{ dispose(): void }> = [];
  private framesRendered = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      // capture() reads the drawing buffer for Save (guide §12)
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
    // The set is bright; exposure gives the steel headroom to catch the HDR
    // instruments without white-clipping the crown (no featureless patches).
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // REAL soft shadows for the vessel (tuned: PCFSoft + bias, no acne, no
    // harsh edges, no flicker). Follows guide §11, not a uniform ambient.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The set is STATIC (key light fixed, dish and ground never move), so the
    // shadow map is rendered exactly once and then frozen: no per-frame
    // shadow pass, and — a bonus the per-frame update had — no shadow
    // shimmering on the dish rim frame to frame. Droplets do not cast into
    // the map (measured: instanced drops in the shadow pass collapsed the
    // frame rate on mid GPUs; the drop silhouette already sells the contact).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setClearColor(0xf4f4f2, 1);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);
    this.scene.background = new THREE.Color(0xf4f4f2);

    // environment (studio reflections)
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = buildEnvironment(this.pmrem);
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 1;

    // ---- lights -----------------------------------------------------------
    // KEY: shadow-casting directional light. Sets the grounded direction of
    // the shading, casts the soft vessel shadow onto the matte ground.
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(2.4, 6.0, 3.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 2.5;
    key.shadow.camera.far = 14;
    key.shadow.camera.left = key.shadow.camera.bottom = -1.9;
    key.shadow.camera.right = key.shadow.camera.top = 1.9;
    // No acne, no detached penumbra: normalBias fights the curved lathe's
    // self-shadowing, bias keeps the shadow floor from streaking.
    key.shadow.bias = -0.00018;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5;
    this.scene.add(key);

    // FILL: broad cool soft source — keeps the interior of the dish and the
    // shaded side of the rim detailed, never black.
    const fill = new THREE.DirectionalLight(0xdfecff, 0.4);
    fill.position.set(-4.5, 3.2, 2.4);
    this.scene.add(fill);

    // RIM: restrained warm source behind-left separates the metal silhouette
    // from the white background.
    const rim = new THREE.DirectionalLight(0xffdcb4, 0.45);
    rim.position.set(-1.8, 2.6, -4.8);
    this.scene.add(rim);

    // RectArea instruments (require RectAreaLightUniformsLib): physically
    // correct soft rectangles for the broad water highlights the dish's
    // environment map alone under-delivers.
    RectAreaLightUniformsLib.init();
    const keyArea = new THREE.RectAreaLight(0xffffff, 1.8, 2.6, 1.8);
    keyArea.position.set(0.4, 3.4, 1.7);
    keyArea.lookAt(0, 0.16, 0);
    this.scene.add(keyArea);

    const copperArea = new THREE.RectAreaLight(0xffb98a, 1.0, 3.2, 0.6);
    copperArea.position.set(-0.2, 0.55, -3.6);
    copperArea.lookAt(0, 0.25, 0);
    this.scene.add(copperArea);

    const sideArea = new THREE.RectAreaLight(0xa8c0ff, 0.7, 0.6, 3.0);
    sideArea.position.set(-3.6, 1.3, 0.8);
    sideArea.lookAt(0, 0.3, 0);
    this.scene.add(sideArea);

    this.scene.add(new THREE.HemisphereLight(0xe3ecff, 0xbac3cd, 0.3));

    // ground + contact shadow
    const groundTex = groundTexture();
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: groundTex, roughness: 0.95, metalness: 0 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.disposables.push(this.ground.geometry, groundTex);

    const shadowTex = contactShadowTexture();
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.0, 4.0),
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    // Offset OPPOSITE the key light so the baked core sits under the vessel
    // while the real shadow falls away from the key.
    this.shadow.position.set(-0.035, 0.004, -0.045);
    this.shadow.renderOrder = -1;
    this.scene.add(this.shadow);
    this.disposables.push(this.shadow.geometry, shadowTex);

    // ---- post: colour-managed output -------------------------------------
    // A composer is kept ONLY so that tone mapping and the sRGB transfer are
    // applied once, correctly, at the end (OutputPass). No bloom on purpose:
    // the wet look is specular + caustics, and a plausible bloom threshold
    // catches the whole bright studio and erases the figure.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new OutputPass());
  }

  /** Resize the drawing buffer and re-frame the camera for the new aspect. */
  resize(width: number, height: number): void {
    const w = Math.max(2, width);
    const h = Math.max(2, height);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.frame(aspect);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Frame the dish as the hero: ~60% of width on desktop, growing toward
   * the full width on narrow viewports, with headroom for the UI rails.
   */
  private frame(aspect: number): void {
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const projHalfW = 1.10;   // dish half-width + a little breathing room
    const projHalfH = 0.99;   // foreshortened half-height + rim
    const wFrac = aspect >= 1.2 ? 0.62 : aspect >= 0.9 ? 0.78 : 0.9;
    const vFrac = 0.8;
    const dW = projHalfW / (wFrac * tan * aspect);
    const dH = projHalfH / (vFrac * tan);
    const d = Math.max(dW, dH);

    const el = THREE.MathUtils.degToRad(ELEVATION_DEG);
    this.camera.position.set(
      0,
      this.target.y + d * Math.sin(el),
      d * Math.cos(el),
    );
    this.camera.lookAt(this.target);
  }

  /** Toggle environment reflections (Appearance → Reflection). */
  setReflections(on: boolean): void {
    this.scene.environmentIntensity = on ? 1 : 0;
  }

  render(): void {
    this.composer.render();
    // NOTE (measured, Windows/ANGLE): the very first combined pigment+droplet
    // session stutters to ~7 FPS for roughly six seconds while the driver
    // finishes compiling/optimising the heavy program set, then self-recovers
    // to a locked 60 FPS and stays there. It is a one-time compile hitch, not
    // steady-state cost; scripts/fpsprobe.mjs records it.
  }

  /** Render immediately, then read the buffer (Save button). */
  capture(): string {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Point a canvas-normalised position (0..1, top-left) at the liquid plane. */
  pickLiquid(nx: number, ny: number): { x: number; y: number; hit: boolean } {
    const ndc = new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1));
    const ray = new THREE.Ray();
    const origin = this.camera.position.clone();
    const dir = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(origin).normalize();
    ray.set(origin, dir);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -LIQUID_Y);
    const hit = new THREE.Vector3();
    if (ray.intersectPlane(plane, hit) === null || dir.y >= 0) {
      return { x: 0.5, y: 0.5, hit: false };
    }
    return { x: hit.x, y: hit.z, hit: true };
  }

  dispose(): void {
    this.ground.geometry.dispose();
    (this.ground.material as THREE.MeshStandardMaterial).map?.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.envTexture.dispose();
    this.pmrem.dispose();
    this.composer.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.renderer.dispose();
  }
}
