# Measured performance (not assumed)

Machine: Windows 11, Chrome (headed, real GPU) — `node scripts/fpsprobe.mjs`
measures median frame time over multi-second windows at a fixed 1600×1000
viewport, drive level 0.85.

| State | This branch (overhaul) | `main` (baseline) |
|---|---:|---:|
| Idle (drive on, no pigment) | **60.6 FPS** (median 16.5 ms) | 60.6 FPS (median 16.5 ms) |
| Transient — first pigment+droplet session | ~7 FPS for ≈6 s (driver shader-compilation hitch, self-recovers) | none observed (59.5 FPS) |
| Settled active (drive + pigment + drops) | **60.6 FPS** (median 16.5 ms) | 59.5–59.9 FPS |

Notes:

- Headless runs fall back to SwiftShader; their FPS (6–15) says nothing about
  real hardware and is reported only by the CI-style `verify.mjs` for
  regression detection.
- The first-use transient is a Windows/ANGLE driver lazily optimising the
  heavy program set the first time the pigment+droplet path runs; it heals by
  itself and does not recur for the rest of the session (verified by
  back-to-back measures: 7 → 7 → 7 → 60.2 → 60 …).
- Cost attribution (headless, per-subsystem): with the dye pass skipped the
  frame returns to 60 FPS; the travelling-wave grid, figure pass and
  transmission are not the bottleneck at these resolutions.

What was actually optimised in this branch:

1. **Figure pass runs on change, not per frame.** The old identity check
   (`slots !== __lastSlots`) never fired because `ResonanceModel.update`
   returns a fresh array each call — the 512² Bessel synthesis ran every
   frame. It now renders when the modal fingerprint (m, kR, amp rounded) or
   the breathing phase (0.55 rad quantum) actually moves.
2. **Liquid mesh 245k → 164k triangles** (256×320 polar grid): displacement
   is small and normals come from the field texture, so the lost tessellation
   is invisible; the fill saving is not.
3. **Dye buffer 1024² → 768²**: the advection + 13-tap unsharp + field-tap
   cost scales with texel count; the 512² figure already carries the fine
   structure.
4. **Per-frame allocations removed** in the pigment deposit path (reused
   scratch vectors; the old code allocated two `THREE.Vector4`s every frame).
5. **Shadow map renders once** (static set) instead of every frame — also
   removes frame-to-frame shadow shimmer on the rim.
