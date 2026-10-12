import { useEffect, useRef, useState } from 'react';
import { createNoise2D } from 'simplex-noise';
import { TAU, clamp, lerp, downloadPNG, hexToRgb } from '../lib/utils';
import { getGL, createProgram, drawFullscreen, fitCanvas, FULLSCREEN_VS } from '../lib/gl';
import { getSettings } from '../lib/settings';
import { useRafLoop, useResize } from '../lib/hooks';
import * as Audio from '../lib/audio';
import { setDock } from '../lib/dock';
import { Bar, Group, Pill, Btn, Dots, Stat, Spacer } from '../ui/chrome';

export const INK_META = {
  n: 1, id: 'ink', name: 'Resonant Ink', one: 'Make sound bloom into pigment.',
  c1: '#46e0d2', c2: '#7c6bff',
  about: 'Tap the liquid. Every strike sings a tone and throws a ripple through living pigment. Layer strikes into a painting, then freeze it.',
};

/* ------------------------------------------------------------------ */
/* engine                                                              */
/* ------------------------------------------------------------------ */

const HUES = ['#46e0d2', '#5b8cff', '#a06bff', '#ff5fa2', '#ff7a59'];
const MAX_IMP = 12;

interface ToneDef { freq: number; kind: Audio.StrikeKind; k: number; om: number; amp: number }
const TONES: Record<string, ToneDef> = {
  Low:    { freq: 110,    kind: 'low',    k: 0.045, om: 5.2, amp: 1.0 },
  Bell:   { freq: 523.25, kind: 'bell',   k: 0.085, om: 9.0, amp: 0.9 },
  Drone:  { freq: 82.4,   kind: 'drone',  k: 0.032, om: 2.6, amp: 1.1 },
  Bright: { freq: 880,    kind: 'bright', k: 0.115, om: 13.0, amp: 0.8 },
};

export type PigmentType = 'flow' | 'bloom' | 'edge' | 'dense' | 'glow';

interface Impulse { nx: number; ny: number; amp: number; k: number; om: number; phase: number; t0: number; decay: number; col: [number, number, number] }
interface Particle { x: number; y: number; vx: number; vy: number; s: number; a: number; c: string; tw: number; life: number }

const INK_FS = `
precision highp float;
uniform vec2 res;
uniform float time;
uniform sampler2D pig;
uniform vec4 imp[${MAX_IMP}];
uniform vec4 prm[${MAX_IMP}];
uniform vec3 icol[${MAX_IMP}];

float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 puv = vec2(frag.x / res.x, 1.0 - frag.y / res.y);
  float w = 0.0;
  vec2 g = vec2(0.0);
  float spd = min(res.x, res.y) * 0.42;
  float sig = min(res.x, res.y);
  vec3 rings = vec3(0.0);
  vec3 cores = vec3(0.0);
  for (int i = 0; i < ${MAX_IMP}; i++) {
    float amp = imp[i].z;
    if (amp > 0.0005) {
      float age = time - imp[i].w;
      if (age > 0.0 && age < 6.0) {
        vec2 dv = frag - imp[i].xy;
        float d = length(dv) + 1.0;
        float att = amp * exp(-d / prm[i].w) * exp(-age * 1.0);
        float ph = prm[i].x * d - prm[i].y * age + prm[i].z;
        float s = sin(ph);
        float c = cos(ph);
        w += att * s;
        float dph = att * (prm[i].x * c - s / prm[i].w);
        g += dph * dv / d;
        float R = age * spd;
        float rr = exp(-abs(d - R) / (sig * 0.016 + 6.0)) * exp(-age * 1.15);
        rings += rr * amp * icol[i];
        float core = exp(-dot(dv, dv) / (2.0 * 26.0 * 26.0)) * exp(-age * 2.2);
        cores += core * amp * (icol[i] + vec3(0.55));
      }
    }
  }
  // Displace the pigment image through the actual wave slope. Sample a
  // small neighbourhood too, so pigment boundaries catch light like wet dye.
  vec2 texel = vec2(1.0 / res.x, 1.0 / res.y);
  vec2 off = clamp((-g * 520.0) / res, vec2(-0.075), vec2(0.075));
  vec2 puvD = clamp(puv + off, vec2(0.001), vec2(0.999));
  vec3 pigCol = texture2D(pig, puvD).rgb;
  vec3 pR = texture2D(pig, clamp(puvD + vec2(texel.x, 0.0), vec2(0.001), vec2(0.999))).rgb;
  vec3 pL = texture2D(pig, clamp(puvD - vec2(texel.x, 0.0), vec2(0.001), vec2(0.999))).rgb;
  vec3 pU = texture2D(pig, clamp(puvD + vec2(0.0, texel.y), vec2(0.001), vec2(0.999))).rgb;
  vec3 pD = texture2D(pig, clamp(puvD - vec2(0.0, texel.y), vec2(0.001), vec2(0.999))).rgb;
  float pigment = dot(pigCol, vec3(0.299, 0.587, 0.114));
  float pigmentEdge = length(pR - pL) + length(pU - pD);

  // Deep dark-water base with a slight indigo lift around the active waves.
  vec2 asp = vec2(res.x / res.y, 1.0);
  float vig0 = length((puv - 0.5) * asp);
  vec3 base = mix(vec3(0.042, 0.052, 0.092), vec3(0.006, 0.009, 0.022), smoothstep(0.0, 0.82, vig0));
  vec3 col = base + pigCol * 1.36;
  col = mix(col, col * vec3(1.08, 1.02, 1.16), smoothstep(0.08, 0.65, pigment));

  // Fine spectral nodal lines make the acoustic pattern legible without
  // turning the whole surface into a neon wireframe.
  float lv = w * 8.0;
  float f = abs(fract(lv + 0.5) - 0.5);
  float fil = 1.0 - smoothstep(0.018, 0.105, f);
  vec3 spectrum = 0.52 + 0.48 * cos(6.28318 * (w * 0.16 + vec3(0.02, 0.34, 0.68)));
  col += spectrum * fil * 0.14 * min(1.0, abs(w) * 2.4 + 0.18);

  // Wet boundaries catch a thin pearl highlight; broad color stays in the pigment.
  float edgeLight = smoothstep(0.08, 0.36, pigmentEdge) * smoothstep(0.025, 0.22, pigment);
  col += mix(vec3(0.34, 0.76, 0.91), vec3(0.94, 0.72, 1.0), 0.5 + 0.5 * sin(w * 2.7)) * edgeLight * 0.34;

  // Expanding cymatic rings and source cores.
  col += rings * 0.72 + cores * 0.76;
  float slope = length(g);
  float spec = pow(smoothstep(0.025, 0.34, slope), 1.6) * (1.0 - smoothstep(0.8, 1.8, slope));
  col += vec3(0.76, 0.90, 1.0) * spec * 0.11;

  // Vignette + restrained static film grain (not temporally flickering noise).
  col *= 1.0 - smoothstep(0.42, 1.05, vig0) * 0.46;
  col += (hash(frag) - 0.5) * 0.012;
  gl_FragColor = vec4(col, 1.0);
}
`;

class InkEngine {
  view: HTMLCanvasElement;
  pig: HTMLCanvasElement;
  px: CanvasRenderingContext2D;
  gl: WebGLRenderingContext | null = null;
  prog: WebGLProgram | null = null;
  u: Record<string, WebGLUniformLocation | null> = {};
  tex: WebGLTexture | null = null;
  impArr = new Float32Array(MAX_IMP * 4);
  prmArr = new Float32Array(MAX_IMP * 4);
  colArr = new Float32Array(MAX_IMP * 3);

  W = 2; H = 2; PW = 2; PH = 2; CW = 2;
  impulses: Impulse[] = [];
  parts: Particle[] = [];
  noise = createNoise2D();
  time = 0;
  drops = 0;
  dead = false;

  toneName = 'Bell';
  pigType: PigmentType = 'bloom';
  hueIdx = 1;
  frozen = false;
  micOn = false;
  micLevel = 0;

  constructor(view: HTMLCanvasElement) {
    this.view = view;
    this.pig = document.createElement('canvas');
    const px = this.pig.getContext('2d');
    if (!px) throw new Error('no 2d context');
    this.px = px;
    this.gl = getGL(view);
    if (this.gl) {
      const gl = this.gl;
      this.prog = createProgram(gl, FULLSCREEN_VS, INK_FS);
      this.u = {
        res: gl.getUniformLocation(this.prog, 'res'),
        time: gl.getUniformLocation(this.prog, 'time'),
        pig: gl.getUniformLocation(this.prog, 'pig'),
        imp: gl.getUniformLocation(this.prog, 'imp[0]'),
        prm: gl.getUniformLocation(this.prog, 'prm[0]'),
        icol: gl.getUniformLocation(this.prog, 'icol[0]'),
      };
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    this.seedParticles();
  }

  seedParticles() {
    // The liquid should begin quiet. Pigment particles are emitted only where
    // the user strikes or pours, so the material feels caused by the gesture
    // rather than like a pre-seeded particle screensaver.
    this.parts = [];
  }

  resize(cw: number, ch: number) {
    this.CW = Math.max(2, cw);
    const box = { clientWidth: Math.max(2, cw), clientHeight: Math.max(2, ch) };
    const r = fitCanvas(this.view, box, 1.75);
    this.W = r.W; this.H = r.H;
    // pigment layer at 1x (upload-friendly), capped for GPU upload
    const scale = Math.min(1, 1200 / Math.max(cw, ch));
    const PW = Math.max(2, Math.round(cw * scale));
    const PH = Math.max(2, Math.round(ch * scale));
    if (this.pig.width !== PW || this.pig.height !== PH) {
      let old: HTMLCanvasElement | null = null;
      if (this.drops > 0 && this.pig.width > 2) {
        old = document.createElement('canvas');
        old.width = this.pig.width; old.height = this.pig.height;
        try { old.getContext('2d')!.drawImage(this.pig, 0, 0); } catch { old = null; }
      }
      this.pig.width = PW; this.pig.height = PH;
      if (old) { try { this.px.drawImage(old, 0, 0, PW, PH); } catch { /* noop */ } }
    }
    this.PW = PW; this.PH = PH;
    this.gl?.viewport(0, 0, this.W, this.H);
  }

  waveAt(nx: number, ny: number) {
    const X = nx * this.PW, Y = ny * this.PH;
    let w = 0, gx = 0, gy = 0;
    for (const im of this.impulses) {
      const age = this.time - im.t0;
      if (age < 0 || age > 6) continue;
      const dx = X - im.nx * this.PW, dy = Y - im.ny * this.PH;
      const d = Math.hypot(dx, dy) + 1e-4;
      const kk = im.k / this.PW; // rad per pigment-px (k stored per full width)
      const decPx = im.decay * this.PW;
      const att = im.amp * Math.exp(-d / decPx) * Math.exp(-age);
      const phx = kk * d - im.om * age + im.phase;
      w += att * Math.sin(phx);
      const dph = att * (kk * Math.cos(phx) - Math.sin(phx) / decPx);
      gx += (dph * dx) / d; gy += (dph * dy) / d;
    }
    return { w, gx, gy };
  }

  strike(nx: number, ny: number, freqMul = 1, ampMul = 1, playSound = true) {
    if (this.frozen || this.dead) return;
    const T = TONES[this.toneName];
    const color = HUES[this.hueIdx % HUES.length];
    if (playSound) void Audio.ensureAudio().then(() => Audio.strike(T.kind, T.freq * freqMul * (0.98 + Math.random() * 0.04))).catch(() => {});
    this.impulses.push({
      nx, ny, amp: T.amp * ampMul * (0.9 + Math.random() * 0.2),
      k: T.k * this.CW * (0.9 + Math.random() * 0.2), // rad per full stage width
      om: T.om,
      phase: Math.random() * TAU, t0: this.time,
      decay: 0.34, col: hexToRgb(color),
    });
    if (this.impulses.length > MAX_IMP) this.impulses.shift();
    for (const p of this.parts) {
      const dx = p.x - nx, dy = p.y - ny;
      const d = Math.hypot(dx, dy);
      if (d < 0.3) {
        const f = (1 - d / 0.3) * ampMul;
        p.vx += (dx / (d + 0.01)) * f * 0.5;
        p.vy += (dy / (d + 0.01)) * f * 0.5;
      }
    }
    this.deposit(nx * this.PW, ny * this.PH, color, this.pigType, 1);
    this.hueIdx = (this.hueIdx + 1) % HUES.length;
  }

  deposit(sx: number, sy: number, color: string, type: PigmentType, mult: number) {
    this.drops++;
    const px = this.px;
    const baseR = (type === 'dense' ? 44 : type === 'bloom' ? 74 : 56) * mult * (this.PW / 900 + 0.5);
    const blobCount = type === 'dense' ? 3 : type === 'bloom' ? 6 : 4;
    const seed = this.drops * 0.173 + sx * 0.013 + sy * 0.019;
    const noise = this.noise;

    // Build a connected stain from layered organic silhouettes instead of
    // independent soft dots. The uneven boundary is what makes it read as
    // pigment rather than particles.
    px.save();
    px.globalCompositeOperation = type === 'glow' ? 'lighter' : 'source-over';
    for (let b = 0; b < blobCount; b++) {
      const angle = b * 2.399 + seed;
      const spread = b === 0 ? 0 : baseR * (0.18 + Math.random() * 0.45);
      const cx = sx + Math.cos(angle) * spread;
      const cy = sy + Math.sin(angle) * spread * 0.78;
      const radius = baseR * (b === 0 ? 1.0 : 0.30 + Math.random() * 0.42);
      const grad = px.createRadialGradient(cx - radius * 0.18, cy - radius * 0.22, radius * 0.02, cx, cy, radius * 1.2);
      grad.addColorStop(0, color + (type === 'dense' ? 'dd' : type === 'glow' ? 'c8' : 'a8'));
      grad.addColorStop(0.48, color + (type === 'dense' ? '92' : '65'));
      grad.addColorStop(1, color + '00');

      const points: Array<[number, number]> = [];
      const count = 34;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU;
        const n = noise(Math.cos(a) * 2.1 + seed + b * 0.71, Math.sin(a) * 2.1 - seed * 0.5);
        const ripple = 0.78 + n * (type === 'bloom' ? 0.30 : 0.18) + Math.sin(a * 5 + seed) * 0.055;
        points.push([cx + Math.cos(a) * radius * ripple, cy + Math.sin(a) * radius * ripple * 0.76]);
      }
      px.beginPath();
      px.moveTo((points[0][0] + points[1][0]) * 0.5, (points[0][1] + points[1][1]) * 0.5);
      for (let i = 1; i <= count; i++) {
        const p = points[i % count];
        const q = points[(i + 1) % count];
        px.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) * 0.5, (p[1] + q[1]) * 0.5);
      }
      px.closePath();
      px.fillStyle = grad;
      px.globalAlpha = type === 'dense' ? 0.66 : type === 'glow' ? 0.48 : 0.72;
      px.fill();

      // Thin tide-lines around selected blooms create a deposited edge.
      if (type === 'edge' || type === 'bloom') {
        px.globalAlpha = type === 'edge' ? 0.34 : 0.15;
        px.strokeStyle = color;
        px.lineWidth = Math.max(0.6, this.PW / 1500);
        px.stroke();
      }
    }

    // A few tapered filaments follow the direction of the strike. They make
    // color feel drawn into the wave instead of sprayed evenly in a circle.
    if (type === 'flow' || type === 'bloom' || type === 'edge') {
      const filamentCount = type === 'flow' ? 11 : 6;
      for (let i = 0; i < filamentCount; i++) {
        const a = seed + (i / filamentCount) * TAU;
        const len = baseR * (0.65 + Math.random() * (type === 'flow' ? 1.9 : 1.1));
        const bend = (noise(i * 0.27 + seed, seed * 0.7) * 0.55) * len;
        px.globalAlpha = type === 'edge' ? 0.22 : 0.18;
        px.strokeStyle = color;
        px.lineWidth = Math.max(0.6, baseR * (0.018 + Math.random() * 0.025));
        px.beginPath();
        px.moveTo(sx, sy);
        px.quadraticCurveTo(
          sx + Math.cos(a) * len * 0.45 + Math.cos(a + Math.PI / 2) * bend,
          sy + Math.sin(a) * len * 0.45 + Math.sin(a + Math.PI / 2) * bend,
          sx + Math.cos(a) * len,
          sy + Math.sin(a) * len * 0.76,
        );
        px.stroke();
      }
    }
    px.restore();

    // Emit moving pigment only around the user's action. These particles are
    // advected by the wave gradient, fade naturally, and remain bounded.
    const count = Math.round((type === 'dense' ? 42 : type === 'bloom' ? 56 : 38) * Math.min(1.3, mult));
    const maxParts = 2600;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * baseR;
      this.parts.push({
        x: clamp((sx + Math.cos(a) * r) / this.PW, 0, 1),
        y: clamp((sy + Math.sin(a) * r * 0.78) / this.PH, 0, 1),
        vx: Math.cos(a) * (0.025 + Math.random() * 0.055) * mult,
        vy: Math.sin(a) * (0.025 + Math.random() * 0.055) * mult,
        s: 0.65 + Math.random() * 2.2,
        a: 0.20 + Math.random() * 0.48,
        c: color,
        tw: Math.random() * TAU,
        life: (type === 'dense' ? 2.2 : type === 'flow' ? 5.4 : 4.0) + Math.random() * 2.8,
      });
    }
    if (this.parts.length > maxParts) this.parts.splice(0, this.parts.length - maxParts);
  }
  step(dt: number, reduced: boolean) {
    if (this.frozen || this.dead) return;
    this.time += reduced ? dt * 0.35 : dt;
    const t = this.time;
    this.impulses = this.impulses.filter((im) => t - im.t0 < 6);

    if (this.micOn) {
      const lv = Audio.micLevel();
      this.micLevel = lerp(this.micLevel, lv, 0.2);
      if (this.micLevel > 0.14 && Math.random() < this.micLevel * 0.35) {
        const T = TONES[this.toneName];
        const color = HUES[(Math.random() * HUES.length) | 0];
        this.impulses.push({
          nx: Math.random(), ny: Math.random(), amp: this.micLevel * 1.5,
          k: T.k, om: T.om, phase: Math.random() * TAU, t0: t, decay: 0.3, col: hexToRgb(color),
        });
        if (this.impulses.length > MAX_IMP) this.impulses.shift();
      }
    }

    // ultra-slow erosion so paintings never turn to mud
    const px = this.px;
    px.save();
    px.globalCompositeOperation = 'destination-out';
    px.fillStyle = 'rgba(0,0,0,0.0008)';
    px.fillRect(0, 0, this.PW, this.PH);
    px.restore();

    // Advect the deposited pigment through the wave field. Lifetimes keep the
    // material expressive without letting a long session become unbounded.
    const n2 = this.noise;
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const p of this.parts) {
      p.life -= dt;
      const { w, gx, gy } = this.waveAt(p.x, p.y);
      const sc = 1 / Math.max(this.PW, this.PH);
      p.vx += -gx * 9000 * sc * dt * 0.5 - p.vx * 1.7 * dt + n2(p.x * 3, t * 0.25 + p.tw) * 0.012;
      p.vy += -gy * 9000 * sc * dt * 0.5 - p.vy * 1.7 * dt + n2(p.y * 3 + 9, t * 0.25) * 0.012;
      p.vx = clamp(p.vx, -0.5, 0.5); p.vy = clamp(p.vy, -0.5, 0.5);
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.x < 0 || p.x > 1) { p.vx *= -1; p.x = clamp(p.x, 0, 1); }
      if (p.y < 0 || p.y > 1) { p.vy *= -1; p.y = clamp(p.y, 0, 1); }

      const X = p.x * this.PW, Y = p.y * this.PH;
      let alpha = p.a * 0.62 * clamp(p.life / 1.1, 0, 1), sz = p.s;
      if (this.pigType === 'edge') {
        if (Math.abs(w) < 0.12) { alpha *= 1.1; sz *= 0.8; }
        else alpha *= 0.12;
      }
      if (this.pigType === 'flow') {
        px.strokeStyle = p.c; px.globalAlpha = alpha * 0.6; px.lineWidth = Math.max(0.6, sz * 0.8);
        px.beginPath(); px.moveTo(X, Y); px.lineTo(X - p.vx * this.PW * 0.03, Y - p.vy * this.PH * 0.03); px.stroke();
      } else if (this.pigType === 'glow') {
        px.globalCompositeOperation = 'lighter';
        px.globalAlpha = alpha * 0.5; px.fillStyle = p.c;
        px.beginPath(); px.arc(X, Y, sz * 2.2, 0, TAU); px.fill();
        px.globalCompositeOperation = 'source-over';
      } else {
        px.globalAlpha = alpha; px.fillStyle = p.c;
        px.beginPath(); px.arc(X, Y, sz, 0, TAU); px.fill();
      }
    }
    px.globalAlpha = 1;
  }

  render() {
    const gl = this.gl;
    if (!gl || !this.prog || this.dead) return;
    // upload pigment
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.pig);
    } catch { return; }
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.res, this.W, this.H);
    gl.uniform1f(this.u.time, this.time);
    gl.uniform1i(this.u.pig, 0);
    for (let i = 0; i < MAX_IMP; i++) {
      const im = this.impulses[i];
      if (im) {
        this.impArr.set([im.nx * this.W, (1 - im.ny) * this.H, im.amp, im.t0], i * 4);
        this.prmArr.set([im.k / this.W, im.om, im.phase, im.decay * this.W], i * 4);
        this.colArr.set(im.col, i * 3);
      } else {
        this.impArr.set([0, 0, 0, -10], i * 4);
        this.prmArr.set([0.08, 8, 0, this.W * 0.3], i * 4);
        this.colArr.set([0, 0, 0], i * 3);
      }
    }
    gl.uniform4fv(this.u.imp, this.impArr);
    gl.uniform4fv(this.u.prm, this.prmArr);
    gl.uniform3fv(this.u.icol, this.colArr);
    drawFullscreen(gl, this.prog);
  }

  clear() {
    this.px.clearRect(0, 0, this.PW, this.PH);
    this.impulses = [];
    this.drops = 0;
    this.seedParticles();
  }

  dispose() {
    this.dead = true;
    if (this.micOn) { Audio.micClose(); this.micOn = false; }
    try {
      const gl = this.gl;
      const ext = gl?.getExtension('WEBGL_lose_context');
      ext?.loseContext();
    } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export default function Ink() {
  const stageRef = useResize<HTMLDivElement>((w, h) => eng.current?.resize(w, h));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const eng = useRef<InkEngine | null>(null);
  const [tone, setTone] = useState('Bell');
  const [pig, setPig] = useState<PigmentType>('bloom');
  const [hue, setHue] = useState(1);
  const [frozen, setFrozen] = useState(false);
  const [mic, setMic] = useState<'off' | 'live' | 'blocked'>('off');
  const [noGL, setNoGL] = useState(false);
  const [hintGone, setHintGone] = useState(false);
  const [stats, setStats] = useState('');
  const down = useRef(false);
  const lastP = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const e = new InkEngine(cv);
    eng.current = e;
    if (!e.gl) setNoGL(true);
    const stage = cv.parentElement!;
    e.resize(stage.clientWidth, stage.clientHeight);
    const t1 = setTimeout(() => { if (e.drops === 0 && !e.dead) { e.strike(0.38, 0.44, 1, 1, false); } }, 400);
    const t2 = setTimeout(() => { if (!e.dead) e.strike(0.62, 0.56, 1.5, 1, false); }, 1000);
    const hint = setTimeout(() => setHintGone(true), 8000);
    const stat = setInterval(() => {
      setStats(`${e.impulses.length} waves · ${e.drops} pours${e.micOn ? (e.micLevel > 0.14 ? ' · ● mic' : ' · ○ mic') : ''}`);
    }, 700);
    setDock({ toggle: () => toggleFreeze(), clear: () => e.clear(), export: () => downloadPNG(cv, 'resonant-ink') });
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(hint); clearInterval(stat);
      e.dispose();
      eng.current = null;
      setDock({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRafLoop(true, (dt) => {
    const e = eng.current;
    if (!e) return;
    e.step(dt, getSettings().reduced);
    e.render();
  });

  function toggleFreeze() {
    const e = eng.current;
    if (!e) return;
    e.frozen = !e.frozen;
    setFrozen(e.frozen);
  }

  async function toggleMic() {
    const e = eng.current;
    if (!e) return;
    if (e.micOn) {
      Audio.micClose();
      e.micOn = false;
      setMic('off');
    } else {
      const ok = await Audio.micOpen();
      e.micOn = ok;
      setMic(ok ? 'live' : 'blocked');
      if (!ok) setTimeout(() => setMic('off'), 1600);
    }
  }

  function pos(ev: React.PointerEvent) {
    const r = (ev.target as HTMLCanvasElement).getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
  }

  return (
    <>
      <div className="stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="art"
          style={{ cursor: 'crosshair' }}
          onPointerDown={(ev) => {
            (ev.target as HTMLCanvasElement).setPointerCapture(ev.pointerId);
            down.current = true;
            const p = pos(ev);
            eng.current?.strike(p.x, p.y);
            setHue(eng.current?.hueIdx ?? 1);
            lastP.current = p;
            setHintGone(true);
          }}
          onPointerMove={(ev) => {
            if (!down.current || !eng.current || eng.current.frozen) return;
            const p = pos(ev);
            const l = lastP.current;
            const e = eng.current;
            if (l && Math.hypot(p.x - l.x, p.y - l.y) > 0.016) {
              e.deposit(p.x * e.PW, p.y * e.PH, HUES[(e.hueIdx + HUES.length - 1) % HUES.length], e.pigType, 0.7);
              lastP.current = p;
            }
          }}
          onPointerUp={() => { down.current = false; }}
        />
        <div className={`hint${hintGone ? ' gone' : ''}`}>Tap the surface — every tap sings + ripples · drag to pour pigment</div>
        {noGL && <div className="hint" style={{ bottom: 52 }}>WebGL unavailable — pigment only, no liquid-light refraction.</div>}
      </div>
      <Bar>
        <Group label="Tone">
          {Object.keys(TONES).map((k) => (
            <Pill key={k} active={tone === k} onClick={() => { setTone(k); if (eng.current) eng.current.toneName = k; }}>{k}</Pill>
          ))}
        </Group>
        <Group label="Pigment">
          {(['flow', 'bloom', 'edge', 'dense', 'glow'] as PigmentType[]).map((k) => (
            <Pill key={k} active={pig === k} onClick={() => { setPig(k); if (eng.current) eng.current.pigType = k; }}>{k}</Pill>
          ))}
          <Dots colors={HUES} index={((hue % HUES.length) + HUES.length) % HUES.length} onPick={(i) => { setHue(i); if (eng.current) eng.current.hueIdx = i; }} />
        </Group>
        <Group>
          <Btn active={frozen} onClick={toggleFreeze}>{frozen ? 'Continue' : 'Freeze'}</Btn>
          <Btn warn onClick={() => eng.current?.clear()}>Clear</Btn>
          <Btn onClick={() => canvasRef.current && downloadPNG(canvasRef.current, 'resonant-ink')}>Save image</Btn>
          <Btn active={mic === 'live'} onClick={toggleMic}>{mic === 'off' ? 'Mic off' : mic === 'live' ? 'Mic live' : 'Mic blocked'}</Btn>
        </Group>
        <Spacer />
        <Stat>{stats}</Stat>
      </Bar>
      <div className="note">
        <b>How it plays:</b> tap = strike (Tone.js FM bell / sub / drone / shimmer + ripple + pigment). Drag = pour.
        Pigment types are behaviours — <b>Flow</b> streams, <b>Bloom</b> blossoms, <b>Edge</b> clings to wave contours,{' '}
        <b>Dense</b> pools opaque, <b>Glow</b> burns additive. The WebGL layer refracts pigment through the live wave
        gradient with specular + contour filaments. <b>Mic</b> is opt-in only, never auto-asked.
      </div>
    </>
  );
}
