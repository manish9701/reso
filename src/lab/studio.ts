/**
 * Studio — the white photographic set the dish lives in (guide §11).
 *
 *  - a procedural studio environment (softbox key, long strips, dark flags,
 *    warm accent) baked through PMREM so glass and liquid have real
 *    reflections to show — an empty white environment makes reflective
 *    materials read as flat plastic;
 *  - key / fill / rim directional lights;
 *  - a matte white ground with a soft, grounded contact shadow;
 *  - a single slightly elevated three-quarter camera (guide §1.5) that is
 *    framed responsively so the dish stays the hero at any aspect ratio.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
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
 * A polished metal dish only reads as metal if it has something DARK to
 * reflect — an all-white environment turns any metal into a featureless white
 * blob. So the surround is a dark studio with a few bright instruments in it:
 * two strip lights, an overhead softbox, a warm kicker and a dim floor bounce.
 * That is what produces the bright streaks over a dark body in the reference.
 */
function buildEnvironment(pmrem: THREE.PMREMGenerator): THREE.Texture {
  const env = new THREE.Scene();

  // A bright-ceiling / mid-wall / bright-floor surround with intense instruments
  // on top of it. That vertical gradient is what makes water read: a tilt of a
  // couple of degrees swings the reflection between the softbox and the floor,
  // so the cymatic relief shows up as light and shade.
  //
  // Crucially the DARK END is a mid grey, never black. A near-black room makes
  // a glossy surface clip every trough to pure black, which reads as harsh
  // chrome rather than water. The gradient carries the contrast; the floor of
  // it must simply never reach zero.
  // A DARK studio with intense instruments. Polished steel only reads as
  // metal when it has dark regions to mirror — an all-bright environment
  // turns the vessel into white ceramic (exactly the failure the first
  // tuning pass produced). The walls are kept near-charcoal; the strips,
  // softbox and copper kickers burn bright above them and draw the rim.
  env.add(panel(40, 40, new THREE.Color(0.16, 0.165, 0.175), [0, 12, 0], [0, 0, 0]));

  // overhead softbox — the long bright sweep along the rim, and the key the
  // standing figure reflects
  env.add(panel(9, 5.5, new THREE.Color(5.4, 5.4, 5.5), [0, 5.0, 1.2], [0, 0, 0]));
  // two elongated strips → the signature longitudinal highlights on the rim
  env.add(panel(0.8, 8.5, new THREE.Color(5.2, 5.25, 5.4), [-4.5, 3.2, 0.5], [0, 0.4, 0]));
  env.add(panel(0.6, 8.5, new THREE.Color(2.6, 2.65, 2.8), [4.5, 3.2, -0.4], [0, 0.4, 0]));
  // a third, dimmer strip on the near side completes the ring of highlights
  env.add(panel(0.7, 7, new THREE.Color(3.0, 3.05, 3.2), [1.6, 3.6, 5.4], [0, 0.4, 0]));
  // warm copper kickers low on the far and near side — the rose/copper bands
  // wrapping the outer wall in the reference
  env.add(panel(9, 1.2, new THREE.Color(3.8, 1.55, 0.62), [0, 0.5, -6.5], [0, 0.5, 0]));
  env.add(panel(11, 0.8, new THREE.Color(3.2, 1.5, 0.8), [0, 0.35, 5.8], [0, 0.4, 0]));
  // cool counterpoint strip so the rim carries both warm and cool streaks
  env.add(panel(4.5, 0.7, new THREE.Color(1.2, 1.7, 3.0), [-3.2, 0.45, -5.2], [0, 0.4, 0]));
  // floor bounce: mid-grey — bright enough that downward tilts still read as
  // liquid, dark enough that the dish foot and lower wall keep contrast
  env.add(panel(24, 24, new THREE.Color(0.30, 0.30, 0.32), [0, -0.05, 0], [0, 1, 0]));

  const rt = pmrem.fromScene(env, 0.03);
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
  g.addColorStop(0, '#f6f6f5');
  g.addColorStop(0.45, '#eeeeec');
  g.addColorStop(0.8, '#e2e3e4');
  g.addColorStop(1, '#d4d6d8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cn);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft, grounded contact shadow — deliberately light. A heavy shadow reads
 *  as a black hole under the dish and flattens the whole composition. */
function contactShadowTexture(): THREE.CanvasTexture {
  const size = 512;
  const cn = document.createElement('canvas');
  cn.width = cn.height = size;
  const ctx = cn.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  // broad soft pool
  let g = ctx.createRadialGradient(size / 2, size / 2, size * 0.16, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, 'rgba(38, 46, 62, 0.15)');
  g.addColorStop(0.55, 'rgba(38, 46, 62, 0.07)');
  g.addColorStop(1, 'rgba(38, 46, 62, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // tighter ambient-occlusion core right under the vessel foot
  g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.30);
  g.addColorStop(0, 'rgba(30, 36, 50, 0.17)');
  g.addColorStop(0.7, 'rgba(30, 36, 50, 0.08)');
  g.addColorStop(1, 'rgba(30, 36, 50, 0)');
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
    // The set is bright; a slightly higher exposure gives the polished steel
    // its headroom to catch the HDR instruments instead of sitting in shadow.
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0xf4f4f2, 1);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);
    this.scene.background = new THREE.Color(0xf4f4f2);

    // environment (studio reflections)
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = buildEnvironment(this.pmrem);
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 1;

    // lights: key (soft, front-above), cool fill, warm rim — these light the
    // SET (water body, white walls). The dish's form comes from the env map.
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(2.2, 5.5, 3.2);
    const fill = new THREE.DirectionalLight(0xdfe9ff, 0.35);
    fill.position.set(-4.5, 3.0, 1.8);
    const rim = new THREE.DirectionalLight(0xffe6cc, 0.45);
    rim.position.set(-1.4, 2.4, -4.5);
    this.scene.add(key, fill, rim);

    // a soft ambient floor so troughs read as shaded water rather than holes
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0xb9c2cc, 0.35));

    // ground + contact shadow
    const groundTex = groundTexture();
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: groundTex, roughness: 0.96, metalness: 0 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0;
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
    this.shadow.position.set(0.03, 0.004, 0.05);
    this.shadow.renderOrder = -1;
    this.scene.add(this.shadow);
    this.disposables.push(this.shadow.geometry, shadowTex);

    // ---- post: colour-managed output -------------------------------------
    // A composer is kept ONLY so that tone mapping and the sRGB transfer are
    // applied once, correctly, at the end (OutputPass). An earlier bloom pass
    // was removed on purpose: the studio's light sources are genuinely HDR
    // (a 5.0-intensity strip against a white set), so every plausible bloom
    // threshold caught the whole scene and erased the cymatic figure — the
    // wet look comes from specular + caustics, not from post-processing.
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
