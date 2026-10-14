import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LabEngine } from './lab/engine';
import { AudioInput } from './lab/audio';
import { EXCITATION_MIN, EXCITATION_MAX, excitationToSim, bandToSim, type Boundary } from './lab/resonance';
import { AUDIO_BAND_CENTERS } from './lab/audio';
import { clamp, hexToRgb } from './lib/utils';

/**
 * CymaticsExperience — white-studio Resonant Ink instrument.
 *
 * Two drivers, and only one of them makes a sound:
 *
 *  - **Frequency** — the slider drives the vessel's modes. Silent.
 *  - **Tone** — an audible signal drives the vessel instead: the bundled track,
 *    the generated piece, or a local file of your own. The slider is not
 *    shown here at all; in this mode the audio IS the frequency.
 *
 * Clicking or dragging on the water pours ink in either mode.
 */

const DEFAULT_INK = '#1a52f0';
const DRIVE_LEVEL = 0.85;

// The bundled track, resolved through Vite's base so it is correct in dev
// (base '/'), in the production build (base './') and under ANY sub-path.
//
// It used to be the bare string 'zen-tones.mp3'. That resolves against the
// DOCUMENT, so the moment the app is served from anywhere other than the root
// — a sub-path, a project page, a file:// open — the request 404s and the
// browser reports "cannot play this". BASE_URL is the base Vite actually built
// with, so this now follows it.
const PRESET_URL = `${import.meta.env.BASE_URL}zen-tones.mp3`.replace(/\/{2,}/g, '/');
type ToneSource = 'preset' | 'builtIn' | 'file';

const SOURCE_META: Record<ToneSource, { label: string; short: string }> = {
  preset: { label: 'Zen Tones', short: 'Zen' },
  builtIn: { label: 'Resonant', short: 'Synth' },
  file: { label: 'Your audio', short: 'Upload' },
};

/**
 * One long vertical spectrum bar instead of a row of swatches.
 *
 * A palette can only offer the colours someone else decided on; a bar lets you
 * pick any colour directly, and it is the same gesture as the thing itself —
 * drag along it and the ink changes under your finger. Black anchors the bottom
 * (it is the one colour the hue wheel cannot express and the one most people
 * reach for), and white the top.
 */
/** hue/sat/light -> #rrggbb, matching the bar's own colour space. */
function hslToHex(hDeg: number, s: number, l: number): string {
  const h = ((hDeg % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * The vertical colour bar, specified ONCE so its pixels, its picker and its
 * cursor cannot disagree.
 *
 * The old bar shipped `linear-gradient(180deg, black, hues, white)` but mapped
 * clicks as if black were at the BOTTOM — 180deg puts the first stop at the
 * TOP, so the picker ran the bar in mirror image: clicking the yellow you could
 * see selected blue ~280° instead. This is the "click yellow, get blue" bug,
 * and no amount of fiddling with the constants could fix it while the gradient
 * and the picker were specified in two places.
 *
 * So both are derived from the same three facts:
 *
 *   HUES        how many hue stops the wheel has (0° .. (HUES-1)*12°)
 *   HUE_START   gradient position of the first hue stop
 *   HUE_END     gradient position of the last hue stop
 *
 * The span stops at 348° rather than wrapping to 360°: wrapping put red at BOTH
 * ends of the bar, so the same colour was reachable twice and red sat next to
 * white at the top, which reads as a smear rather than a spectrum. Stopping at
 * magenta means the top blend is magenta→white, which is what every picker
 * does, and every hue is reachable exactly once.
 */
const HUES = 30;
const HUE_SPAN = (HUES - 1) * 12;          // 348°
/** Gradient position of hsl(0) — stop 1 of HUES+2 evenly spaced stops. */
const HUE_START = 1 / (HUES + 2) * 1;      // = 1/31
const HUE_END = (HUES + 1) / (HUES + 2);   // = 30/31
/** Positions where the bar is pure black / pure white (the blend midpoints). */
const BLACK_AT = HUE_START / 2;
const WHITE_AT = (HUE_END + 1) / 2;

function buildSpectrum(): string {
  const stops: string[] = ['#0a0a0c'];
  for (let i = 0; i < HUES; i++) stops.push(`hsl(${i * 12} 82% 52%)`);
  stops.push('#ffffff');
  // `to top`, not 180deg: the first stop must land at the BOTTOM so the
  // geometry below (t = 1 - y/height) matches what is on screen.
  return `linear-gradient(to top, ${stops.join(', ')})`;
}

/** Gradient position for a hue in degrees. */
const posOfHue = (deg: number): number => HUE_START + (deg / HUE_SPAN) * (HUE_END - HUE_START);

/** Bar position (0 bottom → 1 top) for a colour, and the inverse. */
function hueOfHex(hex: string): number | null {
  const h = hex.replace('#', '');
  if (h.length !== 3 && h.length !== 6) return null;
  const n = h.length === 3
    ? h.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  const [r, g, b] = n.map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 0.03) return null;                 // achromatic — handled by lightness
  let deg = 0;
  if (mx === r) deg = ((g - b) / d) % 6;
  else if (mx === g) deg = (b - r) / d + 2;
  else deg = (r - g) / d + 4;
  return posOfHue((((deg * 60) + 360) % 360) % (HUE_SPAN + 0.0001));
}

/** Linear blend of two #rrggbb colours in RGB — used for the bar's black and
 *  white blend zones, so a click anywhere on the gradient gets the colour the
 *  gradient actually shows there. */
function blendHex(aHex: string, bHex: string, k: number): string {
  const p = (hex: string) => {
    const h = hex.replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ];
  };
  const a = p(aHex), b = p(bHex);
  const to = (v: number) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${to(a[0] + (b[0] - a[0]) * k)}${to(a[1] + (b[1] - a[1]) * k)}${to(a[2] + (b[2] - a[2]) * k)}`;
}

function lightOfHex(hex: string): number {
  const h = hex.replace('#', '');
  const n = h.length === 3
    ? h.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return (0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]) / 255;
}

// The centre line is ONE sentence about the instrument, not a manual — the
// step-by-step lives in the bottom-right how-to list, and two long paragraphs
// of instructions in the middle of the dish pushed the instrument below its
// own instructions.
function hintFor(mode: 'freq' | 'tone', running: boolean, paused: boolean, source: ToneSource | null): string {
  if (mode === 'tone') {
    if (!running) return 'Press play — the sound starts and the water follows it.';
    if (paused) return 'Paused. Press play to continue exactly where it stopped.';
    return `${SOURCE_META[source ?? 'preset'].label} is sounding — drop ink to watch the cells form.`;
  }
  if (!running) return 'The dish is at rest. Slide the frequency, or just drop ink.';
  return 'Sound holds the pattern. Drop ink to see it.';
}

export default function Cymatics() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<LabEngine | null>(null);
  const audioRef = useRef<AudioInput>(new AudioInput());
  const fileElRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const modeRef = useRef<'freq' | 'tone'>('freq');
  const runningRef = useRef(false);
  const driveOnRef = useRef(true);
  const freqRef = useRef(432);
  const pointerDown = useRef(false);
  const lastPaint = useRef({ x: 0.5, y: 0.5 });
  const lastHover = useRef(0);
  const pigmentRef = useRef(DEFAULT_INK);

  const [freq, setFreq] = useState(432);
  const [pigment, setPigment] = useState(DEFAULT_INK);
  const [mode, setMode] = useState<'freq' | 'tone'>('freq');
  /** Frequency mode's own play state: whether the silent drive is running. It
   *  is deliberately separate from `running`, which belongs to the audio. */
  const [driveOn, setDriveOn] = useState(true);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [source, setSource] = useState<ToneSource | null>(null);
  const [fileName, setFileName] = useState('');
  const [boundary] = useState<Boundary>('rigid');
  const [error, setError] = useState('');
  const [nowPlaying, setNowPlaying] = useState<{ pct: number } | null>(null);

  const spectrum = useMemo(() => buildSpectrum(), []);
  const message = hintFor(mode, mode === 'freq' ? driveOn : running, paused, source);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Attach the track's Web Audio tap NOW, before any click — see
    // AudioInput.prime: this is what makes the very first Zen click audible.
    if (fileElRef.current) audioRef.current.prime(fileElRef.current);
    let engine: LabEngine | null = null;
    try {
      engine = new LabEngine(canvas);
      engineRef.current = engine;
      const q = new URLSearchParams(window.location.search);
      if (q.has('drive')) {
        engine.forcedDrive = { freq: Number(q.get('drive')) || 432, level: Number(q.get('level') ?? 0.8) };
      }
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

      // Keep the audio graph fed from the render loop. A timer is throttled in
      // a background tab, which starved the note queue and let a running
      // session die mid-bar — see AudioInput.pump().
      audioRef.current.pump();

      if (modeRef.current === 'tone' && runningRef.current && audioRef.current.kind) {
        const a = audioRef.current.frame();
        (window as unknown as { __audioProbe?: unknown }).__audioProbe = { ...a, kind: audioRef.current.kind };
        engine.drive.freq = excitationToSim(a.freq);
        // A real floor, because the source can genuinely go silent and a water
        // that drops to a dead flat disc reads as the session having stopped
        // rather than as a quiet passage in the music.
        engine.driveTarget = clamp(0.3 + a.level * 0.9, 0.3, 1);
        // MUSIC: the four analysed bands each steer their own region of the
        // dish — bass onto the low orders, vocal/mid onto the middle, shine
        // onto the fine outer drift — so the figure follows the mix, not one
        // averaged tone. bandToSim maps 80 Hz..3.2 kHz across the same visible
        // sim band the slider uses (lab/resonance.ts).
        engine.driveSpectrum = a.bands.map((lv, i) => ({ f: bandToSim(AUDIO_BAND_CENTERS[i]), level: lv }));
      } else {
        // Clear the probe, or it keeps reporting the last frame of audio that
        // was playing and any test that reads it gets a stale answer. The
        // spectrum too: a stale one would keep the spectral driver latched on
        // the last song's bands.
        engine.driveSpectrum = null;
        (window as unknown as { __audioProbe?: unknown }).__audioProbe = null;
        engine.drive.freq = engine.forcedDrive ? engine.drive.freq : excitationToSim(freqRef.current);
        // Frequency mode's drive is governed by ITS play button (driveOn), so
        // pausing it lets the figure decay and holding it brings the session
        // back. Tone mode with nothing loaded keeps a gentle drive so the dish
        // is not dead before a source is chosen.
        engine.driveTarget = modeRef.current === 'freq'
          ? (driveOnRef.current ? DRIVE_LEVEL : 0)
          : (!runningRef.current ? DRIVE_LEVEL : 0);
      }
      engine.step(dt);
      engine.render();
    };
    rafRef.current = requestAnimationFrame(frame);

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
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      engine?.dispose();
      engineRef.current = null;
      audioRef.current.dispose();
    };
  }, []);

  useEffect(() => { freqRef.current = freq; }, [freq]);
  useEffect(() => { pigmentRef.current = pigment; }, [pigment]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { driveOnRef.current = driveOn; }, [driveOn]);
  useEffect(() => { runningRef.current = running && !paused; }, [running, paused]);
  // The silent driver must react INSTANTLY to the slider; the tone driver
  // keeps its smooth musical follow. Toggled on mode switches only — setting
  // it per frame would be redundant.
  useEffect(() => { engineRef.current?.setSnapFollow(mode === 'freq'); }, [mode]);
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
    e.dropIn(p.x, p.y, hexToRgb(pigmentRef.current), 0.8, 0.03);
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
        // the path and spacing them in TIME is what makes it read as liquid
        // falling rather than a brush stroke being drawn. The drops are also
        // wider and softer than a click's: many small hard dots stamped along
        // the path left Scratch-like dashes instead of a pour dispersing,
        // which is the "random lines instead of natural mixing" report.
        const steps = Math.max(1, Math.ceil(d / 0.024));
        for (let i = 1; i <= steps; i++) {
          const k = i / steps;
          e.dropIn(prev.x + (p.x - prev.x) * k, prev.y + (p.y - prev.y) * k,
            hexToRgb(pigmentRef.current), 0.3, 0.026);
        }
        lastPaint.current = p;
      }
    } else if (ev.pointerType === 'mouse' && d > 0.05 && e.time - lastHover.current > 0.4) {
      e.strike(p.x, p.y, 0.06);
      lastHover.current = e.time;
      lastPaint.current = p;
    }
  };

  const onUp = () => { pointerDown.current = false; };

  const saveImage = () => {
    const engine = engineRef.current;
    const cv = canvasRef.current;
    if (!engine || !cv) return;
    const a = document.createElement('a');
    a.download = `resonant-ink-${Date.now().toString(36)}.png`;
    a.href = engine.capture();
    a.click();
  };

  // ---- the colour bar ----------------------------------------------------

  const pickFromBar = useCallback((clientY: number) => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // the bar runs bottom (black) to top (white)
    const t = clamp(1 - (clientY - r.top) / r.height, 0, 1);
    if (t < HUE_START) {
      // below the first hue stop the gradient blends black → red; honour that
      // instead of snapping, so the whole bar is pickable and truthful
      const k = clamp(t / Math.max(1e-6, HUE_START), 0, 1);
      setPigment(blendHex('#0a0a0c', hslToHex(0, 0.82, 0.52), k));
      return;
    }
    if (t > HUE_END) {
      const k = clamp((t - HUE_END) / Math.max(1e-6, 1 - HUE_END), 0, 1);
      setPigment(blendHex(hslToHex(HUE_SPAN, 0.82, 0.52), '#ffffff', k));
      return;
    }
    const hue = ((t - HUE_START) / (HUE_END - HUE_START)) * HUE_SPAN;
    setPigment(hslToHex(hue, 0.82, 0.52));
  }, []);

  const onBarDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.currentTarget.setPointerCapture(ev.pointerId);
    pickFromBar(ev.clientY);
  };
  const onBarMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.buttons !== 0) pickFromBar(ev.clientY);
  };

  /** Where the cursor belongs for the current colour — truthful even for a
   *  colour that came from a file or an eyedropper. */
  const posOf = useMemo(() => {
    const hue = hueOfHex(pigment);
    if (hue !== null) return hue;
    // achromatic: park on the black end or the white end by lightness
    return lightOfHex(pigment) > 0.62 ? WHITE_AT : BLACK_AT;
  }, [pigment]);

  // ---- tone sources ------------------------------------------------------
  // The chips SELECT a source; start/stop lives solely in the transport's
  // Play/Pause. The previous version also stopped a running session when the
  // active chip was clicked again — guarded by REACT's running/source state,
  // which is stale inside the click: the same physical click could arrive
  // twice (pointer dispatch races) and read state from different renders, so
  // the second invocation believed it had to STOP what the first had just
  // started. The track then played for a moment and sat paused, and no error
  // ever surfaced. Every decision below reads the AUDIO's live truth
  // (kind/paused), which cannot be stale, so repeated or stray clicks are
  // harmless no-ops.
  const pickSource = async (which: ToneSource) => {
    setError('');
    // Unlock inside the click: choosing a file from the dialog breaks the
    // gesture chain, so anything awaited afterwards starts from a suspended
    // AudioContext and play() is refused.
    audioRef.current.unlock();
    if (which === 'file') { fileRef.current?.click(); return; }
    const live = audioRef.current;
    if (live.kind === which && !live.paused) return;          // already playing it
    try {
      const ok = which === 'preset'
        ? await live.startPreset(PRESET_URL, fileElRef.current!)
        : await live.startBuiltIn(0.6);
      if (!ok) { setError(live.lastError || 'Audio could not start.'); return; }
      setSource(which);
      setRunning(true);
      setPaused(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audio could not start.');
    }
  };

  const togglePlay = async () => {
    setError('');
    if (modeRef.current === 'freq') {
      // The silent driver. Play brings the figure up from rest, pause lets it
      // decay and holds the session — exactly like the tone side's pause.
      setDriveOn((v) => !v);
      return;
    }
    audioRef.current.unlock();
    // Read the audio's live state, not React's: `kind` is null until a source
    // has STARTED, so this picks the bundled track only when nothing at all is
    // loaded — a paused session continues instead of restarting.
    if (!audioRef.current.kind) { await pickSource('preset'); return; }
    const nowPlaying = await audioRef.current.togglePause();
    // A failed resume leaves the engine PAUSED (see AudioInput.togglePause) —
    // mirror that truth instead of painting a playing button over silence,
    // and surface the named error so "does not play" always says why.
    if (audioRef.current.paused) {
      setPaused(true);
      setRunning(true);
      if (!nowPlaying && audioRef.current.lastError) setError(audioRef.current.lastError);
    } else {
      setPaused(!nowPlaying);
      setRunning(true);
    }
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    setError('');
    audioRef.current.unlock();
    const ok = await audioRef.current.startFile(file, fileElRef.current!);
    if (ok) { setSource('file'); setRunning(true); setPaused(false); setFileName(file.name); }
    else { setError(audioRef.current.lastError); setRunning(false); setSource(null); }
  };

  const setModeAnd = (m: 'freq' | 'tone') => {
    if (m === mode) return;
    if (m === 'freq') {
      // entering the silent driver: resume ITS drive, so the dish is not flat
      setDriveOn(true);
      audioRef.current.stop();
      setRunning(false); setPaused(false); setSource(null);
    }
    // Tone is MANUAL: arriving here starts nothing. The UI says what to do
    // ("Choose a source and press play") and the Play button or a source
    // button starts the track — the user's click, the user's choice.
    setMode(m);
  };

  useEffect(() => {
    const el = fileElRef.current;
    if ((source !== 'preset' && source !== 'file') || !el || !el.duration || !Number.isFinite(el.duration)) {
      setNowPlaying(null);
      return;
    }
    const tick = () => setNowPlaying({ pct: (el.currentTime / el.duration) * 100 });
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [source, running, paused]);

  const playing = mode === 'freq' ? driveOn : running && !paused;

  // ONE transport, rendered on BOTH sides, and it means what the mode says:
  //  - Frequency mode: starts and stops the silent drive, i.e. the figure.
  //  - Tone mode: plays, pauses and continues the audio session.
  // Same button, same two words, different subject — which is what "the button
  // should work for both, differently" asked for. It used to start the bundled
  // track from the Frequency side, which made the silent driver audible.
  const transport = (
    <button
      className={`play${playing ? ' on' : ''}`}
      onClick={() => void togglePlay()}
      aria-label={playing ? 'Pause' : 'Play'}
      aria-pressed={playing}
    >
      <span className="play-ico">
        {playing ? (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <rect x="4.2" y="3.2" width="2.9" height="9.6" rx="1.2" fill="currentColor" />
            <rect x="8.9" y="3.2" width="2.9" height="9.6" rx="1.2" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M5.2 3.4 12.4 8l-7.2 4.6z" fill="currentColor" />
          </svg>
        )}
      </span>
      <span className="play-txt">{playing ? 'Pause' : 'Play'}</span>
      {nowPlaying && <span className="play-bar"><i style={{ width: `${nowPlaying.pct}%` }} /></span>}
    </button>
  );

  const sources = (
    <div className="srcs" role="radiogroup" aria-label="Tone source">
      {(['preset', 'builtIn', 'file'] as ToneSource[]).map((s) => (
        <button
          key={s}
          className={`src${source === s && running ? ' on' : ''}`}
          onClick={() => void pickSource(s)}
          role="radio"
          aria-checked={source === s && running}
          title={(s === 'file' ? 'Choose an audio file (local only)' : SOURCE_META[s].label) + ' — headphones recommended'}
          aria-label={(s === 'file' ? 'Choose an audio file (local only)' : SOURCE_META[s].label) + ', headphones recommended'}
        >
          {s === 'file' && source === s && running && fileName
            ? fileName.replace(/\.[^.]+$/, '').slice(0, 8)
            : SOURCE_META[s].short}
        </button>
      ))}
    </div>
  );

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

      {/* ---------- left rail: driver ---------- */}
      <div className="rail rail-left">
        <div className="seg" role="radiogroup" aria-label="Driver">
          <button
            className={`seg-btn${mode === 'freq' ? ' on' : ''}`}
            onClick={() => setModeAnd('freq')}
            role="radio" aria-checked={mode === 'freq'}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M1.6 8h2.2l1.5-4.2L7.6 12.4 9.4 6.1l1.1 3.3h3.9" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Frequency</span>
          </button>
          <button
            className={`seg-btn${mode === 'tone' ? ' on' : ''}`}
            onClick={() => setModeAnd('tone')}
            role="radio" aria-checked={mode === 'tone'}
            title="Tone plays real sound through your speakers — headphones recommended"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M6 2.6v10.8M9.2 2.6v10.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="4.6" cy="8" r="1.7" fill="currentColor" />
              <circle cx="10.6" cy="8" r="1.7" fill="currentColor" />
            </svg>
            <span>Tone</span>
          </button>
        </div>

        {/* Frequency mode: the slider IS the driver, and it is silent */}
        {mode === 'freq' ? (
          <div className="freq-block">
            <div className="freq-readout">
              <strong>{Math.round(freq)}</strong> <em>Hz</em>
              <span className="tag">silent</span>
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
            {transport}
          </div>
        ) : (
          /* Tone mode: no slider. The audio IS the frequency, so a slider beside
             it would be a second, lying control. */
          <div className="tone-block">
            {sources}
            {transport}
          </div>
        )}
      </div>

      {/* ---------- right rail: colour ---------- */}
      <div className="rail rail-right">
        <div
          ref={barRef}
          className="bar"
          style={{ background: spectrum }}
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          role="slider"
          tabIndex={0}
          aria-label="Ink colour"
          aria-valuetext={pigment}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const step = clamp(posOf + (e.key === 'ArrowUp' ? 0.012 : -0.012), 0, 1);
            // mirror pickFromBar exactly: same zones, same blends
            if (step < HUE_START) {
              const k = step / Math.max(1e-6, HUE_START);
              setPigment(blendHex('#0a0a0c', hslToHex(0, 0.82, 0.52), k));
            } else if (step > HUE_END) {
              const k = (step - HUE_END) / Math.max(1e-6, 1 - HUE_END);
              setPigment(blendHex(hslToHex(HUE_SPAN, 0.82, 0.52), '#ffffff', k));
            } else {
              setPigment(hslToHex(((step - HUE_START) / (HUE_END - HUE_START)) * HUE_SPAN, 0.82, 0.52));
            }
          }}
        >
          <i className="bar-cursor" style={{ bottom: `${posOf * 100}%`, background: pigment }} />
        </div>
        <span className="bar-hex">{pigment.toUpperCase()}</span>
      </div>

      {/* ---------- the short how-to, right, in grey ---------- */}
      <div className="rail rail-howto" aria-label="How to use">
        <ul>
          <li><strong>Slider</strong> — moves the figure by frequency</li>
          <li><strong>Click or drag</strong> — drop ink onto the water</li>
          <li><strong>Play</strong> — sound drives the same figure</li>
          <li><strong>Colour bar</strong> — pick the ink</li>
        </ul>
      </div>

      <p className="ink-hint" role="status" aria-live="polite">{message}</p>

      {/* ---------- utilities ---------- */}
      <div className="rail rail-utils">
        <button className="round-btn ghost" onClick={() => engineRef.current?.clearDye()}
          aria-label="Clear pigment" title="Clear the pigment">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none"
            stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.8 4.2h10.4M6.4 4.2V2.6h3.2v1.6M4.5 4.2l.7 9.2a1.3 1.3 0 0 0 1.3 1.2h2.9a1.3 1.3 0 0 0 1.3-1.2l.7-9.2" />
            <path d="M6.9 6.6v5.2M9.1 6.6v5.2" strokeWidth="1.15" />
          </svg>
        </button>
        <button className="round-btn ghost" onClick={saveImage} aria-label="Save render" title="Save a PNG">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none"
            stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.2 3a1.3 1.3 0 0 1 1.3-1.3h5.2L12.8 5v7.3a1.3 1.3 0 0 1-1.3 1.3H4.5A1.3 1.3 0 0 1 3.2 12.3z" />
            <path d="M5.6 1.9v3.5h4.2" />
            <circle cx="8" cy="9.4" r="2.1" />
          </svg>
        </button>
      </div>

      <input ref={fileRef} type="file" accept="audio/*" className="visually-hidden-file"
        onChange={(e) => { void onFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      <audio
        ref={fileElRef}
        preload="auto"
        // No onEnded handler: a running session is never ended from here. The
        // element is looping, and if it ever lapses anyway the audio class's
        // keep-alive replays it quietly — React flipping running=false would
        // throw the session away over an environment hiccup, which is exactly
        // the auto-vanish this file used to have.
        onError={(ev) => {
          const el = ev.currentTarget;
          const code = el.error?.code;
          const why = code === 4
            ? 'That file type is not supported by this browser.'
            : code === 3 ? 'That audio file could not be decoded.'
            : code === 2 ? 'That audio file could not be found.'
            : 'That audio file could not be played.';
          setError(why);
          setRunning(false);
          setSource(null);
        }}
      />

      {error && <div className="ink-error" role="alert">{error}</div>}
    </main>
  );
}