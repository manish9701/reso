# Resonant Ink — Cymatics Lab

**Live (after Pages is enabled):** https://manish9701.github.io/reso/

A single, immersive white-studio cymatics instrument: a shallow stainless dish
of resonating liquid driven by tone / microphone / local audio, with pigment
transported by the surface flow. Built with React 19 + TypeScript + Vite,
WebGL2 ping-pong simulation, and Web Audio.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # TypeScript check + production build
npm run preview    # serve dist/ at :4173
node scripts/verify.mjs http://localhost:4173/   # real-gesture visual QA
node scripts/verify.mjs http://localhost:5173/   # exits non-zero on any fault
node scripts/freqsweep.mjs http://localhost:4173/  # figure at each frequency
node scripts/itershoot.mjs http://localhost:4173/ docs/after  # before/after + 6-frequency comparison + detail crops
node scripts/fpsprobe.mjs http://localhost:4173/  # headed real-GPU FPS (idle / transient / settled)
```

## Frequency model (read this before touching the slider)

Two different quantities live in this app, and they are never silently
relabelled:

1. **Excitation frequency** — the one audible tone the UI shows and plays,
   spanning **110–880 Hz** (default **432 Hz**).
2. **The dish's own resonant frequencies** — the capillary–gravity modes of
   the documented vessel (8.5 cm radius, 6 mm deep), which all lie far below
   the audible band.

They are related by an explicit, documented, monotonic log-band transform
(`src/lab/resonance.ts`):

```
t       = (ln f_ex − ln 110) / (ln 880 − ln 110)   ∈ [0, 1]
f_model = f_min · (f_max / f_min)^t
```

with `f_min/f_max` derived from the mode bank itself, so the slider always
spans exactly the resonances the vessel has, in order. This is a **visual
simulation model**, not a laboratory calibration; no invented physical
conversion is claimed anywhere. The mode bank is dense and sorted by
frequency, so sweeping the tone walks the spectrum in order — low pitches
resolve to a couple of broad structures, high pitches to finely divided
rosettes — and each stop's resolved `(m, n)` fingerprint is recorded by
`scripts/itershoot.mjs` into `docs/after/comparison.md`.


## Interaction

The control surface is deliberately minimal: **one frequency slider and one
colour dropper.** Everything else is either automatic or hidden.

- **Frequency slider** — the single driver. It is wired *directly* into the
  mode resolution (no FFT re-detection), so sliding it reorganises the standing
  figure continuously and raises the water's agitation with it. Low pitches give
  a few big lobes; high pitches fine concentric rosettes.
- **Colour dropper + palette** — pick any colour, then click/drag on the water
  to pour it. Colour is never imposed by the app; the water is coloured only by
  what you put in it, and it mixes subtractively (blue over yellow → green).
- **Click / tap** — a colour drop plus a local impulse; a travelling ripple
  propagates and reflects off the wall (emerges from the wave equation, not an
  overlay).
- **Drag** — a continuous interpolated ink stroke that the flow then carries,
  folds and gathers onto the nodal lines.
- **Play** — a real sine tone wired straight into the same drive (first click
  is the gesture that unlocks audio). **Mic** and **audio file** remain
  available as small utilities; both are analyser-only and processed locally.
- **Save** (PNG), **Clear**, and a hold/release toggle for the drive.

## Model layers (spec §5)

The scene is a real 3-D set (lathed glass vessel, subdivided liquid surface,
white studio with a baked PMREM environment) driven by a GPU field pipeline.
The field is built in three cooperating parts, each documented where it lives:

| File | Responsibility |
| --- | --- |
| `src/lab/resonance.ts` | Mode bank. Circular-domain eigenmodes from tabulated Bessel zeros (`J′_m` for a rigid wall, `J_m` for a free edge), extended to m ≤ 14, n ≤ 12 with the standard large-argument asymptotics (A&S 9.5.12 / 11.4.9). The bank is **dense and sorted by frequency**, so sliding the tone walks the spectrum in order: low pitches give two or three big lobes, high pitches fine concentric rosettes. Physical mode frequencies come from the capillary–gravity dispersion ω² = (gk + σ/ρ·k³)·tanh(kh) over the documented vessel; the UI's excitation band reaches them through the documented log-band transform (see "Frequency model"). Every mode is a driven, damped oscillator with a **deterministic orientation phase**; the response keeps one dominant figure plus its nearest neighbours, because ten superposed modes read as mush rather than as cymatics. |
| `src/sim/figure.ts` | **The resonant standing figure, synthesized analytically.** A Bessel mode `J_m(kr)·cos(mθ)` is an exact eigenfunction of the wave operator, so the settled pattern is written straight into a 512² half-float texture each frame as `h = breathing(Φ)·Σ Aᵢ·φᵢ`. This is the physics solved in closed form, not an approximation of it — and it sidesteps a real failure mode of the grid solver: a Bessel mode has nonzero spatial mean, so forcing the grid with it pumps the (undamped) zero mode and drives the field into its rails. Bounded by construction here. |
| `src/sim/wave.ts` | **Travelling waves on the grid** — the ripple field that pointer strikes excite. Explicit update, fixed 1/480 s substep with capped catch-up, 512² RGBA16F ping-pong, circular rim (Neighbour clamp, never a torus wrap), soft wall absorption. Ripple speed ≈ 179 texels/s, so a strike ring crosses the basin in about 1.4 s. |
| `src/sim/pigment.ts` + `DYE_FS` | Persistent 1024² half-float dye advected through the combined field. Stored as **optical density**, not colour (rgb = per-channel absorbance, a = mass) and rendered back with **Beer–Lambert** — see "Ink physics" below. Semi-Lagrangian advection with an unsharp correction (semi-Lagrangian is numerically diffusive and turns ink to smoke in a second otherwise). |
| `src/sim/shaders.ts` | All simulation GLSL: `FIGURE_FS`, `STEP_FS`, `COMBINE_FS`, `DYE_FS`. `COMBINE_FS` sums figure + ripples into one field (r = height, g = raw nodal shape) that the surface and pigment both sample. |
| `src/lab/dish.ts` | Vessel lathe + **brushed stainless** material: `MeshPhysicalMaterial` at **metalness 1.0**, roughness tuned inside the **0.18–0.30** window with a *generated* circumferential brushed roughness/bump map that follows the lathe (streaks along u, wrapping seamlessly), mild anisotropy for the turned grain, no clearcoat. The crown is a thick rolled lip with machined bevels; reflections wrap the real shape. |
| `src/lab/studio.ts` | Procedural studio environment baked through PMREM — a BRIGHT white set with contrast instruments: broad softbox + strip lights (silver sweeps), narrow **charcoal flags** (dark bands that reveal curvature), warm-white and **copper kickers** (the rose toning in the reference), cool counterpoint, white floor bounce. Real **shadow-mapped key light** (PCFSoft, 2048², tuned bias/normalBias, no acne) grounds the dish on the matte ground; the baked contact-shadow sprite supplies only the tight AO core. Three `RectAreaLight` instruments (softbox, copper kicker, cool side) add the broad soft rectangle highlights. Static set ⇒ the shadow map renders once and is frozen (no shimmer, no per-frame pass). Output goes through `OutputPass` for tone mapping and the sRGB transfer. |
| `src/lab/liquid.ts` | The surface: a `MeshPhysicalMaterial` extended via `onBeforeCompile`, keeping full PBR. Injects vertex displacement, a shading normal from the live field, Beer–Lambert ink transmission, refraction, caustics, a nodal overlay and debug views. Pigment also gets a specular kill, so dense ink is a matte film whose colour reads instead of being washed white. The shader patches are **asserted after injection** — `String#replace` against a renamed three.js chunk is a silent no-op, and the symptom is a flat, featureless disc that looks exactly like a broken physics model. |
| `src/lab/engine.ts` | Orchestration: audio → ResonanceModel → FigureField + WaveSimulation → combine → pigment → material → studio render. Owns capture (Save). |

Frame order per tick: **modal amplitudes → analytic figure → travelling-wave
grid (fixed substeps) → combine → pigment advection → hand fields to the
surface material → studio render.** Nothing is read back from the GPU per
frame; the only readback is the optional development probe.

`?demo=1` runs a scripted sow+strike sequence; `?debug=dye|mode|h` dumps the
dye, nodal-shape, or height buffers as greyscale; `?drive=432&level=0.8`
overrides the drive, so visual QA does not depend on headless audio autoplay
(which is unreliable, and a tone that silently never starts invalidates every
later assertion). `scripts/verify.mjs` treats GLSL compile failures, a flat
height field and a missing mode set as **hard errors**, and exits non-zero.

## Ink physics (why colours mix correctly)

Pigment is stored as **optical density** and rendered with Beer–Lambert:

```
A(λ)  = Σ deposits (−ln colour)          absorbs additively, per channel
T(λ)  = exp(−A(λ) · d)                   what the eye actually receives
```

Absorbance adding linearly is the whole point: it makes mixing *subtractive*.
Blue ink over yellow ink transmits blue·green, i.e. **green** — the same result
real paint gives. Averaging RGB values (the obvious implementation) always
drifts toward mud, which is exactly the failure mode this model removes.

Channels are limited with a soft `tanh` roll-off rather than a per-channel
`min`. A hard clamp pins the densest channel and then lets the weaker ones
catch up to it over the following frames, which silently bleeds every pigment
toward neutral grey — blue ink ends up rendering as black.

Transport uses **two** fields, because they do different jobs:

1. **Churn** — a divergence-free curl, `v = (∂ψ/∂y, −∂ψ/∂x)`, with the stream
   function built from the live height and modal shape. A vibrating surface
   drives *recirculating orbital* flow, which is rotational; a gradient field
   (∇h) is irrotational by construction and can never produce a swirl, which
   is why the earlier version stirred without ever mixing. A frequency-scaled
   ambient stir is added on top, so a higher tone visibly churns faster.
2. **Chladni migration** — pigment drifts *down the gradient of the squared
   modal shape*, i.e. onto the nodal lines. This is the mechanism that actually
   draws the figure: on a real vibrating plate, grains settle where the surface
   is momentarily still, which is why a Chladni pattern is made of deposited
   powder rather than of a standing wave you can see. It is a **gradient, and
   therefore divergent, flow** — it cannot be folded into the curl above without
   destroying the very migration that makes the pattern legible. Curl alone gives
   swirling colour but never a figure.

Semi-Lagrangian advection is numerically diffusive and turns ink to smoke within
a second, so a mild unsharp mask restores filament edges. Its blur kernel must
be wider (3×3) than the texel jitter advection leaves behind — a 1-texel
difference measures that jitter, amplifies it, and because it amplifies each
absorbance channel slightly differently the result is coloured speckle rather
than grain.

## Honest limitations

- **Two-frequency model.** The audio tone and the dish's modes are different
  quantities, related by the documented log-band mapping (see "Frequency
  model"). The UI states excitation; the simulation states its own modes;
  `?drive=` (used by QA) carries the UI excitation and is mapped the same way
  inside the engine, so nothing bypasses the model.
- **Modal lock (temporal model).** The audio frequency selects *which* modes
  respond; the eye sees the standing pattern breathing at a sub-audible rate,
  not the tens-of-Hz oscillation itself. A 432 Hz ripple cannot be resolved by
  a 512² / 480 Hz solver (it would alias), and the grid's physical ripple
  frequencies are ~1 Hz — the same reason visible-rate cymatics footage is shot
  in slow motion. This is a deliberate, documented temporal scale choice.
- **Optical normal gain.** A real dish's cymatic relief is millimetres deep and
  is seen almost entirely as reflection. The geometric displacement stays
  within a couple of mesh ring-spacings (past that the surface folds and renders
  as hard wedges); a shading-normal gain (`uNormalGain`) brings the *optical*
  relief up to a legible level, like a shallow film under a raking studio key,
  with the slope clamped so a strong gain cannot tip the surface past vertical.
- The Beer–Lambert model is single-constant Kubelka–Munk (Beer–Lambert), not
  full two-constant KM: it reproduces subtractive mixing and saturation well,
  but does not model pigment scattering, granulation or paper interaction.
- Physics-grounded but not laboratory-calibrated: vessel radius/depth and the
  frequency→mode mapping are artistic constants; the pigment transport is a
  documented shallow-flow model, not Navier–Stokes.
- WebGL2 + `EXT_color_buffer_float` required; a calm explanation shows
  otherwise. Verified in Chrome (desktop + software rendering).
