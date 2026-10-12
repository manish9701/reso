/**
 * AudioInput — tone generation, microphone capture and local file playback
 * feeding the same { freq, level } simulation interface.
 *
 * - Tone: the oscillator's frequency is wired DIRECTLY into the simulation
 *   (no FFT re-detection), per spec §5.
 * - Mic: analyser only, never routed to speakers. Permission-gated.
 * - File: local playback via a media element + analyser; spectral centroid
 *   approximates the effective drive frequency, RMS the level. Onsets create
 *   transient impulses (handled by the caller).
 * Files are processed locally; nothing is uploaded.
 */

export type SourceKind = 'tone' | 'mic' | 'file';

export interface AudioFrame {
  level: number;      // smoothed 0..1
  freq: number;       // Hz estimate (exact for tone)
  transient: boolean; // onset detected this frame
}

export class AudioInput {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private out: GainNode | null = null;
  private osc: OscillatorNode | null = null;
  private oscGain: GainNode | null = null;
  private micStream: MediaStream | null = null;
  private micSrc: MediaStreamAudioSourceNode | null = null;
  private mediaEl: HTMLAudioElement | null = null;
  private mediaSrc: MediaElementAudioSourceNode | null = null;
  private objectUrl: string | null = null;
  private timeBuf = new Float32Array(2048);
  private freqBuf = new Uint8Array(1024);
  private smoothed = { level: 0, freq: 220 };
  private lastLevel = 0;
  kind: SourceKind | null = null;
  lastError = '';

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.72;
      this.out = this.ctx.createGain();
      this.out.gain.value = 1;
      this.analyser.connect(this.out); // analyser→speakers only for tone/file
      this.out.connect(this.ctx.destination);
    }
    void this.ctx.resume();
    return this.ctx;
  }

  async startTone(freq: number, amplitude: number): Promise<void> {
    this.stop();
    const ctx = this.ensure();
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.frequency.value = freq;
    this.oscGain = ctx.createGain();
    this.oscGain.gain.value = 0;
    this.oscGain.gain.setTargetAtTime(0.14 * Math.max(0.05, amplitude), ctx.currentTime, 0.05);
    this.osc.connect(this.oscGain);
    this.oscGain.connect(this.analyser!);
    this.oscGain.connect(this.out!);
    this.osc.start();
    this.kind = 'tone';
    this.onToneStart?.();
  }

  onToneStart: (() => void) | null = null;

  setTone(freq: number, amplitude: number) {
    try {
      if (this.osc && this.ctx) {
        this.osc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.03);
        this.oscGain?.gain.setTargetAtTime(0.14 * Math.max(0.05, amplitude), this.ctx.currentTime, 0.05);
      }
    } catch { /* tone already stopped */ }
  }

  async startMic(): Promise<boolean> {
    this.stop();
    const ctx = this.ensure();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      this.lastError = 'Microphone access was not granted.';
      return false;
    }
    this.micSrc = ctx.createMediaStreamSource(this.micStream);
    // analyser ONLY — no connection to destination (no feedback loop)
    this.micSrc.connect(this.analyser!);
    this.kind = 'mic';
    return true;
  }

  async startFile(file: File, el: HTMLAudioElement): Promise<boolean> {
    this.stop();
    const ctx = this.ensure();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    el.src = this.objectUrl;
    el.load();
    if (!this.mediaSrc) this.mediaSrc = ctx.createMediaElementSource(el);
    try { this.mediaSrc.disconnect(); } catch { /* not yet connected */ }
    this.mediaSrc.connect(this.analyser!);
    this.mediaEl = el;
    try {
      await el.play();
    } catch {
      this.lastError = 'The browser refused to play that file.';
      return false;
    }
    this.kind = 'file';
    return true;
  }

  stop() {
    try { this.osc?.stop(); } catch { /* already stopped */ }
    this.osc = null;
    try { this.micSrc?.disconnect(); } catch { /* noop */ }
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micSrc = null;
    this.mediaEl?.pause();
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.02);
    this.kind = null;
  }

  /** One analysis frame; safe to call every rAF. */
  frame(): AudioFrame {
    const a = this.analyser;
    if (!a || !this.kind) {
      this.smoothed.level *= 0.92;
      return { level: this.smoothed.level, freq: this.smoothed.freq, transient: false };
    }
    a.getFloatTimeDomainData(this.timeBuf);
    a.getByteFrequencyData(this.freqBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i += 4) sum += this.timeBuf[i] * this.timeBuf[i];
    const rms = Math.sqrt(sum / (this.timeBuf.length / 4));
    const level = Math.min(1, rms * 4.2);
    // spectral centroid over 80–2400 Hz for mic/file (tone uses exact value)
    let num = 0, den = 0;
    const binHz = (this.ctx?.sampleRate ?? 48000) / a.fftSize;
    for (let i = 2; i < Math.min(250, this.freqBuf.length); i++) {
      const w = this.freqBuf[i];
      num += w * i * binHz;
      den += w;
    }
    const centroid = den > 8 ? num / den : this.smoothed.freq;
    if (this.kind === 'tone') this.smoothed.freq = this.osc?.frequency.value ?? 220;
    else this.smoothed.freq += (centroid - this.smoothed.freq) * 0.06;
    this.smoothed.level += (level - this.smoothed.level) * 0.25;
    // onset: sharp rise in level
    const transient = this.smoothed.level > 0.2 && this.smoothed.level - this.lastLevel > 0.16;
    this.lastLevel = this.smoothed.level;
    return { level: this.smoothed.level, freq: this.smoothed.freq, transient };
  }

  dispose() {
    this.stop();
    try { this.mediaSrc?.disconnect(); } catch { /* noop */ }
    this.analyser?.disconnect();
    this.out?.disconnect();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
