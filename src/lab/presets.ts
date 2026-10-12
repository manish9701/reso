/**
 * PresetBank — a short fixed list of mode starting points.
 * Selecting a preset sets MODEL PARAMETERS (drive frequency + pigment
 * behaviour). It deliberately carries NO colour: the water is coloured only
 * by whatever the user drops in, so a preset never paints over the dish.
 */
import { BANKS, resolveDrive, besselJ, VESSEL, type Boundary } from './resonance';

export interface LabPreset {
  name: string;
  freq: number;          // drive frequency (snaps to a real bank mode)
  gather: number;        // pigment behaviour: Flow(0.15) .. Stick(0.8)
  diffusion: number;
}

function nearestModeFreq(target: number, boundary: Boundary = 'rigid'): number {
  let best = BANKS[boundary][0], d = Infinity;
  for (const md of BANKS[boundary]) {
    const dd = Math.abs(md.freq - target);
    if (dd < d) { d = dd; best = md; }
  }
  return best.freq;
}

export const PRESETS: LabPreset[] = [
  { name: 'Fundamental',   freq: nearestModeFreq(110), gather: 0.2,  diffusion: 0.10 },
  { name: 'Two-lobe',      freq: nearestModeFreq(150), gather: 0.35, diffusion: 0.08 },
  { name: 'Four-lobe',     freq: nearestModeFreq(240), gather: 0.35, diffusion: 0.08 },
  { name: 'Fine radial',   freq: nearestModeFreq(620), gather: 0.25, diffusion: 0.12 },
  { name: 'Interference',  freq: (nearestModeFreq(300) + nearestModeFreq(340)) / 2, gather: 0.3, diffusion: 0.16 },
  { name: 'Pigment study', freq: nearestModeFreq(265), gather: 0.55, diffusion: 0.06 },
];

/** Nodal-diagram thumbnail (monochrome) for a preset's mode. */
export function presetThumb(preset: LabPreset, boundary: Boundary = 'rigid', size = 120): string {
  const cn = document.createElement('canvas');
  cn.width = cn.height = size;
  const c2 = cn.getContext('2d')!;
  const img = c2.createImageData(size, size);
  const res = resolveDrive(preset.freq, BANKS[boundary]);
  const { a, b, wa, wb } = res;
  const blend = wb / Math.max(0.001, wa + wb);
  const km = a.k * VESSEL.radius, kn = b.k * VESSEL.radius;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x / (size - 1)) * 2 - 1, v = (y / (size - 1)) * 2 - 1;
    const rr = Math.hypot(u, v);
    const th = Math.atan2(v, u);
    const fa = besselJ(a.m, km * rr) * Math.cos(a.m * th);
    const fb = besselJ(b.m, kn * rr) * Math.cos(b.m * th);
    const val = Math.abs(fa + (fb - fa) * blend);
    const i = (y * size + x) * 4;
    const g = val < 0.055 ? 36 : 246 - Math.min(52, rr * 42);
    img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
  }
  c2.putImageData(img, 0, 0);
  return cn.toDataURL();
}
