import { useEffect, useRef, useState } from 'react';
import { TAU, clamp, lerp, downloadPNG } from '../lib/utils';
import { getGL, createProgram, drawFullscreen, fitCanvas, FULLSCREEN_VS } from '../lib/gl';
import { getSettings } from '../lib/settings';
import { useRafLoop, useResize } from '../lib/hooks';
import * as Audio from '../lib/audio';
import { setDock } from '../lib/dock';
import { Bar, Group, Pill, Btn, Slider, Stat, Spacer } from '../ui/chrome';

export const FOSSIL_META = {
  n: 5, id: 'fossil', name: 'Sonar Fossil', one: 'Send pulses; shape a landscape.',
  c1: '#ffd9a0', c2: '#46e0d2',
  about: 'The sand remembers. Each tap fires a sonar pulse that raises ridges and hollows that stay. Overlap pulses to grow topography, rake to sculpt it.',
};

/* ------------------------------------------------------------------ */

type Tool = 'pulse' | 'rake' | 'erase';
type WaveKind = 'soft' | 'sharp' | 'triple';
type View = 'shaded' | 'lines' | 'both';

interface Pulse { x: number; y: number; amp: number; t0: number; wl: number; rings: number; dep: number }
interface FossilSnapshot { persist: Float32Array; pulses: Pulse[] }
const KINDS: Record<WaveKind, { wl: number; rings: number; dep: number }> = {
  soft: { wl: 0.05, rings: 1, dep: 0.5 },
  sharp: { wl: 0.028, rings: 1, dep: 0.8 },
  triple: { wl: 0.04, rings: 3, dep: 0.45 },
};

const FOSSIL_FS = `
precision highp float;
uniform vec2 res;
uniform vec2 fres;
uniform sampler2D fld;
uniform float time;
uniform int view;

float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 fuv = vec2(frag.x / res.x, 1.0 - frag.y / res.y);
  vec2 tx = vec2(1.0 / fres.x, 1.0 / fres.y);
  float h  = texture2D(fld, fuv).r;
  float hR = texture2D(fld, fuv + vec2(tx.x, 0.0)).r;
  float hL = texture2D(fld, fuv - vec2(tx.x, 0.0)).r;
  float hD = texture2D(fld, fuv + vec2(0.0, tx.y)).r;
  float hU = texture2D(fld, fuv - vec2(0.0, tx.y)).r;
  float wv = texture2D(fld, fuv).g;
  // slopes in display-pixel units (U = up-screen = +GL y)
  float dx = (hR - hL) / (2.0 * tx.x * res.x + 1e-5);
  float dy = (hU - hD) / (2.0 * tx.y * res.y + 1e-5);
  vec3 n = normalize(vec3(-dx * 30.0, -dy * 30.0, 1.0));
  vec3 L = normalize(vec3(-0.45, 0.62, 0.72));
  float diff = max(dot(n, L), 0.0);
  float e = clamp(h, 0.0, 1.0);
  // hypsometric mineral ramp
  vec3 col = mix(vec3(0.055, 0.038, 0.032), vec3(0.24, 0.135, 0.075), smoothstep(0.0, 0.45, e));
  col = mix(col, vec3(0.86, 0.56, 0.29), smoothstep(0.45, 0.72, e));
  col = mix(col, vec3(0.96, 0.90, 0.79), smoothstep(0.72, 0.95, e));
  col *= 0.30 + 0.88 * pow(diff, 0.9);
  col = mix(col, vec3(0.42, 0.28, 0.20), (1.0 - n.z) * 0.55);
  // live wavefront glow
  float wa = abs(wv - 0.5) * 2.0;
  col += vec3(0.22, 0.88, 0.84) * pow(wa, 3.0) * 1.15;
  // contours
  float lv = h * 10.0;
  float d = abs(fract(lv + 0.5) - 0.5);
  float aa = 0.07;
  float line = 1.0 - smoothstep(0.0, aa, d);
  float lvM = h * 2.0;
  float dM = abs(fract(lvM + 0.5) - 0.5);
  float aaM = 0.05;
  float major = 1.0 - smoothstep(0.0, aaM, dM);
  if (view == 1) {
    col = vec3(0.030, 0.035, 0.055) + vec3(0.62, 0.90, 0.92) * line * 0.85 + vec3(0.9, 0.95, 1.0) * major * 0.35;
    col += vec3(0.22, 0.88, 0.84) * pow(wa, 3.0) * 0.8;
  } else if (view == 2) {
    col = mix(col, vec3(0.10, 0.060, 0.045), line * 0.55);
    col += vec3(0.55, 0.85, 0.85) * major * 0.30;
  }
  vec2 q = frag / res - 0.5;
  col *= 1.0 - dot(q, q) * 0.9;
  col += (hash(floor(frag * 0.75)) - 0.5) * 0.012;
  gl_FragColor = vec4(col, 1.0);
}
`;

const GW = 420;

class FossilEngine {
  cv: HTMLCanvasElement;
  gl: WebGLRenderingContext | null = null;
  prog: WebGLProgram | null = null;
  u: Record<string, WebGLUniformLocation | null> = {};
  tex: WebGLTexture | null = null;
  GH = 200;
  persist = new Float32Array(GW * this.GH);
  wave = new Float32Array(GW * this.GH);
  bytes = new Uint8Array(GW * this.GH * 4);
  pulses: Pulse[] = [];
  undo: FossilSnapshot[] = [];
  W = 2; H = 2;
  time = 0;
  dead = false;
  frozen = false;
  tool: Tool = 'pulse';
  waveKind: WaveKind = 'soft';
  view: View = 'both';
  power = 1;
  kept = 0;

  constructor(cv: HTMLCanvasElement) {
    this.cv = cv;
    this.gl = getGL(cv);
    this.seedTerrain();
    if (this.gl) {
      const gl = this.gl;
      this.prog = createProgram(gl, FULLSCREEN_VS, FOSSIL_FS);
      for (const k of ['res', 'fres', 'fld', 'time', 'view']) this.u[k] = gl.getUniformLocation(this.prog, k);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
  }

  resize(w: number, h: number) {
    const r = fitCanvas(this.cv, { clientWidth: Math.max(2, w), clientHeight: Math.max(2, h) }, 1.5);
    this.W = r.W; this.H = r.H;
    const GH = clamp(Math.round((GW * r.H) / r.W), 140, 320);
    if (GH !== this.GH) {
      // Resample the persistent relief vertically instead of cropping rows when
      // the viewport aspect ratio changes. Existing landforms stay recognizable.
      const old = this.persist;
      const oldH = this.GH;
      const np = new Float32Array(GW * GH);
      for (let y = 0; y < GH; y++) {
        const sy = (y / Math.max(1, GH - 1)) * (oldH - 1);
        const y0 = Math.floor(sy);
        const y1 = Math.min(oldH - 1, y0 + 1);
        const fy = sy - y0;
        for (let x = 0; x < GW; x++) {
          const a = old[y0 * GW + x];
          const b = old[y1 * GW + x];
          np[y * GW + x] = a + (b - a) * fy;
        }
      }
      this.persist = np;
      this.wave = new Float32Array(GW * GH);
      this.bytes = new Uint8Array(GW * GH * 4);
      this.GH = GH;
    }
    this.gl?.viewport(0, 0, r.W, r.H);
  }

  seedTerrain() {
    // Deterministic shallow dunes: avoid random pixel noise so the first frame
    // reads as fine mineral sand rather than a noisy height texture.
    for (let y = 0; y < this.GH; y++) {
      for (let x = 0; x < GW; x++) {
        const nx = x / GW, ny = y / this.GH;
        const dunes =
          Math.sin(nx * 18.0 + Math.sin(ny * 10.5) * 1.65) * 0.048 +
          Math.sin(ny * 23.0 + Math.sin(nx * 8.2) * 1.25) * 0.032 +
          Math.sin(nx * 53.0 + Math.cos(ny * 37.0)) * 0.006;
        this.persist[y * GW + x] = dunes;
      }
    }
  }

  resetTerrain() {
    this.seedTerrain();
    this.wave.fill(0);
    this.pulses = [];
    this.kept = 0;
  }

  snapshot() {
    // Undo must restore the active pulses too. Otherwise an undone pulse keeps
    // depositing ridges on the next frame and appears to undo itself.
    this.undo.push({
      persist: this.persist.slice(),
      pulses: this.pulses.map((p) => ({ ...p })),
    });
    if (this.undo.length > 8) this.undo.shift();
  }

  fire(nx: number, ny: number, amp: number, playSound = true) {
    if (this.frozen || this.dead) return;
    const k = KINDS[this.waveKind];
    this.pulses.push({ x: nx, y: ny, amp: amp * this.power, t0: this.time, wl: k.wl, rings: k.rings, dep: k.dep });
    if (this.pulses.length > 10) this.pulses.shift();
    if (playSound) void Audio.ensureAudio().then(() => Audio.thump(0.4 + amp * 0.4)).catch(() => {});
  }

  rake(nx: number, ny: number, pxn: number, pyn: number) {
    const cx0 = clamp(Math.round(nx * GW), 0, GW - 1);
    const cy0 = clamp(Math.round(ny * this.GH), 0, this.GH - 1);
    const R = 9;
    const dx = (nx - pxn) * GW;
    const dy = (ny - pyn) * this.GH;
    const travel = Math.hypot(dx, dy);
    const ux = travel > 0.001 ? dx / travel : 1;
    const uy = travel > 0.001 ? dy / travel : 0;
    const strength = clamp(travel * 0.008, 0.012, 0.075);

    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      const x = cx0 + i, y = cy0 + j;
      if (x < 0 || y < 0 || x >= GW || y >= this.GH) continue;
      const across = (-i * uy + j * ux) / R;
      const along = (i * ux + j * uy) / R;
      const d2 = (i * i + j * j) / (R * R);
      if (d2 > 1.15) continue;
      const k = y * GW + x;
      if (this.tool === 'rake') {
        // A rake creates a narrow raised berm and a shallow trough behind it;
        // the profile follows the user's stroke direction instead of simply
        // adding the same height everywhere inside a circular brush.
        const brush = Math.exp(-d2 * 2.5);
        const ridge = Math.exp(-Math.pow((along - 0.18) / 0.22, 2) * 2.0) * Math.exp(-across * across * 5.0);
        const trough = Math.exp(-Math.pow((along + 0.24) / 0.25, 2) * 2.0) * Math.exp(-across * across * 5.0);
        this.persist[k] = clamp(this.persist[k] + strength * (ridge - trough) * brush * 2.6, -1.6, 1.6);
      } else {
        // Erase eases the relief back toward the quiet base rather than
        // creating a hard circular divot.
        const smooth = clamp((1.15 - d2) * 0.11, 0, 0.12);
        this.persist[k] = lerp(this.persist[k], 0, smooth);
      }
    }
  }

  step(dt: number, reduced: boolean) {
    if (this.dead) return;
    if (!this.frozen) this.time += reduced ? dt * 0.5 : dt;
    const t = this.time;
    this.pulses = this.pulses.filter((p) => t - p.t0 < 3.2);
    if (!this.frozen) {
      this.wave.fill(0);
      for (const p of this.pulses) {
        const age = t - p.t0;
        const R = age * 0.34;
        const fade = Math.exp(-age * 1.5);
        if (fade < 0.01) continue;
        const cx0 = p.x * GW, cy0 = p.y * this.GH;
        const rad = Math.ceil(R * Math.max(GW, this.GH)) + 8;
        const x0 = Math.max(0, Math.floor(cx0 - rad)), x1 = Math.min(GW - 1, Math.ceil(cx0 + rad));
        const y0 = Math.max(0, Math.floor(cy0 - rad)), y1 = Math.min(this.GH - 1, Math.ceil(cy0 + rad));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const dx = (x - cx0) / GW, dy = (y - cy0) / this.GH;
          const d = Math.hypot(dx, dy) + 1e-6;
          let ring = 0;
          for (let m = 0; m < p.rings; m++) {
            const rm = R - m * p.wl * 1.6;
            const g = Math.exp(-((d - rm) * (d - rm)) / (2 * p.wl * p.wl * 0.4));
            ring += g * Math.sin(((d - rm) / p.wl) * TAU * 0.5) * (m === 0 ? 1 : 0.5);
          }
          const k = y * GW + x;
          this.wave[k] += ring * p.amp * fade;
          this.persist[k] = clamp(this.persist[k] + ring * p.amp * fade * p.dep * dt * 1.4, -1.6, 1.6);
        }
      }
      for (let i = 0; i < this.persist.length; i++) this.persist[i] *= 1 - dt * 0.01;
    }
    this.render();
  }

  render() {
    const gl = this.gl;
    if (!gl || !this.prog || this.dead) return;
    const { persist, wave, bytes, GH } = this;
    for (let i = 0; i < persist.length; i++) {
      const o = i * 4;
      const h = clamp((persist[i] + wave[i]) / 3.2 + 0.5, 0, 1);
      const wv = clamp(wave[i] / 1.2 + 0.5, 0, 1);
      bytes[o] = (h * 255) | 0;
      bytes[o + 1] = (wv * 255) | 0;
      bytes[o + 2] = 0;
      bytes[o + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GW, GH, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    } catch { return; }
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.res, this.W, this.H);
    gl.uniform2f(this.u.fres, GW, GH);
    gl.uniform1i(this.u.fld, 0);
    gl.uniform1f(this.u.time, this.time);
    gl.uniform1i(this.u.view, this.view === 'shaded' ? 0 : this.view === 'lines' ? 1 : 2);
    drawFullscreen(gl, this.prog);
  }

  dispose() {
    this.dead = true;
    try { this.gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */

export default function Fossil() {
  const stageRef = useResize<HTMLDivElement>((w, h) => eng.current?.resize(w, h));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const eng = useRef<FossilEngine | null>(null);
  const [tool, setTool] = useState<Tool>('pulse');
  const [waveKind, setWaveKind] = useState<WaveKind>('soft');
  const [view, setView] = useState<View>('both');
  const [power, setPower] = useState(1);
  const [frozen, setFrozen] = useState(false);
  const [hintGone, setHintGone] = useState(false);
  const [stats, setStats] = useState('');
  const [noGL, setNoGL] = useState(false);
  const down = useRef(false);
  const lastN = useRef<{ nx: number; ny: number } | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const e = new FossilEngine(cv);
    eng.current = e;
    if (!e.gl) setNoGL(true);
    e.resize(cv.parentElement!.clientWidth, cv.parentElement!.clientHeight);
    const seeded = { n: 0 };
    const t1 = setTimeout(() => { if (!e.dead) { e.fire(0.4, 0.45, 0.9, false); seeded.n++; } }, 450);
    const t2 = setTimeout(() => { if (!e.dead) { e.fire(0.62, 0.55, 0.9, false); seeded.n++; } }, 1150);
    const t3 = setTimeout(() => { if (!e.dead && seeded.n === 2) { e.snapshot(); e.kept++; } }, 1350);
    const hint = setTimeout(() => setHintGone(true), 9000);
    const stat = setInterval(() => setStats(`${e.pulses.length} live · ${e.kept} kept`), 700);
    setDock({
      toggle: () => toggleFreeze(),
      clear: () => clearAll(),
      export: () => downloadPNG(cv, 'sonar-fossil'),
    });
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(hint); clearInterval(stat);
      e.dispose();
      eng.current = null;
      setDock({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRafLoop(true, (dt) => eng.current?.step(dt, getSettings().reduced));

  function toggleFreeze() {
    const e = eng.current;
    if (!e) return;
    e.frozen = !e.frozen;
    setFrozen(e.frozen);
  }

  function clearAll() {
    const e = eng.current;
    if (!e) return;
    e.snapshot();
    e.resetTerrain();
  }

  function pos(ev: React.PointerEvent) {
    const r = (ev.target as HTMLCanvasElement).getBoundingClientRect();
    return { nx: (ev.clientX - r.left) / r.width, ny: (ev.clientY - r.top) / r.height };
  }

  return (
    <>
      <div className="stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="art"
          style={{ cursor: tool === 'pulse' ? 'crosshair' : 'grab' }}
          onPointerDown={(ev) => {
            (ev.target as HTMLCanvasElement).setPointerCapture(ev.pointerId);
            down.current = true;
            const e = eng.current;
            if (!e) return;
            const p = pos(ev);
            e.snapshot(); e.kept++;
            if (e.tool === 'pulse') e.fire(p.nx, p.ny, 0.9);
            else e.rake(p.nx, p.ny, p.nx, p.ny);
            lastN.current = p;
            setHintGone(true);
          }}
          onPointerMove={(ev) => {
            if (!down.current || !eng.current || eng.current.frozen) return;
            const e = eng.current;
            const p = pos(ev);
            const l = lastN.current;
            if (!l) { lastN.current = p; return; }
            if (e.tool === 'pulse') {
              if (Math.hypot(p.nx - l.nx, p.ny - l.ny) > 0.03) { e.fire(p.nx, p.ny, 0.55, false); lastN.current = p; }
            } else {
              e.rake(p.nx, p.ny, l.nx, l.ny);
              lastN.current = p;
            }
          }}
          onPointerUp={() => { down.current = false; }}
        />
        <div className={`hint${hintGone ? ' gone' : ''}`}>Tap to fire a sonar pulse · drag to rake the sand</div>
        {noGL && <div className="hint" style={{ bottom: 52 }}>WebGL unavailable — this instrument needs GPU rendering.</div>}
      </div>
      <Bar>
        <Group label="Tool">
          {(['pulse', 'rake', 'erase'] as Tool[]).map((k) => (
            <Pill key={k} active={tool === k} onClick={() => { setTool(k); if (eng.current) eng.current.tool = k; }}>{k}</Pill>
          ))}
        </Group>
        <Group label="Wave">
          {(['soft', 'sharp', 'triple'] as WaveKind[]).map((k) => (
            <Pill key={k} active={waveKind === k} onClick={() => { setWaveKind(k); if (eng.current) eng.current.waveKind = k; }}>{k}</Pill>
          ))}
          <Slider label="power" value={power} min={0.3} max={1.6} step={0.05} width={70} onChange={(v) => { setPower(v); if (eng.current) eng.current.power = v; }} />
        </Group>
        <Group label="Render">
          {(['shaded', 'lines', 'both'] as View[]).map((k) => (
            <Pill key={k} active={view === k} onClick={() => { setView(k); if (eng.current) eng.current.view = k; }}>{k}</Pill>
          ))}
        </Group>
        <Group>
          <Btn onClick={() => { const e = eng.current; if (!e) return; const s = e.undo.pop(); if (s) { e.persist.set(s.persist); e.pulses = s.pulses.map((p) => ({ ...p })); e.wave.fill(0); e.kept = Math.max(0, e.kept - 1); } }}>Undo</Btn>
          <Btn active={frozen} onClick={toggleFreeze}>{frozen ? 'Continue' : 'Freeze'}</Btn>
          <Btn warn onClick={clearAll}>Clear</Btn>
          <Btn onClick={() => canvasRef.current && downloadPNG(canvasRef.current, 'sonar-fossil')}>Export</Btn>
        </Group>
        <Spacer />
        <Stat>{stats}</Stat>
      </Bar>
      <div className="note">
        <b>How it plays:</b> <b>Pulse</b> fires a MembraneSynth thump + a wavelet that deposits a real ridge.{' '}
        <b>Rake</b> combs directional dunes, <b>Erase</b> smooths back to plain. The GPU shades the height-field
        with slope lighting, hypsometric mineral tones, anti-aliased contours and cyan wavefront glow. Overlapping
        pulses grow genuine topography — then export the fossil.
      </div>
    </>
  );
}
