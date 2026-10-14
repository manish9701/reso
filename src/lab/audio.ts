/**
 * AudioInput — the audible side of Resonant Ink.
 *
 * There are exactly TWO drivers in the UI, and only one of them makes sound:
 *
 *  1. **Frequency** — silent. The slider drives the vessel's modes directly and
 *     nothing is played or analysed. The frequency is a property of the
 *     simulation, not a sound.
 *  2. **Tone** — a real audible signal drives the vessel. Three sources:
 *       - the bundled track (`zen-tones.mp3`),
 *       - the generated piece (synthesised in Web Audio),
 *       - the user's own local audio file.
 *
 * Every source goes through the SAME chain:
 *
 *     source -> musicBus -> musicGain -> analyser -> out -> speakers
 *
 * so all three are equally loud and the water is always reading exactly what
 * you are hearing. Files are processed locally; nothing is uploaded.
 *
 * Simple by design: a click starts a source, the transport pauses/continues
 * it, and a refused play reports itself with a named error. Nothing runs
 * behind the user's back.
 */

export type SourceKind = 'preset' | 'builtIn' | 'file';

export interface AudioFrame {
  level: number;      // smoothed 0..1
  freq: number;       // Hz estimate (spectral centroid)
  transient: boolean; // onset detected this frame
  /** Smoothed energy of the four log-spaced bands the water reads. */
  bands: number[];
}

export const AUDIO_BAND_CENTERS = [140, 500, 1800, 5500];

export class AudioInput {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private out: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private step = 0;
  private nextNoteTime = 0;
  private nodes: OscillatorNode[] = [];

  private mediaEl: HTMLAudioElement | null = null;
  private mediaSrc: MediaElementAudioSourceNode | null = null;
  private mediaGain: GainNode | null = null;
  private objectUrl: string | null = null;

  private timeBuf = new Float32Array(2048);
  private freqBuf = new Uint8Array(1024);
  private smoothed = { level: 0, freq: 220 };
  private bandSmoothed = [0, 0, 0, 0];
  /**
   * Per-band running peaks the band energies normalise against.
   *
   * Without this the four bands fight on raw energy, and they will never
   * fight fairly: in any mastered track the bass bins hold 10-20x the energy
   * of the top end, so with absolute levels the presence/sparkle bands read
   * ~0.05 at their peaks and the dish showed high-order reactions to NOTHING.
   * Normalising each band against its own decaying maximum keeps the dynamics
   * INSIDE the band and makes highs speak when the track genuinely raises
   * them — without inventing content in silent bands, because a raw energy
   * of 0 still yields 0.
   */
  private bandPeak = [0.05, 0.05, 0.05, 0.05];
  /** running peak the level is auto-gained against (see frame()) */
  private peak = 0.25;
  private lastLevel = 0;
  kind: SourceKind | null = null;
  paused = false;
  lastError = '';
  /** The verbatim DOMException behind the last failed play(), for diagnosis. */
  lastErrorDetail = '';
  /** QA probe: the live context state ('running' | 'suspended' | 'closed' | null). */
  get engineState(): string { return this.ctx?.state ?? 'none'; }
  /** QA handle: the live context, so harnesses can drive its state directly. */
  get context(): AudioContext | null { return this.ctx; }

  private outputLevel = 0.6;

  /**
   * Create the graph, rebuilding it if the old context somehow died.
   *
   * When the context is rebuilt, EVERY node cached against the dead one has to
   * go — a node from a closed context throws "cannot connect to an AudioNode
   * belonging to a different audio context" the moment it touches a node from
   * the new one.
   */
  private ensure(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      if (this.ctx) {
        this.analyser = null;
        this.out = null;
        this.musicBus = null;
        this.musicGain = null;
        this.mediaSrc = null;
        this.mediaGain = null;
      }
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.72;
      this.out = this.ctx.createGain();
      this.out.gain.value = this.outputLevel;
      this.musicBus = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 1;
      this.musicBus.connect(this.musicGain);
      this.musicGain.connect(this.analyser);
      this.analyser.connect(this.out);
      this.out.connect(this.ctx.destination);
    }
    // A context the browser suspended (hidden tab, autoplay policy, OS audio
    // routing change) stays suspended forever unless something resumes it.
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /**
   * Create/resume the graph and GUARANTEE it runs.
   *
   * ensure() alone resumes WITHOUT awaiting, so a context that arrived
   * suspended left the whole graph frozen while the media element "played"
   * silently into it — audible to nobody. Here the resume is awaited,
   * retried over a few scheduler ticks, and the caller can trust the returned
   * context is actually running — or fail cleanly with the reason.
   */
  private async ensureRunning(): Promise<AudioContext> {
    const ctx = this.ensure();
    for (let attempt = 0; attempt < 3 && !this.runningNow(ctx); attempt++) {
      try { await ctx.resume(); } catch { /* the play() path surfaces the real reason */ }
      if (!this.runningNow(ctx)) await new Promise((r) => setTimeout(r, 50));
    }
    return ctx;
  }

  /**
   * Live state read through a function boundary. Direct `ctx.state`
   * comparisons after an awaited `resume()` trip TypeScript's property
   * narrowing (it believes resume cannot have changed the property), so the
   * honest check is made through a call it cannot inline.
   */
  private runningNow(ctx: AudioContext): boolean {
    return ctx.state === 'running';
  }

  /**
   * Report a refused play() verbatim — there is no such thing as a silent
   * failure any more: a track either plays, or there is a named error in the
   * UI and the console. That distinction is the "either it plays or it
   * doesn't" contract.
   */
  private failed(err: unknown, what: string): void {
    const name = err instanceof DOMException ? err.name : 'unknown';
    this.lastError =
      name === 'NotAllowedError'
        ? `The browser blocked ${what} — click play again, and allow sound for this site.`
        : name === 'NotSupportedError'
          ? `This browser could not decode ${what}.`
          : `${what.charAt(0).toUpperCase() + what.slice(1)} could not start (${name}).`;
    this.lastErrorDetail = name + ': ' + (err instanceof Error ? err.message : String(err));
    console.error('[audio]', this.lastErrorDetail);
  }

  /**
   * Bind the shared <audio> element to the CURRENT context, once.
   *
   * An HTMLMediaElement may only ever be wrapped by one
   * MediaElementAudioSourceNode, and that node belongs to the context it was
   * created in. If this class ever rebuilds its context, the cached node is
   * stale and connecting it to anything fresh throws — so the cache is checked
   * against the live context and discarded when it does not match.
   */
  private bindMedia(el: HTMLAudioElement, ctx: AudioContext): MediaElementAudioSourceNode {
    if (this.mediaSrc && this.mediaSrc.context !== ctx) {
      try { this.mediaSrc.disconnect(); } catch { /* already gone */ }
      this.mediaSrc = null;
    }
    if (!this.mediaSrc) this.mediaSrc = ctx.createMediaElementSource(el);
    return this.mediaSrc;
  }

  /**
   * Create/resume the graph INSIDE a user gesture.
   *
   * This has to happen on the button click, not later on the file input's
   * change event. Choosing a file breaks the gesture chain — the change event
   * arrives in a fresh task with no user activation left — so anything awaited
   * after it starts from a suspended AudioContext and play() is refused.
   * Unlocking here, while the click is still a gesture, is what makes upload
   * work the first time.
   */
  unlock(): void {
    try { this.ensure(); } catch { /* the real error surfaces on play() */ }
  }

  /**
   * Attach the media element's Web Audio tap EARLY — at mount, before the
   * first click.
   *
   * The bundled track is the first thing anyone plays, and building its
   * MediaElementAudioSourceNode in the SAME tick as its first play let the
   * opening stream slip past a tap that did not exist yet: the track ran,
   * the analyser read a dead line, and only pause+play (by which time the
   * node existed) produced sound. Attaching here means the tap is in place
   * before the element ever fetches a byte, so the FIRST click plays.
   */
  prime(el: HTMLAudioElement): void {
    try {
      const ctx = this.ensure();
      this.mediaEl = el;
      this.bindMedia(el, ctx);
    } catch { /* the play() path reports real problems */ }
  }

  setVolume(v: number): void {
    this.outputLevel = Math.max(0, Math.min(1, v));
    if (this.out && this.ctx) {
      this.out.gain.setTargetAtTime(this.outputLevel, this.ctx.currentTime, 0.08);
    }
  }

  /**
   * The bundled track.
   *
   * It is played through the same chain as everything else, so it is as loud
   * as the generated piece and the analyser is reading exactly what the ear
   * hears. The element is the one the UI already holds, so switching sources
   * never leaves a detached node behind.
   */
  /**
   * Resolve once the element can actually make sound, or give up.
   *
   * readyState >= 2 (HAVE_CURRENT_DATA) means real samples are decoded and
   * `play()` will not be asked to start an empty pipeline. The wait is
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

  async startPreset(url: string, el: HTMLAudioElement): Promise<boolean> {
    // Idempotent guard: a repeated invocation (double dispatch, stray second
    // click) must not stop the session it already started.
    if (this.kind === 'preset' && !this.paused) return true;
    this.stop();
    const ctx = await this.ensureRunning();
    this.mediaEl = el;
    // Only touch `src` when it actually changes: assigning the SAME url
    // reloads the element (and drops the tap's stream) for no reason.
    if (el.getAttribute('src') !== url) el.src = url;
    el.loop = true;
    const src = this.bindMedia(el, ctx);
    try { src.disconnect(); } catch { /* not yet connected */ }
    this.mediaGain = ctx.createGain();
    this.mediaGain.gain.value = 1;
    src.connect(this.mediaGain);
    this.mediaGain.connect(this.musicBus!);
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
    }
    // The element "playing" is not yet the contract — sound routes through the
    // Web Audio graph, and a context that never left `suspended` would leave
    // the track playing INTO a frozen graph: audible to nobody. Refuse that
    // outcome loudly instead of shipping it as a silent no-sound session.
    if (!this.runningNow(ctx)) {
      try { await ctx.resume(); } catch { /* falls through to the refusal */ }
      if (!this.runningNow(ctx)) {
        this.lastError = 'The audio engine would not start — click play again.';
        return false;
      }
    }
    this.kind = 'preset';
    this.paused = false;
    this.lastError = '';
    return true;
  }

  /**
   * The generated piece.
   *
   * A slow pentatonic drone with a plucked melody over it. Synthesised rather
   * than shipped as a binary so there is nothing to fetch and it never ends.
   * Every note is in the scale, so no combination can sound like a mistake
   * however long it runs.
   */
  async startBuiltIn(volume = 0.6): Promise<boolean> {
    if (this.kind === 'builtIn' && !this.paused) return true;
    this.stop();
    // Same contract as the element sources: the synth network is only audible
    // through a RUNNING context, so guarantee it before a single note.
    const ctx = await this.ensureRunning();
    this.setVolume(volume);

    const bus = ctx.createGain();
    bus.gain.value = 0.55;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    lp.Q.value = 0.5;
    bus.connect(lp);
    lp.connect(this.musicBus!);

    const verb = ctx.createConvolver();
    try {
      const len = Math.floor(ctx.sampleRate * 2.6);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const ch = ir.getChannelData(c);
        for (let i = 0; i < len; i++) {
          ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6) * 0.5;
        }
      }
      verb.buffer = ir;
    } catch { /* no reverb; dry is still fine */ }
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    bus.connect(verb);
    verb.connect(wet);
    wet.connect(this.musicBus!);

    for (const [mult, gain, detune] of [[0.5, 0.16, -4], [0.75, 0.11, 5], [1, 0.13, 0], [1.5, 0.07, 7]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 110 * mult;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(bus);
      o.start();
      this.nodes.push(o);
    }

    this.step = 0;
    this.nextNoteTime = ctx.currentTime + 0.12;
    this.kind = 'builtIn';
    this.paused = false;
    this.lastError = '';
    this.pump();
    return true;
  }

  private static readonly SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
  private static readonly ROOT = 220; // A3

  /**
   * Schedule the generated piece a little ahead of the audio clock.
   *
   * Driven from the render loop (never a bare setInterval of the old kind — a
   * throttle in a hidden tab starved the queue and let a running session die
   * mid-bar).
   */
  pump(): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus || this.kind !== 'builtIn' || this.paused) return;
    const beat = 0.46;
    //
    // RESYNC, never replay. While the tab is hidden rAF stops, so pump() is
    // not called; on return `nextNoteTime` is up to the WHOLE hidden duration
    // behind the audio clock. Catching up by scheduling every missed beat at
    // once means three hidden minutes as ~400 oscillators created in a single
    // frame — an audio glitch-storm that reads as the session dying. Beats the
    // clock has passed are counted and skipped instead: resync to the next bar
    // from now. (`scripts/session.mjs` measures the oscillator rate on return.)
    if (this.nextNoteTime < ctx.currentTime - 0.2) {
      const missed = Math.ceil((ctx.currentTime - this.nextNoteTime) / beat);
      this.step += missed;
      this.nextNoteTime = ctx.currentTime + 0.12;
    }
    // Runway 1.2 s: comfortably more than one render frame, so a long frame
    // cannot starve the queue.
    while (this.nextNoteTime < ctx.currentTime + 1.2) {
      const t = this.nextNoteTime;
      const s = this.step++;
      const deg = MELODY_WALK[s % MELODY_WALK.length];
      const semis = AudioInput.SCALE[((deg % AudioInput.SCALE.length) + AudioInput.SCALE.length) % AudioInput.SCALE.length];
      const freq = AudioInput.ROOT * Math.pow(2, semis / 12);

      if (s % 2 === 0) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq;
        const g = ctx.createGain();
        const peak = 0.10 + 0.06 * Math.sin(s * 0.7);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
        o.connect(g);
        g.connect(bus);
        o.start(t);
        o.stop(t + 1.6);
        this.nodes.push(o);
        o.onended = () => { try { o.disconnect(); } catch { /* gone */ } };
      }
      if (s % 8 === 0) {
        // soft low thump for the transient detector to find
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(130, t);
        o.frequency.exponentialRampToValueAtTime(48, t + 0.28);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o.connect(g);
        g.connect(bus);
        o.start(t);
        o.stop(t + 0.55);
        this.nodes.push(o);
        o.onended = () => { try { o.disconnect(); } catch { /* gone */ } };
      }
      this.nextNoteTime += beat;
    }
    if (this.nodes.length > 96) this.nodes.splice(0, this.nodes.length - 48);
  }

  async startFile(file: File, el: HTMLAudioElement): Promise<boolean> {
    // No idempotence guard here: every call carries a DIFFERENT file, so a
    // repeat invocation means "play the new one", not "restart the old one".
    this.stop();
    const ctx = await this.ensureRunning();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    el.src = this.objectUrl;
    el.loop = true;
    const src = this.bindMedia(el, ctx);
    try { src.disconnect(); } catch { /* not yet connected */ }
    this.mediaGain = ctx.createGain();
    this.mediaGain.gain.value = 1;
    src.connect(this.mediaGain);
    this.mediaGain.connect(this.musicBus!);
    this.mediaEl = el;
    try {
      await el.play();
    } catch (err) {
      this.failed(err, 'that file');
      return false;
    }
    // Same post-play contract as startPreset: the element playing into a
    // frozen context is the invisible half of "sometimes nothing plays".
    if (!this.runningNow(ctx)) {
      try { await ctx.resume(); } catch { /* falls through to the refusal */ }
      if (!this.runningNow(ctx)) {
        this.lastError = 'The audio engine would not start — click play again.';
        return false;
      }
    }
    this.kind = 'file';
    this.paused = false;
    this.lastError = '';
    return true;
  }

  /**
   * Stop / continue a running session without tearing the graph down.
   *
   * Ducking rather than stopping is deliberate: the analyser keeps sampling a
   * near-silent graph, so the water settles smoothly to rest instead of
   * snapping off, and resuming continues the same session.
   */
  async togglePause(): Promise<boolean> {
    if (!this.kind) return false;
    const ctx = await this.ensureRunning();
    if (this.paused) {
      this.paused = false;
      if (this.mediaEl) {
        try {
          await this.mediaEl.play();
        } catch (err) {
          // A refused resume is a FAILURE, not a quiet duck: leave the session
          // marked paused, with the real reason in the banner.
          this.failed(err, 'the paused track');
          this.paused = true;
          return true;
        }
      }
      if (this.musicGain) this.musicGain.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
      if (this.out) this.out.gain.setTargetAtTime(this.outputLevel, ctx.currentTime, 0.05);
      if (this.kind === 'builtIn') this.nextNoteTime = ctx.currentTime + 0.12;
      this.pump();
      return true;
    }
    this.paused = true;
    if (this.mediaEl) { try { this.mediaEl.pause(); } catch { /* noop */ } }
    if (this.musicGain) this.musicGain.gain.setTargetAtTime(0.0001, this.ctx!.currentTime, 0.06);
    if (this.out) this.out.gain.setTargetAtTime(0.0001, this.ctx!.currentTime, 0.06);
    this.smoothed.level = 0;
    return false;
  }

  stop() {
    // The keep-alive is tied to a RUNNING session; stopping the session stops it.
    for (const n of this.nodes) { try { n.stop(); } catch { /* already stopped */ } }
    this.nodes = [];
    try { this.mediaEl?.pause(); } catch { /* noop */ }
    try { this.mediaGain?.disconnect(); } catch { /* noop */ }
    this.mediaGain = null;
    this.paused = false;
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.03);
    if (this.musicGain && this.ctx) this.musicGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
    this.kind = null;
    this.lastLevel = 0;
    this.smoothed.level = 0;
    this.peak = 0.25;
    this.bandSmoothed = [0, 0, 0, 0];
    this.bandPeak = [0.05, 0.05, 0.05, 0.05];
  }

  /** One analysis frame; safe to call every rAF. */
  frame(): AudioFrame {
    const a = this.analyser;
    if (!a || !this.kind || this.paused) {
      this.smoothed.level *= 0.92;
      for (let b = 0; b < this.bandSmoothed.length; b++) this.bandSmoothed[b] *= 0.9;
      return { level: this.smoothed.level, freq: this.smoothed.freq, transient: false, bands: [...this.bandSmoothed] };
    }
    a.getFloatTimeDomainData(this.timeBuf);
    a.getByteFrequencyData(this.freqBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i += 4) sum += this.timeBuf[i] * this.timeBuf[i];
    const rms = Math.sqrt(sum / (this.timeBuf.length / 4));

    // FOUR BANDS, each read straight off the spectrum that is playing.
    //
    // One scalar centroid cannot tell a bassline from a hi-hat — it averages
    // the whole tone into a single position, which is why a busy track still
    // produced one slowly wandering mode. These four log-spaced bands keep the
    // parts separate: bass drums drive the bottom of the dish, melody the
    // middle, cymbals and shine the fine outer order. Bin indexes over
    // fftSize 2048 (~23 Hz per bin at 48 kHz), so they follow any sample rate.
    const BAND_BINS: Array<[number, number]> = [[2, 10], [11, 34], [35, 127], [128, 340]];
    for (let b = 0; b < BAND_BINS.length; b++) {
      let acc = 0, n = 0;
      for (let i = BAND_BINS[b][0]; i < Math.min(BAND_BINS[b][1] + 1, this.freqBuf.length); i++) { acc += this.freqBuf[i]; n++; }
      const raw = Math.min(1, (acc / n / 255) * 1.9);
      // peak-normalise against this band's own running maximum, like the main
      // level does — the peak decays over a few seconds so a track that opens
      // into brightness (a break to cymbals, a high vocal note) still reads
      // while one that dips keeps the dish from pinning.
      this.bandPeak[b] = Math.max(this.bandPeak[b] * 0.995, raw, 0.05);
      const inst = raw > 0 ? Math.min(1, raw / this.bandPeak[b]) : 0;
      // gentle per-band smoothing; faster than the centroid so rhythm survives
      this.bandSmoothed[b] += (inst - this.bandSmoothed[b]) * (inst > this.bandSmoothed[b] ? 0.22 : 0.05);
    }

    // Spectral centroid. This is what steers the figure, so it has to be
    // STABLE: a plucked note's centroid jumps around as the note decays, and
    // feeding that raw into the mode solver makes the figure stutter between
    // cell counts. The heavy smoothing is what makes the water follow the music
    // smoothly instead of twitching on every note.
    let num = 0, den = 0;
    const binHz = (this.ctx?.sampleRate ?? 48000) / a.fftSize;
    for (let i = 2; i < Math.min(250, this.freqBuf.length); i++) {
      const w = this.freqBuf[i];
      num += w * i * binHz;
      den += w;
    }
    const centroid = den > 8 ? num / den : this.smoothed.freq;

    // LEVEL, auto-gained against a slowly decaying running peak.
    //
    // A fixed gain cannot serve both sources. The bundled track is a quiet
    // ambient piece: measured through this chain it sat at 0.0005 for seconds
    // at a time, rising to 0.27 only at its peaks, so the drive spent most of
    // the track pinned at its floor and the water looked dead — which reads as
    // "the session has vanished" even though the audio was playing the whole
    // time. Normalising against a peak that decays over a couple of seconds
    // makes a quiet passage still move the water while keeping the dynamics.
    const raw = Math.min(1, rms * 2.4);
    this.peak = Math.max(this.peak * 0.997, raw, 0.08);
    const inst = Math.min(1, raw / this.peak);
    // Fast attack, slow release. The bundled track is ambient and has
    // genuinely silent passages; a symmetric filter let the water snap to a
    // standstill the instant one arrived, which reads as the session having
    // stopped rather than as the music getting quiet. The water now glides
    // down and comes back.
    const k = inst > this.smoothed.level ? 0.20 : 0.045;
    this.smoothed.level += (inst - this.smoothed.level) * k;

    // Clamp into a musical band. A near-silent passage makes the centroid
    // meaningless and can return 0, and 0 Hz maps to the very bottom of the
    // mode bank, which collapses the figure instead of simply going quiet.
    const target = Math.min(1500, Math.max(80, centroid));
    this.smoothed.freq += (target - this.smoothed.freq) * 0.04;

    const transient = this.smoothed.level > 0.18 && this.smoothed.level - this.lastLevel > 0.10;
    this.lastLevel = this.smoothed.level;
    return { level: this.smoothed.level, freq: this.smoothed.freq, transient, bands: [...this.bandSmoothed] };
  }

  dispose() {
    this.stop();
    try { this.mediaSrc?.disconnect(); } catch { /* noop */ }
    this.analyser?.disconnect();
    this.musicGain?.disconnect();
    this.musicBus?.disconnect();
    this.out?.disconnect();
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    this.mediaSrc = null;
    this.mediaGain = null;
    this.analyser = null;
    this.musicBus = null;
    this.musicGain = null;
    this.out = null;
    // Deliberately NOT closed, and the context is kept. An HTMLMediaElement can
    // be wrapped by exactly one MediaElementAudioSourceNode in its lifetime;
    // once that node's context is closed the element is orphaned for good, and
    // every later play throws "cannot connect to an AudioNode belonging to a
    // different audio context" — which is exactly what React's
    // mount → unmount → remount cycle was doing. An idle, suspended context is
    // free; ensure() resumes it on the next play.
  }
}

/** A fixed melodic walk, so the scheduler is a pure function of the step. */
const MELODY_WALK = [
  7, 4, 9, 2, 7, 11, 4, 9, 6, 2, 9, 0, 4, 7, 11, 6, 2, 7, 9, 4, 11, 6, 9, 2,
];
