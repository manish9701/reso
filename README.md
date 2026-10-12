# Cymatics — Resonant Water

**Live experience:** https://manish9701.github.io/reso/

A single, fullscreen interactive cymatics-inspired water study. Move through the surface to send ripples, strike the water to create stronger wavefronts, and drag colored pigment into the current. Use a generated tone, microphone input or an audio file to drive standing-wave patterns.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # TypeScript check + production build
npm run preview
```

## Interaction

- **Move the cursor:** create small wavefronts on the water.
- **Click or tap:** strike the surface and release a stronger ripple.
- **Drag:** release pigment. The pigment field is carried by the simulated wave-gradient flow, diffuses gently and refracts under the moving surface.
- **Pigment palette:** choose lagoon, ultramarine, orchid, fuchsia, amber or pearl.
- **Tone:** play a generated sine tone; adjust frequency to change the cymatics-like radial standing-wave mode.
- **Mic:** explicitly grant microphone access to let nearby sound drive the water. Microphone input is analysed but not monitored back to the speakers.
- **Load audio:** play a local audio file and use its amplitude and dominant frequency to drive the water.
- **Clear / Save study:** reset the pigment and waves or export the current render as a PNG.

## Rendering approach

- **WebGL 1 fragment shader:** radial wavefronts, frequency-shaped standing modes, specular highlights, refraction, reflected environment bands and restrained grain.
- **Canvas pigment field:** a low-resolution persistent color field is advected by wave gradients and softened with a small diffusion step. It is a deliberately controlled visual simulation, not a physically exact fluid solver.
- **Paper Shaders:** MeshGradient provides the subdued atmospheric light around the water surface; the water itself is rendered by the custom shader.
- **Performance:** the water render target has a capped pixel dimension and the pigment simulation is intentionally low-resolution. The simulation is limited to a steady ~30 fps target.

## Audio and privacy

No microphone permission is requested on load. Microphone access begins only after the user selects **Mic**. Audio files are processed locally in the browser through the Web Audio API; no backend or file upload service is used. The selected local file is represented with a browser object URL and released when replaced or when the experience is closed.

## Notes

The project contains one user-facing experience: Cymatics. The old instrument gallery and navigation are no longer part of the app entry point.
