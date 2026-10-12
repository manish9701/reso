import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getSettings, toggleMuted, toggleReduced, useSettings } from './lib/settings';
import { dock } from './lib/dock';
import * as Audio from './lib/audio';
import { Hero, Gallery, type ToyMeta } from './ui/Home';

// Code-split: each instrument loads on demand so the gallery stays light.
const Ink = lazy(() => import('./toys/Ink'));
const Garden = lazy(() => import('./toys/Garden'));
const Weaver = lazy(() => import('./toys/Weaver'));
const Moire = lazy(() => import('./toys/Moire'));
const Fossil = lazy(() => import('./toys/Fossil'));

const TOYS: ToyMeta[] = [  { n: 1, id: 'ink', name: 'Resonant Ink', one: 'Make sound bloom into pigment.', c1: '#46e0d2', c2: '#7c6bff', about: 'Tap the liquid. Every strike sings a tone and throws a ripple through living pigment. Layer strikes into a painting, then freeze it.' },
  { n: 2, id: 'garden', name: 'Harmonic Garden', one: 'Arrange waves; discover interference.', c1: '#7c6bff', c2: '#ff5fa2', about: 'Drag luminous sources around the field. Where their waves overlap, corridors, rosettes and cells appear. Tune phase to reorganise everything.' },
  { n: 3, id: 'weaver', name: 'Wavelength Weaver', one: 'Draw with frequency and phase.', c1: '#ffb35c', c2: '#ff5fa2', about: 'A pen driven by two oscillators. Pick a ratio, turn the phase dial — circles grow into petals, knots and lace. Trails never clear unless you say so.' },
  { n: 4, id: 'moire', name: 'Shadow Moiré', one: 'Make images out of alignment.', c1: '#e8eaf0', c2: '#46e0d2', about: 'Two transparent plates, nothing more. Slide and rotate them — the image neither plate contains appears only in the overlap. Capture prints you love.' },
  { n: 5, id: 'fossil', name: 'Sonar Fossil', one: 'Send pulses; shape a landscape.', c1: '#ffd9a0', c2: '#46e0d2', about: 'The sand remembers. Each tap fires a sonar pulse that raises ridges and hollows that stay. Overlap pulses to grow topography, rake to sculpt it.' },
];
type Screen = string; // 'home' | toy id

function screenFromHash(): Screen {
  const id = window.location.hash.replace(/^#\/?/, '').replace(/\/$/, '');
  return TOYS.some((t) => t.id === id) ? id : 'home';
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(screenFromHash);
  const { muted, reduced } = useSettings();

  useEffect(() => {
    Audio.setMuted(getSettings().muted);
  }, [muted]);

  const open = useCallback((id: string) => {
    window.location.hash = id === 'home' ? '' : `/${id}`;
    setScreen(id);
    requestAnimationFrame(() => {
      document.getElementById('stage-anchor')?.scrollIntoView({ block: 'nearest', behavior: getSettings().reduced ? 'auto' : 'smooth' });
    });
  }, []);

  useEffect(() => {
    const onHash = () => setScreen(screenFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const k = e.key.toLowerCase();
      const editing = !!t && (
        t.tagName === 'INPUT' ||
        t.tagName === 'SELECT' ||
        t.tagName === 'TEXTAREA' ||
        (t as HTMLElement).isContentEditable
      );
      // Let native buttons and links retain Space/Enter activation. Global shortcuts
      // only run when focus is on the page/canvas, not while using the interface.
      const interactive = !!t?.closest('button, a, [role="button"], [role="slider"]');
      if (editing) return;
      if (interactive && k !== 'escape') return;
      if (k >= '1' && k <= '5') open(TOYS[parseInt(k) - 1].id);
      else if (k === ' ') { e.preventDefault(); dock.toggle?.(); }
      else if (k === 'c') dock.clear?.();
      else if (k === 'e') dock.export?.();
      else if (k === 'escape' && screen !== 'home') open('home');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, screen]);

  const meta = TOYS.find((t) => t.id === screen);

  return (
    <>
      <header className="topbar">
        <div className="logo"><span>◍</span></div>
        <button type="button" className="brand brand-button" aria-label="Return to Resonance Lab home" onClick={() => open('home')}>
          <h1>RESONANCE <em>lab</em></h1>
          <p>five instruments · sound → image · WebGL + Tone.js + Paper Shaders</p>
        </button>
        <div className="top-actions">
          <button className="chipbtn" aria-pressed={reduced} onClick={toggleReduced} title="Reduce motion">
            motion: {reduced ? 'soft' : 'full'}
          </button>
          <button className="chipbtn" aria-pressed={muted} onClick={toggleMuted} title="Mute all sound">
            sound: {muted ? 'off' : 'on'}
          </button>
          {screen !== 'home' && (
            <button className="chipbtn" onClick={() => open('home')} title="Back to gallery">⌂ lab</button>
          )}
        </div>
      </header>

      {screen === 'home' ? (
        <motion.div key="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <Hero onEnter={open} />
          <Gallery toys={TOYS} onOpen={open} />
        </motion.div>
      ) : (
        <>
          <nav className="selector" aria-label="Choose instrument">
            {TOYS.map((t) => (
              <button
                key={t.id}
                className={`sel${t.id === screen ? ' active' : ''}`}
                style={{ ['--c1' as string]: t.c1, ['--c2' as string]: t.c2 }}
                onClick={() => open(t.id)}
              >
                <div className="num">0{t.n} — INSTRUMENT</div>
                <div className="nm">{t.name}</div>
                <div className="one">{t.one}</div>
                <kbd>{t.n}</kbd>
                <div className="bar" />
              </button>
            ))}
          </nav>
          <main className="wrap" id="stage-anchor">
            <AnimatePresence mode="wait">
              <motion.div
                key={screen}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              >
                {meta && (
                  <div className="toyhead">
                    <span className="tag">0{meta.n}</span>
                    <h2>{meta.name}</h2>
                    <p>{meta.about}</p>
                  </div>
                )}
                <Suspense fallback={<div className="stage"><div className="hint">Tuning the instrument…</div></div>}>
                  {screen === 'ink' && <Ink />}
                  {screen === 'garden' && <Garden />}
                  {screen === 'weaver' && <Weaver />}
                  {screen === 'moire' && <Moire />}
                  {screen === 'fossil' && <Fossil />}
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </main>
        </>
      )}

      <footer>
        <b>Resonance Lab</b> · React + WebGL + Tone.js + Paper Shaders + simplex-noise · click / drag /
        keys <b>1–5</b> · <b>space</b> pause · <b>C</b> clear · <b>E</b> export · <b>esc</b> gallery
        &nbsp;·&nbsp; sound starts only after you tap · mic never auto-asked
      </footer>
    </>
  );
}
