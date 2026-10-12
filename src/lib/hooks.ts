import { useEffect, useRef } from 'react';

/** requestAnimationFrame loop with clamped dt; pauses when tab hidden. */
export function useRafLoop(active: boolean, fn: (dt: number, t: number) => void) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    let t = 0;
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (document.hidden) {
        last = now;
        return;
      }
      const dt = Math.min(0.05, Math.max(0.0005, (now - last) / 1000));
      last = now;
      t += dt;
      fnRef.current(dt, t);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/** Observe an element's CSS pixel size. */
export function useResize<T extends HTMLElement>(cb: (w: number, h: number) => void) {
  const ref = useRef<T | null>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      cbRef.current(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return ref;
}
