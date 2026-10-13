State of the branch: what is working, what is not

Recorded after a sweep of uWater (scripts/sweep.mjs, 0.25 -> 0.75). The
cropped grid revealed more than the full-frame comparisons did.

WHAT IS ACTUALLY WORKING

The cymatic figure is present and crisp. Sweeping at a tighter crop shows the
nodal line network clearly: fine white contour lines forming a cellular
structure across the whole dish. At full-frame zoom these read as "flat
patches" and I had wrongly concluded the figure was broken. It is not - the
geometry is there and it is legible. This is what the crop is for, and it is
why the sweep harness was worth building.

The water colour sits in a good range already. The shipped uWater is
(0.40, 0.47, 0.55); the sweep shows 0.39-0.48 as the sweet spot - below 0.31
it goes an unnatural saturated teal, above 0.60 it washes to grey.

The dark crater on drop contact is gone. It is absent across every cell of
this sweep, which is the independent confirmation that removing the negative
impulse in onDropLand fixed it.

The dish rim now shows a proper metallic gradient rather than flat white.

The harsh centre streaks are greatly reduced. A faint vertical line remains
and is the next thing to sweep.

KEEP - verified, each with a reason
- Droplet ghosting fix, with scripts/dropimpact.mjs holding it
- Solid disc on impact fix, held by the same script
- Nodal settling normalised off texel size (was resolution-dependent)
- MAX_MODES 4 with a raised dominance threshold - this is what makes each
  frequency show a DIFFERENT figure instead of the same interference mush
- Wave speed 100000, bounded by the explicit scheme's stability ceiling
- Inaudible tone -> pentatonic mapping
- Microphone control removed
- preserveDrawingBuffer off, canvas MSAA off
- The four harnesses: bench, profile, sweep, dropimpact

REVERTED - tried, measured worse, undone
- Removing three.js transmission (saved 34ms, flattened pigment to pastel)
- Backdrop-pass refraction (same cost saving, same visual failure)
- Thin plate, warm rose metal, 70-degree overhead camera
- Shader tap consolidation (no measurable gain; reverted to keep the known
  -good shader)

STILL OPEN
- Faint residual streak through the centre (sweep the studio strip lights)
- Fine filament detail is present but not yet as dense as the reference
- No shadow under the plate; metal reflection still lacks the reference's
  warm copper band
- Tone: current one to be replaced with a soothing one