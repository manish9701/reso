# Resonance Lab — Five Instruments for Playing with Waves

**Live:** https://manish9701.github.io/reso/ &nbsp;·&nbsp; run locally below.

Five real, playable browser instruments in one lab. React 19 + TypeScript + Vite,
with WebGL1 fullscreen-shader rendering, Tone.js pro audio, Paper Shaders gallery
backdrop, simplex-noise organic motion and framer-motion transitions.

## Run it

```bash
cd resonance-lab
npm install
npm run dev      # → http://localhost:5173
npm run build    # type-check + production build (dist/)
```

No accounts, no backend, no build-time network calls. All state is local;
exported PNG/SVG files download straight from the canvas.

## Controls (global)

| Key | Action |
| --- | ------ |
| `1–5` | Switch instrument |
| `Space` | Pause / resume (freeze) |
| `C` | Clear current toy |
| `E` | Export current toy as PNG |
| `Esc` | Back to gallery |

Top bar: `motion: full/soft` (reduced-motion), `sound: on/off` (master mute).

## The five toys

1. **Resonant Ink** — tap = strike (Tone.js FM bell / sub / drone / shimmer + ripple).
   1600 pigment particles advected by the analytic wave gradient with simplex drift;
   WebGL layer refracts the pigment through the live field with rings, specular and
   contour filaments. Pigment behaviours: Flow / Bloom / Edge / Dense / Glow.
   Optional mic (explicit opt-in) stirs the field.
2. **Harmonic Garden** — up to 6 draggable wave sources in a domain-warped WebGL
   interference field. Contours / Interference / Filament modes, smooth preset morphs,
   simplex drift, per-source freq/amp/phase, quiet hum monitor (sine + lowpass).
3. **Wavelength Weaver** — Lissajous performance pen with additive glow trails.
   Ratio picker, phase/speed dials, live morphing, second layer, entry overture,
   gesture **record/replay**, PNG + true-vector **SVG** export.
4. **Shadow Moiré** — two draggable plates (slide / rotate-handle / wheel-scale /
   fling inertia), 6 procedural patterns each, screen/multiply/difference merges,
   Lab + Print themes, capture-to-bake + downloadable print filmstrip, undo.
5. **Sonar Fossil** — persistent 360-cell height-field; MembraneSynth thumps fire
   soft/sharp/triple wavelets that deposit real ridges. GPU shading: slope lighting,
   hypsometric mineral ramp, AA contours, cyan wavefront glow. Rake/erase tools,
   8-deep undo, shaded/lines/both views.

## Performance notes

- DPR capped at 1.5–1.75 per toy; pigment layer uploads at ≤1200px; fossil field
  uploads ~360×260 RGBA/frame.
- Only the active toy runs a loop; WebGL contexts are released on unmount.
- `prefers-reduced-motion` is respected on load; the motion toggle slows all clocks.
- Audio graph is lazy (first tap) behind a limiter; mute kills the destination.
