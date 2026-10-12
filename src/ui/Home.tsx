import { motion } from 'framer-motion';
import { MeshGradient } from '@paper-design/shaders-react';
import { useSettings } from '../lib/settings';

export interface ToyMeta {
  n: number;
  id: string;
  name: string;
  one: string;
  c1: string;
  c2: string;
  about: string;
}

export function Hero({ onEnter }: { onEnter: (id: string) => void }) {
  const { reduced } = useSettings();
  void onEnter;
  return (
    <div className="hero">
      <div className="hero-bg">
        <MeshGradient
          colors={['#0a0f22', '#134b5a', '#3b2a6e', '#0e2a3a']}
          distortion={0.9}
          swirl={0.45}
          speed={reduced ? 0 : 0.5}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      <div className="hero-inner">
        <motion.h2
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          Five instruments <b>for playing with waves.</b>
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.12 }}
        >
          A collection of small browser instruments that turn sound, interference, geometry and
          topography into things you can manipulate and compose with. Pick one — every first
          interaction takes under ten seconds. Sound starts only after you tap; the mic is never
          auto-asked.
        </motion.p>
      </div>
    </div>
  );
}

const SWATCH: Record<string, string> = {
  ink: 'radial-gradient(120% 130% at 30% 30%, #123a44 0%, #0a0e1a 45%, #05060a 100%), conic-gradient(from 200deg at 65% 60%, #46e0d233, #7c6bff44, transparent 70%)',
  garden: 'radial-gradient(100% 120% at 70% 30%, #2a1f5e 0%, #0a0e1a 50%, #05060a 100%), conic-gradient(from 40deg at 35% 65%, #ff5fa233, #7c6bff55, transparent 70%)',
  weaver: 'radial-gradient(110% 120% at 50% 80%, #3a2410 0%, #0a0e1a 55%, #05060a 100%), conic-gradient(from 120deg at 60% 40%, #ffb35c33, #ff5fa244, transparent 70%)',
  moire: 'repeating-linear-gradient(115deg, #e8f4ff22 0 2px, transparent 2px 9px), repeating-linear-gradient(35deg, #46e0d233 0 2px, transparent 2px 11px), linear-gradient(180deg, #101423, #05060a)',
  fossil: 'radial-gradient(120% 130% at 60% 70%, #4a2f18 0%, #17100a 50%, #050505 100%), conic-gradient(from 300deg at 40% 35%, #ffd9a022, transparent 60%)',
};

export function Gallery({ toys, onOpen }: { toys: ToyMeta[]; onOpen: (id: string) => void }) {
  return (
    <div className="gallery">
      {toys.map((t, i) => (
        <motion.button
          key={t.id}
          className="card"
          style={{ ['--c1' as string]: t.c1, ['--c2' as string]: t.c2 }}
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08 + i * 0.07, ease: [0.22, 1, 0.36, 1] }}
          whileHover={{ y: -4 }}
          onClick={() => onOpen(t.id)}
        >
          <div className="swatch" style={{ background: SWATCH[t.id] }} />
          <div className="body">
            <div className="num">0{t.n} — INSTRUMENT</div>
            <h3>{t.name}</h3>
            <p>{t.one} {t.about.split('.')[0]}.</p>
            <span className="go">OPEN →</span>
          </div>
          <div className="bar" />
        </motion.button>
      ))}
    </div>
  );
}
