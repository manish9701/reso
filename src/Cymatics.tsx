import { useEffect, useRef, useState } from 'react';
import { LabEngine } from './lab/engine';
import { AudioInput } from './lab/audio';
import { EXCITATION_MIN, EXCITATION_MAX, EXCITATION_DEFAULT, excitationToSim, type Boundary } from './lab/resonance';
import { clamp, hexToRgb } from './lib/utils';

/**
 * CymaticsExperience — white-studio Resonant Ink instrument.
 *
 * Deliberately MINIMAL control surface: one frequency slider (which drives
 * how the water behaves) and one colour dropper with a fixed palette.
 * Clicking/dragging on the water pours ink; the physics does the rest.
 */

/**
 * FREQUENCY MODEL (see lab/resonance.ts): the slider and the tone carry one
 * audible EXCITATION frequency (110–880 Hz, default 432 Hz — the reference
 * image's setting). The simulated dish's own resonances live far lower, so
 * the engine maps this value through the documented monotonic log-band
 * transform before it reaches the mode bank. The UI states excitation; the
 * simulation states its own modes; the mapping between them is explicit and
 * documented — one quantity is never silently relabelled as the other.
 */
const PALETTE = ['#0b3fd6', '#2e62e8', '#35c8f0', '#0fa393', '#23c07a',
  '#8a3ff2', '#6a2ce0', '#f064b0', '#e8365f', '#f5a13d', '#e8c534', '#e9edf2'];
const DEFAULT_INK = '#2e62e8';
/** Constant drive level — the slider is frequency only, per the spec. */
const DRIVE_LEVEL = 0.85;

/** Nearest equal-tempered note name for the excitation tone (display only). */
function noteName(freqHz: number): string {
  const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const midi = Math.round(69 + 12 * Math.log2(Math.max(1, freqHz) / 440));
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export default function Cymatics() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<LabEngine | null>(null);
  const audioRef = useRef<AudioInput>(new AudioInput());
  const fileElRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rafRef = useRef(0);
  const pausedRef = useRef(false);            // vibration (drive) on/off
  const freqRef = useRef(EXCITATION_DEFAULT);
  const ampRef = useRef(0.85);
  const pointerDown = useRef(false);
  const lastPaint = useRef({ x: 0.5, y: 0.5 });
  const lastHover = useRef(0);
  const pigmentRef = useRef(DEFAULT_INK);

  const [freq, setFreq] = useState(EXCITATION_DEFAULT);
  const [amplitude] = useState(0.85);
  const [pigment, setPigment] = useState(DEFAULT_INK);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [boundary] = useState<Boundary>('rigid');
  const [source, setSource] = useState<'tone' | 'mic' | 'file' | null>(null);
  const [message, setMessage] = useState('Pick a colour, then click or drag on the water to pour it.');
  const [error, setError] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: LabEngine | null = null;
    try {
      engine = new LabEngine(canvas);
      engineRef.current = engine;
      // visual-QA hook: ?drive=432&level=0.8 drives the figure deterministically
      const q = new URLSearchParams(window.location.search);
      if (q.has('drive')) {
        engine.forcedDrive = { freq: Number(q.get('drive')) || 432, level: Number(q.get('level') ?? 0.8) };
      }
      // development handle (guide §18 debug tools)
      (window as unknown as { __lab?: LabEngine }).__lab = engine;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The water surface could not start.');
      return () => { audioRef.current.dispose(); };
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

      // live audio (when running) wins over the slider drive
      const a = audioRef.current.frame();
      if (audioRef.current.kind) {
        engine.drive.freq = excitationToSim(a.freq);
        engine.drive.level = Math.min(1, a.level * 1.4);
      } else {
        // The frequency slider IS the excitation: it is mapped through the
        // documented band transform into the vessel's resonance range, which
        // is what selects which modes respond. No hidden knobs, no relabelled
        // quantities.
        engine.drive.freq = engine.forcedDrive ? engine.drive.freq : excitationToSim(freqRef.current);
        engine.drive.level = pausedRef.current ? 0 : DRIVE_LEVEL * ampRef.current;
      }
      if (!pausedRef.current) engine.step(dt);
      engine.render();
    };
    rafRef.current = requestAnimationFrame(frame);
    // TEMP-DEMO-START: self-clocking scripted verification, driven by engine time
    if (new URLSearchParams(window.location.search).has('demo')) {
      const colors = ['#2e62e8', '#7a3fe0', '#e06ba8', '#eda14c'];
      const w = window as unknown as { __demoNext: number; __demoN: number };
      w.__demoNext = 1.2; w.__demoN = 0;
      const demoDrive = (e: LabEngine) => {
        const n = w.__demoN;
        const spots: Array<[number, number, string]> = [
          [0.36, 0.44, colors[0]], [0.60, 0.40, colors[3]], [0.48, 0.60, colors[1]],
          [0.64, 0.58, colors[2]], [0.40, 0.62, colors[0]], [0.55, 0.48, colors[1]],
        ];
        const [x, y, c] = spots[n % spots.length];
        e.deposit(x, y, 0.075, 0.6, hexToRgb(c));
        if (n % 4 === 1) e.strike(x, y, 0.85);
        w.__demoN = n + 1;
        w.__demoNext = e.time + 0.45;
      };
      const origStep = engine.step.bind(engine);
      engine.step = (dt: number) => {
        if (engineRef.current && engineRef.current.time >= w.__demoNext && w.__demoN < 14) demoDrive(engineRef.current);
        origStep(dt);
      };
    }
    // TEMP-DEMO-END
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      engine?.dispose();
      engineRef.current = null;
      audioRef.current.dispose();
    };
  }, []);

  // keep the live tone in sync with the slider
  useEffect(() => {
    freqRef.current = freq;
    // The oscillator plays the EXCITATION tone the UI shows (110–880 Hz is
    // directly audible); the simulation receives the mapped drive band.
    if (source === 'tone') void audioRef.current.startTone(freq, amplitude);
    else audioRef.current.setTone(freq, amplitude);
  }, [freq, amplitude, source]);
  useEffect(() => { ampRef.current = amplitude; }, [amplitude]);
  useEffect(() => { pigmentRef.current = pigment; }, [pigment]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { engineRef.current?.setBoundary(boundary); }, [boundary]);

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
    // The colour is DROPPED, not painted: it falls, lands, and mixes in.
    e.dropIn(p.x, p.y, hexToRgb(pigmentRef.current), 0.55, 0.02);
    setMessage('A drop falls; it lands, mixes, and the figure carries it.');
  };

  const onMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const e = engineRef.current;
    if (!e) return;
    const p = pos(ev);
    const prev = lastPaint.current;
    const d = Math.hypot(p.x - prev.x, p.y - prev.y);
    e.pointer = p;
    if (pointerDown.current) {
      if (d > 0.012) {
        // A drag is a stream of drops, not a painted line. Spacing them along
        // the path and spacing them in TIME (below) is what makes it read as
        // liquid falling rather than a brush stroke being drawn.
        const steps = Math.max(1, Math.ceil(d / 0.03));
        for (let i = 1; i <= steps; i++) {
          const k = i / steps;
          e.dropIn(prev.x + (p.x - prev.x) * k, prev.y + (p.y - prev.y) * k,
            hexToRgb(pigmentRef.current), 0.4, 0.016);
        }
        lastPaint.current = p;
      }
    } else if (ev.pointerType === 'mouse' && d > 0.05 && e.time - lastHover.current > 0.4) {
      e.strike(p.x, p.y, 0.06); // hover: barely-there disturbance
      lastHover.current = e.time;
      lastPaint.current = p;
    }
  };

  const onUp = () => { pointerDown.current = false; };

  const toggleVibration = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    setMessage(pausedRef.current ? 'Driver off — the surface settles.' : 'Driving — drop ink into the figure.');
  };

  const clear = () => {
    engineRef.current?.clearDye();
    setMessage('Cleared. The vessel keeps its resonance; pigment washes out.');
  };

  const saveImage = () => {
    const engine = engineRef.current;
    const cv = canvasRef.current;
    if (!engine || !cv) return;
    const a = document.createElement('a');
    a.download = `resonant-ink-${Date.now().toString(36)}.png`;
    a.href = engine.capture();
    a.click();
    setMessage('Saved a clean render of the dish — UI chrome stays out of the frame.');
  };

  const pickSource = async (kind: 'tone' | 'mic' | 'file') => {
    const audio = audioRef.current;
    if (!audio) return;
    setError('');
    if (source === kind) { audio.stop(); setSource(null); setMessage('Input released. The surface settles.'); return; }
    try {
      if (kind === 'tone') {
        await audio.startTone(freqRef.current, amplitude);
        setSource('tone');
        setMessage('Tone driving. Slide frequency — the figure reorganises between resonances.');
      } else if (kind === 'mic') {
        const ok = await audio.startMic();
        if (ok) { setSource('mic'); setMessage('Listening — sustained sound builds the mode. Never played back.'); }
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
      setMessage(`Playing "${file.name}" — its spectrum drives the figure. Local only.`);
    } else {
      setError(audio.lastError);
      setSource(null);
    }
  };

  return (
    <main className="ink-app">
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

      {/* left rail — frequency (excitation, see the frequency model) */}
      <div className="rail rail-left">
        <span className="rail-label">Frequency</span>
        <div className="freq-readout">
          <strong>{Math.round(freq)}</strong> <em>Hz</em>
          <span className="note-name">{noteName(freq)}</span>
        </div>
        <input
          className="freq-slider"
          type="range"
          min={EXCITATION_MIN}
          max={EXCITATION_MAX}
          step={1}
          value={freq}
          onChange={(e) => setFreq(Number(e.target.value))}
          aria-label="Excitation frequency"
        />
        <button
          className={`round-btn${source === 'tone' ? ' live' : ''}`}
          onClick={() => void pickSource('tone')}
          aria-pressed={source === 'tone'}
          aria-label={source === 'tone' ? 'Stop tone' : 'Play tone'}
          title="Play the tone that drives the water"
        >
          {source === 'tone' ? (
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <rect x="3.4" y="2.6" width="3.1" height="10.8" rx="1.1" fill="currentColor" />
              <rect x="9.5" y="2.6" width="3.1" height="10.8" rx="1.1" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d="M4.6 2.6 13 8l-8.4 5.4z" fill="currentColor" />
            </svg>
          )}
        </button>
        <button className="round-btn ghost" onClick={toggleVibration} aria-pressed={paused} aria-label={paused ? 'Resume vibration' : 'Hold the surface'} title="Hold / release the drive">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M1.5 8c1.2-3 2.4-3 3.6 0s2.4 3 3.6 0 2.4-3 3.6 0 2.4 3 3.6 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* right rail — colour: an easy picker for ANY ink */}
      <div className="rail rail-right">
        <span className="rail-label">Color</span>

        {pickerOpen && (
          <div className="ink-picker" role="dialog" aria-label="Choose an ink">
            <button
              className="picker-current"
              style={{ background: pigment }}
              title="Selected ink"
              aria-label={`Selected ink ${pigment}`}
            />
            <div className="picker-grid">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={`picker-dot${pigment === c ? ' selected' : ''}`}
                  style={{ background: c }}
                  onClick={() => { setPigment(c); setPickerOpen(false); setMessage('Ink picked — click or drag on the water to pour it in.'); }}
                  aria-label={`Ink colour ${c}`}
                />
              ))}
            </div>
            <label className="picker-custom">
              Custom…
              <input
                type="color"
                value={pigment}
                onChange={(ev) => setPigment(ev.target.value)}
                aria-label="Custom ink colour"
              />
            </label>
          </div>
        )}

        <button
          className="swatch dropper"
          onClick={() => setPickerOpen((v) => !v)}
          aria-expanded={pickerOpen}
          aria-label="Open the colour picker"
          title="Pick any colour"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M10.7 1.9a2.1 2.1 0 0 1 3 3l-1.4 1.4.8.8a.9.9 0 0 1-1.3 1.3l-.8-.8-5 5a1 1 0 0 1-.5.3l-2.4.6a.5.5 0 0 1-.6-.6l.6-2.4a1 1 0 0 1 .3-.5l5-5-.8-.8a.9.9 0 0 1 1.3-1.3l.8.8z" fill="currentColor" />
          </svg>
        </button>
        {PALETTE.map((c) => (
          <button
            key={c}
            className={`swatch${pigment === c ? ' selected' : ''}`}
            style={{ background: c, color: c }}
            onClick={() => {
              setPigment(c); setPickerOpen(false);
              setMessage('Ink picked — click or drag on the water to pour it in.');
            }}
            aria-pressed={pigment === c}
            aria-label={`Ink colour ${c}`}
          />
        ))}
      </div>

      {/* bottom-left utility cluster: clear + save */}
      <div className="rail rail-utils">
        <button className="round-btn ghost" onClick={clear} aria-label="Clear pigment" title="Clear the pigment">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M3 3.5h10M6.5 3V2h3v1M4.6 3.8l.7 9a1.5 1.5 0 0 0 1.5 1.4h2.9a1.5 1.5 0 0 0 1.5-1.4l.7-9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <button className="round-btn ghost" onClick={saveImage} aria-label="Save render" title="Save a PNG">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M3 2.8A1.8 1.8 0 0 1 4.8 1h5L13 4.2v9A1.8 1.8 0 0 1 11.2 15H4.8A1.8 1.8 0 0 1 3 13.2z" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M5.4 1.6v3.6H10M5.6 10.2h4.8M5.6 12.4h3" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        </button>
      </div>

      {/* hidden audio plumbing — no visible controls */}
      <input ref={fileRef} type="file" accept="audio/*" className="visually-hidden-file"
        onChange={(e) => { void onFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      <audio ref={fileElRef} preload="none" onEnded={() => { audioRef.current.stop(); setSource(null); }} />

      <div className="ink-hint" aria-live="polite">{message}</div>
      {error && <div className="ink-error" role="alert">{error}</div>}
    </main>
  );
}
