import { useEffect, useRef, useState } from 'react';
import { createNoise2D } from 'simplex-noise';
import { TAU, clamp, lerp, easeInOut, downloadPNG, hexToRgb } from '../lib/utils';
import { getGL, createProgram, drawFullscreen, fitCanvas, FULLSCREEN_VS } from '../lib/gl';
import { getSettings } from '../lib/settings';
import { useRafLoop, useResize } from '../lib/hooks';
import * as Audio from '../lib/audio';
import { setDock } from '../lib/dock';
import { Bar, Group, Pill, Btn, Slider, Spacer } from '../ui/chrome';

export const GARDEN_META = {
  n: 2, id: 'garden', name: 'Harmonic Garden', one: 'Arrange waves; discover interference.',
  c1: '#7c6bff', c2: '#ff5fa2',
  about: 'Drag luminous sources around the field. Where their waves overlap, corridors, rosettes and cells appear. Tune phase to reorganise everything.',
};

/* ------------------------------------------------------------------ */

const NSRC = 6;
const COLS = ['#46e0d2', '#7c6bff', '#ff5fa2', '#ffb35c', '#8dff7a', '#5b8cff'];
export type FieldMode = 'contours' | 'interference' | 'filament';

interface Source { id: number; x: number; y: number; freq: number; amp: number; phase: number; ci: number }

const SEEDS: Record<string, Array<[number, number, number, number]>> = {
  rosette:  [[0.32, 0.42, 1.2, 0], [0.68, 0.42, 1.2, 2.1], [0.5, 0.72, 1.32, 4.2]],
  corridor: [[0.35, 0.5, 1.7, 0], [0.65, 0.5, 1.7, 3.14]],
  cellular: [[0.3, 0.35, 1.4, 0], [0.7, 0.35, 1.4, 1.6], [0.3, 0.7, 1.4, 3.1], [0.7, 0.7, 1.4, 4.7]],
  spiral:   [[0.5, 0.5, 1.1, 0], [0.62, 0.5, 1.5, 2.4], [0.5, 0.62, 1.3, 4.4]],
};

const GARDEN_FS = `
precision highp float;
uniform vec2 res;
uniform float time;
uniform int mode;
uniform int n;
uniform vec3 spos[${NSRC}];
uniform vec4 sprm[${NSRC}];
uniform vec3 scol[${NSRC}];

float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 spectral(float x) {
  return 0.52 + 0.48 * cos(6.28318 * (x + vec3(0.02, 0.34, 0.68)));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / res;
  vec2 asp = vec2(res.x / res.y, 1.0);
  vec2 p = (uv - 0.5) * asp;

  // Keep a very small drift in the domain. The radial wave fronts should
  // remain readable and geometric; they must not dissolve into a noise field.
  vec2 wp = p + 0.009 * vec2(
    sin(p.y * 5.1 + time * 0.22),
    cos(p.x * 4.7 - time * 0.19)
  );

  float field = 0.0;
  float energy = 0.0;
  vec3 sourceGlow = vec3(0.0);
  vec3 localTint = vec3(0.0);
  float totalInfluence = 0.0;

  for (int i = 0; i < ${NSRC}; i++) {
    if (i >= n) break;
    vec2 source = (spos[i].xy - 0.5) * asp;
    vec2 d = wp - source;
    float dist = length(d) + 0.0001;
    float freq = sprm[i].x;
    float amp = sprm[i].y;
    float phase = sprm[i].z;

    float k = 18.0 + freq * 17.0;
    float omega = 1.1 + freq * 2.6;
    float theta = k * dist - omega * time + phase;
    float attenuation = 1.0 / sqrt(0.24 + dist * 1.45);
    float wave = sin(theta) * amp * attenuation;

    field += wave;
    energy += abs(wave);

    float ring = exp(-abs(sin(theta * 0.5)) * 18.0) * exp(-dist * 0.55) * amp;
    sourceGlow += scol[i] * ring * 0.18;

    float nearSource = exp(-dist * 5.0) * amp;
    localTint += scol[i] * nearSource;
    totalInfluence += nearSource;
  }

  float countScale = inversesqrt(max(float(n), 1.0));
  field *= countScale;
  energy *= countScale;

  vec3 deep = vec3(0.008, 0.012, 0.027);
  vec3 indigo = vec3(0.023, 0.031, 0.082);
  float vignette = 1.0 - smoothstep(0.40, 0.98, length((uv - 0.5) * asp));
  vec3 outc = mix(deep, indigo, 0.35 + 0.15 * sin(time * 0.12));

  vec3 tint = spectral(field * 0.11 + 0.58);
  float brightBands = 0.5 + 0.5 * sin(field * 3.0);
  float node = exp(-abs(field) * 10.0);
  float ridge = exp(-abs(abs(field) - 0.42) * 13.0);
  float halo = 1.0 - exp(-energy * 1.5);

  if (mode == 0) {
    // Contours: crisp isophase lines separated by dark negative space.
    float bands = field * 3.8;
    float d = abs(fract(bands + 0.5) - 0.5);
    float line = 1.0 - smoothstep(0.025, 0.11, d);
    float minorD = abs(fract(field * 11.0 + 0.5) - 0.5);
    float minor = 1.0 - smoothstep(0.018, 0.065, minorD);
    outc += tint * line * 0.82;
    outc += vec3(0.45, 0.72, 0.95) * minor * 0.18;
    outc += localTint * 0.10;
  } else if (mode == 1) {
    // Interference: colored wave bands with bright nodal intersections.
    outc = mix(outc, tint * (0.28 + brightBands * 0.82), smoothstep(0.04, 0.8, energy));
    outc += tint * node * 0.34;
    outc += spectral(field * 0.17 + 0.14) * ridge * 0.25;
    outc += localTint * 0.16;
  } else {
    // Filaments: show only stable-looking ridges and wavefronts, with an
    // iridescent edge rather than broad filled gradients.
    float fine = exp(-abs(field) * 14.0);
    float secondary = exp(-abs(abs(field) - 0.30) * 22.0);
    outc += spectral(field * 0.15 + 0.2) * fine * 0.95;
    outc += spectral(field * 0.12 + 0.57) * secondary * 0.38;
    outc += sourceGlow * 0.8;
  }

  // Source cores remain visible as tactile handles, but the whole image is
  // driven by the wave field, not just colored blobs around the handles.
  outc += sourceGlow;
  outc += vec3(0.15, 0.48, 0.72) * halo * 0.05;
  outc *= vignette;
  outc += (hash(frag) - 0.5) * 0.009;
  gl_FragColor = vec4(outc, 1.0);
}
`;

class GardenEngine {
  cv: HTMLCanvasElement;
  stage: HTMLElement;
  gl: WebGLRenderingContext | null;
  prog: WebGLProgram | null = null;
  u: Record<string, WebGLUniformLocation | null> = {};
  posArr = new Float32Array(NSRC * 3);
  prmArr = new Float32Array(NSRC * 4);
  colArr = new Float32Array(NSRC * 3);
  sources: Source[] = [];
  seq = 1;
  time = 0;
  dead = false;
  mode: FieldMode = 'interference';
  drift = true;
  noise = createNoise2D();
  handles = new Map<number, HTMLDivElement>();
  morph: { from: Source[]; to: Source[]; t0: number; dur: number } | null = null;
  onSelect: (id: number) => void = () => {};
  selId = 1;

  constructor(cv: HTMLCanvasElement, stage: HTMLElement) {
    this.cv = cv;
    this.stage = stage;
    this.gl = getGL(cv);
    if (this.gl) {
      const gl = this.gl;
      this.prog = createProgram(gl, FULLSCREEN_VS, GARDEN_FS);
      for (const k of ['res', 'time', 'mode', 'n', 'spos', 'sprm', 'scol']) {
        this.u[k] = gl.getUniformLocation(this.prog, k === 'spos' || k === 'sprm' || k === 'scol' ? k + '[0]' : k);
      }
    }
    this.applySeed('rosette', true);
  }

  applySeed(name: string, instant = false) {
    const def = SEEDS[name] ?? SEEDS.rosette;
    const to: Source[] = def.map((d, i) => ({
      id: this.sources[i]?.id ?? this.seq++,
      x: d[0], y: d[1], freq: d[2], amp: 0.75, phase: d[3],
      ci: this.sources[i]?.ci ?? i % COLS.length,
    }));
    if (instant || this.sources.length === 0) {
      this.sources = to;
      this.morph = null;
    } else {
      const from = this.sources.map((s) => ({ ...s }));
      // Grow/shrink the LIVE array in place so existing handle closures stay valid.
      while (this.sources.length < to.length) {
        const t = to[this.sources.length];
        this.sources.push({ ...t, amp: 0 });
      }
      if (this.sources.length > to.length) this.sources.length = to.length;
      this.morph = { from, to, t0: this.time, dur: 1.4 };
    }
    this.selId = to[0]?.id ?? 1;
    this.onSelect(this.selId);
    this.syncHandles();
  }

  syncHandles() {
    // remove stale
    for (const [id, h] of this.handles) {
      if (!this.sources.some((s) => s.id === id)) { h.remove(); this.handles.delete(id); }
    }
    for (const s of this.sources) {
      let h = this.handles.get(s.id);
      if (!h) {
        h = document.createElement('div');
        h.className = 'srcHandle';
        h.innerHTML = '<i></i>';
        h.title = 'drag to move · click to select';
        h.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          h!.setPointerCapture(ev.pointerId);
          (h as HTMLElement).dataset.drag = '1';
          this.selId = s.id;
          this.onSelect(s.id);
          this.refreshHandleSel();
        });
        h.addEventListener('pointermove', (ev) => {
          if ((h as HTMLElement).dataset.drag !== '1') return;
          this.morph = null; // user takes over mid-tween
          const r = this.stage.getBoundingClientRect();
          s.x = clamp((ev.clientX - r.left) / r.width, 0.02, 0.98);
          s.y = clamp(1 - (ev.clientY - r.top) / r.height, 0.02, 0.98);
          this.morph = null;
        });
        const up = () => { delete (h as HTMLElement).dataset.drag; };
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
        this.stage.appendChild(h);
        this.handles.set(s.id, h);
      }
      h.style.color = COLS[s.ci % COLS.length];
    }
    this.refreshHandleSel();
  }

  refreshHandleSel() {
    for (const [id, h] of this.handles) h.classList.toggle('sel', id === this.selId);
  }

  selected(): Source | undefined {
    return this.sources.find((s) => s.id === this.selId) ?? this.sources[0];
  }

  addSource() {
    if (this.sources.length >= NSRC) return;
    this.morph = null;
    const s: Source = {
      id: this.seq++, x: 0.3 + Math.random() * 0.4, y: 0.3 + Math.random() * 0.4,
      freq: 0.6 + Math.random() * 0.8, amp: 0, phase: Math.random() * TAU, ci: this.sources.length % COLS.length,
    };
    this.sources.push(s);
    this.selId = s.id;
    // bloom in
    const target = 0.75;
    const t0 = this.time;
    const tick = () => { s.amp = lerp(s.amp, target, 0.08); if (s.amp < target - 0.01 && !this.dead) requestAnimationFrame(tick); else s.amp = target; };
    void t0; tick();
    this.onSelect(s.id);
    this.syncHandles();
  }

  removeSelected() {
    if (this.sources.length <= 1) return;
    this.morph = null;
    this.sources = this.sources.filter((s) => s.id !== this.selId);
    this.selId = this.sources[0].id;
    this.onSelect(this.selId);
    this.syncHandles();
  }

  resize(w: number, h: number) {
    fitCanvas(this.cv, { clientWidth: Math.max(2, w), clientHeight: Math.max(2, h) }, 1.5);
    this.gl?.viewport(0, 0, this.cv.width, this.cv.height);
  }

  step(dt: number, reduced: boolean) {
    if (this.dead) return;
    this.time += reduced ? dt * 0.3 : dt;
    const t = this.time;
    if (this.morph) {
      const k = clamp((t - this.morph.t0) / this.morph.dur, 0, 1);
      const e = easeInOut(k);
      const { from, to } = this.morph;
      // Lengths can only differ if add/remove ran (which cancels morph),
      // but stay defensive and keep mutating the live array in place.
      while (this.sources.length < to.length) {
        this.sources.push({ ...to[this.sources.length], amp: 0 });
        this.syncHandles();
      }
      if (this.sources.length > to.length) {
        this.sources.length = to.length;
        this.syncHandles();
      }
      this.sources.forEach((s, i) => {
        const f = from[i] ?? { ...to[i], amp: 0 };
        const tg = to[i];
        let dp = tg.phase - f.phase;
        dp = Math.atan2(Math.sin(dp), Math.cos(dp));
        s.x = lerp(f.x, tg.x, e);
        s.y = lerp(f.y, tg.y, e);
        s.freq = lerp(f.freq, tg.freq, e);
        s.amp = lerp(f.amp, tg.amp, e);
        s.phase = f.phase + dp * e;
        s.id = tg.id;
        s.ci = tg.ci;
      });
      if (k >= 1) {
        this.morph = null;
        this.syncHandles();
      }
    }
    if (this.drift && !reduced) {
      for (const s of this.sources) {
        s.x = clamp(s.x + this.noise(s.id * 7.3, t * 0.05) * 0.00035, 0.02, 0.98);
        s.y = clamp(s.y + this.noise(s.id * 3.1 + 40, t * 0.05) * 0.00035, 0.02, 0.98);
      }
    }
    // handles
    for (const s of this.sources) {
      const h = this.handles.get(s.id);
      if (h) {
        h.style.left = `${(s.x * 100).toFixed(2)}%`;
        h.style.top = `${((1 - s.y) * 100).toFixed(2)}%`;
      }
    }
    this.render();
  }

  render() {
    const gl = this.gl;
    if (!gl || !this.prog || this.dead) return;
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.res, this.cv.width, this.cv.height);
    gl.uniform1f(this.u.time, this.time);
    gl.uniform1i(this.u.mode, this.mode === 'contours' ? 0 : this.mode === 'interference' ? 1 : 2);
    gl.uniform1i(this.u.n, this.sources.length);
    this.sources.forEach((s, i) => {
      this.posArr.set([s.x, s.y, 0], i * 3);
      this.prmArr.set([s.freq, s.amp, s.phase, 0], i * 4);
      this.colArr.set(hexToRgb(COLS[s.ci % COLS.length]), i * 3);
    });
    for (let i = this.sources.length; i < NSRC; i++) {
      this.posArr.set([0, 0, 0], i * 3);
      this.prmArr.set([0, 0, 0, 0], i * 4);
      this.colArr.set([0, 0, 0], i * 3);
    }
    gl.uniform3fv(this.u.spos, this.posArr);
    gl.uniform4fv(this.u.sprm, this.prmArr);
    gl.uniform3fv(this.u.scol, this.colArr);
    drawFullscreen(gl, this.prog);
  }

  dispose() {
    this.dead = true;
    Audio.humStop();
    for (const h of this.handles.values()) h.remove();
    this.handles.clear();
    try { this.gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */

export default function Garden() {
  const stageRef = useResize<HTMLDivElement>((w, h) => eng.current?.resize(w, h));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const eng = useRef<GardenEngine | null>(null);
  const [mode, setMode] = useState<FieldMode>('interference');
  const [seed, setSeed] = useState('rosette');
  const [selId, setSelId] = useState(1);
  const [freq, setFreq] = useState(1.2);
  const [amp, setAmp] = useState(0.75);
  const [phase, setPhase] = useState(0);
  const [drift, setDrift] = useState(true);
  const [tone, setTone] = useState(false);
  const [hintGone, setHintGone] = useState(false);
  const [noGL, setNoGL] = useState(false);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const stage = cv.parentElement!;
    const e = new GardenEngine(cv, stage);
    eng.current = e;
    if (!e.gl) setNoGL(true);
    e.resize(stage.clientWidth, stage.clientHeight);
    e.onSelect = (id) => {
      setSelId(id);
      const s = e.sources.find((x) => x.id === id);
      if (s) { setFreq(s.freq); setAmp(s.amp); setPhase(s.phase); }
    };
    e.onSelect(e.selId);
    const hint = setTimeout(() => setHintGone(true), 8000);
    setDock({
      clear: () => { e.applySeed('corridor'); setSeed('corridor'); },
      export: () => downloadPNG(cv, 'harmonic-garden'),
    });
    return () => {
      clearTimeout(hint);
      e.dispose();
      eng.current = null;
      setDock({});
    };
  }, []);

  useRafLoop(true, (dt) => eng.current?.step(dt, getSettings().reduced));

  function reseed(name: string) {
    setSeed(name);
    eng.current?.applySeed(name);
    setTimeout(() => {
      const s = eng.current?.selected();
      if (s) { setFreq(s.freq); setAmp(s.amp); setPhase(s.phase); }
    }, 1500);
  }

  function poke(param: 'freq' | 'amp' | 'phase', v: number) {
    const e = eng.current;
    const s = e?.selected();
    if (!e || !s) return;
    e.morph = null;
    s[param] = v;
    if (param === 'freq') { setFreq(v); if (tone) Audio.humFreq(110 + v * 160); }
    if (param === 'amp') setAmp(v);
    if (param === 'phase') setPhase(v);
  }

  function toggleTone() {
    if (tone) { Audio.humStop(); setTone(false); return; }
    const s = eng.current?.selected();
    if (!s) return;
    void Audio.ensureAudio().then(() => {
      if (getSettings().muted) return;
      Audio.humStart(110 + s.freq * 160);
      setTone(true);
    });
  }

  return (
    <>
      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} className="art" style={{ cursor: 'default' }} />
        {noGL && <div className="hint">WebGL unavailable — this instrument needs GPU rendering.</div>}
        {!noGL && <div className={`hint${hintGone ? ' gone' : ''}`}>Drag a source · add a second one — interference appears</div>}
      </div>
      <Bar>
        <Group label="Seed">
          {Object.keys(SEEDS).map((k) => (
            <Pill key={k} active={seed === k} onClick={() => reseed(k)}>{k}</Pill>
          ))}
        </Group>
        <Group label="View">
          {(['contours', 'interference', 'filament'] as FieldMode[]).map((k) => (
            <Pill key={k} active={mode === k} onClick={() => { setMode(k); if (eng.current) eng.current.mode = k; }}>{k}</Pill>
          ))}
        </Group>
        <Group label={`Src ${selId}`}>
          <Slider label="freq" value={freq} min={0.1} max={1.6} step={0.01} onChange={(v) => poke('freq', v)} />
          <Slider label="amp" value={amp} min={0} max={1} step={0.01} onChange={(v) => poke('amp', v)} />
          <Slider label="phase" value={phase} min={0} max={6.28} step={0.01} onChange={(v) => poke('phase', v)} />
        </Group>
        <Group>
          <Btn onClick={() => eng.current?.addSource()}>+ source</Btn>
          <Btn warn onClick={() => eng.current?.removeSelected()}>remove</Btn>
          <Btn active={tone} onClick={toggleTone}>♪ tone</Btn>
          <Btn active={drift} onClick={() => { setDrift(!drift); if (eng.current) eng.current.drift = !drift; }}>drift</Btn>
          <Btn onClick={() => canvasRef.current && downloadPNG(canvasRef.current, 'harmonic-garden')}>Save image</Btn>
        </Group>
        <Spacer />
      </Bar>
      <div className="note">
        <b>How it plays:</b> drag sources — the whole field re-organises live. Select a ring, then tune{' '}
        <b>freq / amp / phase</b>. <b>Contours</b> draws the map, <b>Interference</b> the glowing landscape,{' '}
        <b>Filament</b> the nodal threads. Seeds morph smoothly — nothing jumps. <b>Drift</b> lets sources wander
        faintly on simplex noise; the ♪ tone hums the selected source through a lowpass filter.
      </div>
    </>
  );
}
