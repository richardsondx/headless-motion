# Rifle fix report

Date: Nov 8, 2026. Approved by Richardson 15:54 EST. Direct fix, not a Handover unit.

## What was wrong

Two defects in the image-node path, both confirmed by reading the code.

1. `src/renderer/compile.mjs`, nodeHtml() image branch: the div had no
   position style. Every other node type gets position absolute plus
   left, top, width, height, and z-index. The image div was static
   (1920x0 at 0,0), so the runtime per-frame left and top sets were
   no-ops.
2. `src/renderer/runtime.mjs`, apply() image branch: it overwrote the
   img src with the raw relative filesystem path on every frame. That
   replaced compile's embedded data URI, so the img never loaded
   (naturalWidth 0).

## What changed

- `src/renderer/compile.mjs`, image branch: the div now gets the same
  position, left, top, width, height, and z-index style as the shape
  branch.
- `src/renderer/runtime.mjs`, apply() image branch: it now skips the
  src set when the img already holds an embedded data URI. External
  URLs still set normally.

Commit: 91e5329, local only, 2 files, 2 lines changed. Only my two
hunks were staged. The other uncommitted changes in compile.mjs belong
to other work and were left alone.

## Proof

- Previs: `out/seg4-rifle-fixed/`, 12 frames (168-180), previs profile.
  Video and frame PNGs kept. Probe screenshot
  `out/seg4-rifle-fixed/frame-168-probe.png`.
- DOM probe at frame 168: rifle div position absolute, left 613, top
  649, width 160, height 166, z-index 4. Img complete, naturalWidth
  160, naturalHeight 166, src starts with data. Badge rect the same
  box.
- Rifle pixel count at frame 168: 2,668 dark non-orange pixels in the
  badge zone (613,649,160,166). Rule: luma under 150 and colour
  distance over 50 from badge orange #CC4726. Rifle.png holds 2,671
  opaque pixels. The earlier smoke previs had 4. The rifle renders.
- Scene validation: OK seg4-scene-v5, 192 frames, 24 fps.
- Renderer tests: 20 pass, 0 fail.
