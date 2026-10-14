# Reso — Resonant Ink · Cymatics Lab

**Live:** https://manish9701.github.io/reso/

An interactive cymatics instrument: a shallow steel dish of water in a white
studio. Sound organises the surface into standing-wave figures, and pigment
you drop in makes the figure visible as it is carried, folded, and gathered
onto the nodal lines.

Built with React 19 + TypeScript + Vite, a WebGL2 field simulation, and
Web Audio. No backend, no build-time assets beyond one bundled track —
the whole thing runs in the browser.

## Why we built it

Cymatics figures are usually lab-bound: a plate, a signal generator, powder.
Reso makes that playable — pick a frequency or play a tone, pour colour,
and watch the physics draw. It is a study in sound, water, and pigment,
not a measurement tool.

## How it works (brief)

- **Drive:** a silent frequency slider (224–836 Hz) drives the dish directly,
  or Tone mode lets real audio (bundled Zen track, synth piece, your upload)
  drive it through an analyser — what you hear is what the water reads.
- **Figure:** circular-dish modes (Bessel eigenfunctions) respond as driven
  oscillators; the settled figure is written analytically each frame, while
  pointer strikes travel as real ripples on a wave grid.
- **Ink:** pigment is stored as optical density and rendered with
  Beer–Lambert, so colours mix subtractively like real paint
  (blue over yellow → green) and gather onto the still nodal lines.

Full detail lives in [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) —
frequency model, model layers, ink physics, limitations, QA harnesses.

## Try it

- **Frequency slider** — silent; drag to reorganise the figure live.
- **Colour bar** — click/drag to pick any colour (black at the bottom,
  white at the top).
- **Click / drag on the water** — drop ink, strike ripples, paint strokes.
- **Tone mode** — Zen / Synth / Upload, with play-pause-continue transport.
- **Save** (PNG) and **Clear**.

Needs WebGL2 + `EXT_color_buffer_float`. Verified in desktop Chrome.

## Run it locally

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build into dist/
npm run preview  # serve dist/ at http://localhost:4173
```

## Share it via GitHub Pages

The site is a static Vite build deployed by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):
every push to `main` builds and publishes `dist/`.

- Live URL: `https://manish9701.github.io/reso/`
- First-time setup: repo **Settings → Pages → Build and deployment →
  Source: GitHub Actions**, then push to `main`.
- The build uses a relative base (`./`), so the same output works on
  Pages (`/reso/`) and in local preview.
