import { useEffect, useRef, useState } from 'react';
import { TAU, clamp, downloadPNG } from '../lib/utils';
import { fitCanvas } from '../lib/gl';
import { useRafLoop, useResize } from '../lib/hooks';
import { setDock } from '../lib/dock';
import { Bar, Group, Pill, Btn, Slider, Spacer } from '../ui/chrome';

export const MOIRE_META = {
  n: 4, id: 'moire', name: 'Shadow Moiré', one: 'Make images out of alignment.',
  c1: '#e8eaf0', c2: '#46e0d2',
  about: 'Two transparent plates, nothing more. Slide and rotate them — the image neither plate contains appears only in the overlap. Capture prints you love.',
};

/* ------------------------------------------------------------------ */

const PATTERNS = ['lines', 'dots', 'rings', 'radial', 'waves', 'checker'] as const;
type PatternType = (typeof PATTERNS)[number];
type Blend = 'screen' | 'multiply' | 'difference';
const INKS_LAB = ['#e8f4ff', '#46e0d2', '#7c6bff', '#ff5fa2', '#ffb35c'];
const INKS_PRINT = ['#1c1a17', '#4a3f33', '#8a2b2b', '#1f4d5a', '#2b3a8a'];

interface Plate {
  type: PatternType; x: number; y: number; rot: number; scale: number;
  spacing: number; lineW: number; color: string; opacity: number;
  tile: HTMLCanvasElement | null;
  vx: number; vy: number; omega: number;
}

function freshPlate(type: PatternType, color: string): Plate {
  return { type, x: 0.5, y: 0.5, rot: 0, scale: 1, spacing: 26, lineW: 2.4, color, opacity: 0.92, tile: null, vx: 0, vy: 0, omega: 0 };
}

const TILE = 768;

function makeTile(p: Plate): HTMLCanvasElement {
  const t = document.createElement('canvas');
  t.width = t.height = TILE;
  const c = t.getContext('2d')!;
  c.clearRect(0, 0, TILE, TILE);
  c.strokeStyle = p.color; c.fillStyle = p.color;
  const dpr = 1;
  c.lineWidth = p.lineW * dpr;
  const sp = p.spacing * dpr;
  if (p.type === 'lines') {
    for (let x = -TILE; x < TILE * 2; x += sp) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, TILE); c.stroke(); }
  } else if (p.type === 'dots') {
    for (let y = sp / 2; y < TILE; y += sp) for (let x = sp / 2; x < TILE; x += sp) {
      c.beginPath(); c.arc(x, y, p.lineW * 0.9, 0, TAU); c.fill();
    }
  } else if (p.type === 'rings') {
    c.save(); c.translate(TILE / 2, TILE / 2);
    for (let r = sp / 2; r < TILE; r += sp) { c.beginPath(); c.arc(0, 0, r, 0, TAU); c.stroke(); }
    c.restore();
  } else if (p.type === 'radial') {
    c.save(); c.translate(TILE / 2, TILE / 2);
    const n = Math.round((TILE / sp) * 2.2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * TILE, Math.sin(a) * TILE); c.stroke();
    }
    c.restore();
  } else if (p.type === 'waves') {
    for (let y = 0; y < TILE; y += sp) {
      c.beginPath();
      for (let x = 0; x <= TILE; x += 6) {
        const yy = y + Math.sin((x / TILE) * TAU * 2) * sp * 0.28;
        if (x) c.lineTo(x, yy); else c.moveTo(x, yy);
      }
      c.stroke();
    }
  } else {
    const n = Math.max(4, Math.round(TILE / sp));
    const s = TILE / n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if ((i + j) % 2 === 0) c.fillRect(i * s, j * s, s, s);
  }
  return t;
}

class MoireEngine {
  cv: HTMLCanvasElement;
  cx: CanvasRenderingContext2D;
  stage: HTMLElement;
  bake: HTMLCanvasElement;
  bx: CanvasRenderingContext2D;
  A = freshPlate('lines', INKS_LAB[0]);
  B = freshPlate('radial', INKS_LAB[1]);
  W = 2; H = 2;
  dead = false;
  theme: 'lab' | 'print' = 'lab';
  blend: Blend = 'screen';
  undo: string[] = [];
  handles: HTMLDivElement[] = [];
  dragP: Plate | null = null;
  lastM = { x: 0, y: 0 };
  lastT = 0;
  onCapture: (thumb: string, full: string) => void = () => {};

  constructor(cv: HTMLCanvasElement, stage: HTMLElement) {
    this.cv = cv;
    this.stage = stage;
    const cx = cv.getContext('2d');
    const bx = document.createElement('canvas').getContext('2d');
    if (!cx || !bx) throw new Error('no 2d');
    this.cx = cx;
    this.bake = bx.canvas;
    this.bx = bx;
    this.A.x = 0.42; this.B.x = 0.6; this.B.rot = 0.35;
    // rotation handles
    for (const [plate] of [[this.A], [this.B]] as Array<[Plate]>) {
      const h = document.createElement('div');
      h.className = 'moireHandle';
      h.innerHTML = '<div class="rot" title="drag to rotate">◍</div>';
      stage.appendChild(h);
      this.handles.push(h);
      const ring = h.firstChild as HTMLDivElement;
      let angVel = 0, lastA = 0;
      ring.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        ring.setPointerCapture(ev.pointerId);
        ring.dataset.d = '1';
        this.pushUndo();
        const r = stage.getBoundingClientRect();
        lastA = Math.atan2(ev.clientY - (r.top + plate.y * r.height), ev.clientX - (r.left + plate.x * r.width));
        angVel = 0;
      });
      ring.addEventListener('pointermove', (ev) => {
        if (ring.dataset.d !== '1') return;
        const r = stage.getBoundingClientRect();
        const a = Math.atan2(ev.clientY - (r.top + plate.y * r.height), ev.clientX - (r.left + plate.x * r.width));
        let d = a - lastA;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        lastA = a;
        const now = performance.now();
        const dt = Math.max(8, now - this.lastT) / 1000;
        this.lastT = now;
        plate.rot += d;
        angVel = angVel * 0.7 + (d / dt) * 0.3;
        plate.omega = 0;
      });
      const up = () => { delete ring.dataset.d; plate.omega = clamp(angVel, -9, 9); };
      ring.addEventListener('pointerup', up);
      ring.addEventListener('pointercancel', up);
    }
    cv.addEventListener('pointerdown', (ev) => {
      cv.setPointerCapture(ev.pointerId);
      const r = stage.getBoundingClientRect();
      const mx = (ev.clientX - r.left) / r.width, my = (ev.clientY - r.top) / r.height;
      const dA = Math.hypot(mx - this.A.x, my - this.A.y);
      const dB = Math.hypot(mx - this.B.x, my - this.B.y);
      this.dragP = dA < dB ? this.A : this.B;
      this.dragP.vx = this.dragP.vy = 0;
      this.lastM = { x: mx, y: my };
      this.lastT = performance.now();
      this.pushUndo();
    });
    cv.addEventListener('pointermove', (ev) => {
      if (!this.dragP) return;
      const r = stage.getBoundingClientRect();
      const mx = (ev.clientX - r.left) / r.width, my = (ev.clientY - r.top) / r.height;
      const now = performance.now();
      const dt = Math.max(8, now - this.lastT) / 1000;
      const dx = mx - this.lastM.x, dy = my - this.lastM.y;
      this.dragP.x = clamp(this.dragP.x + dx, -0.2, 1.2);
      this.dragP.y = clamp(this.dragP.y + dy, -0.2, 1.2);
      this.dragP.vx = this.dragP.vx * 0.6 + (dx / dt) * 0.4;
      this.dragP.vy = this.dragP.vy * 0.6 + (dy / dt) * 0.4;
      this.lastM = { x: mx, y: my };
      this.lastT = now;
    });
    const stop = () => { this.dragP = null; };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = stage.getBoundingClientRect();
      const mx = (ev.clientX - r.left) / r.width, my = (ev.clientY - r.top) / r.height;
      const p = Math.hypot(mx - this.A.x, my - this.A.y) < Math.hypot(mx - this.B.x, my - this.B.y) ? this.A : this.B;
      p.scale = clamp(p.scale * (ev.deltaY < 0 ? 1.06 : 0.94), 0.4, 2.4);
    }, { passive: false });
  }

  pushUndo() {
    const snap = (p: Plate) => ({ ...p, tile: undefined, vx: 0, vy: 0, omega: 0 });
    this.undo.push(JSON.stringify([snap(this.A), snap(this.B), this.theme, this.blend]));
    if (this.undo.length > 24) this.undo.shift();
  }

  popUndo(): { theme: string; blend: Blend } | null {
    const s = this.undo.pop();
    if (!s) return null;
    const [a, b, theme, blend] = JSON.parse(s);
    Object.assign(this.A, a, { tile: null });
    Object.assign(this.B, b, { tile: null });
    this.theme = theme;
    this.blend = blend;
    return { theme, blend };
  }

  resize(w: number, h: number) {
    const r = fitCanvas(this.cv, { clientWidth: Math.max(2, w), clientHeight: Math.max(2, h) }, 1.75);
    this.W = r.W; this.H = r.H;
    if (this.bake.width !== r.W || this.bake.height !== r.H) {
      let old: HTMLCanvasElement | null = null;
      if (this.bake.width > 2) {
        old = document.createElement('canvas');
        old.width = this.bake.width; old.height = this.bake.height;
        try { old.getContext('2d')!.drawImage(this.bake, 0, 0); } catch { old = null; }
      }
      this.bake.width = r.W; this.bake.height = r.H;
      if (old) { try { this.bx.drawImage(old, 0, 0, r.W, r.H); } catch { /* noop */ } }
    }
  }

  drawPlate(p: Plate) {
    if (!p.tile) p.tile = makeTile(p);
    const { cx, W, H } = this;
    cx.save();
    cx.translate(p.x * W, p.y * H);
    cx.rotate(p.rot);
    cx.scale(p.scale, p.scale);
    cx.globalAlpha = p.opacity;
    cx.globalCompositeOperation = this.blend;
    const S = Math.max(W, H) * 1.6;
    cx.translate(-S / 2, -S / 2);
    cx.fillStyle = cx.createPattern(p.tile, 'repeat')!;
    cx.fillRect(0, 0, S, S);
    cx.restore();
  }

  step(dt: number) {
    if (this.dead) return;
    // inertia
    for (const p of [this.A, this.B]) {
      if (p !== this.dragP && (Math.abs(p.vx) > 0.001 || Math.abs(p.vy) > 0.001)) {
        p.x = clamp(p.x + p.vx * dt, -0.2, 1.2);
        p.y = clamp(p.y + p.vy * dt, -0.2, 1.2);
        const d = Math.exp(-3 * dt);
        p.vx *= d; p.vy *= d;
      }
      if (Math.abs(p.omega) > 0.01) {
        p.rot += p.omega * dt;
        p.omega *= Math.exp(-2.5 * dt);
      }
    }
    const { cx, W, H } = this;
    cx.globalCompositeOperation = 'source-over';
    cx.globalAlpha = 1;
    if (this.theme === 'lab') {
      const g = cx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, '#0a0e1a'); g.addColorStop(1, '#030408');
      cx.fillStyle = g; cx.fillRect(0, 0, W, H);
    } else {
      cx.fillStyle = '#f1e9d6'; cx.fillRect(0, 0, W, H);
    }
    cx.drawImage(this.bake, 0, 0);
    this.drawPlate(this.A);
    this.drawPlate(this.B);
    // handles
    const r = this.stage.getBoundingClientRect();
    [[this.A, this.handles[0]], [this.B, this.handles[1]]].forEach(([p, h]) => {
      const pl = p as Plate, hh = h as HTMLDivElement;
      const off = 92;
      hh.style.left = `${(pl.x * r.width + Math.cos(pl.rot + Math.PI / 2) * off).toFixed(1)}px`;
      hh.style.top = `${(pl.y * r.height + Math.sin(pl.rot + Math.PI / 2) * off).toFixed(1)}px`;
    });
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    cx.globalCompositeOperation = 'source-over';
    cx.globalAlpha = 1;
    cx.fillStyle = this.theme === 'lab' ? 'rgba(230,236,248,0.7)' : 'rgba(60,45,30,0.7)';
    cx.font = `700 ${11 * dpr}px Inter,sans-serif`;
    cx.fillText(`A ${this.A.type} · ${(this.A.rot * 57.3).toFixed(0)}°      B ${this.B.type} · ${(this.B.rot * 57.3).toFixed(0)}°`, 12 * dpr, 22 * dpr);
  }

  capture() {
    this.bx.drawImage(this.cv, 0, 0);
    const full = this.cv.toDataURL('image/png');
    const t = document.createElement('canvas');
    t.width = 168; t.height = Math.max(2, Math.round((168 * this.H) / this.W));
    t.getContext('2d')!.drawImage(this.cv, 0, 0, t.width, t.height);
    this.onCapture(t.toDataURL(), full);
  }

  dispose() {
    this.dead = true;
    for (const h of this.handles) h.remove();
  }
}

/* ------------------------------------------------------------------ */

interface Print { thumb: string; full: string }

export default function Moire() {
  const stageRef = useResize<HTMLDivElement>((w, h) => eng.current?.resize(w, h));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const eng = useRef<MoireEngine | null>(null);
  const [patA, setPatA] = useState<PatternType>('lines');
  const [patB, setPatB] = useState<PatternType>('radial');
  const [spA, setSpA] = useState(26);
  const [spB, setSpB] = useState(26);
  const [inkA, setInkA] = useState(0);
  const [inkB, setInkB] = useState(1);
  const [theme, setTheme] = useState<'lab' | 'print'>('lab');
  const [blend, setBlend] = useState<Blend>('screen');
  const [prints, setPrints] = useState<Print[]>([]);
  const [hintGone, setHintGone] = useState(false);
  const inks = theme === 'lab' ? INKS_LAB : INKS_PRINT;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const e = new MoireEngine(cv, cv.parentElement!);
    eng.current = e;
    e.resize(cv.parentElement!.clientWidth, cv.parentElement!.clientHeight);
    e.onCapture = (thumb, full) => setPrints((p) => [{ thumb, full }, ...p].slice(0, 6));
    const hint = setTimeout(() => setHintGone(true), 9000);
    setDock({
      clear: () => clearAll(),
      export: () => downloadPNG(cv, 'shadow-moire'),
    });
    return () => {
      clearTimeout(hint);
      e.dispose();
      eng.current = null;
      setDock({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRafLoop(true, (dt) => eng.current?.step(dt));

  function clearAll() {
    const e = eng.current;
    if (!e) return;
    e.pushUndo();
    e.bx.clearRect(0, 0, e.W, e.H);
    e.A.x = 0.42; e.A.y = 0.5; e.A.rot = 0;
    e.B.x = 0.6; e.B.y = 0.5; e.B.rot = 0.35;
  }

  function setPlate(which: 'A' | 'B', patch: Partial<Plate>) {
    const e = eng.current;
    if (!e) return;
    Object.assign(which === 'A' ? e.A : e.B, patch, { tile: null });
  }

  function undo() {
    const r = eng.current?.popUndo();
    if (!r) return;
    setTheme(eng.current!.theme);
    setBlend(eng.current!.blend);
    const e = eng.current!;
    setPatA(e.A.type); setPatB(e.B.type);
    setSpA(e.A.spacing); setSpB(e.B.spacing);
    setInkA(Math.max(0, inks.indexOf(e.A.color)));
    setInkB(Math.max(0, inks.indexOf(e.B.color)));
  }

  function switchTheme(t: 'lab' | 'print') {
    const e = eng.current;
    setTheme(t);
    if (!e) return;
    e.pushUndo();
    e.theme = t;
    const inks2 = t === 'lab' ? INKS_LAB : INKS_PRINT;
    e.A.color = inks2[0]; e.B.color = inks2[1];
    e.A.tile = e.B.tile = null;
    setInkA(0); setInkB(1);
    if (t === 'print' && e.blend === 'screen') { e.blend = 'multiply'; setBlend('multiply'); }
    if (t === 'lab' && e.blend === 'multiply') { e.blend = 'screen'; setBlend('screen'); }
  }

  function plateGroup(which: 'A' | 'B') {
    const pat = which === 'A' ? patA : patB;
    const setPat = which === 'A' ? setPatA : setPatB;
    const sp = which === 'A' ? spA : spB;
    const ink = which === 'A' ? inkA : inkB;
    return (
      <Group label={`Plate ${which}`}>
        <select
          className="btn"
          value={pat}
          onChange={(e) => { setPat(e.target.value as PatternType); setPlate(which, { type: e.target.value as PatternType }); }}
        >
          {PATTERNS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <Slider label="gap" value={sp} min={10} max={64} step={1} width={70} format={(v) => v.toFixed(0)} onChange={(v) => {
          if (which === 'A') setSpA(v); else setSpB(v);
          setPlate(which, { spacing: v });
        }} />
        <span className="dots">
          {inks.map((c, i) => (
            <button
              key={c} className={`dot${(which === 'A' ? inkA : inkB) === i ? ' on' : ''}`}
              style={{ background: c, width: 18, height: 18 }}
              onClick={() => { if (which === 'A') setInkA(i); else setInkB(i); setPlate(which, { color: c }); }}
            />
          ))}
        </span>
        <span style={{ display: 'none' }}>{ink}</span>
      </Group>
    );
  }

  return (
    <>
      <div className="stage" ref={stageRef} onPointerDown={() => setHintGone(true)}>
        <canvas ref={canvasRef} className="art" style={{ cursor: 'move' }} />
        <div className={`hint${hintGone ? ' gone' : ''}`}>Drag a plate to slide it · drag its ◍ handle to rotate · fling it</div>
      </div>
      <Bar>
        {plateGroup('A')}
        {plateGroup('B')}
        <Group label="Merge">
          {(['screen', 'multiply', 'difference'] as Blend[]).map((b) => (
            <Pill key={b} active={blend === b} onClick={() => { setBlend(b); if (eng.current) eng.current.blend = b; }}>{b}</Pill>
          ))}
        </Group>
        <Group>
          <Pill active={theme === 'lab'} onClick={() => switchTheme('lab')}>Lab</Pill>
          <Pill active={theme === 'print'} onClick={() => switchTheme('print')}>Print</Pill>
          <Btn onClick={() => eng.current?.capture()}>Capture print</Btn>
          <Btn onClick={undo}>Undo</Btn>
          <Btn warn onClick={clearAll}>Clear</Btn>
          <Btn onClick={() => canvasRef.current && downloadPNG(canvasRef.current, 'shadow-moire')}>Export</Btn>
        </Group>
        {prints.length > 0 && (
          <Group label="Prints">
            <span className="filmstrip">
              {prints.map((p, i) => (
                <img
                  key={i} src={p.thumb} title="click to download this print"
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = p.full; a.download = `moire-print-${i}.png`; a.click();
                  }}
                />
              ))}
            </span>
          </Group>
        )}
        <Spacer />
      </Bar>
      <div className="note">
        <b>How it plays:</b> each plate is real — <b>drag</b> to slide, <b>◍ ring</b> to rotate, <b>fling</b> for
        inertia, <b>wheel</b> to scale. <b>Merge</b> modes (screen / multiply / difference) reinvent the overlap.{' '}
        <b>Capture print</b> bakes the moment into the sheet and the filmstrip — keep remixing on top.
      </div>
    </>
  );
}
