import { useEffect, useRef, useState } from 'react';
import { TAU, clamp, lerp, downloadPNG, downloadText } from '../lib/utils';
import { fitCanvas } from '../lib/gl';
import { getSettings } from '../lib/settings';
import { useRafLoop, useResize } from '../lib/hooks';
import { setDock } from '../lib/dock';
import { Bar, Group, Pill, Btn, Dots, Slider, Spacer } from '../ui/chrome';

export const WEAVER_META = {
  n: 3, id: 'weaver', name: 'Wavelength Weaver', one: 'Draw with frequency and phase.',
  c1: '#ffb35c', c2: '#ff5fa2',
  about: 'A pen driven by two oscillators. Pick a ratio, turn the phase dial — circles grow into petals, knots and lace. Trails never clear unless you say so.',
};

/* ------------------------------------------------------------------ */

const COLORS = ['#46e0d2', '#7c6bff', '#ff5fa2', '#ffb35c', '#e8eaf0', '#8dff7a'];
const RATIOS: Array<[number, number]> = [[1, 1], [2, 1], [3, 1], [3, 2], [4, 3], [5, 4], [5, 3]];
const OVERTURE: Array<[number, number, number]> = [
  [1, 1, 1.57], [2, 1, 0.2], [3, 2, 0.78], [5, 4, 0.5], [4, 3, 1.2], [3, 1, 0.3],
];

interface Take { t: number; fx: number; fy: number; ph: number }

class WeaverEngine {
  live: HTMLCanvasElement;
  lx: CanvasRenderingContext2D;
  trail: HTMLCanvasElement;
  tx: CanvasRenderingContext2D;
  W = 2; H = 2;
  cur = { fx: 2, fy: 1, ph: 0, speed: 0.9 };
  tgt = { fx: 2, fy: 1, ph: 0, speed: 0.9 };
  tt = 0;
  dead = false;
  paused = false;
  persistence = 0.985;
  layer2 = false;
  showGrid = false;
  color = COLORS[0];
  overture = true;
  ovIdx = 0;
  ovT = 0;
  recording = false;
  take: Take[] = [];
  recT = 0;
  replaying = false;
  replayTake: Take[] = [];
  replayT = 0;
  onOvertureEnd: () => void = () => {};

  constructor(live: HTMLCanvasElement) {
    this.live = live;
    const lx = live.getContext('2d');
    const tx = document.createElement('canvas').getContext('2d');
    if (!lx || !tx) throw new Error('no 2d');
    this.lx = lx;
    this.trail = tx.canvas;
    this.tx = tx;
  }

  resize(w: number, h: number) {
    const r = fitCanvas(this.live, { clientWidth: Math.max(2, w), clientHeight: Math.max(2, h) }, 1.75);
    if (this.trail.width !== r.W || this.trail.height !== r.H) {
      const o = document.createElement('canvas');
      o.width = this.trail.width || 2; o.height = this.trail.height || 2;
      try { if (this.trail.width > 2) o.getContext('2d')!.drawImage(this.trail, 0, 0); } catch { /* noop */ }
      this.trail.width = r.W; this.trail.height = r.H;
      try { this.tx.drawImage(o, 0, 0, r.W, r.H); } catch { /* noop */ }
    }
    this.W = r.W; this.H = r.H;
  }

  pt(t: number, fx: number, fy: number, ph: number, layer: boolean): [number, number] {
    const cx = this.W / 2, cy = this.H / 2, R = Math.min(this.W, this.H) * 0.36;
    let x = cx + R * Math.sin(fx * t + (layer ? 0.9 : 0));
    let y = cy + R * 0.92 * Math.sin(fy * t + ph + (layer ? 1.7 : 0));
    x += Math.sin(fx * t * 2.02 + ph * 0.5) * R * (layer ? 0.05 : 0.035);
    y += Math.cos(fy * t * 2.03) * R * (layer ? 0.05 : 0.035);
    return [x, y];
  }

  userTouch() {
    if (this.overture) { this.overture = false; this.onOvertureEnd(); }
    if (this.replaying) this.replaying = false;
  }

  step(dt: number, reduced: boolean) {
    if (this.dead || this.paused) { if (!this.dead) this.drawLive(); return; }
    if (this.overture && !reduced) {
      this.ovT += dt;
      if (this.ovT > 2.6) {
        this.ovT = 0;
        this.ovIdx++;
        if (this.ovIdx >= OVERTURE.length) { this.overture = false; this.onOvertureEnd(); }
        else { const [fx, fy, ph] = OVERTURE[this.ovIdx]; this.tgt.fx = fx; this.tgt.fy = fy; this.tgt.ph = ph; }
      }
    }
    if (this.replaying && this.replayTake.length > 1) {
      this.replayT += dt;
      const dur = this.replayTake[this.replayTake.length - 1].t;
      const rt = this.replayT % dur;
      const tk = this.replayTake;
      let i = 0;
      while (i < tk.length - 2 && tk[i + 1].t < rt) i++;
      const a = tk[i], b = tk[i + 1];
      const k = clamp((rt - a.t) / Math.max(1e-4, b.t - a.t), 0, 1);
      this.tgt.fx = lerp(a.fx, b.fx, k);
      this.tgt.fy = lerp(a.fy, b.fy, k);
      this.tgt.ph = lerp(a.ph, b.ph, k);
    }
    if (this.recording) {
      this.recT += dt;
      const last = this.take[this.take.length - 1];
      if (!last || this.recT - last.t > 1 / 30) {
        this.take.push({ t: this.recT, fx: this.tgt.fx, fy: this.tgt.fy, ph: this.tgt.ph });
        if (this.take.length > 3600) this.take.shift();
      }
    }
    const k = 1 - Math.pow(0.0018, dt);
    this.cur.fx = lerp(this.cur.fx, this.tgt.fx, k);
    this.cur.fy = lerp(this.cur.fy, this.tgt.fy, k);
    let dph = this.tgt.ph - this.cur.ph;
    dph = Math.atan2(Math.sin(dph), Math.cos(dph));
    this.cur.ph += dph * k;
    this.cur.speed = lerp(this.cur.speed, this.tgt.speed, k);
    this.tt += dt * 2.1 * this.cur.speed * (reduced ? 0.5 : 1);

    const tx = this.tx;
    tx.save();
    tx.globalCompositeOperation = 'destination-out';
    tx.fillStyle = `rgba(0,0,0,${((1 - this.persistence) * dt * 60 * 0.12).toFixed(4)})`;
    tx.fillRect(0, 0, this.W, this.H);
    tx.restore();

    const span = dt * 2.1 * this.cur.speed;
    const steps = Math.max(2, Math.round(dt * 240));
    for (let i = 0; i < steps; i++) {
      const t0 = this.tt - span + (span * i) / steps;
      const t1 = this.tt - span + (span * (i + 1)) / steps;
      this.strokeSeg(
        this.pt(t0, this.cur.fx, this.cur.fy, this.cur.ph, false),
        this.pt(t1, this.cur.fx, this.cur.fy, this.cur.ph, false),
        this.color, 2.1,
      );
      if (this.layer2) {
        this.strokeSeg(
          this.pt(t0, this.cur.fx * 1.5, this.cur.fy, this.cur.ph + 1, true),
          this.pt(t1, this.cur.fx * 1.5, this.cur.fy, this.cur.ph + 1, true),
          '#ff5fa2', 1.6,
        );
      }
    }
    this.drawLive();
  }

  strokeSeg(a: [number, number], b: [number, number], col: string, w: number) {
    const c = this.tx;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    c.save();
    c.strokeStyle = col; c.lineCap = 'round'; c.lineJoin = 'round';
    c.shadowColor = col; c.shadowBlur = 8 * dpr;
    c.globalAlpha = 0.92; c.lineWidth = w * dpr;
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    c.shadowBlur = 0; c.globalAlpha = 0.5; c.strokeStyle = '#ffffff'; c.lineWidth = 0.7 * dpr;
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    c.restore();
  }

  drawLive() {
    const { lx: c, W, H } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    c.clearRect(0, 0, W, H);
    const bg = c.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, '#0b0f1c'); bg.addColorStop(1, '#04050a');
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    if (this.showGrid) {
      c.save();
      c.strokeStyle = 'rgba(140,160,200,0.14)'; c.lineWidth = 1;
      const s = Math.min(W, H) / 8;
      for (let x = W / 2 - s * 4; x < W / 2 + s * 4; x += s) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
      for (let y = H / 2 - s * 4; y < H / 2 + s * 4; y += s) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
      c.restore();
    }
    c.drawImage(this.trail, 0, 0);
    const p = this.pt(this.tt, this.cur.fx, this.cur.fy, this.cur.ph, false);
    c.save();
    c.globalCompositeOperation = 'lighter';
    const g = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], 16 * dpr);
    g.addColorStop(0, '#fff'); g.addColorStop(0.3, this.color); g.addColorStop(1, this.color + '00');
    c.fillStyle = g;
    c.beginPath(); c.arc(p[0], p[1], 16 * dpr, 0, TAU); c.fill();
    c.fillStyle = '#fff';
    c.beginPath(); c.arc(p[0], p[1], 2.4 * dpr, 0, TAU); c.fill();
    c.restore();
    const fxr = Math.round(this.cur.fx * 2) / 2, fyr = Math.round(this.cur.fy * 2) / 2;
    c.fillStyle = 'rgba(230,236,248,0.75)';
    c.font = `700 ${11 * dpr}px Inter,sans-serif`;
    c.fillText(`${fxr} : ${fyr}   φ ${(((this.cur.ph % TAU) + TAU) % TAU).toFixed(2)}${this.replaying ? '   ▶ replay' : ''}${this.recording ? '   ● rec' : ''}`, 12 * dpr, 22 * dpr);
  }

  exportSVG(): string {
    // trace the recent path of the primary pen into a vector polyline
    const pts: string[] = [];
    const N = 1600;
    const t1 = this.tt, t0 = this.tt - 9;
    for (let i = 0; i <= N; i++) {
      const t = t0 + ((t1 - t0) * i) / N;
      const [x, y] = this.pt(t, this.cur.fx, this.cur.fy, this.cur.ph, false);
      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.W} ${this.H}" width="${this.W}" height="${this.H}"><rect width="100%" height="100%" fill="#04050a"/><path d="${pts.join(' ')}" fill="none" stroke="${this.color}" stroke-width="${(2.1 * Math.min(window.devicePixelRatio || 1, 1.75)).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
}

/* ------------------------------------------------------------------ */

function fmtRatio(v: number) {
  const r = Math.round(v * 2) / 2;
  return Math.abs(r - Math.round(r)) < 0.01 ? String(Math.round(r)) : r.toFixed(1);
}

export default function Weaver() {
  const stageRef = useResize<HTMLDivElement>((w, h) => eng.current?.resize(w, h));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const eng = useRef<WeaverEngine | null>(null);
  const [ratio, setRatio] = useState<[number, number]>([2, 1]);
  const [phase, setPhase] = useState(0);
  const [speed, setSpeed] = useState(0.9);
  const [color, setColor] = useState(0);
  const [fade, setFade] = useState(0.985);
  const [layer, setLayer] = useState(false);
  const [grid, setGrid] = useState(false);
  const [paused, setPaused] = useState(false);
  const [overture, setOverture] = useState(true);
  const [recording, setRecording] = useState(false);
  const [hasTake, setHasTake] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [hintGone, setHintGone] = useState(false);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const e = new WeaverEngine(cv);
    eng.current = e;
    e.resize(cv.parentElement!.clientWidth, cv.parentElement!.clientHeight);
    e.onOvertureEnd = () => { setOverture(false); setRatio([e.tgt.fx, e.tgt.fy]); setPhase(norm(e.tgt.ph)); };
    const hint = setTimeout(() => setHintGone(true), 9000);
    setDock({
      toggle: () => togglePause(),
      clear: () => e.tx.clearRect(0, 0, e.W, e.H),
      export: () => exportPNG(),
    });
    const sync = setInterval(() => {
      if (e.overture || e.replaying) {
        setRatio([e.tgt.fx, e.tgt.fy]);
        setPhase(norm(e.tgt.ph));
      }
    }, 300);
    return () => {
      clearTimeout(hint); clearInterval(sync);
      e.dead = true;
      eng.current = null;
      setDock({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRafLoop(true, (dt) => eng.current?.step(dt, getSettings().reduced));

  function norm(p: number) { return ((p % TAU) + TAU) % TAU; }

  function touch() {
    eng.current?.userTouch();
    setOverture(false);
    setReplaying(false);
    setHintGone(true);
  }

  function setR(fx: number, fy: number) {
    touch();
    setRatio([fx, fy]);
    if (eng.current) { eng.current.tgt.fx = fx; eng.current.tgt.fy = fy; }
  }

  function setP(p: number) {
    touch();
    setPhase(p);
    if (eng.current) eng.current.tgt.ph = p;
  }

  function togglePause() {
    const e = eng.current;
    if (!e) return;
    e.paused = !e.paused;
    setPaused(e.paused);
  }

  function exportPNG() {
    const e = eng.current;
    const cv = canvasRef.current;
    if (!e || !cv) return;
    const o = document.createElement('canvas');
    o.width = e.W; o.height = e.H;
    const c = o.getContext('2d')!;
    c.fillStyle = '#04050a'; c.fillRect(0, 0, e.W, e.H);
    c.drawImage(e.trail, 0, 0);
    downloadPNG(o, 'wavelength-weaver');
    void cv;
  }

  function toggleRec() {
    const e = eng.current;
    if (!e) return;
    touch();
    if (e.recording) {
      e.recording = false;
      setRecording(false);
      setHasTake(e.take.length > 10);
    } else {
      e.take = [];
      e.recT = 0;
      e.recording = true;
      setRecording(true);
    }
  }

  function toggleReplay() {
    const e = eng.current;
    if (!e || e.take.length < 10) return;
    touch();
    e.replayTake = e.take.map((t) => ({ ...t }));
    e.replayT = 0;
    e.replaying = true;
    setReplaying(true);
  }

  return (
    <>
      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} className="art" style={{ cursor: 'default' }} />
        <div className={`hint${hintGone ? ' gone' : ''}`}>{overture ? 'Overture playing — touch any control to take over' : 'Change the ratio, turn phase — trails keep the journey'}</div>
      </div>
      <Bar>
        <Group label="Ratio">
          {RATIOS.map(([a, b]) => (
            <Pill key={`${a}:${b}`} active={Math.abs(ratio[0] - a) < 0.05 && Math.abs(ratio[1] - b) < 0.05} onClick={() => setR(a, b)}>
              {a}:{b}
            </Pill>
          ))}
        </Group>
        <Group>
          <Slider label="phase" value={phase} min={0} max={6.28} step={0.01} onChange={setP} />
          <Slider label="speed" value={speed} min={0.15} max={2} step={0.01} width={80} onChange={(v) => { touch(); setSpeed(v); if (eng.current) eng.current.tgt.speed = v; }} />
        </Group>
        <Group label="Ink">
          <Dots colors={COLORS} index={color} onPick={(i) => { touch(); setColor(i); if (eng.current) eng.current.color = COLORS[i]; }} />
          <Slider label="fade" value={fade} min={0.94} max={0.999} step={0.001} width={80} format={(v) => fmtRatio(v * 1000 / 10)} onChange={(v) => { setFade(v); if (eng.current) eng.current.persistence = v; }} />
        </Group>
        <Group>
          <Pill active={layer} onClick={() => { touch(); setLayer(!layer); if (eng.current) eng.current.layer2 = !layer; }}>{layer ? '◆ layer' : '◇ layer'}</Pill>
          <Pill active={grid} onClick={() => { setGrid(!grid); if (eng.current) eng.current.showGrid = !grid; }}>grid</Pill>
          <Btn onClick={() => { touch(); const r = RATIOS[(Math.random() * RATIOS.length) | 0]; setR(r[0], r[1]); setP(Math.random() * TAU); }}>New variation</Btn>
          <Btn active={recording} onClick={toggleRec} title="Record your parameter gestures, then replay them">{recording ? '● stop' : '○ rec'}</Btn>
          <Btn active={replaying} onClick={() => { if (replaying) { if (eng.current) eng.current.replaying = false; setReplaying(false); } else toggleReplay(); }} title="Replay the recorded gesture">▶ replay</Btn>
          <Btn active={paused} onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</Btn>
          <Btn warn onClick={() => eng.current?.tx.clearRect(0, 0, eng.current.W, eng.current.H)}>Clear</Btn>
          <Btn onClick={exportPNG}>PNG</Btn>
          <Btn onClick={() => eng.current && downloadText(eng.current.exportSVG(), 'wavelength-weaver.svg')}>SVG</Btn>
        </Group>
        <Spacer />
      </Bar>
      <div className="note">
        <b>How it plays:</b> the pen never stops. <b>Ratio</b> sets the harmony (3:2 petals, 4:3 knots),{' '}
        <b>phase</b> turns the form inside-out — changes morph live while old trails persist, so you paint time.
        An <b>overture</b> performs on entry until you take over. <b>Rec</b> captures your gesture, <b>replay</b>{' '}
        performs it back. <b>SVG</b> exports a true vector tracing of the curve.
      </div>
    </>
  );
}
