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
interface Particle { x: number; y: number; vx: number; vy: number; s: number; a: number; c: string; tw: number }

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
  // refract the pigment layer through the wave gradient
  vec2 off = clamp((-g * 620.0) / res, vec2(-0.08), vec2(0.08));
  vec3 pigCol = texture2D(pig, clamp(puv + off, vec2(0.001), vec2(0.999))).rgb;
  // deep liquid base
  vec2 asp = vec2(res.x / res.y, 1.0);
  float vig0 = length((puv - 0.5) * asp);
  vec3 base = mix(vec3(0.050, 0.066, 0.108), vec3(0.010, 0.014, 0.032), smoothstep(0.0, 0.78, vig0));
  vec3 col = base + pigCol * 1.06;
  // contour filaments riding the field
  float lv = w * 9.0;
  float f = abs(fract(lv + 0.5) - 0.5);
  float fil = 1.0 - smoothstep(0.0, 0.16, f);
  col += vec3(0.55, 0.90, 1.0) * fil * 0.20 * min(1.0, abs(w) * 3.0 + 0.22);
  // expanding rings + glowing cores
  col += rings * 0.9 + cores * 0.9;
  // soft specular from surface slope
  float spec = pow(clamp(1.0 - length(g) * 20.0, 0.0, 1.0), 3.0);
  col += vec3(0.85, 0.95, 1.0) * spec * 0.10;
  // vignette + animated grain
  col *= 1.0 - smoothstep(0.42, 1.05, vig0) * 0.55;
  col += (hash(frag + fract(time) * 61.7) - 0.5) * 0.032;
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
    this.parts = [];
    for (let i = 0; i < 1600; i++) {
      this.parts.push({
        x: Math.random(), y: Math.random(), vx: 0, vy: 0,
        s: 0.6 + Math.random() * 1.9, a: 0.22 + Math.random() * 0.6,
        c: HUES[i % HUES.length], tw: Math.random() * TAU,
      });
    }
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

  strike(nx: number, ny: number, freqMul = 1, ampMul = 1) {
    if (this.frozen || this.dead) return;
    const T = TONES[this.toneName];
    const color = HUES[this.hueIdx % HUES.length];
    void Audio.ensureAudio().then(() => Audio.strike(T.kind, T.freq * freqMul * (0.98 + Math.random() * 0.04)));
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
    px.save();
    px.globalCompositeOperation = type === 'glow' ? 'lighter' : 'source-over';
    const R = (type === 'dense' ? 26 : type === 'bloom' ? 64 : 44) * mult * (this.PW / 900 + 0.5);
    const n = type === 'bloom' ? 26 : type === 'dense' ? 42 : 18;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, r = Math.pow(Math.random(), 0.6) * R;
      const x = sx + Math.cos(a) * r, y = sy + Math.sin(a) * r * 0.9;
      const rr = (type === 'dense' ? 2 + Math.random() * 5 : type === 'glow' ? 6 + Math.random() * 14 : 3 + Math.random() * 9);
      const g = px.createRadialGradient(x, y, 0, x, y, rr * 2.4);
      g.addColorStop(0, color);
      g.addColorStop(1, color + '00');
      px.globalAlpha = type === 'dense' ? 0.5 : type === 'glow' ? 0.32 : 0.3;
      px.fillStyle = g;
      px.beginPath(); px.arc(x, y, rr * 2.4, 0, TAU); px.fill();
    }
    px.restore();
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

    // advect + draw particles (normalized coords)
    const n2 = this.noise;
    for (const p of this.parts) {
      const { w, gx, gy } = this.waveAt(p.x, p.y);
      const sc = 1 / Math.max(this.PW, this.PH);
      p.vx += -gx * 9000 * sc * dt * 0.5 - p.vx * 1.7 * dt + n2(p.x * 3, t * 0.25 + p.tw) * 0.012;
      p.vy += -gy * 9000 * sc * dt * 0.5 - p.vy * 1.7 * dt + n2(p.y * 3 + 9, t * 0.25) * 0.012;
      p.vx = clamp(p.vx, -0.5, 0.5); p.vy = clamp(p.vy, -0.5, 0.5);
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.x < 0 || p.x > 1) { p.vx *= -1; p.x = clamp(p.x, 0, 1); }
      if (p.y < 0 || p.y > 1) { p.vy *= -1; p.y = clamp(p.y, 0, 1); }

      const X = p.x * this.PW, Y = p.y * this.PH;
      let alpha = p.a * 0.5, sz = p.s;
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
    const t1 = setTimeout(() => { if (e.drops === 0 && !e.dead) { e.strike(0.38, 0.44); } }, 400);
    const t2 = setTimeout(() => { if (!e.dead) e.strike(0.62, 0.56, 1.5); }, 1000);
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
