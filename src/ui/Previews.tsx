import { useEffect, useRef } from 'react';

type InstrumentId = 'ink' | 'garden' | 'weaver' | 'moire' | 'fossil';

const PALETTES: Record<InstrumentId, string[]> = {
  ink: ['#35e0d0', '#687cff', '#b06cff', '#ff5fa8', '#ffac68'],
  garden: ['#55c9ff', '#8a73ff', '#ee72c7', '#ffae72'],
  weaver: ['#5de4df', '#6f9cff', '#b17cff', '#ff76b7', '#ffc07b'],
  moire: ['#e5efff', '#64d9e8', '#a98cff', '#ffad8a'],
  fossil: ['#e4b783', '#c69c6d', '#69cad0', '#7b9bce'],
};

function background(ctx: CanvasRenderingContext2D, w: number, h: number, id: InstrumentId) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#101725');
  g.addColorStop(0.55, '#080c15');
  g.addColorStop(1, '#100d19');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const glow = ctx.createRadialGradient(w * 0.52, h * 0.5, 2, w * 0.52, h * 0.5, Math.max(w, h) * 0.72);
  const hue = id === 'ink' ? '39, 164, 177' : id === 'garden' ? '111, 78, 205' : id === 'weaver' ? '190, 77, 143' : id === 'moire' ? '91, 145, 185' : '193, 139, 81';
  glow.addColorStop(0, `rgba(${hue},0.18)`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
}

function strokePath(ctx: CanvasRenderingContext2D, points: Array<[number, number]>, color: string, width: number, alpha = 1) {
  if (points.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
  ctx.restore();
}

function drawInk(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const colors = PALETTES.ink;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const sources: Array<[number, number, number]> = [
    [w * (0.34 + Math.sin(t * 0.35) * 0.025), h * 0.53, 0.1],
    [w * 0.65, h * (0.43 + Math.cos(t * 0.28) * 0.03), 1.7],
    [w * 0.51, h * 0.68, 3.1],
  ];
  sources.forEach(([x, y, phase], si) => {
    for (let i = 0; i < 8; i++) {
      const r = 7 + i * 8 + Math.sin(t * 0.8 + phase + i * 0.32) * 2;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.34, r * 0.55, Math.sin(t * 0.16 + phase) * 0.42, 0, Math.PI * 2);
      ctx.strokeStyle = colors[(i + si * 2) % colors.length];
      ctx.globalAlpha = 0.22 + (i / 8) * 0.23;
      ctx.lineWidth = i % 3 === 0 ? 1.4 : 0.7;
      ctx.shadowColor = ctx.strokeStyle as string;
      ctx.shadowBlur = i % 3 === 0 ? 7 : 0;
      ctx.stroke();
    }
    const grad = ctx.createRadialGradient(x, y, 0, x, y, 34);
    grad.addColorStop(0, colors[(si + 2) % colors.length] + 'aa');
    grad.addColorStop(1, colors[(si + 2) % colors.length] + '00');
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(x, y, 34, 0, Math.PI * 2);
    ctx.fill();
  });
  // A fine flow filament gives the preview the sense of pigment being advected.
  for (let line = 0; line < 6; line++) {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 90; i++) {
      const u = i / 90;
      const x = u * w;
      const y = h * (0.22 + line * 0.105) + Math.sin(u * 8 + t * 0.72 + line) * 7 + Math.sin(u * 17 - t * 0.25) * 2;
      pts.push([x, y]);
    }
    strokePath(ctx, pts, colors[line % colors.length], 0.8, 0.34);
  }
  ctx.restore();
}

function drawGarden(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const sources = [
    { x: w * 0.28, y: h * 0.43, p: 0.3, c: '#55c9ff' },
    { x: w * 0.71, y: h * 0.39, p: 2.1, c: '#ee72c7' },
    { x: w * 0.52, y: h * 0.71, p: 4.1, c: '#ffae72' },
  ];
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  sources.forEach((s, si) => {
    for (let r = 1; r <= 7; r++) {
      const radius = r * 9 + Math.sin(t * 0.7 + s.p) * 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = s.c;
      ctx.globalAlpha = 0.45 - r * 0.035;
      ctx.lineWidth = r % 3 === 0 ? 1.2 : 0.65;
      ctx.shadowColor = s.c;
      ctx.shadowBlur = r % 3 === 0 ? 5 : 0;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = s.c;
    ctx.globalAlpha = 0.95;
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
  });
  // Interference contours: deterministic sampled wave field.
  for (let band = -3; band <= 3; band++) {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 100; i++) {
      const x = (i / 100) * w;
      const y0 = h * (0.48 + band * 0.055);
      const wave = sources.reduce((sum, s) => sum + Math.sin(Math.hypot(x - s.x, y0 - s.y) * 0.105 - t * 1.1 + s.p), 0);
      pts.push([x, y0 + wave * 3.8]);
    }
    strokePath(ctx, pts, sources[(band + 9) % sources.length].c, 0.7, 0.4);
  }
  ctx.restore();
}

function drawWeaver(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const colors = PALETTES.weaver;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let layer = 0; layer < 4; layer++) {
    const pts: Array<[number, number]> = [];
    const fx = 2 + layer * 0.5;
    const fy = 3 + layer * 0.25;
    const phase = t * 0.22 + layer * 0.58;
    for (let i = 0; i <= 560; i++) {
      const a = (i / 560) * Math.PI * 2;
      const x = w * 0.5 + Math.sin(fx * a + phase) * w * (0.25 - layer * 0.018);
      const y = h * 0.5 + Math.sin(fy * a) * h * (0.36 - layer * 0.018);
      pts.push([x, y]);
    }
    ctx.shadowColor = colors[layer];
    ctx.shadowBlur = layer === 0 ? 8 : 2;
    strokePath(ctx, pts, colors[layer], layer === 0 ? 1.5 : 0.85, 0.82 - layer * 0.12);
  }
  ctx.restore();
}

function drawMoire(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const drawPlate = (rotation: number, color: string, spacing: number, alpha: number) => {
    ctx.save();
    ctx.translate(w * 0.5, h * 0.5);
    ctx.rotate(rotation);
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.7;
    ctx.globalAlpha = alpha;
    for (let x = -w; x < w; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, -h);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.restore();
  };
  drawPlate(-0.15 + Math.sin(t * 0.13) * 0.015, '#5bd9e8', 7, 0.4);
  drawPlate(0.16 + Math.cos(t * 0.11) * 0.025, '#f3a7d0', 7, 0.35);
  // A radial plate adds the signature interference ring without another texture.
  ctx.translate(w * 0.57, h * 0.5);
  for (let i = 1; i <= 10; i++) {
    ctx.beginPath();
    ctx.arc(0, 0, i * 7.4, 0, Math.PI * 2);
    ctx.strokeStyle = i % 2 ? '#6e91ff' : '#f1b4dc';
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  ctx.restore();
}

function drawFossil(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const centers = [
    [w * 0.38, h * 0.53, 1],
    [w * 0.68, h * 0.41, -1],
  ] as const;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let level = 0; level < 21; level++) {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 100; i++) {
      const x = (i / 100) * w;
      let y = h * 0.5 + (level - 10) * 4.2;
      centers.forEach(([cx, cy, sign], j) => {
        const d = (x - cx) / (w * 0.18);
        const influence = Math.exp(-d * d * 2.2);
        y += (cy - h * 0.5) * influence * 0.8 + Math.sin(x * 0.04 + t * 0.16 + level * 0.12 + j) * influence * 3.4;
        y += sign * Math.cos(x * 0.026 + level * 0.17 + t * 0.09) * 1.8;
      });
      pts.push([x, y]);
    }
    strokePath(ctx, pts, level < 7 ? '#d7ad79' : level < 14 ? '#6dcbd0' : '#9aa7db', 0.8, 0.24 + 0.12 * Math.sin(level));
  }
  centers.forEach(([x, y], i) => {
    for (let r = 1; r <= 7; r++) {
      ctx.beginPath();
      ctx.ellipse(x, y, r * 6.2, r * 2.1, -0.18, 0, Math.PI * 2);
      ctx.strokeStyle = i ? '#6dcbd0' : '#e5bd8c';
      ctx.globalAlpha = 0.54 - r * 0.045;
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }
  });
  ctx.restore();
}

const DRAWERS: Record<InstrumentId, (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void> = {
  ink: drawInk,
  garden: drawGarden,
  weaver: drawWeaver,
  moire: drawMoire,
  fossil: drawFossil,
};

export function InstrumentPreview({ id }: { id: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !ctx) return;

    let width = 1;
    let height = 1;
    let dpr = 1;
    let frame = 0;
    let last = 0;
    let time = Math.random() * 2;
    let alive = true;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const drawer = DRAWERS[id as InstrumentId] ?? drawInk;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 1.35);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawer(ctx, width, height, time);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const tick = (now: number) => {
      if (!alive) return;
      frame = requestAnimationFrame(tick);
      if (document.hidden || now - last < 1000 / 30) return;
      last = now;
      time += reduced ? 0.0015 : 0.012;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      background(ctx, width, height, id as InstrumentId);
      drawer(ctx, width, height, time);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [id]);

  return <canvas className={`instrument-preview preview-${id}`} ref={canvasRef} aria-hidden="true" />;
}
