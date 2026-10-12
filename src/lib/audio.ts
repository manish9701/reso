/**
 * Pro-audio engine built on Tone.js.
 * Everything is lazy + fault-tolerant: audio must never crash a toy.
 */
import * as Tone from 'tone';

let booted = false;
let bootPromise: Promise<void> | null = null;

let bus: Tone.Gain | null = null;
let verb: Tone.Reverb | null = null;

let bell: Tone.PolySynth | null = null;
let low: Tone.MonoSynth | null = null;
let bright: Tone.PolySynth | null = null;
let thumpSynth: Tone.MembraneSynth | null = null;
let humOsc: Tone.Oscillator | null = null;
let humGain: Tone.Gain | null = null;

let mic: Tone.UserMedia | null = null;
let micAnalyser: Tone.Analyser | null = null;

function send(node: Tone.ToneAudioNode, wet: number) {
  if (!bus || !verb) return;
  const g = new Tone.Gain(wet);
  node.connect(g);
  g.connect(verb);
}

export async function ensureAudio(): Promise<void> {
  if (booted) return;
  if (!bootPromise) {
    bootPromise = (async () => {
      await Tone.start();
      const limiter = new Tone.Limiter(-2).toDestination();
      bus = new Tone.Gain(0.9);
      bus.connect(limiter);
      verb = new Tone.Reverb({ decay: 5.5, wet: 1 });
      verb.connect(bus);
      void verb.generate().catch(() => {});

      bell = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 2.99,
        modulationIndex: 16,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.004, decay: 0.5, sustain: 0, release: 1.8 },
        modulation: { type: 'sine' },
        modulationEnvelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.9 },
      });
      bell.volume.value = -10;
      bell.connect(bus);
      send(bell, 0.55);

      low = new Tone.MonoSynth({
        oscillator: { type: 'sine' },
        filter: { Q: 1, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.01, decay: 0.5, sustain: 0.25, release: 1.4 },
        filterEnvelope: { attack: 0.01, decay: 0.35, sustain: 0.3, baseFrequency: 110, octaves: 2.6 },
      });
      low.volume.value = -7;
      low.connect(bus);
      send(low, 0.4);

      bright = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.003, decay: 0.3, sustain: 0, release: 1.1 },
      });
      bright.volume.value = -14;
      const echo = new Tone.FeedbackDelay({ delayTime: 0.31, feedback: 0.38, wet: 0.5 });
      bright.connect(echo);
      echo.connect(bus);
      bright.connect(bus);
      send(bright, 0.5);

      thumpSynth = new Tone.MembraneSynth({
        pitchDecay: 0.045,
        octaves: 6,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.4 },
      });
      thumpSynth.volume.value = -6;
      thumpSynth.connect(bus);
      send(thumpSynth, 0.35);

      humGain = new Tone.Gain(0);
      const humFilter = new Tone.Filter(700, 'lowpass');
      humGain.connect(humFilter);
      humFilter.connect(bus);
      humOsc = new Tone.Oscillator(180, 'sine');
      humOsc.connect(humGain);
      humOsc.start();

      booted = true;
    })().catch(() => {
      bootPromise = null;
    });
  }
  await bootPromise;
}

export type StrikeKind = 'low' | 'bell' | 'drone' | 'bright';

export function strike(kind: StrikeKind, freq: number) {
  try {
    if (!booted) return;
    if (kind === 'low') low?.triggerAttackRelease(freq, 1.6);
    else if (kind === 'bell') bell?.triggerAttackRelease(freq, 1.8);
    else if (kind === 'bright') bright?.triggerAttackRelease(freq, 1.1);
    else if (kind === 'drone') {
      low?.triggerAttackRelease(freq / 2, 2.6);
      bell?.triggerAttackRelease(freq * 2, 2.0, '+0.06', 0.35);
    }
  } catch {
    /* audio is decorative */
  }
}

export function thump(strength = 1) {
  try {
    if (!booted || !thumpSynth) return;
    thumpSynth.triggerAttackRelease('C1', 0.5, undefined, Math.min(1, 0.35 + strength * 0.5));
  } catch {
    /* noop */
  }
}

export function humStart(freq = 180) {
  try {
    if (!booted || !humGain || !humOsc) return;
    humOsc.frequency.value = freq;
    humGain.gain.rampTo(0.05, 0.4);
  } catch {
    /* noop */
  }
}

export function humFreq(freq: number) {
  try {
    humOsc?.frequency.rampTo(freq, 0.1);
  } catch {
    /* noop */
  }
}

export function humStop() {
  try {
    humGain?.gain.rampTo(0, 0.25);
  } catch {
    /* noop */
  }
}

export function setMuted(m: boolean) {
  try {
    Tone.Destination.mute = m;
  } catch {
    /* noop */
  }
}

/** Open the microphone (explicit user gesture only). Returns false if denied. */
export async function micOpen(): Promise<boolean> {
  try {
    await ensureAudio();
    micClose();
    mic = new Tone.UserMedia();
    await mic.open();
    micAnalyser = new Tone.Analyser('waveform', 1024);
    mic.connect(micAnalyser);
    return true;
  } catch {
    micClose();
    return false;
  }
}

/** 0..~1 room level from the mic analyser. */
export function micLevel(): number {
  try {
    if (!micAnalyser) return 0;
    const v = micAnalyser.getValue() as Float32Array;
    let s = 0;
    const n = Math.floor(v.length / 8);
    for (let i = 0; i < v.length; i += 8) s += Math.abs(v[i]);
    return Math.min(1, s / Math.max(1, n));
  } catch {
    return 0;
  }
}

export function micClose() {
  try {
    mic?.close();
    mic?.dispose();
    micAnalyser?.dispose();
  } catch {
    /* noop */
  }
  mic = null;
  micAnalyser = null;
}
