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
 *  - a matte white ground with a soft grounded contact shadow for the
 *    ambient-occlusion core the shadow map deliberately blurs away;
 *  - a single elevated three-quarter camera framed so the dish stays hero.
 *
 * The soft instruments live in the baked ENVIRONMENT rather than as extra
 * lights — on the integrated tier every additional light is a full BRDF
 * evaluation on every pixel of a full-frame set. The file's earlier header
 * claimed three RectAreaLight instruments here; there never were any, and
 * panels in the PMREM give the same sweeps for one IBL lookup.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { LIQUID_Y } from './liquid';
import { detectTier, profileFor, readRenderer, type QualityProfile } from './quality';

export const FOV = 30;
export const ELEVATION_DEG = 52;

/**
 * The studio vignette.
 *
 * A photographic cyclorama is never flat white — it falls off into a soft grey
 * toward the edges of the frame, and that falloff is what makes the white read
 * as a lit volume instead of a blank page, and what separates the vessel's
 * silhouette from the ground.
 *
 * Painting it into the floor texture does not work here: the camera only ever
 * sees the central ~40% of the ground plane, so any gradient authored in texture
 * space lands entirely outside the visible area. A screen-space falloff matches
 * what the reference actually shows, because that is what the reference is — a
 * photograph of a lit volume, vignetted by the lens and the lighting.
 */
const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uAmount: { value: 0.30 },
    uSoft: { value: 0.62 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uSoft;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // aspect-corrected radius so the falloff is circular, not elliptical
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.82);
      float r = length(d) / 0.72;
      float v = smoothstep(uSoft, 1.0, r);
      // a touch of cool in the falloff, as a real studio's grey has
      vec3 grey = vec3(0.90, 0.905, 0.92);
      c.rgb = mix(c.rgb, c.rgb * grey, v * uAmount);
      gl_FragColor = c;
    }`,
};

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
 * Cyclorama gradient — the BASE the whole studio is built on.
 *
 * A white photographic set has no black in it. The previous environment was
 * two large planes: a 50x50 ceiling panel at y=6 and a 40x40 floor panel at
 * y=0.02, both facing inward. That covers the upper and lower hemispheres and
 * leaves the entire HORIZONTAL BAND empty — a ray leaving the origin at 0°
 * elevation hits neither plane, because one is above it and one is below.
 *
 * That void is not cosmetic. The vessel is a near-mirror (metalness 0.94), so
 * its inner wall reflects almost exactly sideways, straight into the hole. The
 * bowl therefore rendered as hard black wedges separated by blown-out white
 * strips, and the water — which transmits that bowl — went black wherever the
 * reflection pointed at the gap. Every note in this project about "hard black
 * wedges across the surface" was describing this hole.
 *
 * An enclosing sphere removes the class of bug entirely: every direction has a
 * value, so no material can ever mirror a void, at any k, at any relief gain.
 */
function cycloramaTexture(): THREE.CanvasTexture {
  const w = 4, h = 256;
  const cn = document.createElement('canvas');
  cn.width = w; cn.height = h;
  const ctx = cn.getContext('2d')!;
  // v = 0 at the south pole, v = 1 at the north pole.
  const STOPS: Array<[number, [number, number, number]]> = [
    [0.00, [0.34, 0.36, 0.40]],   // floor, under the dish — a soft dark bounce
    [0.34, [0.46, 0.48, 0.53]],   // lower wall
    [0.48, [0.68, 0.70, 0.74]],   // THE HORIZON — the cyclorama curve, mid grey
    [0.62, [0.82, 0.83, 0.88]],   // upper wall, bright
    [1.00, [0.93, 0.94, 1.00]],   // ceiling
  ];
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = 1 - y / (h - 1);
    let c = STOPS[0][1];
    for (let i = 0; i < STOPS.length - 1; i++) {
      const [v0, c0] = STOPS[i];
      const [v1, c1] = STOPS[i + 1];
      if (v >= v0 && v <= v1) {
        const t = (v - v0) / Math.max(1e-6, v1 - v0);
        c = [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
        break;
      }
      if (v > v1) c = c1;
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = Math.min(255, Math.round(c[0] * 255));
      img.data[i + 1] = Math.min(255, Math.round(c[1] * 255));
      img.data[i + 2] = Math.min(255, Math.round(c[2] * 255));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cn);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Baked studio reflection environment (HDR intensities preserved).
 *
 * A bright white studio with CONTRAST INSTRUMENTS laid over a cyclorama
 * (see cycloramaTexture above): broad soft panels for the silver sweeps,
 * narrow charcoal flags for the dark bands that reveal curvature,
 * warm-white and copper kickers for the toning in the reference, and a
 * floor bounce that keeps the water's troughs from clipping black.
 * The dark end is a mid-charcoal — near-black flags would clip every
 * glossy trough to pure black and read as harsh chrome.
 */
function buildEnvironment(pmrem: THREE.PMREMGenerator): THREE.Texture {
  const env = new THREE.Scene();
  const disposables: Array<{ dispose(): void }> = [];

  // ---- the cyclorama: an enclosing shell, so no direction is ever a void --
  const cyc = cycloramaTexture();
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(30, 32, 24),
    new THREE.MeshBasicMaterial({ map: cyc, side: THREE.BackSide }),
  );
  env.add(shell);
  disposables.push(shell.geometry, shell.material as THREE.Material, cyc);

  // ---- instruments -------------------------------------------------------
  // Broad radiant overhead softbox. Kept well below the old 3.8/5.0: at that
  // intensity the crown of the dish mirrored it as a clipped white ring, the
  // whole rim blew out to featureless plastic, and the pool had no headroom
  // left for pigment. It only has to be the brightest thing in the room.
  env.add(panel(22, 22, new THREE.Color(1.34, 1.36, 1.44), [0.0, 7.5, 0.0], [0, 0, 0]));
  env.add(panel(12, 12, new THREE.Color(1.62, 1.65, 1.72), [0.0, 6.8, 0.4], [0, 0, 0]));

  // Lateral silver strip diffusers — soft sculpted highlights along the lathe
  // rim. These are what read as the swept highlight on the bowl.
  env.add(panel(3.0, 16, new THREE.Color(1.42, 1.45, 1.53), [-4.8, 4.2, 0.5], [0, 0.5, 0]));
  env.add(panel(2.6, 16, new THREE.Color(1.16, 1.19, 1.28), [4.8, 4.2, 0.0], [0, 0.5, 0]));

  // Warm copper kicker — the rose/amber band on the upper-right of the rim.
  //
  // Narrow and moderate on purpose. It used to be three panels peaking at 4.2
  // in red across a wide solid angle, which did not read as an accent band at
  // all: it tinted the whole bowl, the ground and the water peach, and the
  // "white studio" stopped being white. The reference has copper as a BAND on
  // the metal, with neutral white everywhere else.
  env.add(panel(6.0, 3.0, new THREE.Color(1.85, 0.90, 0.38), [4.4, 4.0, -3.4], [0, 0, 0]));
  env.add(panel(7.0, 2.2, new THREE.Color(1.40, 0.70, 0.28), [3.5, 2.2, -5.5], [0, 0.3, 0]));

  // Soft cool counter-accent on the upper left — the reference's cool edge.
  env.add(panel(5.0, 2.2, new THREE.Color(1.00, 1.20, 1.70), [-3.8, 3.0, -4.5], [0, 0.4, 0]));

  // Narrow charcoal flags. These are what give the polished bowl its dark
  // bands: without a dark instrument a mirror has nothing to reflect except
  // white, and the curvature of the lathe stops reading at all. Kept narrow and
  // mid-toned (not near-black) — a hard black bar across the bowl reads as a
  // scratch, not as a flag.
  env.add(panel(1.0, 13, new THREE.Color(0.30, 0.31, 0.35), [-2.1, 3.0, -3.2], [0, 1.0, 0]));
  env.add(panel(0.8, 13, new THREE.Color(0.34, 0.35, 0.40), [2.6, 3.2, 2.9], [0, 1.0, 0]));

  const rt = pmrem.fromScene(env, 0.035);
  env.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material && !disposables.includes(m.material as THREE.Material)) (m.material as THREE.Material).dispose();
  });
  disposables.forEach((d) => d.dispose());
  return rt.texture;
}

/**
 * The seamless white sweep the dish stands on.
 *
 * A photographic cyclorama has no visible horizon and no hard edge: it curves
 * from the floor up into the backdrop, lit so it falls off in soft grey toward
 * the edges of the frame. That falloff is what makes the white read as a lit
 * volume rather than as a blank page, and it is what separates the vessel's
 * silhouette from the ground.
 *
 * Painted as a radial gradient plus a very soft directional pool, so the
 * brightest part of the sweep sits under and slightly behind the dish.
 */
function groundTexture(): THREE.CanvasTexture {
  const size = 1024;
  const cn = document.createElement('canvas');
  cn.width = cn.height = size;
  const ctx = cn.getContext('2d')!;

  // base: white under the dish, falling to a soft grey well inside the frame.
  // The falloff has to complete inside the VISIBLE part of the sweep, not
  // across the whole plane — the camera only ever sees the central ~45% of it,
  // so a gradient spread over the full texture was pure white on screen and the
  // studio looked like a blank page.
  const g = ctx.createRadialGradient(size * 0.5, size * 0.42, size * 0.02, size * 0.5, size * 0.5, size * 0.34);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.30, '#fdfdfd');
  g.addColorStop(0.62, '#f0f2f5');
  g.addColorStop(1, '#e4e7ec');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // a wide, very soft warm pool — the key light spilling onto the sweep. This
  // is the "warm light reflections" the reference shows on the floor.
  const warm = ctx.createRadialGradient(size * 0.30, size * 0.62, 0, size * 0.30, size * 0.62, size * 0.46);
  warm.addColorStop(0, 'rgba(255, 236, 214, 0.30)');
  warm.addColorStop(1, 'rgba(255, 236, 214, 0)');
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, size, size);

  // and a cool counter-pool on the far side, so the sweep is not monochrome
  const cool = ctx.createRadialGradient(size * 0.74, size * 0.30, 0, size * 0.74, size * 0.30, size * 0.40);
  cool.addColorStop(0, 'rgba(214, 228, 255, 0.22)');
  cool.addColorStop(1, 'rgba(214, 228, 255, 0)');
  ctx.fillStyle = cool;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(cn);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * A real reflection of the vessel in the sweep.
 *
 * The reference floor is not a flat backdrop — the plate is mirrored in it,
 * faintly, and that reflection is what grounds the object. Without it the dish
 * floats on white however good the shadow is.
 *
 * This is a true planar reflection, not a painted blob: the scene is rendered
 * from a camera mirrored about the sweep's plane into an offscreen target, and
 * the ground samples that target at its own screen position. Because the
 * camera is FIXED and the vessel does not move, the target is baked ONCE at
 * startup and then costs nothing per frame — which is why this can be a real
 * reflection on a laptop GPU at all. It would have to be re-rendered every
 * frame the moment either the camera or the vessel could move.
 */

/**
 * A real reflection of the vessel in the sweep.
 *
 * The reference floor is not a flat backdrop — the plate is mirrored in it,
 * faintly, and that reflection is what grounds the object. Without it the dish
 * floats on white however good the shadow is.
 *
 * This is a true planar reflection, not a painted blob: the scene is rendered
 * from a camera mirrored about the sweep's plane into an offscreen target, and
 * the ground samples that target at its own screen position. Because the
 * camera is FIXED and the vessel does not move, the target is baked ONCE at
 * startup and then costs nothing per frame — which is why this can be a real
 * reflection on a laptop GPU at all. It would have to be re-rendered every
 * frame the moment either the camera or the vessel could move.
 */
function contactShadowTexture(): THREE.CanvasTexture {
  const size = 512;
  const cn = document.createElement('canvas');
  cn.width = cn.height = size;
  const ctx = cn.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  // wide ambient pool — the soft occlusion the shadow map deliberately blurs
  let g = ctx.createRadialGradient(size / 2, size / 2, size * 0.14, size / 2, size / 2, size * 0.50);
  g.addColorStop(0, 'rgba(20, 26, 40, 0.26)');
  g.addColorStop(0.5, 'rgba(20, 26, 40, 0.11)');
  g.addColorStop(1, 'rgba(20, 26, 40, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // tight AO core right under the foot
  g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.30);
  g.addColorStop(0, 'rgba(12, 17, 28, 0.34)');
  g.addColorStop(0.62, 'rgba(12, 17, 28, 0.13)');
  g.addColorStop(1, 'rgba(12, 17, 28, 0)');
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
  /** the baked planar reflection the sweep samples (see bakeReflection) */
  private reflectTarget: THREE.WebGLRenderTarget | null = null;
  private reflectUniform = { value: null as THREE.Texture | null };
  private reflectResolution = { value: new THREE.Vector2(1, 1) };
  private reflectionBaked = false;
  private target = new THREE.Vector3(0, 0.14, 0);
  private composer: EffectComposer;
  private disposables: Array<{ dispose(): void }> = [];
  /** the profile chosen for the GPU this page actually found */
  readonly profile: QualityProfile;
  /** last drawing-buffer size, so a resize re-applies the fixed ratio */
  private lastSize = { w: 2, h: 2 };
  private framesRendered = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      // NOTE: preserveDrawingBuffer is deliberately OFF. capture() (Save)
      // renders and reads the drawing buffer in the SAME synchronous tick, so
      // the pixels are still there — but leaving the flag on forces the
      // driver to keep a full extra copy of every frame, which costs real
      // frame time for nothing.
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });

    // ---- GPU tier --------------------------------------------------------
    // A discrete GTX 1050 and an Intel UHD 630 differ by ~10x in fill rate, so
    // the render scale, shadow size, pigment buffer and per-pixel shader work
    // all follow the detected tier. See ./quality.ts. The simulation is
    // identical on both — only sampling density changes.
    const gl = this.renderer.getContext();
    const rendererName = readRenderer(gl);
    this.profile = profileFor(detectTier(rendererName), rendererName);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.profile.dpr));
    this.renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
    // Just under 1.0. At 1.0 the pool clipped against the softbox before the
    // pigment had any headroom, which is why every pour read as a pastel wash
    // instead of ink: the densest channel was already pinned at white.
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // REAL soft shadows for the vessel (tuned: no acne, no harsh edges, no
    // flicker). Follows guide §11, not a uniform ambient.
    //
    // PCFSoftShadowMap was REMOVED in three r18x — asking for it logs
    // "PCFSoftShadowMap has been removed. Using PCFShadowMap instead" and
    // silently gives a hard-edged filter, which also makes the old
    // `shadow.radius = 5` below a no-op (PCF ignores radius; only VSM blurs).
    // VSM is the soft path that still exists and does honour radius, so that
    // is what is requested, with the blur size set explicitly.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setClearColor(0xfbfbfb, 1);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);
    this.scene.background = new THREE.Color(0xfbfbfb);

    // environment (studio reflections)
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = buildEnvironment(this.pmrem);
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 1;

    // ---- lights -----------------------------------------------------------
    // KEY: shadow-casting directional light. Sets the grounded direction of
    // the shading, casts the soft vessel shadow onto the matte ground.
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(2.4, 6.0, 3.4);
    key.castShadow = true;
    key.shadow.mapSize.set(this.profile.shadowMap, this.profile.shadowMap);
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
    const fill = new THREE.DirectionalLight(0xdfecff, 0.45);
    fill.position.set(-4.5, 3.2, 2.4);
    this.scene.add(fill);

    // RIM: restrained warm source behind-left separates the metal silhouette
    // from the white background.
    const rim = new THREE.DirectionalLight(0xffdcb4, 0.45);
    rim.position.set(-1.8, 2.6, -4.8);
    this.scene.add(rim);

    // The softbox / copper / cool shaping lives in the baked ENVIRONMENT (one
    // IBL lookup) rather than in extra lights: on the integrated tier every
    // additional light is a full BRDF evaluation on every pixel of a
    // full-frame set, and LTC area lights are the most expensive of all.
    this.scene.add(new THREE.HemisphereLight(0xe3ecff, 0xbac3cd, 0.45));

    // ground + contact shadow
    const groundTex = groundTexture();
    // On the lean tier the sweep is Lambert: it fills the frame and gains
    // nothing visible from a PBR specular lobe.
    //
    // The rough value is the one that matters. Fully matte (1.0) killed the
    // white hot spot the softbox used to throw around the rim, but it also
    // removed the floor's own reflected sheen, and the reference floor is a
    // polished sweep: it holds a broad soft highlight and a faint mirror of
    // the plate. 0.42 keeps the sweep reading as a lit surface with a
    // reflection while staying far too rough to show a hard specular dot.
    const groundMat = this.profile.groundLambert
      ? new THREE.MeshLambertMaterial({ color: 0xffffff, map: groundTex })
      : new THREE.MeshStandardMaterial({
        color: 0xffffff, map: groundTex, roughness: 0.42, metalness: 0, envMapIntensity: 0.55,
      });
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 18),
      groundMat,
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

    // The sweep samples the baked reflection. Injected rather than swapped for
    // a Mirror material, so the painted cyclorama gradient, the shadow and the
    // reflection all composite in the one surface.
    (groundMat as THREE.MeshStandardMaterial).onBeforeCompile = (shader) => {
      shader.uniforms.uReflect = this.reflectUniform;
      shader.uniforms.uReflectRes = this.reflectResolution;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec4 vReflClip;\nvarying vec3 vReflWorld;',
        )
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\n  vReflClip = gl_Position;\n  vReflWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec4 vReflClip;\nvarying vec3 vReflWorld;\nuniform sampler2D uReflect;\nuniform vec2 uReflectRes;',
        )
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
{
  // Screen-space lookup of the planar reflection baked from the mirrored
  // camera: the mirrored camera's ray through this pixel IS the real camera's
  // ray reflected off the sweep, so the same screen coordinate is exact.
  vec2 suv = (vReflClip.xy / vReflClip.w) * 0.5 + 0.5;
  vec4 refl = texture2D(uReflect, suv);
  // Fade with distance from the vessel so the reflection is a tight pool under
  // the plate rather than a duplicate smeared over the whole sweep, and so the
  // far floor stays a clean seamless white.
  float d = length(vReflWorld.xz) / 3.8;
  float fade = smoothstep(1.0, 0.0, d);
  fade = fade * fade * (3.0 - 2.0 * fade);
  // a polished sweep blurs what it reflects; three offset taps stand in for
  // that blur without a pass
  vec4 soft = refl * 0.5
    + texture2D(uReflect, suv + vec2(0.0040, 0.0)) * 0.25
    + texture2D(uReflect, suv - vec2(0.0040, 0.0)) * 0.25;
  // Strong, because on a WHITE sweep a reflection only reads where what is
  // reflected is DARKER than the floor — the vessel's shadowed underside and
  // its charcoal reflections. A weak mix is invisible against 245-white.
  gl_FragColor.rgb = mix(gl_FragColor.rgb, soft.rgb, fade * 0.52);
}`,
        );
    };

    // ---- post: colour-managed output -------------------------------------
    // A composer is kept ONLY so that tone mapping and the sRGB transfer are
    // applied once, correctly, at the end (OutputPass). No bloom on purpose:
    // the wet look is specular + caustics, and a plausible bloom threshold
    // catches the whole bright studio and erases the figure.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new ShaderPass(VignetteShader));
    this.composer.addPass(new OutputPass());
  }

  /**
   * Bake the planar reflection.
   *
   * Renders the scene from a camera mirrored about y = 0 into an offscreen
   * target, with the sweep itself hidden (it cannot reflect itself). The ground
   * then samples that target at each pixel's own screen position, which is
   * exact: the mirrored camera's ray through a given pixel IS the real camera's
   * ray reflected off the plane.
   *
   * Called once after the vessel exists. Both the camera and the vessel are
   * fixed for the life of the scene, so this never has to run again — which is
   * the whole reason a true reflection is affordable here.
   */
  private bakeReflection(): void {
    // The target MUST share the viewport's aspect: the ground samples it by
    // screen UV, so a square target for a 16:9 frame squashes the reflection
    // horizontally and the dish's mirrored image comes out the wrong shape.
    const v = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.min(1024, Math.round(v.x * 0.5)));
    const h = Math.max(64, Math.round(w * (v.y / Math.max(1, v.x))));
    if (!this.reflectTarget || this.reflectTarget.width !== w || this.reflectTarget.height !== h) {
      this.reflectTarget?.dispose();
      this.reflectTarget = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        colorSpace: THREE.LinearSRGBColorSpace,
      });
      this.reflectUniform.value = this.reflectTarget.texture;
      this.reflectResolution.value.set(w, h);
    }
    const r = this.renderer;
    const mirror = this.camera.clone();
    // reflect position and up about y = 0; the flipped handedness is what makes
    // the winding come out right
    mirror.position.set(this.camera.position.x, -this.camera.position.y, this.camera.position.z);
    mirror.up.set(0, -1, 0);
    mirror.lookAt(this.target.x, -this.target.y, this.target.z);
    mirror.aspect = this.camera.aspect;
    mirror.updateProjectionMatrix();
    mirror.updateMatrixWorld(true);

    this.ground.visible = false;
    this.shadow.visible = false;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.reflectTarget);
    r.clear();
    r.render(this.scene, mirror);
    r.setRenderTarget(prev);
    this.ground.visible = true;
    this.shadow.visible = true;
    this.reflectionBaked = true;
  }

  /** Give the studio the vessel, then bake the floor reflection. */
  attachVessel(): void {
    // NOT baked here: the engine calls this from its constructor, before the
    // first resize() has framed the camera. Baking from an unframed camera
    // produced an empty reflection target. It happens on the first render()
    // instead, by which point the projection is real.
    this.reflectionBaked = false;
  }

  /** Resize the drawing buffer and re-frame the camera for the new aspect. */
  resize(width: number, height: number): void {
    const w = Math.max(2, width);
    const h = Math.max(2, height);
    this.lastSize = { w, h };
    this.renderer.setPixelRatio(this.ratioForQuality());
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.frame(aspect);
    this.camera.updateProjectionMatrix();
    // the reflection is baked at the viewport's aspect, so a resize invalidates
    // it; it costs one render and only happens when the window changes
    this.reflectionBaked = false;
  }

  /** Pixel ratio actually in use (from the detected GPU tier). */
  private ratioForQuality(): number {
    return Math.min(window.devicePixelRatio || 1, this.profile.dpr);
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
    // the camera has been framed by the time the first frame runs, so the
    // planar reflection can finally be baked
    if (!this.reflectionBaked) this.bakeReflection();
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
    this.reflectTarget?.dispose();
    this.ground.geometry.dispose();
    const gm = this.ground.material as THREE.MeshStandardMaterial & THREE.MeshLambertMaterial;
    gm.map?.dispose();
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
