import { useEffect, useRef, useState } from 'react';
import { LabEngine } from './lab/engine';
import { AudioInput } from './lab/audio';
import { BANK_FREQ_MIN, BANK_FREQ_MAX, type Boundary } from './lab/resonance';
import { clamp, hexToRgb } from './lib/utils';

/**
 * CymaticsExperience — white-studio Resonant Ink instrument.
 *
 * Deliberately MINIMAL control surface: one frequency slider (which drives
 * how the water behaves) and one colour dropper with a fixed palette.
 * Clicking/dragging on the water pours ink; the physics does the rest.
 */

const PALETTE = ['#8a3ff2', '#2e62e8', '#35c8f0', '#f064b0', '#f5a13d', '#e9edf2'];
const DEFAULT_INK = '#2e62e8';
/**
 * Default drive = a real resonance of this vessel (the 3rd radial mode,
 * ≈4.5 Hz), not an arbitrary number. It sits in the middle of the bank so the
 * figure has a clear multi-lobed structure the moment the page opens.
 */
const DEFAULT_FREQ = 4.5;
/** Constant drive level — the slider is frequency only, per the spec. */
const DRIVE_LEVEL = 0.85;

/**
 * Audible pitch for a vessel resonance.
 *
 * The dish's real modes sit at 1.7–12 Hz. Human hearing starts at 20 Hz, so
 * feeding that straight to the oscillator produced sound nobody can consciously
 * hear — an infrasonic pressure you feel rather than hear, which is exactly
 * the "sound that kills your ears".
 *
 * So the tone is a LISTENING representation of the mode, not the mode itself:
 * the physics still runs at the true frequency, and the pitch is mapped onto
 * a pentatonic scale across three octaves. Pentatonic is the important choice
 * — every note the slider can reach is consonant with every other, so sweeping
 * the whole range never produces a dissonance, which a chromatic scale would
 * do constantly.
 */
const PENTATONIC = [0, 3, 5, 7, 10];   // semitones: minor pentatonic
const AUDIO_ROOT = 196.0;             // G3
const NOTE_NAMES = ['C', 'D', 'E', 'G', 'A'];

function noteFor(freqHz: number): { hz: number; name: string } {
  const lo = Math.log(BANK_FREQ_MIN);
  const hi = Math.log(BANK_FREQ_MAX);
  const t = clamp((Math.log(freqHz) - lo) / (hi - lo), 0, 1);
  const steps = 3 * PENTATONIC.length;
  const idx = Math.round(t * steps);
  const oct = Math.floor(idx / PENTATONIC.length);
  const semi = PENTATONIC[idx % PENTATONIC.length];
  return {
    hz: AUDIO_ROOT * Math.pow(2, oct + semi / 12),
    name: `${NOTE_NAMES[idx % PENTATONIC.length]}${3 + oct}`,
  };
}

export default function Cymatics() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<LabEngine | null>(null);
  const audioRef = useRef<AudioInput>(new AudioInput());
  const fileElRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rafRef = useRef(0);
  const pausedRef = useRef(false);            // vibration (drive) on/off
  const freqRef = useRef(DEFAULT_FREQ);
  const ampRef = useRef(0.85);
  const pointerDown = useRef(false);
  const lastPaint = useRef({ x: 0.5, y: 0.5 });
  const lastHover = useRef(0);
  const pigmentRef = useRef(DEFAULT_INK);

  const [freq, setFreq] = useState(DEFAULT_FREQ);
  const [amplitude] = useState(0.85);
  const [pigment, setPigment] = useState(DEFAULT_INK);
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
        engine.drive.freq = a.freq;
        engine.drive.level = Math.min(1, a.level * 1.4);
      } else {
        // the frequency slider IS the drive: it selects which modes respond
        // and how fast the water churns — no hidden knobs
        engine.drive.freq = engine.forcedDrive ? engine.drive.freq : freqRef.current;
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
    // The oscillator gets the AUDIBLE pitch; the simulation keeps the true
    // resonance. Driving the speaker at 4.5 Hz is not music, it is infrasound.
    if (source === 'tone') void audioRef.current.startTone(noteFor(freq).hz, amplitude);
    else audioRef.current.setTone(noteFor(freq).hz, amplitude);
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
        await audio.startTone(noteFor(freqRef.current).hz, amplitude);
        setSource('tone');
        setMessage('Tone driving. Slide frequency — the figure snaps between resonances.');
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

      {/* left rail — frequency */}
      <div className="rail rail-left">
        <span className="rail-label">Frequency</span>
        <div className="freq-readout">
          <strong>{freq.toFixed(2)}</strong> <em>Hz</em>{
          <span className="note-name">{noteFor(freq).name}</span>}
        </div>
        <input
          className="freq-slider"
          type="range"
          min={BANK_FREQ_MIN}
          max={BANK_FREQ_MAX}
          step={0.01}
          value={freq}
          onChange={(e) => setFreq(Number(e.target.value))}
          aria-label="Drive frequency"
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

      {/* right rail — colour */}
      <div className="rail rail-right">
        <span className="rail-label">Color</span>
        <label className="swatch dropper" title="Pick any colour">
          <input
            type="color"
            value={pigment}
            onChange={(ev) => { setPigment(ev.target.value); setMessage('Ink picked — click or drag on the water to pour it in.'); }}
            aria-label="Custom ink colour"
          />
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M10.7 1.9a2.1 2.1 0 0 1 3 3l-1.4 1.4.8.8a.9.9 0 0 1-1.3 1.3l-.8-.8-5 5a1 1 0 0 1-.5.3l-2.4.6a.5.5 0 0 1-.6-.6l.6-2.4a1 1 0 0 1 .3-.5l5-5-.8-.8a.9.9 0 0 1 1.3-1.3l.8.8z" fill="currentColor" />
          </svg>
        </label>
        {PALETTE.map((c) => (
          <button
            key={c}
            className={`swatch${pigment === c ? ' selected' : ''}`}
            style={{ background: c, color: c }}
            onClick={() => { setPigment(c); setMessage('Ink picked — click or drag on the water to pour it in.'); }}
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
