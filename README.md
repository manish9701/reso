# Resonant Ink — Cymatics Lab

**Live (after Pages is enabled):** https://manish9701.github.io/reso/

A single, immersive white-studio cymatics instrument: a shallow glass dish of
resonating liquid driven by tone / microphone / local audio, with pigment
transported by the surface flow. Built with React 19 + TypeScript + Vite,
WebGL2 ping-pong simulation, and Web Audio.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # TypeScript check + production build
npm run preview    # serve dist/ at :4173
node scripts/verify.mjs http://localhost:4173/   # real-gesture visual QA
```

## Interaction

- **Move cursor** — very light disturbance only (no endless ring trails).
- **Click / tap** — one local impulse; a travelling wave propagates through
  the current surface state (emerges from the wave equation, not an overlay).
- **Drag** — a continuous interpolated pigment stroke that the flow then
  carries, folds and gathers.
- **Tone** — a real sine; its frequency is wired *directly* into the mode
  resolution (no FFT re-detection). Sliding frequency snaps the water through
  resonant geometries (1:1 … 4:4 angular/radial pairs), blending neighbours.
- **Mic** — permission-gated, analyser-only (never played back), envelope +
  spectral centroid drive the figure; claps create transient impulses.
- **Audio file** — local playback via Web Audio; processed in-browser only.
- **Presets** — six model states (mode + behaviour + pigment seed), each
  thumbnail is a true nodal diagram of the target Bessel mode.
- **Save study** (PNG), **Record** (WebM via MediaRecorder), hide-UI toggle.

## Model layers (spec §5)

| File | Responsibility |
| --- | --- |
| `src/lab/resonance.ts` | Mode bank: rigid-wall circular modes — k·R at zeros of J′_m (computed at runtime by bisection); mode frequencies mapped from the capillary–gravity dispersion ω² = (gk + σ/ρ·k³)·tanh(kh) into the audible band through a documented monotonic transform. Frequency → nearest-mode blending with soft weights. |
| `src/lab/wave.ts` | GLSL passes: mode-field render, damped wave step (symplectic Euler, 6 bounded substeps, circular boundary absorption), pigment advection (semi-Lagrangian + streaming vortices ψ=φ² that spiral ink onto nodal lines), concentration-weighted colour mixing. |
| `src/lab/engine.ts` | WebGL2 orchestration: ping-pong RGBA16F state + RGBA8 dye buffers (explicitly zeroed — texStorage2D contents are undefined), the optical dish pass (glass rim highlights, meniscus, contact shadow, normal-warped studio reflections, refraction of pigment, caustics, sparkle, nodal overlay, dither), PNG/WebM capture. |
| `src/lab/audio.ts` | Tone / mic / file input feeding one {freq, level} interface. |
| `src/lab/presets.ts` | Fixed preset list + nodal-diagram thumbnails. |
| `src/Cymatics.tsx` | Experience layout: floating left/right rails, transport strip, responsive trays. |

`?demo=1` runs a scripted sow+strike sequence (used by the verification
harness); `?debug=dye|mode|h` dumps simulation buffers as greyscale.

## Honest limitations

- Physics-grounded but not calibrated: vessel radius/depth are artistic
  constants; drive coupling is visual. Described as a real-time simulation,
  not laboratory fluid dynamics.
- WebGL2 + `EXT_color_buffer_float` required; a calm explanation shows
  otherwise. Verified in Chrome (desktop + software rendering).
