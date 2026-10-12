import { motion } from 'framer-motion';
import { MeshGradient } from '@paper-design/shaders-react';
import { useSettings } from '../lib/settings';
import { InstrumentPreview } from './Previews';

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
  return (
    <section className="hero">
      <div className="hero-bg" aria-hidden="true">
        <MeshGradient
          colors={['#0a0f22', '#134b5a', '#3b2a6e', '#0e2a3a']}
          distortion={0.9}
          swirl={0.45}
          speed={reduced ? 0 : 0.35}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      <div className="hero-inner">
        <div className="hero-kicker"><span className="hero-kicker-dot" /> A SMALL LAB FOR CURIOUS MINDS <span className="hero-kicker-line" /></div>
        <motion.h2
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          Make a little <b>beautiful noise.</b>
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.12 }}
        >
          Five interactive instruments for turning sound, movement and mathematics into things you can touch, change and keep.
        </motion.p>
        <motion.div
          className="hero-actions"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.22 }}
        >
          <button className="hero-primary" onClick={() => onEnter('ink')}>
            Enter Resonant Ink <span aria-hidden="true">↗</span>
          </button>
          <button className="hero-secondary" onClick={() => document.getElementById('instrument-gallery')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })}>
            Explore all five <span aria-hidden="true">↓</span>
          </button>
          <span className="hero-footnote">No setup · Sound only when you choose · Save your experiments</span>
        </motion.div>
        <div className="hero-signature" aria-hidden="true">
          <span className="signature-index">01—05</span>
          <span className="signature-rule" />
          <span>WEBGL / SOUND / FORM</span>
        </div>
      </div>
    </section>
  );
}

export function Gallery({ toys, onOpen }: { toys: ToyMeta[]; onOpen: (id: string) => void }) {
  return (
    <section className="gallery-section" id="instrument-gallery">
      <div className="gallery-heading">
        <div>
          <span className="section-kicker">THE INSTRUMENTS</span>
          <h2>Five ways to <em>play with reality.</em></h2>
        </div>
        <p>Start anywhere. Follow the shape that catches your eye.</p>
      </div>
      <div className="gallery">
        {toys.map((t, i) => (
          <motion.button
            key={t.id}
            className="card"
            style={{ ['--c1' as string]: t.c1, ['--c2' as string]: t.c2 }}
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 + i * 0.07, ease: [0.22, 1, 0.36, 1] }}
            whileHover={{ y: -4 }}
            whileTap={{ scale: 0.99 }}
            onClick={() => onOpen(t.id)}
            aria-label={`Open ${t.name}: ${t.one}`}
          >
            <div className="swatch">
              <InstrumentPreview id={t.id} />
              <div className="swatch-shade" aria-hidden="true" />
              <div className="swatch-meta">
                <span>STUDY 0{t.n}</span>
                <span className="preview-live"><i /> LIVE STUDY</span>
              </div>
              <div className="swatch-bottom">
                <span>{t.id === 'ink' ? 'SOUND → PIGMENT' : t.id === 'garden' ? 'WAVES → FORM' : t.id === 'weaver' ? 'RATIO → LINE' : t.id === 'moire' ? 'ALIGN → REVEAL' : 'PULSE → TERRAIN'}</span>
                <span className="preview-arrow" aria-hidden="true">↗</span>
              </div>
            </div>
            <div className="body">
              <div className="card-title-row">
                <span className="num">0{t.n}</span>
                <h3>{t.name}</h3>
              </div>
              <p>{t.one} {t.about.split('.')[0]}.</p>
              <span className="go">OPEN INSTRUMENT <span aria-hidden="true">↗</span></span>
            </div>
            <div className="bar" />
          </motion.button>
        ))}
      </div>
      <div className="gallery-foot">
        <span><i /> FIVE SMALL WORLDS</span>
        <span>MAKE SOMETHING / SAVE IT / MAKE ANOTHER</span>
      </div>
    </section>
  );
}
