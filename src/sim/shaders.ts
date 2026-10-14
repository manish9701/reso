/**
 * Simulation shaders for the Resonant Ink dish (guide §7 / §8 / §9).
 *
 * All passes are plain fullscreen-quad fragment shaders writing into
 * ping-pong render targets. Domain convention (shared with the liquid
 * mesh and the pointer raycast):
 *
 *     uv ∈ [0,1]²,  disc = { length(uv - 0.5) * 2 ≤ 1 }
 *
 * The domain is a circular basin — never a torus: every neighbour fetch
 * is projected back onto the disc so the wall reflects instead of wrapping.
 */

/* ------------------------------------------------------------------ */
/* modal forcing field — Σ amplitude_i · φ_i(r, θ)                    */
/* ------------------------------------------------------------------ */

/**
 * J_m(x), numerically stable for x up to ~50 and m up to ~12.
 *
 * The obvious implementation — truncate the defining series — is unusable
 * here: at k·r ~ 10 the terms climb to ~10^3 while the answer is O(1), and
 * float32 (≈7 digits) cancels catastrophically. The result is per-texel
 * garbage, which reads on screen as a blocky, quantised figure.
 *
 * So this uses the standard split (Abramowitz & Stegun 9.4):
 *   - x below the order  → the direct series, where terms are all small and
 *     therefore stable;
 *   - otherwise          → rational approximations for J₀/J₁ followed by
 *     upward recurrence, which is stable for x > m.
 */
const BESSEL_GLSL = /* glsl */ `
float besselJ0(float x) {
  if (x < 3.75) {
    float y = x / 3.75, y2 = y * y;
    float a = 57568490574.0 + y2 * (-13362590354.0 + y2 * (651619640.7
      + y2 * (-11214424.18 + y2 * (77392.33017 + y2 * -184.9052456))));
    float b = 57568490411.0 + y2 * (1029532985.0 + y2 * (9494680.718
      + y2 * (59272.64853 + y2 * (267.8532712 + y2 * 1.0))));
    return a / b;
  }
  float z = 3.75 / x, th = x - 0.785398164;
  float f = 0.79788456 + z * (-0.00000077 + z * (-0.00552740 + z * (-0.00009512
    + z * (0.00137237 + z * (-0.00072805 + z * 0.00014476)))));
  float g = 0.00015999 + z * (-0.00010609 + z * (0.00946327 + z * (-0.00335646
    + z * (0.00253718 + z * (0.00082793 - z * 0.00020868)))));
  return (f * cos(th) - g * sin(th)) / sqrt(x);
}

float besselJ1(float x) {
  float ax = abs(x);
  if (ax < 3.75) {
    float y = x / 3.75, y2 = y * y;
    float a = x * (72362614232.0 + y2 * (-7895059235.0 + y2 * (242396853.1
      + y2 * (-2972611.439 + y2 * (15704.48260 + y2 * -30.16036606)))));
    float b = 144725228442.0 + y2 * (2300535178.0 + y2 * (18583304.74
      + y2 * (99447.43394 + y2 * (376.9991397 + y2 * 1.0))));
    return a / b;
  }
  float z = 3.75 / ax, th = ax - 2.356194491;
  float h = 0.02282967 + z * (-0.02895312 + z * (0.01787654 - z * 0.00420059));
  float k = 0.39894228 + z * (-0.03988024 + z * (-0.00362018 + z * (0.00163801
    + z * (-0.00031519 + z * 0.00002211))));
  float r = sqrt(ax);
  if (x > 0.0) return (h * cos(th) - k * sin(th)) / r;
  return (k * cos(th) - h * sin(th)) / r;
}

float besselJ(int m, float x) {
  x = abs(x);
  if (x < 1e-5) return m == 0 ? 1.0 : 0.0;
  // below the order: the series is stable (no cancellation) and recurrence
  // would amplify error badly, so use it
  if (x < float(m) + 1.0) {
    float halfx = x * 0.5;
    float term = 1.0;
    for (int i = 1; i <= 12; i++) {
      if (i > m) break;
      term *= halfx / float(i);
    }
    float sum = term;
    for (int k = 0; k < 48; k++) {
      term *= -(halfx * halfx) / (float(k + 1) * float(k + 1 + m));
      sum += term;
      if (abs(term) < 1e-9) break;
    }
    return sum;
  }
  if (m <= 0) return besselJ0(x);
  if (m == 1) return besselJ1(x);
  float jm = besselJ0(x), jn = besselJ1(x);
  for (int i = 2; i <= 12; i++) {
    if (i > m) break;
    float jp = (2.0 * float(i - 1) / x) * jn - jm;
    jm = jn;
    jn = jp;
  }
  return jn;
}`;

/* ------------------------------------------------------------------ */
/* figure synthesis — the resonant standing pattern (guide §8)          */
/* ------------------------------------------------------------------ */

/**
 * The visible figure is the modal sum Σ Aᵢ·φᵢ evaluated ANALYTICALLY from
 * the eigenfunctions. A Bessel mode is an exact eigenfunction of the wave
 * operator, so writing it directly is not a shortcut around the physics — it
 * is the physics, solved in closed form. Two practical wins:
 *   - the 4-point Laplacian grid has an undamped zero mode, so any forcing
 *     with nonzero spatial mean ramps the field into its rails; eigenfunction
 *     synthesis is bounded by construction (no DC leakage, no CFL limit);
 *   - it costs one pass instead of a 512² solve at 480 substeps/s.
 * The grid (STEP_FS) still runs, carrying genuine TRAVELLING ripples from
 * pointer strikes that reflect off the wall. COMBINE_FS sums the two fields.
 */

/**
 * The visible figure is the modal sum Σ Aᵢ·φᵢ evaluated analytically.
 * A Bessel mode on a free-free or rigid membrane is an exact eigenfunction
 * of the wave operator, so writing it directly is not a shortcut around the
 * physics — it is the physics, solved. It also sidesteps the grid's DC
 * leakage (a spatially non-mean-zero forcing pumps an undamped zero mode),
 * and costs one pass instead of a 512² solve.
 */
export const FIGURE_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec4 uModes[4];   // x = m, y = kR, z = amplitude, w = breathing phase
uniform float uPhase[4];  // deterministic per-mode orientation of cos(mθ+φ)
${BESSEL_GLSL}

void main() {
  vec2 c = (vUv - 0.5) * 2.0;
  float r = length(c);
  float mask = 1.0 - smoothstep(0.985, 1.0, r);
  if (mask <= 0.0) { gl_FragColor = vec4(0.0); return; }
  float th = atan(c.y, c.x);
  float h = 0.0;
  float live = 0.0;
  for (int i = 0; i < 4; i++) live += step(1e-5, abs(uModes[i].z));
  for (int i = 0; i < 4; i++) {
    vec4 M = uModes[i];
    if (abs(M.z) < 1e-5) continue;

    // The eigenmode, and nothing else.
    //
    //   phi(r, theta) = J_m(k r) . cos(m theta + phi_i)
    //
    // This used to carry three EXTRA terms on top: a hardcoded m=4 "clover
    // rosette", an m=8 harmonic, and a fixed "petalRings" stamp — four
    // Gaussian lobes at r=0.32 carrying cos(34.d) ripples, plus a centre eye.
    //
    // None of them is a mode of this vessel. The rosettes used wavenumbers that
    // are not Bessel zeros of any boundary condition, so they drew a structure
    // the mode bank does not contain; and the ring stamp was IDENTICAL for every
    // frequency and every mode, which is why turning the frequency up produced
    // that quilted cellular web on the water — a fixed decorative overlay sitting
    // on top of the real figure rather than the figure itself. Superposing m=4,
    // m=8 and four ring clusters also interfered with each other into the
    // criss-cross lattice it was read as.
    //
    // The modal sum IS the complete solution of the eigenproblem. Adding
    // anything to it can only make the dish show a pattern the vessel cannot
    // produce, so it is removed rather than tuned.
    h += M.z * besselJ(int(M.x + 0.5), M.y * r) * cos(M.x * th + uPhase[i]);
  }
  h /= sqrt(max(live, 1.0)) * 1.45;
  // single coherent breathing envelope: the figure stays lit and shimmers
  float env = 0.84 + 0.16 * sin(uModes[0].w);
  gl_FragColor = vec4(h * env * mask, h * mask, 0.0, 1.0);
}`;

/* ------------------------------------------------------------------ */
/* combine — figure (analytic) + travelling waves (grid)                */
/* ------------------------------------------------------------------ */

export const COMBINE_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFigure;   // r = breathing figure, g = raw modal shape
uniform sampler2D uWave;     // r = travelling-wave height, g = velocity
uniform float uFigureGain;
uniform float uWaveGain;

void main() {
  vec4 f = texture2D(uFigure, vUv);
  vec4 w = texture2D(uWave, vUv);
  float height = f.r * uFigureGain + w.r * uWaveGain;
  // g = raw modal shape for the nodal map / streaming; b = wave velocity
  gl_FragColor = vec4(height, f.g, w.g, 1.0);
}`;

/* ------------------------------------------------------------------ */
/* wave step — travelling ripples only (strikes), grid solve            */
/* ------------------------------------------------------------------ */

export const STEP_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uState;   // r = height, g = velocity
uniform vec2 uTexel;
uniform float uDt;
uniform float uC2;          // wave-speed² · dt²/dx²  (Courant ≤ 0.5)
uniform float uDamp;        // velocity decay rate (1/s)
uniform float uWall;        // wall absorption (1/s)
uniform vec4 uImp[8];       // xy = uv, z = Δv kick, w = σ²

// Neumann (no-flux) boundary: neighbours outside the basin are projected
// back onto the rim, so waves reflect at the dish wall — never wrap.
vec2 rimClamp(vec2 uv) {
  vec2 d = uv - 0.5;
  float r = length(d);
  return r > 0.4990 ? 0.5 + d * (0.4990 / r) : uv;
}

void main() {
  float r = length(vUv - 0.5) * 2.0;
  if (r > 1.0) { gl_FragColor = vec4(0.0); return; }

  vec4 st = texture2D(uState, vUv);
  float h = st.r;
  float v = st.g;

  float hL = texture2D(uState, rimClamp(vUv - vec2(uTexel.x, 0.0))).r;
  float hR = texture2D(uState, rimClamp(vUv + vec2(uTexel.x, 0.0))).r;
  float hD = texture2D(uState, rimClamp(vUv - vec2(0.0, uTexel.y))).r;
  float hU = texture2D(uState, rimClamp(vUv + vec2(0.0, uTexel.y))).r;
  float lap = hL + hR + hU + hD - 4.0 * h;

  // This grid carries TRAVELLING waves only — pointer strikes and drags.
  // The resonant standing figure is synthesized analytically (FIGURE_FS);
  // injecting it here would pump the grid's undamped zero mode to the rails.
  for (int i = 0; i < 8; i++) {
    vec4 im = uImp[i];
    if (abs(im.z) < 1e-6) continue;
    vec2 d = vUv - im.xy;
    v += im.z * exp(-dot(d, d) / max(im.w, 1e-6));
  }

  v += uC2 * lap * uDt;
  v *= exp(-uDt * uDamp);
  h += v * uDt;

  // lossy wall (documented boundary): soft absorption near the rim keeps
  // repeated reflections from knitting into permanent knots
  float wall = smoothstep(0.86, 1.0, r);
  v *= exp(-uDt * wall * uWall);
  h *= exp(-uDt * wall * uWall * 0.35);

  // sanity rails — well above the operating range (h ≤ ~1.2, v ≤ ~10),
  // hit only by genuine instability, never by design
  h = clamp(h, -2.2, 2.2);
  v = clamp(v, -16.0, 16.0);
  gl_FragColor = vec4(h, v, 0.0, 1.0);
}`;

/* ------------------------------------------------------------------ */
/* pigment — semi-Lagrangian advection driven by the simulated flow    */
/* ------------------------------------------------------------------ */

export const DYE_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uDye;     // rgb premultiplied pigment, a = concentration
uniform sampler2D uField;   // r = height, g = raw modal shape
uniform vec2 uTexel;
uniform float uDt;
uniform float uGather;      // nodal streaming strength (Behavior)
uniform float uDiffusion;   // 0..1 blur mix per frame
uniform float uRelax;       // per-frame mass persistence
uniform float uFlow;        // slope-driven transport gain
uniform float uSwirl;       // rotational transport gain
uniform float uStir;        // frequency-driven ambient agitation
uniform float uTime;
uniform float uSharpen;     // filament contrast recovery
uniform vec4 uDep[8];       // xy = uv, z = radius, w = amount
uniform vec3 uDepAbs[8];    // optical density (Beer–Lambert absorbance) of the ink
uniform vec4 uErase;        // xy = uv, z = radius, w = strength

vec2 discClamp(vec2 uv) {
  vec2 d = uv - 0.5;
  float r = length(d);
  return r > 0.4985 ? 0.5 + d * (0.4985 / r) : uv;
}

vec4 sampleDisc(sampler2D tex, vec2 uv) {
  vec2 d = uv - 0.5;
  if (length(d) > 0.5) return vec4(0.0);
  return texture2D(tex, uv);
}

/**
 * Value noise, used as the stream-function potential for the ambient
 * turbulence. Cheaper than gradient noise and perfectly adequate here: its
 * curl is what matters, and value noise still produces the multi-scale,
 * divergence-free folding that shreds pigment into filaments.
 */
float dhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dhash(i), dhash(i + vec2(1.0, 0.0)), u.x),
             mix(dhash(i + vec2(0.0, 1.0)), dhash(i + vec2(1.0, 1.0)), u.x), u.y);
}

/**
 * Pigment field: rgb = per-channel OPTICAL DENSITY (absorbance), a = mass.
 * Ink mixes SUBTRACTIVELY and correctly because absorbance adds linearly —
 * blue over yellow transmits blue·green (green), exactly as real pigment
 * does. Averaging colours (an RGB lerp) is what makes fake ink go muddy.
 */
void main() {
  float r = length(vUv - 0.5) * 2.0;
  if (r > 1.0) { gl_FragColor = vec4(0.0); return; }

  // ---- divergence-free transport --------------------------------------
  // A vibrating surface drives recirculating orbital flow, which is a
  // CURL field: v = (∂ψ/∂y, −∂ψ/∂x). Using a gradient (∇h) instead would be
  // irrotational — no swirls, ever. The stream function is built from the
  // live height and the modal shape, plus a frequency-scaled ambient stir.
  vec4 fL = texture2D(uField, vUv - vec2(uTexel.x, 0.0));
  vec4 fR = texture2D(uField, vUv + vec2(uTexel.x, 0.0));
  vec4 fD = texture2D(uField, vUv - vec2(0.0, uTexel.y));
  vec4 fU = texture2D(uField, vUv + vec2(0.0, uTexel.y));
  float inv2x = 0.5 / uTexel.x, inv2y = 0.5 / uTexel.y;

  // ---- (1) incompressible churn ---------------------------------------
  // Curl of a stream function. Divergence-free by construction, so it stirs
  // and folds the pigment without ever creating or destroying any of it.
  // A gradient field cannot do this job: it is irrotational, and an
  // irrotational field can never swirl — it can only push everything the same
  // way, which is why ink driven by one just spreads into a flat blob.
  float dPsiDy = uFlow * (fU.r - fD.r) * inv2y + uSwirl * (fU.g - fD.g) * inv2y;
  float dPsiDx = uFlow * (fR.r - fL.r) * inv2x + uSwirl * (fR.g - fL.g) * inv2x;
  vec2 flow = vec2(dPsiDy, -dPsiDx);

  // ---- (2) Chladni migration: what actually draws the figure -----------
  // On a real vibrating plate the powder drifts toward the NODAL lines,
  // where the surface is momentarily still. That is why a Chladni figure is
  // made of settled grains rather than of a standing wave you can see.
  //
  // Collecting ink on the nodes therefore requires a GRADIENT flow, which is
  // divergent by definition — it cannot be folded into the curl above without
  // destroying the very migration that makes the pattern legible. Driving
  // pigment purely by curl gives swirling colour but never a figure.
  // Gradient of shape², in PER-PIXEL units rather than per-texel. Dividing by
  // the texel size (the old inv2x/inv2y) made this term scale with resolution:
  // at 1024² it was ~1000× stronger than the surrounding flow, so pigment
  // snapped into hard one-texel bands at the nodes instead of drifting onto
  // them smoothly. Normalising by a fixed scale keeps the migration a gentle
  // settling force, which is what real powder does.
  vec2 gradShape2 = vec2(fR.g * fR.g - fL.g * fL.g,
                         fU.g * fU.g - fD.g * fD.g);
  // Nodal settling, in per-uv units rather than per-texel.
  //
  // Dividing by the texel size (as this once did) made the term scale with
  // resolution: at 1024² it was orders of magnitude stronger than the
  // surrounding flow, so pigment SNAPPED onto the nodes and froze into flat
  // plates with hard cut edges instead of drifting there and settling.
  // That is what made the pour read as flat coloured shapes rather than the
  // fine branching filaments a real plate builds up.
  //
  // The factor below is calibrated so a drop visibly migrates toward a node
  // over a few seconds — long enough for the flow to stretch and fold it on the
  // way, which is what produces filaments rather than blobs.
  flow -= uGather * gradShape2 * 9.0;

  // ---- ambient turbulence: multi-octave curl noise --------------------
  // This is what makes pigment look like a real fluid rather than a few
  // smooth lobes.
  //
  // The previous version was the curl of two smooth sinusoidal wave trains.
  // Those are perfectly coherent, so they advected pigment into clean, large,
  // unbranched shapes — the dish filled with a handful of big blobs and the
  // rest stayed bare. Real cymatics ink is the opposite: fine, chaotic,
  // branching filaments, because it is stirred by broadband turbulence at
  // every scale.
  //
  // So the stream function is now sum-of-octaves noise. Each octave is a
  // DIFFERENT spatial frequency, and the curl of a sum of octaves is still
  // divergence-free (so pigment is stirred and folded, never created or
  // destroyed) but carries detail down to the finest scale — which is what
  // shreds blobs into filaments.
  {
    float t = uTime;
    vec2 p = vUv * 6.0;
    float psi = 0.0;
    // three octaves, amplitude falling as frequency rises
    psi += 1.00 * vnoise(p * 1.00 + vec2(0.00, t * 0.20));
    psi += 0.55 * vnoise(p * 2.30 + vec2(t * 0.13, 0.70));
    psi += 0.30 * vnoise(p * 5.10 + vec2(0.40, -t * 0.27));
    // curl of the potential = (dψ/dy, -dψ/dx), by central difference
    float e = 0.012;
    float psiY = vnoise((p + vec2(0.0, e * 6.0)) * 1.00 + vec2(0.00, t * 0.20))
               + 0.55 * vnoise((p + vec2(0.0, e * 6.0)) * 2.30 + vec2(t * 0.13, 0.70))
               + 0.30 * vnoise((p + vec2(0.0, e * 6.0)) * 5.10 + vec2(0.40, -t * 0.27));
    float psiX = vnoise((p + vec2(e * 6.0, 0.0)) * 1.00 + vec2(0.00, t * 0.20))
               + 0.55 * vnoise((p + vec2(e * 6.0, 0.0)) * 2.30 + vec2(t * 0.13, 0.70))
               + 0.30 * vnoise((p + vec2(e * 6.0, 0.0)) * 5.10 + vec2(0.40, -t * 0.27));
    flow += uStir * vec2((psiY - psi) / e, -(psiX - psi) / e) * 0.06;
  }

  // transport must stay bounded: a strike spike cannot eject pigment
  //
  // The bound IS the pace of the piece. At 0.055 uv/s a pour crosses the
  // whole basin in about nine seconds, which reads as the ink being wiped
  // rather than as pigment settling; 0.016 puts a pour across in about half a
  // minute, which is slow enough to watch it gather onto the nodal lines and
  // fast enough to still feel like moving water. It also lowers the stirring
  // proportionally, so the noise term stops shredding dense cores.
  const float FLOW_MAX = 0.016;
  float speed = length(flow);
  if (speed > FLOW_MAX) flow *= FLOW_MAX / speed;

  // ---- semi-Lagrangian advection --------------------------------------
  vec2 back = discClamp(vUv - flow * uDt);
  vec4 dye = sampleDisc(uDye, back);

  // Unsharp mask: semi-Lagrangian advection is numerically diffusive, which
  // blurs ink into smoke within a second. This restores the crisp filament
  // edges real pigment keeps.
  //
  // The blur MUST be wider than the noise it is trying to sharpen. A 1-texel
  // difference measures the texel-level jitter that advection leaves behind,
  // so the mask amplifies exactly that jitter — and because it amplifies each
  // absorbance channel by a slightly different amount, the result is not
  // "grain" but coloured speckle (green/magenta flecks) across the pigment.
  // A 3x3 kernel averages that jitter away and leaves real filament edges.
  //
  // The LIMITER is not optional, it is the whole thing.
  //
  // A sharpener is a high-pass boost, so its gain at near-Nyquist is
  // (1 + k·(1 - H)) — about 1.089 per frame at k = 0.1 with this kernel.
  // Because the pigment field is PERSISTENT, that gain COMPOUNDS: 1.089^300
  // frames is roughly 1e11. Within a couple of seconds the field is pinned at
  // the hard ceiling and the screen fills with horizontal dashes — saturated
  // plateaus alternating with gaps, which is precisely the artefact this was
  // supposed to prevent. It also destroyed the colour, because the ceiling
  // clamps each absorbance channel independently and so bleeds the hue.
  //
  // Clamping the sharpened value to the neighbourhood's own min/max — the
  // standard MacCormack limiter — makes the operator genuinely contractive:
  // the output can never exceed what was already present next to it, so there
  // is no gain to compound. It still tightens real filament edges (it pulls a
  // local maximum up and a local minimum down, toward their neighbours'
  // range) but it cannot manufacture new extremes, which is what the earlier
  // version was doing.
  if (uSharpen > 0.0) {
    // Sharpen the shared MASS channel only, never the three absorbance
    // channels independently. Per-channel sharpening amplifies each channel's
    // own advection jitter separately, and since the renderer reads the
    // channels as three different colour filters, that surfaces as coloured
    // speckle rather than as crisper edges. Carrying the hue ratio through
    // untouched keeps the ink's colour while the density gets its edges back.
    vec4 c0  = sampleDisc(uDye, back);
    vec4 cx1 = sampleDisc(uDye, back + vec2(uTexel.x, 0.0));
    vec4 cx0 = sampleDisc(uDye, back - vec2(uTexel.x, 0.0));
    vec4 cy1 = sampleDisc(uDye, back + vec2(0.0, uTexel.y));
    vec4 cy0 = sampleDisc(uDye, back - vec2(0.0, uTexel.y));
    vec4 cd1 = sampleDisc(uDye, back + uTexel);
    vec4 cd0 = sampleDisc(uDye, back - uTexel);
    vec4 cxp = sampleDisc(uDye, back + vec2(uTexel.x, -uTexel.y));
    vec4 cxm = sampleDisc(uDye, back + vec2(-uTexel.x, uTexel.y));

    float blurM = (c0.a * 4.0 + (cx1.a + cx0.a + cy1.a + cy0.a) * 2.0
                 + cd1.a + cd0.a + cxp.a + cxm.a) / 16.0;
    float loM = min(min(min(cx1.a, cx0.a), min(cy1.a, cy0.a)),
                   min(min(cd1.a, cd0.a), min(cxp.a, cxm.a)));
    loM = min(loM, c0.a);
    float hiM = max(max(max(cx1.a, cx0.a), max(cy1.a, cy0.a)),
                   max(max(cd1.a, cd0.a), max(cxp.a, cxm.a)));
    hiM = max(hiM, c0.a);

    float massNow = dye.a;
    float target = massNow + (massNow - blurM) * uSharpen;
    float sharpenedMass = min(max(target, loM), hiM);
    vec3 ratio = massNow > 1e-3 ? dye.rgb / massNow : vec3(0.0);
    dye.rgb = clamp(ratio * sharpenedMass, vec3(0.0), vec3(6.5));
    dye.a = sharpenedMass;
  }
  dye = mix(dye, sampleDisc(uDye, vUv), uDiffusion);

  // ---- deposits: absorbance adds, so colours mix subtractively ---------
  for (int i = 0; i < 8; i++) {
    vec4 d = uDep[i];
    if (d.w <= 0.0) continue;
    vec2 dd = vUv - d.xy;
    float spot = exp(-dot(dd, dd) / max(d.z * d.z, 1e-6)) * d.w;
    if (spot < 1e-5) continue;
    dye.rgb += uDepAbs[i] * spot;
    dye.a += spot * 0.85;
  }

  // ---- SOFT CEILINGS ----------------------------------------------------
  //
  // Every bound in a PERSISTENT field has to be soft. A hard min()/clamp() is a
  // plateau, and a plateau beside a slope is a step: neighbouring texels that
  // straddle the ceiling disagree about whether they have "hit the top", and
  // once the transport stirs that boundary it shreds into hard-edged dashes.
  // These are tanh roll-offs — smooth everywhere, asymptotic to the same
  // ceiling — so the approach is gradual and no two adjacent texels can
  // disagree about which side of the bound they are on.
  dye.a = 2.6 * tanh(dye.a / 2.6);
  dye.rgb = 6.5 * tanh(dye.rgb / 6.5);

  // ---- local erase ----------------------------------------------------
  if (uErase.w > 0.0) {
    vec2 de = vUv - uErase.xy;
    float cut = exp(-dot(de, de) / max(uErase.z * uErase.z, 1e-6)) * uErase.w;
    dye *= 1.0 - cut;
  }

  // persistence: keeps clear water readable between strokes
  dye *= uRelax;
  gl_FragColor = dye;
}`;
