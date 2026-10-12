import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { LabEngine } from './lab/engine';
import { AudioInput, type SourceKind } from './lab/audio';
import { PRESETS, presetThumb } from './lab/presets';
import { FREQ_MIN, FREQ_MAX } from './lab/resonance';
import { clamp, hexToRgb } from './lib/utils';

/**
 * CymaticsExperience — the single white-background Resonant Ink instrument.
 * Panels are thin; the dish is the product (spec §2/§4).
 */

const PALETTE = [
  { name: 'Deep blue', color: '#3b74e8' },
  { name: 'Cobalt', color: '#35a7e0' },
  { name: 'Violet', color: '#9b5be0' },
  { name: 'Magenta', color: '#ee7d90' },
  { name: 'Amber', color: '#eda54c' },
  { name: 'Pearl', color: '#dfe8ea' },
];
type Behavior = 'flow' | 'diffuse' | 'stick';
const BEHAVIOR: Record<Behavior, { gather: number; diffusion: number }> = {
  flow: { gather: 0.18, diffusion: 0.10 },
  diffuse: { gather: 0.15, diffusion: 0.5 },
  stick: { gather: 0.75, diffusion: 0.04 },
};

export default function Cymatics() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<LabEngine | null>(null);
  const audioRef = useRef<AudioInput>(new AudioInput());
  const fileElRef = useRef<HTMLAudioElement>(null);
  const freqLabelRef = useRef<HTMLOutputElement>(null);
  const recLabelRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef(0);
  const pausedRef = useRef(false);
  const freqRef = useRef(286);
  const ampRef = useRef(0.6);
  const respRef = useRef(0.5);
  const pointerDown = useRef(false);
  const lastPaint = useRef({ x: 0.5, y: 0.5 });
  const lastHover = useRef(0);
  const pigmentRef = useRef(PALETTE[0].color);
  const brushPx = 24;

  const [freq, setFreq] = useState(286);
  const [amplitude, setAmplitude] = useState(0.6);
  const [response, setResponse] = useState(0.5);
  const [source, setSource] = useState<SourceKind | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pigment, setPigment] = useState(PALETTE[0].color);
  const [behavior, setBehavior] = useState<Behavior>('flow');
  const [opts, setOpts] = useState({ reflections: true, caustics: true, depth: true, grain: false });
  const [nodal, setNodal] = useState(false);
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState('Strike the surface. Drag to pour pigment.');
  const [error, setError] = useState('');
  const [uiHidden, setUiHidden] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  void recSecs;
  const [tray, setTray] = useState<'none' | 'left' | 'right'>('none');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunks = useRef<Blob[]>([]);
  const recTimer = useRef(0);

  const thumbs = useMemo(() => PRESETS.map((p) => presetThumb(p)), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas) return;
    let engine: LabEngine | null = null;
    try {
      engine = new LabEngine(canvas);
      engineRef.current = engine;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The water surface could not start.');
      return () => { audio.dispose(); };
    }
    const ro = new ResizeObserver(() => engine?.resize());
    ro.observe(canvas);
    engine.resize();

    let last = performance.now();
    const frame = (now: number) => {
      if (!engine || engine.dead) return;
      rafRef.current = requestAnimationFrame(frame);
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      engine.noForce = new URLSearchParams(window.location.search).has('noforce');
      engine.noImp = new URLSearchParams(window.location.search).has('noimp');
      const a = audio.frame();
      // drive the simulation from the analysed input
      engine.drive.freq = a.freq;
      const resp = lerpN(0.45, 1.5, respRef.current);
      const base = audio.kind === 'tone' ? 0.5 : 0;
      engine.drive.level = Math.min(1, (base + a.level * resp) * ampRef.current * 1.6);
      if (a.transient && !pausedRef.current) {
        engine.strike(engine.pointer.x, engine.pointer.y, Math.min(1, a.level * 1.4));
      }
      if (!pausedRef.current) engine.step(dt);
      engine.render();
      if (freqLabelRef.current) {
        freqLabelRef.current.textContent = `${Math.round(freqRef.current)} Hz`;
      }
    };
    audioRef.current.onToneStart = () => {
      // first light: a wide, low-mass pigment scatter across the whole dish —
      // the surface flow then organises it into nodal line structures within
      // seconds (this is how the reference pattern becomes visible)
      const e = engineRef.current;
      if (!e || e.dyeStats().cells > 100) return;
      const blue = hexToRgb('#3b74e8');
      const violet = hexToRgb('#9b5be0');
      const amber = hexToRgb('#eda54c');
      for (let i = 0; i < 56; i++) {
        const a = Math.random() * Math.PI * 2;
        const rad = Math.pow(Math.random(), 0.7) * 0.42;
        const x = 0.5 + Math.cos(a) * rad;
        const y = 0.5 + Math.sin(a) * rad * 0.92;
        const c = x < 0.42 ? blue : x > 0.60 ? amber : violet;
        e.deposit(x, y, 0.04 + Math.random() * 0.022, 0.14 + Math.random() * 0.07, c);
      }
    };
    rafRef.current = requestAnimationFrame(frame);
    // TEMP-DEMO-START: self-clocking scripted verification, driven by engine time
    if (new URLSearchParams(window.location.search).has('demo')) {
      void audio.startTone(freqRef.current, ampRef.current).then(() => setSource('tone'));
      const colors = ['#2e5bd6', '#8a3fc9', '#e8707e', '#e09a3e', '#2e9bd6'];
      const w = window as unknown as { __demoNext: number; __demoN: number };
      w.__demoNext = 1.2; w.__demoN = 0;
      const demoDrive = (e: LabEngine) => {
        const n = w.__demoN;
        if (n < 5) {
          const s = PRESETS[5].pigment[n % PRESETS[5].pigment.length];
          e.deposit(s.x + (Math.random() - 0.5) * 0.04, s.y + (Math.random() - 0.5) * 0.04, s.r, s.a, hexToRgb(s.color));
        } else {
          const x = 0.30 + Math.random() * 0.4, y = 0.30 + Math.random() * 0.4;
          e.deposit(x, y, 0.06, 0.5, hexToRgb(colors[n % colors.length]));
          if (n % 4 === 1) e.strike(x, y, 0.85);
        }
        w.__demoN = n + 1;
        w.__demoNext = e.time + 0.45;
      };
      const origStep = engine.step.bind(engine);
      engine.step = (dt: number) => {
        if (engineRef.current && engineRef.current.time >= w.__demoNext && w.__demoN < 14) demoDrive(engineRef.current);
        origStep(dt);
      };
      const iv2 = window.setInterval(() => {
        const e3 = engineRef.current;
        if (!e3 || e3.dead) { window.clearInterval(iv2); return; }
        console.log('DYE-TICK', e3.time.toFixed(1), JSON.stringify(e3.dyeStats()), 'DEP', e3.debug.deposits);
      }, 2000);
      window.setTimeout(() => window.clearInterval(iv2), 13000);
    }
    // TEMP-DEMO-END
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.clearInterval(recTimer.current);
      ro.disconnect();
      engine?.dispose();
      engineRef.current = null;
      audio.dispose();
    };
  }, []);

  useEffect(() => { freqRef.current = freq; audioRef.current.setTone(freq, amplitude); }, [freq, amplitude]);
  useEffect(() => { ampRef.current = amplitude; }, [amplitude]);
  useEffect(() => { respRef.current = response; }, [response]);
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    const b = BEHAVIOR[behavior];
    e.gather = b.gather;
    e.diffusion = b.diffusion;
  }, [behavior]);
  useEffect(() => {
    const e = engineRef.current;
    if (e) e.opts = { ...opts, nodalMap: nodal };
  }, [opts, nodal]);
  useEffect(() => { pigmentRef.current = pigment; }, [pigment]);

  const pos = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    return { x: clamp((ev.clientX - r.left) / r.width, 0, 1), y: clamp((ev.clientY - r.top) / r.height, 0, 1) };
  };

  const onDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const e = engineRef.current;
    if (!e) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    pointerDown.current = true;
    const p = pos(ev);
    e.pointer = p;
    lastPaint.current = p;
    e.strike(p.x, p.y, 0.9);
    const r = ev.currentTarget.getBoundingClientRect();
    e.deposit(p.x, p.y, (2 * brushPx) / r.height, 0.5, hexToRgb(pigmentRef.current));
    setMessage('A strike sends a travelling wave. Drag to pour pigment into its current.');
  };

  const onMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const e = engineRef.current;
    if (!e) return;
    const p = pos(ev);
    const prev = lastPaint.current;
    const d = Math.hypot(p.x - prev.x, p.y - prev.y);
    e.pointer = p;
    if (pointerDown.current) {
      // continuous stroke: interpolate dabs so fast drags stay unbroken
      const steps = Math.max(1, Math.ceil(d / 0.012));
      const r = ev.currentTarget.getBoundingClientRect();
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        e.deposit(
          prev.x + (p.x - prev.x) * t, prev.y + (p.y - prev.y) * t,
          (2 * brushPx * 0.8) / r.height, 0.22, hexToRgb(pigmentRef.current),
        );
      }
      if (d > 0.02) e.strike(p.x, p.y, 0.18);
      lastPaint.current = p;
    } else if (ev.pointerType === 'mouse' && d > 0.05 && e.time - lastHover.current > 0.30) {
      // hover: very light disturbance only
      e.strike(p.x, p.y, 0.12);
      lastHover.current = e.time;
      lastPaint.current = p;
    }
  };

  const onUp = () => { pointerDown.current = false; };

  const togglePlay = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    setMessage(pausedRef.current ? 'Surface held. The figure and pigment are preserved.' : 'Surface released.');
  };

  const clear = () => {
    engineRef.current?.clearDye();
    setMessage('Cleared. The vessel keeps its resonance; pigment washes out.');
  };

  const saveImage = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const a = document.createElement('a');
    a.download = `resonant-ink-${Date.now().toString(36)}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
  };

  const applyPreset = (i: number) => {
    const e = engineRef.current;
    const p = PRESETS[i];
    if (!e || !p) return;
    setFreq(Math.round(p.freq));
    freqRef.current = p.freq;
    setBehavior(p.gather > 0.5 ? 'stick' : p.diffusion > 0.3 ? 'diffuse' : 'flow');
    e.gather = p.gather; e.diffusion = p.diffusion;
    e.clearDye();
    for (const s of p.pigment) e.deposit(s.x, s.y, s.r, s.a, hexToRgb(s.color));
    e.strike(0.5, 0.5, 0.5);
    setMessage(`${p.name} — the drive now sits on this resonance. Paint into it.`);
  };

  const pickSource = async (kind: SourceKind) => {
    const audio = audioRef.current;
    if (!audio) return;
    setError('');
    if (source === kind) { audio.stop(); setSource(null); setMessage('Input released. The surface settles.'); return; }
    try {
      if (kind === 'tone') {
        await audio.startTone(freqRef.current, amplitude);
        setSource('tone');
        setMessage('Tone driving. Slide the frequency — the figure snaps between resonances.');
      } else if (kind === 'mic') {
        const ok = await audio.startMic();
        if (ok) { setSource('mic'); setMessage('Listening. Claps make transients; sustained sound builds the mode. Mic is never played back.'); }
        else { setError(audio.lastError); setSource(null); }
      } else {
        fileRef.current?.click();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audio could not start.');
    }
  };

  const onFile = async (file?: File) => {
    const audio = audioRef.current;
    const el = fileElRef.current;
    if (!file || !audio || !el) return;
    setError('');
    const ok = await audio.startFile(file, el);
    if (ok) {
      setSource('file');
      setMessage(`Playing "${file.name}" — its spectrum drives the figure. Processed locally, never uploaded.`);
    } else {
      setError(audio.lastError);
      setSource(null);
    }
  };

  const toggleRecord = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = cv.captureStream(30);
      const mr = new MediaRecorder(stream);
      recChunks.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) recChunks.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(recChunks.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `resonant-ink-${Date.now().toString(36)}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setRecording(false);
      };
      mr.start(250);
      recorderRef.current = mr;
      setRecording(true);
      const t0 = Date.now();
      window.clearInterval(recTimer.current);
      recTimer.current = window.setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        if (recLabelRef.current) recLabelRef.current.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }, 500);
      setMessage('Recording the dish.');
    } catch {
      setError('Recording is not supported in this browser.');
    }
  };
  const stopRecord = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
    window.clearInterval(recTimer.current);
  };

  return (
    <main className="ink-app" data-ui={uiHidden ? 'hidden' : 'shown'}>
      <section className="dish-stage" aria-label="Resonant Ink cymatics dish">
        <canvas
          ref={canvasRef}
          className="dish-canvas"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onLostPointerCapture={onUp}
        />
      </section>

      <header className="ink-mark">
        <p className="ink-eyebrow">CYMATICS LAB</p>
        <h1 className="ink-title">Resonant Ink</h1>
      </header>

      <div className="ink-topright">
        <button className="quiet-btn" onClick={saveImage} title="Save study as PNG">Save</button>
        <button className="quiet-btn icon-only" onClick={toggleRecord} title={recording ? 'Stop recording' : 'Record the dish'}>
          {recording ? '■' : '○'}
          {recording && <span ref={recLabelRef} className="rec-time">00:00</span>}
        </button>
        <button className="quiet-btn icon-only" onClick={() => setUiHidden(!uiHidden)} title="Hide or show controls">☰</button>
      </div>

      {/* left rail — sound source + drive */}
      <aside className={`rail rail-left${uiHidden ? ' hidden' : ''}${tray === 'left' ? ' open' : ''}`} aria-label="Sound source and drive">
        <div className="rail-block">
          <span className="rail-label">Source</span>
          <div className="source-list">
            {(['tone', 'mic', 'file'] as SourceKind[]).map((k) => (
              <button
                key={k}
                className={`source-item${source === k ? ' selected' : ''}`}
                onClick={() => void pickSource(k)}
                aria-pressed={source === k}
              >
                <span className="source-icon">{k === 'tone' ? '∿' : k === 'mic' ? '⌁' : '↥'}</span>
                <span>{k === 'tone' ? 'Tone' : k === 'mic' ? 'Mic Input' : 'Audio File'}</span>
                <span className="chev">›</span>
              </button>
            ))}
            <input
              ref={fileRef} type="file" accept="audio/*" className="visually-hidden-file"
              onChange={(e) => { void onFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }}
            />
          </div>
        </div>
        <div className="rail-block">
          <div className="slider-row"><label htmlFor="fFreq">Frequency</label><output>{freq} Hz</output></div>
          <input
            id="fFreq" type="range" min={FREQ_MIN} max={FREQ_MAX} step={1} value={freq}
            onChange={(e) => setFreq(Number(e.target.value))}
          />
          <div className="slider-row"><label htmlFor="fAmp">Amplitude</label><output>{amplitude.toFixed(2)}</output></div>
          <input id="fAmp" type="range" min={0.05} max={1} step={0.01} value={amplitude}
            onChange={(e) => setAmplitude(Number(e.target.value))} />
          <div className="slider-row"><label htmlFor="fResp">Response</label><output>{['Slow', 'Medium', 'Fast'][Math.round(response * 2)] ?? 'Medium'}</output></div>
          <input id="fResp" type="range" min={0} max={1} step={0.5} value={response}
            onChange={(e) => setResponse(Number(e.target.value))} />
        </div>
      </aside>

      {/* right rail — pigment + appearance */}
      <aside className={`rail rail-right${uiHidden ? ' hidden' : ''}${tray === 'right' ? ' open' : ''}`} aria-label="Pigment and appearance">
        <div className="rail-block">
          <span className="rail-label">Color</span>
          <div className="swatch-row">
            {PALETTE.map((s) => (
              <button
                key={s.color}
                className={`swatch${pigment === s.color ? ' selected' : ''}`}
                style={{ '--swatch': s.color } as CSSProperties}
                onClick={() => { setPigment(s.color); setMessage(`${s.name} selected. Drag on the water to pour it.`); }}
                title={s.name}
                aria-pressed={pigment === s.color}
                aria-label={`Pigment ${s.name}`}
              />
            ))}
            <label className={`swatch custom${PALETTE.some((s) => s.color === pigment) ? '' : ' selected'}`} title="Custom colour">
              <input type="color" value={pigment} onChange={(e) => setPigment(e.target.value)} />
            </label>
          </div>
        </div>
        <div className="rail-block">
          <span className="rail-label">Behavior</span>
          <div className="seg">
            {(['flow', 'diffuse', 'stick'] as Behavior[]).map((b) => (
              <button key={b} className={`seg-item${behavior === b ? ' selected' : ''}`} onClick={() => setBehavior(b)} aria-pressed={behavior === b}>
                {b === 'flow' ? 'Flow' : b === 'diffuse' ? 'Diffuse' : 'Stick'}
              </button>
            ))}
          </div>
        </div>
        <div className="rail-block">
          <span className="rail-label">Visual</span>
          <div className="seg small">
            <button className="seg-item selected" aria-pressed>Realistic</button>
          </div>
          {([
            ['Reflections', 'reflections'],
            ['Grain', 'grain'],
            ['Caustics', 'caustics'],
            ['Depth', 'depth'],
          ] as Array<[string, keyof typeof opts]>).map(([label, key]) => (
            <div className="toggle-row" key={key}>
              <span>{label}</span>
              <button
                className={`switch${opts[key] ? ' on' : ''}`}
                onClick={() => setOpts({ ...opts, [key]: !opts[key] })}
                aria-pressed={opts[key]}
                aria-label={label}
              />
            </div>
          ))}
          <div className="toggle-row">
            <span>Nodal Map</span>
            <button className={`switch${nodal ? ' on' : ''}`} onClick={() => setNodal(!nodal)} aria-pressed={nodal} aria-label="Nodal map" />
          </div>
        </div>
      </aside>

      {/* mobile trays */}
      <button className="tray-btn tray-left" onClick={() => setTray(tray === 'left' ? 'none' : 'left')} aria-label="Sound controls">∿</button>
      <button className="tray-btn tray-right" onClick={() => setTray(tray === 'right' ? 'none' : 'right')} aria-label="Pigment controls">◐</button>

      {/* bottom transport + presets */}
      <footer className={`ink-transport${uiHidden ? ' hidden' : ''}`}>
        <button className="play-btn" onClick={togglePlay} aria-label={paused ? 'Play' : 'Pause'}>
          {paused ? '▶' : '❚❚'}
        </button>
        <button className="round-btn" onClick={clear} aria-label="Clear surface" title="Clear">↺</button>
        <output ref={freqLabelRef} className="freq-readout">286 Hz</output>
        <div className="preset-strip" role="listbox" aria-label="Resonance presets">
          <button className="preset-tile new" onClick={() => { clear(); setMessage('A fresh vessel. Strike it, or pick a resonance below.'); }} title="New">
            <span>＋</span><small>New</small>
          </button>
          {PRESETS.map((p, i) => (
            <button key={p.name} className="preset-tile" role="option" aria-selected={false} onClick={() => applyPreset(i)} title={p.name}>
              <img src={thumbs[i]} alt={p.name} />
            </button>
          ))}
        </div>
        <button className="save-pill" onClick={saveImage}>Save study <span>⇱</span></button>
      </footer>

      <div className="ink-caption" aria-hidden="true">
        <span>01 / WATER & RESONANCE</span>
        <span>STRIKE · LISTEN · POUR · OBSERVE</span>
      </div>
      <div className="ink-hint" aria-live="polite">{message}</div>
      {error && <div className="ink-error" role="alert">{error}</div>}
      <audio ref={fileElRef} preload="none" onEnded={() => { audioRef.current.stop(); setSource(null); }} />
    </main>
  );
}

function lerpN(a: number, b: number, t: number) { return a + (b - a) * t; }
