# How Reso Works — Deep Dive

> Companion to the brief [README](../README.md). Everything below is the
> full technical record: frequency model, drivers, model layers, traps,
> ink physics, limitations, and the measurement harnesses.

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
node scripts/verify.mjs http://localhost:5173/   # real-gesture visual QA
node scripts/verify.mjs http://localhost:4173/   # exits non-zero on any fault
node scripts/freqsweep.mjs http://localhost:4173/  # figure at each frequency
node scripts/itershoot.mjs http://localhost:4173/ docs/after  # before/after + 6-frequency comparison + detail crops
node scripts/fpsprobe.mjs http://localhost:4173/  # headed real-GPU FPS (idle / transient / settled)
```

### Measurement harnesses (added 2026-10-14)

Several defaults in this project are numbers, not taste, and these are the
scripts that produced them. Re-run them before changing anything in the list
above rather than tuning by eye.

```bash
node scripts/slope.mjs  http://localhost:5173/ "110,290,432,620,790"  # field gradient + shading slope distribution
node scripts/slopefit.cjs slope.txt      # what gain each stop NEEDS (sets RELIEF_BASE/RELIEF_EXP)
node scripts/pixels.mjs http://localhost:5173/ 432   # framebuffer luminance scans + clipping
node scripts/lookshot.mjs http://localhost:5173/ tag "150,432,790" 1  # render at each frequency
node scripts/tweak.mjs  http://localhost:5173/ tag "<js expr against window.__lab>"   # live probe
node scripts/diag.mjs   http://localhost:5173/     # console/page errors + app error state
node scripts/repro.mjs  http://localhost:5173/     # drive-state regression: dumps the dye field
node scripts/smoke.mjs  http://localhost:5173/     # click every control; non-zero on any fault
node scripts/bankaudit.mjs                      # mode bank vs the TRUE Bessel zeros; no server needed
node scripts/visibleband.mjs                    # where the water visibly reacts -> EXCITATION_MIN/MAX
node scripts/freqmap.mjs  http://localhost:5173/ # the WHOLE slider vs the modal response, stepped to convergence
node scripts/session.mjs  http://localhost:5173/ # ~3 min survival across visible/hidden/returns; no backlog storm
node scripts/audiodebug.mjs http://localhost:5173/ # real media-element events, no autoplay override
```

Two rules these harnesses exist to enforce. **Step to convergence, never sleep
and hope** — `freqmap.mjs` reads the engine's own frequency mapping from one
real frame and then steps the modal state deterministically, because a timed
read returns however far the loop happened to get and reports a dead slider
that is merely slow. And **do not pass
`--autoplay-policy=no-user-gesture-required`**: every harness used to, which is
precisely how the bundled track and the upload path could both be broken and
still test green.

The one-off probes from earlier sessions (~25 scripts) have been removed; what
remains above is everything still worth running.

## Frequency model (read this before touching the slider)

Two different quantities live in this app, and they are never silently
relabelled:

1. **Excitation frequency** — the one tone the UI shows, spanning
   **224–836 Hz** (default **432 Hz**), and the *measured* range:
   `scripts/visibleband.mjs` sweep-tests the whole 110–880 band and keeps only
   what responds with a visible figure. Below 224 the slider hit dead spots
   (122–128 Hz excited no mode at all) and 110–218 could not hold a usable
   figure; above 836 only the weakly-coupled m13/m14 cluster answered and the
   figure faded to 0.15–0.25 of band peak. The dead range is simply not on the
   slider.
2. **The dish's own resonant frequencies** — the capillary–gravity modes of
   the documented vessel (8.5 cm radius, 6 mm deep), which all lie far below
   the audible band.

They are related by an explicit, documented, monotonic log-band transform
(`src/lab/resonance.ts`):

```
t       = (ln f_ex − ln 224) / (ln 836 − ln 224)   ∈ [0, 1]
f_model = SIM_VIS_MIN · (SIM_VIS_MAX / SIM_VIS_MIN)^t
```

with `SIM_VIS_MIN/MAX` (2.596–21.195 Hz) the simulated frequencies at the
measured band edges — the mapping covers the *visible* sub-band of the mode
bank, not the whole bank, so the dead modes cannot slide back into reach. This
is a **visual simulation model**, not a laboratory calibration; no invented
physical conversion is claimed anywhere. The mode bank is dense and sorted by
frequency, so sweeping the tone walks the spectrum in order — low pitches
resolve to a couple of broad structures, high pitches to finely divided
rosettes.

The figure follows a slider move **instantly**: in Frequency mode the modal
amplitudes snap to their new targets (`snapFollow`, a couple of frames rather
than the ~0.5–1.2 s audio-follow time constant), so the figure reorganises as
fast as you can drag. Tone mode deliberately keeps the slow follow.

## Sessions do not end by themselves

A session is ended by the user — pause, another source, leaving Tone mode, or
Clear/Save — and by nothing else. Four mechanisms close, because each one read
as "the session auto vanishes after a few minutes":

1. **A suspended AudioContext.** Chromium suspends a context at any time after
   launch (OS audio route change, autoplay re-check). `frame()` — called every
   animation frame — notices and re-drives `resume()`, throttled to ~half a
   second.
2. **The generated piece's scheduler is driven by the render loop**, which
   freezes when the tab is hidden along with rAF. A keep-alive interval
   (800 ms, sized to outlast a hidden tab's ~1 s timer throttling) keeps the
   note queue topped while away.
3. **On return, the scheduler RESYNCS instead of replaying.** The old catch-up
   while-loop created the whole hidden duration as an oscillator backlog in one
   frame — three hidden minutes was ~400 oscillators at once, an audio
   glitch-storm that read as a dead session. `scripts/session.mjs` measures the
   oscillator rate on return: steady ~1.4/s now, where a storm would be a
   spike of the hidden duration at once.
4. **A lapsed media element is replayed, and React no longer reacts to
   `ended`.** The old `onEnded` handler threw the session away whenever the
   element hiccuped, even though the element is looping; the audio class owns
   recovery instead — a stopped element that should be running is restarted
   quietly from position zero.

The whole contract is exercised by `scripts/session.mjs`: a preset phase, a
generated-piece phase, a backgrounded phase with the tab actually hidden
(`document.hidden` observed `true`), and a return — ~2.5 minutes end to end,
with every sample required alive.


## Two drivers

There are exactly two, and they differ in kind:

| Driver | Sound | What it does |
| --- | --- | --- |
| **Frequency** | **None — fully silent.** | The slider drives the vessel's modes directly. The frequency is a property of the water, not a note, so nothing is played and nothing is analysed. |
| **Tone** | **Audible.** | A real signal drives the vessel instead. Always audible, never muted. |

Tone mode has **three sources**, all on one gain → analyser → speakers chain so
they are equally loud and the water reads exactly what you hear:

- **Zen** — the bundled track (`public/zen-tones.mp3`), looping. The URL is built
  from `import.meta.env.BASE_URL`, not a bare `'zen-tones.mp3'`: a relative
  string resolves against the *document*, so the moment the app is served from
  anything other than the root — a sub-path, a project page, a `file://` open —
  the request 404s and the browser reports "cannot play this file".
- **Synth** — a short pentatonic piece **synthesised in Web Audio**: no asset to
  fetch, never ends, guaranteed audible.
- **Upload** — your own local audio file. Nothing is uploaded.

The transport button is **play / pause / continue**: pausing ducks the graph
rather than tearing it down, so the water settles smoothly and resuming picks
the same session up where it stopped.

The two drivers used to share one path, which was wrong in both directions: the
audible bed's own frequency (not the slider's) fed the solver, so turning the
tone on silently detached the figure from the control the user was looking at.
They are now separate, and the analyser feeds the figure only in Tone mode.

## Interaction

The control surface is deliberately minimal: **one frequency slider, one colour
dropper, one driver choice.**

- **Frequency slider** — in Frequency mode this is the driver: sliding it
  reorganises the standing figure continuously and raises the water's agitation
  with it. Low pitches give a few big lobes; high pitches fine concentric
  rosettes.
- **Colour bar** — one vertical spectrum bar down the right-hand side. Click
  anywhere on it, or drag along it, to pick any colour directly; arrow keys work
  too. It runs **black at the bottom → the full hue wheel → white at the top**:
  black is the one colour the hue wheel cannot express and the one most people
  reach for, so it is given its own stop. There are no swatches — a palette can
  only offer the colours someone else chose — and no eyedropper.
- **No slider in Tone mode.** The audio *is* the frequency there, so a slider
  next to it would be a second, lying control. The frequency slider appears only
  in Frequency mode, where it is the driver and is silent.
- **One transport, in both modes.** Play / Continue / Pause with the current
  track name and a progress bar sits under the Frequency slider *and* under the
  Tone sources. It is the same control doing the same thing; having it appear
  and vanish as you switch drivers is what made the two modes look like
  different applications.
- **Click / tap** — a colour drop plus a local impulse; a travelling ripple
  propagates and reflects off the wall (emerges from the wave equation, not an
  overlay).
- **Drag** — a continuous interpolated ink stroke that the flow then carries,
  folds and gathers onto the nodal lines.
- **Save** (PNG) and **Clear**.

## Model layers (spec §5)

The scene is a real 3-D set (lathed glass vessel, subdivided liquid surface,
white studio with a baked PMREM environment) driven by a GPU field pipeline.
The field is built in three cooperating parts, each documented where it lives:

| File | Responsibility |
| --- | --- |
| `src/lab/resonance.ts` | Mode bank. Circular-domain eigenmodes from **Bessel zeros found by bisection on the real functions** (`J′_m` for a rigid wall, `J_m` for a free edge), out to m ≤ 14, n ≤ 12. The bank is **dense and sorted by frequency**, so sliding the tone walks the spectrum in order: low pitches give two or three big lobes, high pitches fine concentric rosettes. Physical mode frequencies come from the capillary–gravity dispersion ω² = (gk + σ/ρ·k³)·tanh(kh) over the documented vessel; the UI's excitation band reaches them through the documented log-band transform (see "Frequency model"). Every mode is a driven, damped oscillator with a **deterministic orientation phase**; the response keeps one dominant figure plus its nearest neighbours, because ten superposed modes read as mush rather than as cymatics. |
| `src/sim/figure.ts` | **The resonant standing figure, synthesized analytically.** A Bessel mode `J_m(kr)·cos(mθ)` is an exact eigenfunction of the wave operator, so the settled pattern is written straight into a 512² half-float texture each frame as `h = breathing(Φ)·Σ Aᵢ·φᵢ`. This is the physics solved in closed form, not an approximation of it — and it sidesteps a real failure mode of the grid solver: a Bessel mode has nonzero spatial mean, so forcing the grid with it pumps the (undamped) zero mode and drives the field into its rails. Bounded by construction here. |
| `src/sim/wave.ts` | **Travelling waves on the grid** — the ripple field that pointer strikes excite. Explicit update, fixed 1/480 s substep with capped catch-up, 512² RGBA16F ping-pong, circular rim (Neighbour clamp, never a torus wrap), soft wall absorption. Ripple speed ≈ 179 texels/s, so a strike ring crosses the basin in about 1.4 s. |
| `src/sim/pigment.ts` + `DYE_FS` | Persistent 1024² half-float dye advected through the combined field. Stored as **optical density**, not colour (rgb = per-channel absorbance, a = mass) and rendered back with **Beer–Lambert** — see "Ink physics" below. Semi-Lagrangian advection with an unsharp correction (semi-Lagrangian is numerically diffusive and turns ink to smoke in a second otherwise). |
| `src/sim/shaders.ts` | All simulation GLSL: `FIGURE_FS`, `STEP_FS`, `COMBINE_FS`, `DYE_FS`. `COMBINE_FS` sums figure + ripples into one field (r = height, g = raw nodal shape) that the surface and pigment both sample. |
| `src/lab/dish.ts` | Vessel lathe + **brushed stainless** material: `MeshPhysicalMaterial` at **metalness 1.0**, roughness tuned inside the **0.18–0.30** window with a *generated* circumferential brushed roughness/bump map that follows the lathe (streaks along u, wrapping seamlessly), mild anisotropy for the turned grain, no clearcoat. The crown is a thick rolled lip with machined bevels; reflections wrap the real shape. |
| `src/lab/studio.ts` | Procedural studio environment baked through PMREM — an enclosing **cyclorama gradient** (so no direction is ever a black void) plus contrast instruments: broad softbox + strip lights (silver sweeps), narrow **charcoal flags** (dark bands that reveal curvature), warm-white and **copper kickers** (the rose toning in the reference), cool counterpoint. Real **shadow-mapped key light** (VSM, 2048², tuned bias/normalBias) plus a soft baked contact-shadow core. The sweep is a **polished** white surface (roughness 0.42) carrying a **real planar reflection**: the scene is rendered once from a camera mirrored about the sweep's plane into an offscreen target that the ground samples by screen position. Camera and vessel are both fixed, so that target is baked once and costs nothing per frame. A **vignette pass** supplies the soft grey falloff toward the frame edges. Output goes through `OutputPass` for tone mapping and the sRGB transfer. |
| `src/lab/liquid.ts` | The surface: a `MeshPhysicalMaterial` extended via `onBeforeCompile`, keeping full PBR. Injects vertex displacement, a shading normal from the live field, Beer–Lambert ink transmission, refraction, a nodal overlay and debug views. Pigment also gets a specular kill, so dense ink is a matte film whose colour reads instead of being washed white. The shader patches are **asserted after injection** — `String#replace` against a renamed three.js chunk is a silent no-op, and the symptom is a flat, featureless disc that looks exactly like a broken physics model. That assertion is load-bearing, not decoration: it caught a stale marker and turned out to be the reason the water had not rendered at all. |
| `src/lab/engine.ts` | Orchestration: audio → ResonanceModel → FigureField + WaveSimulation → combine → pigment → material → studio render. Owns capture (Save). |

Frame order per tick: **modal amplitudes → analytic figure → travelling-wave
grid (fixed substeps) → combine → pigment advection → hand fields to the
surface material → studio render.** Nothing is read back from the GPU per
frame; the only readback is the optional development probe.

`?demo=1` runs a scripted sow+strike sequence; `?debug=dye|mode|h|cover|refract`
dumps the dye, nodal-shape, height, coverage or **raw transmission sample**
buffers — `refract` exists because the water once transmitted pure black and
this is the view that proved the transmission sampler itself was being
multiplied by zero rather than that the studio behind it was unlit;
`?drive=432&level=0.8` overrides the drive, so visual QA does not depend on
headless audio autoplay (which is unreliable, and a tone that silently never
starts invalidates every later assertion). `scripts/verify.mjs` treats GLSL
compile failures, a flat height field and a missing mode set as **hard errors**,
and exits non-zero.

## Three traps this project has already paid for

Each is recorded because the symptom looked like broken physics, and none of
them was. The next three (in "Three more that shaped the physics") are the same
kind of thing and cost more to find.

**1. The water shader must not zero `diffuseColor`.** three.js derives the
transmission tint from it:

```glsl
material.diffuseContribution = diffuseColor.rgb * (1 - metalness);
transmittance    = diffuseColor * volumeAttenuation(path, ...);
transmittedLight *= transmittance;
```

`diffuseColor.rgb = vec3(0.0)` — chosen so no diffuse wash would cover the bowl
— multiplies the whole refracted image by **zero**. The dish renders as an
opaque black disc with only a specular sheen, and no amount of lighting, gain
or material tuning touches it. Clear water is `vec3(1.0)`; absorption belongs
to Beer–Lambert and to `attenuationColor`. Found by hiding the dish and the
ground, painting the background a strong blue (the water stayed black), and
reading the sample back through `?debug=refract`.

**2. An environment made of two big planes has a hole at the horizon.** A
ceiling panel and a floor panel cover the upper and lower hemispheres and
nothing between them: a ray leaving the origin horizontally hits neither. The
vessel is a mirror, so its inner wall reflects straight into that void and
renders as hard black wedges — every "hard black wedge across the surface" note
in this project's history was this one gap. An enclosing cyclorama sphere makes
the class of bug impossible.

**3. A sharpener applied every frame to a persistent field is a bomb.** An
unsharp mask is a high-pass boost, so its gain at near-Nyquist is about 1.089
per frame at k = 0.1 with a 3×3 kernel — and the pigment field persists, so
that gain *compounds*: 1.089³⁰⁰ ≈ 10¹¹. Within a couple of seconds the field is
pinned at the hard ceiling and the screen fills with horizontal dashes, which
is precisely what the mask existed to prevent.

Measured with `scripts/repro.mjs`, which dumps the dye field directly: mean
absolute texel-to-texel delta **1.17** against a maximum mass of 3.5. With the
sharpener off it is **0.003**. The fix is the standard MacCormack limiter —
clamp the sharpened value to the neighbourhood's own min/max — which makes the
operator contractive: it still tightens real filament edges but cannot
manufacture new extremes, so there is no gain left to compound. Every other
bound in that pass is a `tanh` roll-off for the same reason; a hard `min()` is
a plateau, and a plateau beside a slope is a step.

## Three more that shaped the physics

**4. Approximated Bessel zeros put modes in the bank that do not exist.** Past
the fourth radial order the bank used the standard large-argument asymptotics
(`j_{m,n} ≈ β − (4m²−1)/8β`, β = (n + m/2 − 1/4)π, and the derivative form).
Checked against the real functions — `scripts/bankaudit.mjs` root-finds the true
zeros by bisection and compares — **64 of 79 modes were wrong by more than
0.2%**, and for m = 0 on the rigid branch the formula lands one index out:
`0/5` came out at k·R = 13.32368 against the tabulated `0/4` at 13.32369, a
**duplicate mode to five decimal places.**

A duplicate is not a rounding error. It is the *same standing shape* in the bank
twice at the same frequency, so the dish rings in two identical modes whose sum
is a self-cancelling interference pattern that does not answer the drive at all.
It is a direct cause of "the cymatics don't change with the frequency", and no
amount of tuning downstream can fix it — the input was wrong. The zeros are now
**solved by bisection on the real Bessel functions** (~20 ms once at module
load, cached per family), and `buildBank` refuses any two entries closer than
1e-4 in k·R, so a future edit cannot quietly reintroduce the class of bug.

**5. A fixed modal Q leaves part of the slider dead.** `BASE_BW` is a narrow
ln-frequency bandwidth — narrow enough to stop four near-degenerate modes summing
into rings. But the relative spacing of the modes is *not* uniform: ω ≈ √(gk) in
the gravity regime means f ∝ k^1.5, so the spacing **shrinks** as k grows. The
first modes are 50% apart in log frequency; the dense ones a fraction of a
percent. A bandwidth tuned for the crowded top is far narrower than the gaps at
the bottom, so the lowest third of the slider drove nothing measurable — 110 Hz
and 165 Hz both returned m1@1.84 and the figure was identical.

The width now follows the **local** spacing: sharp where modes crowd, wide
enough where they are sparse, so every drive lands on a mode. Two details
matter. It is sized from the mode's reach to its **furthest** of its two
neighbours, not the nearest — sizing it from the next mode up alone is what left
130 Hz exciting *nothing at all*, since m1@1.84 is 50% from the mode below it
but only 23% from the mode above. And a drive must be compared in log frequency
throughout, which is also the space the response is defined in.

**6. A broad response makes rings, not figures.** The mode bank is full of
*exactly* degenerate pairs: at 432 Hz, m=6@18.7, m=14@18.5, m=11@18.3 and
m=4@19.2 differ by ~1% in k·R, i.e. ~0.5% in frequency. **No bandwidth can
separate them** — at `BASE_BW = 0.035` they still all come back at 0.98 of the
leader, because there is nothing to tell them apart, and their sum is radially
coherent, so the dish showed concentric circles instead of a figure.

Coupling is the physical lever. A real vessel is driven from below or by broad
pressure across its floor, and a mode of angular order *m* moves progressively
less net volume for the same drive as the m-fold cancellation around the
circumference grows — so high orders are driven less efficiently. That is why a
real Chladni figure at a given tone is named by a *low* order with a clear spoke
count. `COUPLING_PER_M = 0.085` in `sim/resonance.ts` applies that; it is a
modelling choice, documented as one, and without it the whole upper half of the
band renders as rings. With it, the modes resolve to m3 alone at 262 Hz, m2+m4
at 523 Hz, and so on.

**Chroma must never be normalised against brightness.** `pigmentChroma /
max(pigmentChroma)`, mixed in to "vivid" the colour, divides by whatever the
colour's largest channel happens to be. Pure black has zero chroma and one
equal non-zero value, so it normalises to `(1,1,1)` and a 38% mix toward that
lifted a black pour to **mid grey** — the reported "black turns white". Taking
the hue from the ratio and the *brightness* from `exp(-A)` keeps neutrals dark.
Dense pigment also has to absorb the specular lobe, or the studio reflection
survives on top of the ink and every dark pour comes back washed out.

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
  relief up to a legible level. The gain is driven per-frame from the dominant
  mode's wavenumber as `RELIEF_BASE · (kR/10)^-0.52`, with a **negative**
  exponent because the field gradient already grows with k — the previous rising
  law compounded the two and over-drove 83–88% of the dish into the shader's
  slope clamp. The bound is a soft knee, not a hard clamp, so an over-driven
  crest degrades into a rounded swell instead of a flat stencil.
  `scripts/slope.mjs` reproduces the measurement.
- The Beer–Lambert model is single-constant Kubelka–Munk (Beer–Lambert), not
  full two-constant KM: it reproduces subtractive mixing and saturation well,
  but does not model pigment scattering, granulation or paper interaction.
- Physics-grounded but not laboratory-calibrated: vessel radius/depth and the
  frequency→mode mapping are artistic constants; the pigment transport is a
  documented shallow-flow model, not Navier–Stokes.
- WebGL2 + `EXT_color_buffer_float` required; a calm explanation shows
  otherwise. Verified in Chrome (desktop + software rendering).
