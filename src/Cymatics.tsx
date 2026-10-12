import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { MeshGradient } from '@paper-design/shaders-react';
import { createProgram, drawFullscreen, FULLSCREEN_VS } from './lib/gl';
import { clamp } from './lib/utils';

const MAX_WAVES = 6;
const PALETTE = [
  { name: 'Lagoon', color: '#55ead9' },
  { name: 'Ultramarine', color: '#618cff' },
  { name: 'Orchid', color: '#bd83ff' },
  { name: 'Fuchsia', color: '#ff6ea9' },
  { name: 'Amber', color: '#ffb36d' },
  { name: 'Pearl', color: '#e9f4f5' },
];

type Wave = { x: number; y: number; born: number; amp: number; k: number; omega: number; phase: number; decay: number };
type AudioMetrics = { level: number; pitch: number };
type InputMode = 'idle' | 'tone' | 'mic' | 'file';

// Chladni plate modes: pairs chosen so sliding frequency snaps through
// visibly distinct geometries, like frets on an instrument.
const MODES: Array<[number, number]> = [
  [1, 1], [2, 1], [2, 2], [3, 1], [3, 2],
  [4, 2], [4, 3], [5, 3], [5, 4], [6, 4],
];
const PI = Math.PI;
function modeIndexForPitch(pitch: number): number {
  return Math.min(MODES.length - 1, Math.max(0, Math.round(pitch * (MODES.length - 1))));
}
// TypeScript twin of the shader's plate figure (u in 0..1, v up in 0..1).
function chladni(u: number, v: number, m: number, n: number, t: number): number {
  const a = Math.sin(PI * m * u) * Math.sin(PI * n * v);
  const b = Math.sin(PI * n * u) * Math.sin(PI * m * v);
  return a * Math.cos(t * 1.3) + b * Math.sin(t * 1.3);
}

const WATER_FRAGMENT = `
precision highp float;
uniform vec2 res;
uniform float time;
uniform sampler2D dyeTex;
uniform vec4 waveData[${MAX_WAVES}];
uniform vec4 waveShape[${MAX_WAVES}];
uniform float audioLevel;
uniform vec2 modeA;
uniform vec2 modeB;
uniform float modeBlend;
uniform vec2 pointer;
uniform float aspect;

float chladni(vec2 q, vec2 mn, float t) {
  float a = sin(3.14159 * mn.x * q.x) * sin(3.14159 * mn.y * q.y);
  float b = sin(3.14159 * mn.y * q.x) * sin(3.14159 * mn.x * q.y);
  return a * cos(t * 1.3) + b * sin(t * 1.3);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
vec3 spectrum(float t) {
  return 0.52 + 0.48 * cos(6.28318 * (t + vec3(0.0, 0.32, 0.68)));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = vec2(frag.x / res.x, 1.0 - frag.y / res.y);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float field = 0.0;
  vec2 grad = vec2(0.0);
  float ringLight = 0.0;
  vec3 ringColor = vec3(0.0);

  for (int i = 0; i < ${MAX_WAVES}; i++) {
    float amp = waveData[i].w;
    if (amp > 0.001) {
      vec2 source = vec2((waveData[i].x - 0.5) * aspect, waveData[i].y - 0.5);
      vec2 delta = p - source;
      float dist = length(delta) + 0.0001;
      float age = waveData[i].z;
      float k = waveShape[i].x;
      float omega = waveShape[i].y;
      float phase0 = waveShape[i].z;
      float decay = waveShape[i].w;
      float envelope = amp * exp(-age * 1.03) * exp(-dist * decay);
      float theta = dist * k - age * omega + phase0;
      field += envelope * sin(theta);
      float radialGrad = envelope * (k * cos(theta) - sin(theta) * decay);
      grad += (delta / dist) * radialGrad;

      float radius = age * (omega / max(k, 1.0)) * 0.90;
      float ring = exp(-abs(dist - radius) * 105.0) * exp(-age * 1.18) * amp;
      ringLight += ring;
      ringColor += spectrum(dist * 0.34 + age * 0.035 + phase0 * 0.05) * ring;
    }
  }

  // A true Chladni plate figure: two rectilinear modes superposed while the
  // figure breathes between orientations. Frequency snaps the (m, n) pair,
  // so pitch changes geometry rather than just scaling a visualizer.
  // The plate is always faintly alive (drive floor); sound makes it blaze.
  float temporal = cos(time * (1.1 + audioLevel * 2.2));
  float drive = 0.26 + min(audioLevel * 1.5, 1.0);
  float mA = chladni(uv, modeA, time);
  float mB = chladni(uv, modeB, time);
  float standing = mix(mA, mB, modeBlend) * temporal;
  float soundField = standing * drive * 1.7;
  field += soundField;

  // Gradient of the plate figure (finite differences) for normals + refraction.
  float ce = 0.012;
  float pAx = chladni(uv + vec2(ce, 0.0), modeA, time);
  float pBx = chladni(uv + vec2(ce, 0.0), modeB, time);
  float mAx = chladni(uv - vec2(ce, 0.0), modeA, time);
  float mBx = chladni(uv - vec2(ce, 0.0), modeB, time);
  float pAy = chladni(uv + vec2(0.0, ce), modeA, time);
  float pBy = chladni(uv + vec2(0.0, ce), modeB, time);
  float mAy = chladni(uv - vec2(0.0, ce), modeA, time);
  float mBy = chladni(uv - vec2(0.0, ce), modeB, time);
  vec2 plateGrad = vec2(
    (mix(pAx, pBx, modeBlend) - mix(mAx, mBx, modeBlend)) / (2.0 * ce),
    (mix(pAy, pBy, modeBlend) - mix(mAy, mBy, modeBlend)) / (2.0 * ce)
  ) * temporal;
  vec2 normalGrad = grad + plateGrad * (0.10 + drive * 0.30);

  // Refract the accumulated pigment through the moving surface normal.
  vec2 displacement = clamp(normalGrad * 0.00125, vec2(-0.025), vec2(0.025));
  vec2 sampleUv = clamp(uv + displacement, vec2(0.002), vec2(0.998));
  vec4 dye = texture2D(dyeTex, sampleUv);
  vec4 dyeN = texture2D(dyeTex, clamp(sampleUv + vec2(0.0, 0.003), vec2(0.002), vec2(0.998)));
  vec4 dyeS = texture2D(dyeTex, clamp(sampleUv - vec2(0.0, 0.003), vec2(0.002), vec2(0.998)));
  vec4 dyeE = texture2D(dyeTex, clamp(sampleUv + vec2(0.003, 0.0), vec2(0.002), vec2(0.998)));
  vec4 dyeW = texture2D(dyeTex, clamp(sampleUv - vec2(0.003, 0.0), vec2(0.002), vec2(0.998)));
  float dyeEdge = length(dyeN.rgb - dyeS.rgb) + length(dyeE.rgb - dyeW.rgb);
  vec3 pigment = dye.rgb * dye.a;

  // Dark mirror-water, with a restrained reflected environment strip.
  float edge = length((uv - 0.5) * vec2(aspect, 1.0));
  float fresnel = smoothstep(0.2, 0.95, length(normalGrad) * 0.018 + edge * 0.72);
  vec3 deep = mix(vec3(0.018, 0.035, 0.065), vec3(0.004, 0.008, 0.022), smoothstep(0.15, 0.82, edge));
  vec3 reflected = mix(vec3(0.065, 0.16, 0.23), vec3(0.15, 0.075, 0.24), 0.5 + 0.5 * sin(uv.x * 5.4 + sin(uv.y * 7.0) + time * 0.035));
  float horizon = exp(-abs(uv.y - 0.43 + sin(uv.x * 6.0 + time * 0.05) * 0.018) * 18.0);
  float reflectionBands = pow(0.5 + 0.5 * sin(uv.y * 155.0 + sin(uv.x * 12.0 + time * 0.08) * 2.5 + field * 0.34), 18.0);
  vec3 col = deep;
  col = mix(col, reflected, fresnel * 0.25);
  col += vec3(0.12, 0.32, 0.42) * horizon * 0.12;
  col += reflected * reflectionBands * (0.035 + fresnel * 0.14);

  // Colored matter stays broad and translucent; wave crests pull thin edges
  // of pigment into filaments and give the liquid a glassy, wet surface.
  col += pigment * vec3(1.08, 1.03, 1.12) * 2.35;
  // Nodal filaments: luminous lines where the plate stands still.
  float node = exp(-standing * standing * 26.0);
  vec3 filament = mix(vec3(0.42, 0.95, 1.0), vec3(1.0, 0.55, 0.88), 0.5 + 0.5 * sin(standing * 4.0 + time * 0.4));
  col += filament * node * (0.10 + drive * 0.60);
  // Anti-node wash: broad luminous breath between the node lines.
  col += spectrum(standing * 0.35 + 0.10) * smoothstep(0.05, 0.95, abs(standing)) * (0.05 + drive * 0.30);
  // Soft glow that follows the cursor across the surface.
  vec2 pc = (pointer - 0.5) * vec2(aspect, 1.0);
  float pdist = length(p - pc);
  col += vec3(0.35, 0.85, 0.95) * exp(-pdist * pdist * 90.0) * 0.10;
  col += ringColor * 0.78;
  float spec = pow(clamp(1.0 - abs(field * 0.24 + length(normalGrad) * 0.012), 0.0, 1.0), 22.0);
  col += vec3(0.68, 0.88, 1.0) * spec * (0.12 + fresnel * 0.11);
  col += mix(vec3(0.18, 0.72, 0.85), vec3(0.95, 0.59, 0.84), 0.5 + 0.5 * sin(field * 0.9)) * dyeEdge * dye.a * 0.46;

  // Fine, static film grain keeps the reflections and dye from feeling sterile.
  float grain = hash(floor(frag * 0.8));
  col += (grain - 0.5) * 0.018;
  col *= 1.0 - smoothstep(0.48, 1.05, edge) * 0.32;
  gl_FragColor = vec4(col, 1.0);
}
`;

class CymaticWater {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  uniforms: Record<string, WebGLUniformLocation | null> = {};
  time = 0;
  dead = false;
  width = 2;
  height = 2;
  cssWidth = 2;
  cssHeight = 2;
  dyeWidth = 200;
  dyeHeight = 120;
  field = new Float32Array(this.dyeWidth * this.dyeHeight * 4);
  nextField = new Float32Array(this.field.length);
  pixels = new Uint8ClampedArray(this.dyeWidth * this.dyeHeight * 4);
  imageData = new ImageData(this.dyeWidth, this.dyeHeight);
  dyeCanvas = document.createElement('canvas');
  dyeCtx = this.dyeCanvas.getContext('2d', { willReadFrequently: false })!;
  waves: Wave[] = [];
  pointer = { x: 0.5, y: 0.5 };
  audioLevel = 0;
  audioPitch = 0.25;
  modeA: [number, number] = [2, 2];
  modeB: [number, number] = [2, 2];
  modeBlend = 1;
  modeIdx = 2;
  pendingIdx = 2;
  pendingTime = 0;
  onModeChange: ((idx: number) => void) | null = null;
  plateGrid = new Float32Array(56 * 40 * 3);
  lastAudioWave = -1;
  hueIndex = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL is unavailable in this browser.');
    this.gl = gl;
    this.program = createProgram(gl, FULLSCREEN_VS, WATER_FRAGMENT);
    for (const name of ['res', 'time', 'dyeTex', 'waveData', 'waveShape', 'audioLevel', 'modeA', 'modeB', 'modeBlend', 'pointer', 'aspect']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name === 'waveData' || name === 'waveShape' ? name + '[0]' : name);
    }
    const tex = gl.createTexture();
    if (!tex) throw new Error('Could not create the water pigment texture.');
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssWidth = Math.max(2, rect.width);
    this.cssHeight = Math.max(2, rect.height);
    // Cap the render target on large/high-DPI screens. This is one fullscreen
    // wave shader, so a predictable pixel budget matters more than native DPR.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.18, 1560 / Math.max(this.cssWidth, this.cssHeight));
    const W = Math.max(2, Math.round(this.cssWidth * dpr));
    const H = Math.max(2, Math.round(this.cssHeight * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    this.width = W;
    this.height = H;
    this.gl.viewport(0, 0, W, H);

    const nextW = 200;
    const nextH = clamp(Math.round(nextW * this.cssHeight / this.cssWidth), 100, 180);
    if (nextW !== this.dyeWidth || nextH !== this.dyeHeight) {
      const old = this.field, oldW = this.dyeWidth, oldH = this.dyeHeight;
      this.dyeWidth = nextW;
      this.dyeHeight = nextH;
      this.field = new Float32Array(nextW * nextH * 4);
      this.nextField = new Float32Array(this.field.length);
      if (old.length) {
        for (let y = 0; y < nextH; y++) for (let x = 0; x < nextW; x++) {
          const ox = Math.round(x * (oldW - 1) / Math.max(1, nextW - 1));
          const oy = Math.round(y * (oldH - 1) / Math.max(1, nextH - 1));
          const oi = (oy * oldW + ox) * 4, ni = (y * nextW + x) * 4;
          this.field.set(old.subarray(oi, oi + 4), ni);
        }
      }
      this.pixels = new Uint8ClampedArray(nextW * nextH * 4);
      this.imageData = new ImageData(nextW, nextH);
      this.dyeCanvas.width = nextW;
      this.dyeCanvas.height = nextH;
    }
  }

  addWave(x: number, y: number, amp = 0.72, pitch = this.audioPitch) {
    if (this.dead) return;
    const p = clamp(pitch, 0, 1);
    this.waves.push({
      x: clamp(x, 0, 1), y: clamp(y, 0, 1), born: this.time,
      amp: clamp(amp, 0.08, 1.25),
      k: 23 + p * 44,
      omega: 5.2 + p * 12.0,
      phase: Math.random() * Math.PI * 2,
      decay: 1.35 + p * 0.8,
    });
    if (this.waves.length > MAX_WAVES) this.waves.shift();
  }

  deposit(x: number, y: number, colorHex: string, amount = 0.7, radius = 0.06) {
    const rgb = [1, 3, 5].map((n) => parseInt(colorHex.slice(n, n + 2), 16) / 255);
    // NOTE: the dye texture uploads with UNPACK_FLIP_Y, so canvas row y lives
    // at texture row (1 - y): deposit flipped to land under the pointer.
    const cx = x * (this.dyeWidth - 1), cy = (1 - y) * (this.dyeHeight - 1);
    const r = Math.max(3, Math.round(radius * Math.min(this.dyeWidth, this.dyeHeight)));
    const x0 = Math.max(0, Math.floor(cx - r * 2.5)), x1 = Math.min(this.dyeWidth - 1, Math.ceil(cx + r * 2.5));
    const y0 = Math.max(0, Math.floor(cy - r * 2.5)), y1 = Math.min(this.dyeHeight - 1, Math.ceil(cy + r * 2.5));
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const d = Math.hypot((px - cx) / r, (py - cy) / r);
      if (d > 2.5) continue;
      const falloff = Math.exp(-d * d * 1.65) * amount * 0.23;
      const i = (py * this.dyeWidth + px) * 4;
      const oldA = this.field[i + 3];
      const addA = falloff * (1 - oldA * 0.48);
      const nextA = clamp(oldA + addA, 0, 0.96);
      const oldR = oldA > 0.001 ? this.field[i] / oldA : rgb[0];
      const oldG = oldA > 0.001 ? this.field[i + 1] / oldA : rgb[1];
      const oldB = oldA > 0.001 ? this.field[i + 2] / oldA : rgb[2];
      const mixA = addA / Math.max(0.001, oldA + addA);
      this.field[i] = clamp((oldR + (rgb[0] - oldR) * mixA) * nextA, 0, 1);
      this.field[i + 1] = clamp((oldG + (rgb[1] - oldG) * mixA) * nextA, 0, 1);
      this.field[i + 2] = clamp((oldB + (rgb[2] - oldB) * mixA) * nextA, 0, 1);
      this.field[i + 3] = nextA;
    }
  }

  sample(x: number, y: number, channel: number, src: Float32Array) {
    const xx = clamp(x, 0, this.dyeWidth - 1);
    const yy = clamp(y, 0, this.dyeHeight - 1);
    const x0 = Math.floor(xx), y0 = Math.floor(yy);
    const x1 = Math.min(this.dyeWidth - 1, x0 + 1), y1 = Math.min(this.dyeHeight - 1, y0 + 1);
    const fx = xx - x0, fy = yy - y0;
    const a = src[(y0 * this.dyeWidth + x0) * 4 + channel];
    const b = src[(y0 * this.dyeWidth + x1) * 4 + channel];
    const c = src[(y1 * this.dyeWidth + x0) * 4 + channel];
    const d = src[(y1 * this.dyeWidth + x1) * 4 + channel];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  flowAt(nx: number, ny: number, aspect: number) {
    let vx = 0, vy = 0;
    for (const w of this.waves) {
      const age = this.time - w.born;
      if (age < 0 || age > 4.6) continue;
      const dx = (nx - w.x) * aspect, dy = ny - w.y;
      const d = Math.hypot(dx, dy) + 0.001;
      const envelope = w.amp * Math.exp(-age * 0.95) * Math.exp(-d * w.decay);
      const theta = d * w.k - age * w.omega + w.phase;
      const radial = Math.cos(theta) * envelope * 0.62;
      const tangential = Math.sin(theta * 0.5) * envelope * 0.055;
      vx += (dx / d) * radial / aspect - (dy / d) * tangential;
      vy += (dy / d) * radial + (dx / d) * tangential;
    }
    return { x: vx, y: vy };
  }

  // Plate figure value (no temporal factor — direction is time-invariant).
  plateFigure(u: number, v: number): number {
    const t = this.time;
    const A = chladni(u, v, this.modeA[0], this.modeA[1], t);
    const B = chladni(u, v, this.modeB[0], this.modeB[1], t);
    return A + (B - A) * this.modeBlend;
  }

  // Coarse plate grid (value + gradient) rebuilt once per frame; the dense
  // advection loop bilinear-samples it instead of evaluating trig per cell.
  computePlateGrid() {
    const GW2 = 56, GH2 = 40, e = 0.008;
    const g = this.plateGrid;
    for (let j = 0; j < GH2; j++) for (let i = 0; i < GW2; i++) {
      const u = i / (GW2 - 1), v = j / (GH2 - 1);
      const M = this.plateFigure(u, v);
      const gx = (this.plateFigure(Math.min(1, u + e), v) - this.plateFigure(Math.max(0, u - e), v)) / (2 * e);
      const gy = (this.plateFigure(u, Math.min(1, v + e)) - this.plateFigure(u, Math.max(0, v - e))) / (2 * e);
      const o = (j * GW2 + i) * 3;
      g[o] = M; g[o + 1] = gx; g[o + 2] = gy;
    }
  }

  step(dt: number, metrics: AudioMetrics, audioActive: boolean) {
    if (this.dead) return;
    const delta = clamp(dt, 0, 0.04);
    this.time += delta;
    this.audioLevel += (metrics.level - this.audioLevel) * Math.min(1, delta * 5.5);
    this.audioPitch += (metrics.pitch - this.audioPitch) * Math.min(1, delta * 3.2);
    this.waves = this.waves.filter((w) => this.time - w.born < 4.8);

    // Retarget the (m, n) pair only once the pitch is stable, then crossfade
    // the figure so geometry morphs instead of popping.
    const targetIdx = modeIndexForPitch(this.audioPitch);
    if (targetIdx !== this.modeIdx) {
      if (targetIdx !== this.pendingIdx) {
        this.pendingIdx = targetIdx;
        this.pendingTime = this.time;
      } else if (this.time - this.pendingTime > 0.35) {
        const k = this.modeBlend;
        this.modeA = [
          this.modeA[0] + (this.modeB[0] - this.modeA[0]) * k,
          this.modeA[1] + (this.modeB[1] - this.modeA[1]) * k,
        ];
        const [nm, nn] = MODES[targetIdx];
        this.modeB = [nm, nn];
        this.modeIdx = targetIdx;
        this.modeBlend = 0;
        this.onModeChange?.(targetIdx);
      }
    } else {
      this.pendingIdx = targetIdx;
      this.pendingTime = this.time;
    }
    if (this.modeBlend < 1) this.modeBlend = Math.min(1, this.modeBlend + delta / 0.9);
    this.computePlateGrid();

    if (audioActive && this.audioLevel > 0.025 && this.time - this.lastAudioWave > 0.115) {
      this.addWave(this.pointer.x, this.pointer.y, clamp(this.audioLevel * 3.1, 0.12, 0.92), this.audioPitch);
      this.lastAudioWave = this.time;
    }

    const w = this.dyeWidth, h = this.dyeHeight;
    const aspect = this.cssWidth / this.cssHeight;
    const src = this.field, dst = this.nextField;
    const flowScale = delta * 0.58;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const nX = x / Math.max(1, w - 1), nY = y / Math.max(1, h - 1);
      const flow = this.flowAt(nX, nY, aspect);
      const backX = x - flow.x * flowScale * w + Math.sin(nY * 9 + this.time * 0.19) * 0.11;
      const backY = y - flow.y * flowScale * h + Math.cos(nX * 8 - this.time * 0.17) * 0.09;

      // Nodal gathering: pigment migrates toward the still node lines, the
      // signature cymatics behavior. Sampled from the coarse plate grid
      // (v up, rows down) and applied as an uphill sampling offset.
      const gu = nX * 55, gv = (1 - nY) * 39;
      const gi = Math.min(54, Math.floor(gu)), gj = Math.min(38, Math.floor(gv));
      const fu = gu - gi, fv = gv - gj;
      const pg = this.plateGrid;
      const s00 = (gj * 56 + gi) * 3, s10 = s00 + 3, s01 = s00 + 56 * 3, s11 = s01 + 3;
      const bilerp = (o: number) => (pg[o] * (1 - fu) + pg[o + 3] * fu) * (1 - fv) + (pg[o + 56 * 3] * (1 - fu) + pg[o + 56 * 3 + 3] * fu) * fv;
      const Mf = bilerp(s00);
      const gxf = bilerp(s00 + 1);
      const gyf = bilerp(s00 + 2);
      const temporal = Math.cos(this.time * (1.1 + this.audioLevel * 2.2));
      const Mt = Mf * temporal;
      const sgn = Mt >= 0 ? 1 : -1;
      const pull = Math.min(1, Math.abs(Mt) * 3 + 0.3) * 12 * delta;
      const glen = Math.hypot(gxf, gyf) + 1e-4;
      const sampleX = backX + sgn * (gxf / glen) * pull;
      const sampleY = backY - sgn * (gyf / glen) * pull;

      // Semi-Lagrangian advection with a touch of diffusion. Pigment drifts
      // with the wave gradient, migrates onto node lines, and slowly settles.
      for (let c = 0; c < 4; c++) {
        const center = this.sample(sampleX, sampleY, c, src);
        const around = (
          this.sample(sampleX - 1, sampleY, c, src) +
          this.sample(sampleX + 1, sampleY, c, src) +
          this.sample(sampleX, sampleY - 1, c, src) +
          this.sample(sampleX, sampleY + 1, c, src)
        ) * 0.25;
        const diffusion = c === 3 ? 0.012 : 0.023;
        dst[i + c] = clamp((center * (1 - diffusion) + around * diffusion) * (c === 3 ? 0.99988 : 0.9997), 0, 1);
      }
    }
    this.field = dst;
    this.nextField = src;
    this.render();
  }

  render() {
    const gl = this.gl;
    if (this.dead) return;
    const { field, pixels, dyeWidth, dyeHeight, imageData } = this;
    for (let i = 0; i < field.length; i += 4) {
      const alpha = field[i + 3];
      const pi = i;
      pixels[pi] = alpha > 0.001 ? clamp(field[i] / alpha, 0, 1) * 255 : 0;
      pixels[pi + 1] = alpha > 0.001 ? clamp(field[i + 1] / alpha, 0, 1) * 255 : 0;
      pixels[pi + 2] = alpha > 0.001 ? clamp(field[i + 2] / alpha, 0, 1) * 255 : 0;
      pixels[pi + 3] = alpha * 255;
    }
    imageData.data.set(pixels);
    this.dyeCtx.putImageData(imageData, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.dyeCanvas);
    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.res, this.width, this.height);
    gl.uniform1f(this.uniforms.time, this.time);
    gl.uniform1i(this.uniforms.dyeTex, 0);
    const waveData = new Float32Array(MAX_WAVES * 4);
    const waveShape = new Float32Array(MAX_WAVES * 4);
    this.waves.forEach((w, i) => {
      waveData.set([w.x, w.y, this.time - w.born, w.amp], i * 4);
      waveShape.set([w.k, w.omega, w.phase, w.decay], i * 4);
    });
    gl.uniform4fv(this.uniforms.waveData, waveData);
    gl.uniform4fv(this.uniforms.waveShape, waveShape);
    gl.uniform1f(this.uniforms.audioLevel, this.audioLevel);
    gl.uniform2f(this.uniforms.modeA, this.modeA[0], this.modeA[1]);
    gl.uniform2f(this.uniforms.modeB, this.modeB[0], this.modeB[1]);
    gl.uniform1f(this.uniforms.modeBlend, this.modeBlend);
    gl.uniform2f(this.uniforms.pointer, this.pointer.x, this.pointer.y);
    gl.uniform1f(this.uniforms.aspect, this.cssWidth / this.cssHeight);
    drawFullscreen(gl, this.program);
  }

  clear() {
    this.field.fill(0);
    this.nextField.fill(0);
    this.waves = [];
    this.lastAudioWave = this.time;
  }

  exportPNG() {
    const url = this.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cymatics-water-study.png';
    a.click();
  }

  dispose() {
    this.dead = true;
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
    try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore teardown errors */ }
  }
}

class SoundInput {
  context: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  output: GainNode | null = null;
  oscillator: OscillatorNode | null = null;
  microphone: MediaStream | null = null;
  micSource: MediaStreamAudioSourceNode | null = null;
  mediaSource: MediaElementAudioSourceNode | null = null;
  activeNode: AudioNode | null = null;
  audioEl: HTMLAudioElement | null = null;
  objectUrl: string | null = null;
  mode: InputMode = 'idle';
  timeData = new Float32Array(2048);
  freqData = new Uint8Array(1024);

  async ensure(audioEl: HTMLAudioElement) {
    if (!this.context) {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.76;
      this.output = this.context.createGain();
      this.output.gain.value = 0;
      this.analyser.connect(this.output);
      this.output.connect(this.context.destination);
      this.timeData = new Float32Array(this.analyser.fftSize);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.audioEl = audioEl;
    }
    await this.context.resume();
  }

  stopCurrent() {
    try { this.oscillator?.stop(); } catch { /* already stopped */ }
    this.oscillator = null;
    try { this.activeNode?.disconnect(); } catch { /* already disconnected */ }
    this.activeNode = null;
    try { this.micSource?.disconnect(); } catch { /* already disconnected */ }
    this.micSource = null;
    if (this.microphone) this.microphone.getTracks().forEach((track) => track.stop());
    this.microphone = null;
    if (this.audioEl) this.audioEl.pause();
    if (this.output) this.output.gain.setTargetAtTime(0, this.context!.currentTime, 0.035);
    this.mode = 'idle';
  }

  async startTone(frequency: number, audioEl: HTMLAudioElement) {
    await this.ensure(audioEl);
    this.stopCurrent();
    const ctx = this.context!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    osc.connect(this.analyser!);
    this.oscillator = osc;
    this.activeNode = osc;
    this.output!.gain.setTargetAtTime(0.12, ctx.currentTime, 0.06);
    osc.start();
    this.mode = 'tone';
  }

  setFrequency(frequency: number) {
    if (this.oscillator && this.context) this.oscillator.frequency.setTargetAtTime(frequency, this.context.currentTime, 0.025);
  }

  async startMic(audioEl: HTMLAudioElement) {
    await this.ensure(audioEl);
    this.stopCurrent();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone input is not available in this browser.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.microphone = stream;
    this.micSource = this.context!.createMediaStreamSource(stream);
    this.micSource.connect(this.analyser!);
    this.output!.gain.setTargetAtTime(0, this.context!.currentTime, 0.02);
    this.activeNode = this.micSource;
    this.mode = 'mic';
  }

  async startFile(file: File, audioEl: HTMLAudioElement) {
    await this.ensure(audioEl);
    this.stopCurrent();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    audioEl.src = this.objectUrl;
    audioEl.load();
    if (!this.mediaSource) this.mediaSource = this.context!.createMediaElementSource(audioEl);
    this.mediaSource.connect(this.analyser!);
    this.activeNode = this.mediaSource;
    this.output!.gain.setTargetAtTime(0.30, this.context!.currentTime, 0.05);
    await audioEl.play();
    this.mode = 'file';
  }

  sample(): AudioMetrics {
    const analyser = this.analyser;
    if (!analyser) return { level: 0, pitch: 0.25 };
    analyser.getFloatTimeDomainData(this.timeData);
    analyser.getByteFrequencyData(this.freqData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i += 4) sum += this.timeData[i] * this.timeData[i];
    const rms = Math.sqrt(sum / Math.max(1, this.timeData.length / 4));
    let max = 0, peak = 0;
    for (let i = 2; i < Math.min(250, this.freqData.length); i++) {
      if (this.freqData[i] > max) { max = this.freqData[i]; peak = i; }
    }
    const hz = this.context ? peak * this.context.sampleRate / analyser.fftSize : 220;
    const pitch = clamp((Math.log(Math.max(60, hz)) - Math.log(70)) / (Math.log(2500) - Math.log(70)), 0, 1);
    return { level: clamp((rms - 0.002) * 4.1, 0, 1), pitch };
  }

  dispose() {
    this.stopCurrent();
    try { this.mediaSource?.disconnect(); } catch { /* ignore */ }
    this.analyser?.disconnect();
    this.output?.disconnect();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    void this.context?.close();
  }
}

export default function Cymatics() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CymaticWater | null>(null);
  const soundRef = useRef<SoundInput | null>(null);
  const audioElRef = useRef<HTMLAudioElement>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef(0);
  const lastPointerWave = useRef(0);
  const lastPaint = useRef({ x: 0.5, y: 0.5 });
  const pointerDown = useRef(false);
  const [pigment, setPigment] = useState(PALETTE[0].color);
  const [frequency, setFrequency] = useState(220);
  const [inputMode, setInputMode] = useState<InputMode>('idle');
  const [audioName, setAudioName] = useState('');
  const [message, setMessage] = useState('Move through the water. Tap to strike a wave; drag to release pigment.');
  const [modeLabel, setModeLabel] = useState('2×2');
  const [error, setError] = useState('');
  const [hasGL, setHasGL] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const audioEl = audioElRef.current;
    if (!canvas || !audioEl) return;
    let engine: CymaticWater | null = null;
    let sound = new SoundInput();
    soundRef.current = sound;
    try {
      engine = new CymaticWater(canvas);
      engineRef.current = engine;
      engine.onModeChange = (idx) => {
        const [m, n] = MODES[idx];
        setModeLabel(`${m}×${n}`);
      };
      const resize = () => engine?.resize();
      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      let last = performance.now();
      const frame = (now: number) => {
        if (!engine || engine.dead) return;
        frameRef.current = requestAnimationFrame(frame);
        // A steady 30 fps is enough for this liquid study and keeps both the
        // CPU advection pass and the fullscreen shader within a modest budget.
        if (now - last < 1000 / 30) return;
        const dt = Math.min(0.04, Math.max(0, (now - last) / 1000));
        last = now;
        const metrics = sound.sample();
        engine.step(dt, metrics, sound.mode !== 'idle');
        if (meterRef.current) meterRef.current.style.width = `${Math.round(engine.audioLevel * 100)}%`;
      };
      frameRef.current = requestAnimationFrame(frame);
      return () => {
        cancelAnimationFrame(frameRef.current);
        observer.disconnect();
        engine?.dispose();
        sound.dispose();
        engineRef.current = null;
        soundRef.current = null;
      };
    } catch (e) {
      setHasGL(false);
      setError(e instanceof Error ? e.message : 'The water surface could not start.');
      return () => { sound.dispose(); };
    }
  }, []);

  const pointerPosition = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDown.current = true;
    const p = pointerPosition(event);
    engine.pointer = p;
    engine.addWave(p.x, p.y, 1.0, engine.audioPitch);
    engine.deposit(p.x, p.y, pigment, 0.95, 0.08);
    lastPaint.current = p;
    lastPointerWave.current = engine.time;
    setMessage('A strike sends a ring through the surface. Drag to pull the pigment into its current.');
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    const p = pointerPosition(event);
    const previous = lastPaint.current;
    engine.pointer = p;
    const distance = Math.hypot(p.x - previous.x, p.y - previous.y);
    if (pointerDown.current) {
      if (distance > 0.004) {
        engine.deposit(p.x, p.y, pigment, clamp(distance * 24, 0.12, 0.72), 0.052);
        if (distance > 0.014 && engine.time - lastPointerWave.current > 0.07) {
          engine.addWave(p.x, p.y, clamp(distance * 15, 0.18, 0.72), engine.audioPitch);
          lastPointerWave.current = engine.time;
        }
        lastPaint.current = p;
      }
    } else if (event.pointerType === 'mouse' && distance > 0.012 && engine.time - lastPointerWave.current > 0.14) {
      engine.addWave(p.x, p.y, 0.23, engine.audioPitch);
      lastPointerWave.current = engine.time;
      lastPaint.current = p;
    }
  };

  const onPointerUp = () => { pointerDown.current = false; };

  const stopAudio = useCallback(() => {
    soundRef.current?.stopCurrent();
    setInputMode('idle');
    setMessage('Sound input stopped. The water keeps its pigment until you clear it.');
  }, []);

  const toggleTone = useCallback(async () => {
    const sound = soundRef.current, audio = audioElRef.current;
    if (!sound || !audio) return;
    setError('');
    try {
      if (inputMode === 'tone') {
        sound.stopCurrent();
        setInputMode('idle');
      } else {
        setInputMode('idle');
        await sound.startTone(frequency, audio);
        setInputMode('tone');
        setMessage('The tone is driving standing waves. Change its frequency to reshape the pattern.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the tone.');
    }
  }, [frequency, inputMode]);

  const toggleMic = useCallback(async () => {
    const sound = soundRef.current, audio = audioElRef.current;
    if (!sound || !audio) return;
    setError('');
    if (inputMode === 'mic') { stopAudio(); return; }
    setInputMode('idle');
    try {
      await sound.startMic(audio);
      setInputMode('mic');
      setMessage('Microphone live. Your voice, claps and nearby sounds now disturb the water. Input is not played back.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Microphone access was not available.');
    }
  }, [inputMode, stopAudio]);

  const uploadAudio = useCallback(async (file?: File) => {
    const sound = soundRef.current, audio = audioElRef.current;
    if (!file || !sound || !audio) return;
    setError('');
    setInputMode('idle');
    try {
      await sound.startFile(file, audio);
      setInputMode('file');
      setAudioName(file.name);
      setMessage('Your audio is driving the water. Pigment is advected by the combined wave field.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That audio file could not be played.');
      setInputMode('idle');
    }
  }, []);

  useEffect(() => {
    soundRef.current?.setFrequency(frequency);
  }, [frequency]);

  const clearSurface = () => {
    engineRef.current?.clear();
    setMessage('A fresh surface. Strike it, feed it sound, then add color.');
  };

  const saveImage = () => engineRef.current?.exportPNG();

  return (
    <main className="cymatics-app">
      <div className="paper-backdrop" aria-hidden="true">
        <MeshGradient
          colors={['#071722', '#102b38', '#252044', '#0a101b']}
          distortion={0.26}
          swirl={0.16}
          speed={0.08}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      <div className="paper-grain" aria-hidden="true" />
      <section className="water-pond" aria-label="Interactive cymatics water surface">
        <canvas
          ref={canvasRef}
          className="water-canvas"
          aria-label="Interactive water surface. Tap to create waves and drag to add pigment."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
        />
        <div className="water-edge" aria-hidden="true" />
        <div className="pond-reflection" aria-hidden="true" />
      </section>

      <header className="instrument-mark">
        <div className="mark-symbol"><span /></div>
        <div>
          <p className="eyebrow">A PLAYABLE STUDY IN</p>
          <h1>CYMATICS <span>/</span> <em>01</em></h1>
          <p className="submark">sound · water · pigment</p>
        </div>
      </header>

      <div className="signal-status" aria-live="polite">
        <span className={inputMode === 'idle' ? 'status-dot' : 'status-dot is-live'} />
        <span>{inputMode === 'idle' ? 'SURFACE STILL' : inputMode === 'mic' ? 'LISTENING' : inputMode === 'tone' ? 'TONE DRIVING' : 'AUDIO DRIVING'}</span>
        <div className="signal-track"><span ref={meterRef} /></div>
      </div>

      <div className="interaction-hint" aria-live="polite">{message}</div>
      {error && <div className="error-toast" role="alert">{error}</div>}

      <section className="control-dock" aria-label="Cymatics controls">
        <div className="dock-section pigment-section">
          <span className="dock-label">PIGMENT</span>
          <div className="pigment-palette">
            {PALETTE.map((swatch) => (
              <button
                key={swatch.color}
                type="button"
                className={`pigment-swatch${pigment === swatch.color ? ' selected' : ''}`}
                style={{ '--swatch': swatch.color } as CSSProperties}
                onClick={() => { setPigment(swatch.color); setMessage(`${swatch.name} pigment selected. Drag across the surface to release it into the current.`); }}
                aria-label={`Select ${swatch.name} pigment`}
                aria-pressed={pigment === swatch.color}
                title={swatch.name}
              />
            ))}
          </div>
        </div>

        <div className="dock-divider" />

        <div className="dock-section sound-section">
          <span className="dock-label">DRIVE THE WATER</span>
          <div className="sound-buttons">
            <button type="button" className={`control-button${inputMode === 'mic' ? ' active' : ''}`} onClick={toggleMic} aria-pressed={inputMode === 'mic'}>
              <span className="control-icon">⌁</span><span>{inputMode === 'mic' ? 'Listening' : 'Mic'}</span>
            </button>
            <button type="button" className={`control-button${inputMode === 'tone' ? ' active' : ''}`} onClick={toggleTone} aria-pressed={inputMode === 'tone'}>
              <span className="control-icon">∿</span><span>{inputMode === 'tone' ? 'Tone on' : 'Tone'}</span>
            </button>
            <label className="control-button upload-button" title="Load an audio file">
              <input type="file" accept="audio/*" onChange={(e) => { void uploadAudio(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
              <span className="control-icon">↥</span><span>{audioName ? 'Replace audio' : 'Load audio'}</span>
            </label>
            {inputMode !== 'idle' && (
              <button type="button" className="control-button stop-button" onClick={stopAudio}>
                <span className="control-icon">■</span><span>Stop</span>
              </button>
            )}
          </div>
        </div>

        <div className="frequency-control">
          <div className="frequency-heading"><span className="dock-label">TONE FREQUENCY</span><output>{frequency} <small>Hz</small></output><span className="mode-chip" title="Standing-wave plate mode">{modeLabel}</span></div>
          <input
            type="range"
            min={70}
            max={1200}
            step={1}
            value={frequency}
            onChange={(e) => setFrequency(Number(e.target.value))}
            aria-label="Tone frequency"
          />
        </div>

        <div className="dock-divider final-divider" />
        <div className="utility-buttons">
          <button type="button" className="icon-button" onClick={clearSurface} aria-label="Clear pigment and waves" title="Clear surface">↺</button>
          <button type="button" className="save-button" onClick={saveImage}>Save study <span>↗</span></button>
        </div>
      </section>

      <div className="bottom-caption"><span>01 / WATER & RESONANCE</span><span>STRIKE · LISTEN · POUR · OBSERVE</span></div>
      <audio ref={audioElRef} className="audio-element" preload="none" onEnded={() => { if (inputMode === 'file') stopAudio(); }} />
      {!hasGL && <div className="fallback-message" role="alert">{error || 'This cymatics experiment requires WebGL. Try a browser with hardware acceleration enabled.'}</div>}
    </main>
  );
}
