export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Deterministic PRNG for stable compositions. */
export function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function downloadPNG(canvas: HTMLCanvasElement, name: string) {
  const a = document.createElement('a');
  a.download = `${name}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

export function downloadText(text: string, filename: string, mime = 'image/svg+xml') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function hexToRgb(hex: string): [number, number, number] {
  const c = parseInt(hex.slice(1), 16);
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}
