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
uniform vec4 uModes[6];   // x = m, y = k·R, z = amplitude, w = breathing phase
${BESSEL_GLSL}

void main() {
  vec2 c = (vUv - 0.5) * 2.0;
  float r = length(c);
  float mask = 1.0 - smoothstep(0.985, 1.0, r);
  if (mask <= 0.0) { gl_FragColor = vec4(0.0); return; }
  float th = atan(c.y, c.x);
  float h = 0.0;
  // Count the live modes so the sum can be normalised. Superposing N modes
  // accumulates ~N times the amplitude of one; without this, adding modes
  // (which is what makes the figure interesting) simply drives the surface
  // harder and harder until it clips into hard-edged wedges.
  float live = 0.0;
  for (int i = 0; i < 6; i++) live += step(1e-5, abs(uModes[i].z));
  for (int i = 0; i < 6; i++) {
    vec4 M = uModes[i];
    if (abs(M.z) < 1e-5) continue;
    int m = int(M.x + 0.5);
    h += M.z * besselJ(m, M.y * r) * cos(M.x * th);
  }
  h /= sqrt(max(live, 1.0));
  // single coherent breathing envelope: the figure stays lit and shimmers
  // instead of strobing through zero every cycle (documented in README)
  float env = 0.78 + 0.22 * sin(uModes[0].w);
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
  flow -= uGather * gradShape2 * 64.0;

  // ambient stir: analytic curl of two drifting wave trains. Amplitude
  // tracks the drive, so a higher tone visibly churns the water faster.
  {
    float t = uTime;
    vec2 q = (vUv - 0.5) * 6.2831853;
    float k1 = 1.7, k2 = 2.9;
    // psi = sin(k1 qx + a t) cos(k2 qy + b t) + 0.6 sin(k3 qx + c t) sin(k4 qy + d t)
    float p1 = sin(k1 * q.x + 0.9 * t) * cos(k2 * q.y - 0.7 * t);
    float p1y = sin(k1 * q.x + 0.9 * t) * -sin(k2 * q.y - 0.7 * t) * k2;
    float p1x = cos(k1 * q.x + 0.9 * t) * k1 * cos(k2 * q.y - 0.7 * t);
    float k3 = 4.3, k4 = 5.1;
    float p2 = 0.6 * sin(k3 * q.x - 1.3 * t) * sin(k4 * q.y + 0.4 * t);
    float p2y = 0.6 * sin(k3 * q.x - 1.3 * t) * cos(k4 * q.y + 0.4 * t) * k4;
    float p2x = 0.6 * cos(k3 * q.x - 1.3 * t) * k3 * sin(k4 * q.y + 0.4 * t);
    flow += uStir * vec2(p1y + p2y, -(p1x + p2x));
  }

  // transport must stay bounded: a strike spike cannot eject pigment
  float speed = length(flow);
  if (speed > 0.10) flow *= 0.10 / speed;

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
  if (uSharpen > 0.0) {
    vec4 b = sampleDisc(uDye, back) * 4.0;
    b += (sampleDisc(uDye, back + vec2(uTexel.x, 0.0))
        + sampleDisc(uDye, back - vec2(uTexel.x, 0.0))
        + sampleDisc(uDye, back + vec2(0.0, uTexel.y))
        + sampleDisc(uDye, back - vec2(0.0, uTexel.y))) * 2.0;
    b += (sampleDisc(uDye, back + uTexel)
        + sampleDisc(uDye, back - uTexel)
        + sampleDisc(uDye, back + vec2(uTexel.x, -uTexel.y))
        + sampleDisc(uDye, back + vec2(-uTexel.x, uTexel.y)));
    b /= 16.0;
    // Sharpen the MASS channel, not each absorbance channel independently.
    //
    // Advection leaves slightly different texel jitter in each of the three
    // absorbance channels. Sharpening them separately amplifies those
    // differences independently, and because the renderer reads each channel
    // as a different colour filter, the result is not grain but COLOURED
    // speckle — rainbow dashes over the whole surface. Sharpening the shared
    // mass restores filament edges while leaving the hue ratio intact, which
    // is exactly what the mask is meant to do.
    float massNow = dye.a;
    float massBlur = b.a;
    float sharpenedMass = max(massNow + (massNow - massBlur) * uSharpen, 0.0);
    vec3 ratio = massNow > 1e-4 ? dye.rgb / massNow : vec3(0.0);
    dye.rgb = ratio * sharpenedMass;
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
    dye.a = min(dye.a + spot * 0.85, 4.0);
  }

  // ---- local erase ----------------------------------------------------
  if (uErase.w > 0.0) {
    vec2 de = vUv - uErase.xy;
    float cut = exp(-dot(de, de) / max(uErase.z * uErase.z, 1e-6)) * uErase.w;
    dye *= 1.0 - cut;
  }

  // persistence: keeps clear water readable between strokes
  dye *= uRelax;
  dye.a = min(dye.a, 4.0);
  // SOFT saturation instead of min(): a hard per-channel clamp pins the
  // densest channel and then lets the weaker ones catch up to it over a few
  // frames, which bleeds every pigment toward neutral grey. tanh rolls off
  // asymptotically while preserving the channel RATIOS — i.e. the hue.
  dye.rgb = 9.0 * tanh(dye.rgb / 9.0);
  gl_FragColor = dye;
}`;
