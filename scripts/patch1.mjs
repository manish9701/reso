// One-off patch: wait for the element to be ready before asking it to play.
import fs from 'node:fs';

const p = 'D:/Desktop/reso/resonance-lab/src/lab/audio.ts';
let s = fs.readFileSync(p, 'utf8');

const old = `this.mediaGain.connect(this.musicBus!);
    try {
      await el.play();
    } catch (err) {
      this.failed(err, 'the Zen track');
      return false;
    }`;

const next = `this.mediaGain.connect(this.musicBus!);
    // WAIT FOR SAMPLES. The first click can arrive before the mp3 has any
    // audio data; a play() into an empty pipeline starts a session that runs
    // forever without sound — the "silent until I pause and play again"
    // report, which is a LOADING problem, not a policy one. 'canplay' is the
    // browser's own promise that the element can genuinely make sound, so we
    // wait for it (bounded) and only then ask it to play.
    await this.waitReady(el);
    try {
      await el.play();
    } catch {
      // One second chance: a play() that landed mid-load retried, now that
      // the data is definitely there.
      await this.waitReady(el);
      try {
        await el.play();
      } catch (err) {
        this.failed(err, 'the Zen track');
        return false;
      }
    }`;

if (!s.includes(old)) {
  console.error('startPreset play() block not found — file moved on again');
  process.exit(1);
}
s = s.replace(old, next);

// the waitReady helper, right before startPreset
const marker = '  async startPreset(url: string, el: HTMLAudioElement): Promise<boolean> {';
if (!s.includes('waitReady(el: HTMLAudioElement')) {
  const helper = `  /**
   * Resolve once the element can actually make sound, or give up.
   *
   * readyState >= 2 (HAVE_CURRENT_DATA) means real samples are decoded and
   * \`play()\` will not be asked to start an empty pipeline. The wait is
   * bounded: a track that never arrives must not hang the click.
   */
  private waitReady(el: HTMLAudioElement, timeoutMs = 8000): Promise<void> {
    if (el.readyState >= 2) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { cleanup(); resolve(); };
      const cleanup = () => {
        el.removeEventListener('canplay', done);
        el.removeEventListener('loadeddata', done);
        el.removeEventListener('error', done);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
      el.addEventListener('canplay', done);
      el.addEventListener('loadeddata', done);
      el.addEventListener('error', done);
    });
  }

`;
  s = s.replace(marker, helper + marker);
}

fs.writeFileSync(p, s, 'utf8');
console.log('patched: waitReady helper + gated play() in startPreset');