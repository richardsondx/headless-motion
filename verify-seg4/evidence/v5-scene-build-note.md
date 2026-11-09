# Seg4 v5 scene build note

Date: 2026-11-08 (early). Scene: `tests/fixtures/seg4-scene-clone-v5.json`.
Source of every number: `verify-seg4/evidence/seg4-trace.json` (10 browser frames,
21x21 medians, mapped to 1920x1080). No colour or position was guessed.
Validation: schema 0 errors, 0 warnings; engine self-check
(`computeMapState` + `sampleScene` vs the trace) ALL CHECKS PASSED;
compile OK, 1,202,270 byte page.html. No render was run in this task.

## What v5 fixes (layout-check fix order)

- Coral flood killed. Sudan is teal, land is dark, no coral anywhere 0:00-0:07.
- Sudan and land are different colours, so the layer check can separate them
  (v4 failed this: both were the same teal). Separation Delta E 8.8.
- Camera matched: one continuous zoom 0:00-0:06, then held. No travel-land-hold.
- RSF badge added, October 2025 title added, El Fasher dot added (dot, not ring).
- Map ends at the 0:08 hard cut. Duration is 192 frames (8 s), not 240.

## Palette (all measured, trace `palette_measured`)

- Sudan fill #143C34. Trace `sudan_teal`, same value at six 0:07 points and at
  Sudan centre in 0:03, 0:05, 0:06. Scene flood #06332A (see grain note).
- Non-subject land #1C2B28. Trace `non_subject_land`, Chad/Arabia samples
  (700,450)/(1400,350). Tokens landBase #082721 (see grain note).
- Water #191D1E. Trace `water_darkest`, Red Sea sample. Tokens waterBase #0B1414.
- RSF orange #CC4726. Trace `rsf_orange`, 0:04 median (0:07 sample #CD4626).
  Used directly on the badge square: shape nodes sit above the map grain.
- October 2025 grey #ABADAC. Trace `october_2025_grey`, 0:01 bright-pixel median.
- Label white #FFFFFF. Trace `label_white`, glyph peaks 228 (SUDAN) / 254 (EL FASHER).
- El Fasher dot #C6C6C6. Trace dot peak luminance 198, so (198,198,198).

## Grain and dim compensation (why the scene/tokens values are darker)

Map fills sit under the static grain tile, which lifts flat fills. The lift
measured on v4 draft frames was +14/+9/+10 per channel (base #0C3630 rendered
#1A3F3A), not the +7.6 model in the old note. Bases are target minus (14,9,10).
The focus also dims non-subject land (saturation x0.75, value x0.88, 6-frame
ramp), which the real video does not do, so the land base is solved backwards
through the dim: dim(#082721) + lift = #1C2B28 exactly (Delta E 0.00 by
construction). Water is not dimmed (background rect). Sudan is the subject,
not dimmed. Solved values, all checked Delta E 0.00 against target:

- Land base #082721. Rendered dimmed #1C2B28. Frames 0-17 (before the focus)
  render #16302B, Delta E 4.16 vs target; those frames are not sampled.
- Water base #0B1414. Rendered #191D1E.
- Sudan flood #06332A. Rendered #143C34.
- Previous tokens values, kept here for the record: landBase was #0C3630
  (rendered #1A3F3A, Delta E 8.43 vs the opening land), waterBase was #111A1C
  (rendered #1E2527, Delta E 2.82). The thumbnail values
  (landMeasuredThumb #133A35, waterMeasuredThumb #182022) are untouched: they
  describe the maxres thumbnail, a different image.
- Tokens change is in `src/map/tokens.json` with provenance notes. Blast radius:
  every dark-register render changes pixels. Determinism (same scene, same
  bytes) is unaffected. The running v2b benchmark measures time and renders
  each scene/profile once with no within-run SHA comparison, so its timing
  comparison is unaffected. The lift was measured on draft frames; the final
  profile supersamples 1.5x and may lift differently. The render step must
  verify rendered colours on the final profile and correct the bases if needed.

## Camera: 9 moves, one continuous zoom, no single-move fit

Zoom from Sudan width per second (trace `sudan_width_px_1920x1080`, Sudan lng
span 16.794 deg from the Natural Earth GeoJSON, pxPerDeg = 7.5 x 2^zoom):
0.255 at 0:01, 0.840 at 0:02, 1.498 early 0:03, 1.933 late 0:03, 2.089 at 0:04,
2.231 at 0:05, 2.370 at 0:06 and 0:07. Centres solved from the Sudan shape bbox
(trace `sudan_bbox_screenshot_px`, mapped to 1920x1080, anchor = polygon bbox
centre 30.207, 15.454). The camera path is NOT a straight line: centre lat
goes 30.63, 24.22, 18.80, 15.84, 14.82, 15.18, 15.81, 15.87, overshooting south
at 0:04 then settling back. A single easeInOutCubic move from the 0:01 state
to the 0:07 state misses the label by up to 108 px and the width by 41 px, so
it was rejected. The scene uses 9 moves landing exactly on the 8 measured
seconds (open + s1/s2/s3e/s3l/s4/s5/s6/s7); each move's travel is the gap to the
previous knot. Validation: Sudan width and bbox centre match the trace within
2 px at all 8 seconds. Between knots the camera eases per segment; the trace
cannot resolve intra-second velocity, so this is an interpolation (see below).
The opening move equals the 0:01 state: the 0:00 framing is unmeasured, so no
motion is invented before the first measurement. This camera deliberately
violates the Harris travel-land-hold law: the real video does not follow it.

## Why labels and badge are screen-space nodes, not map labels/badges

- The SUDAN label's implied geographic point, solved from the shape-based
  camera, is (30.2, 16.35) at every second (spread 0.52 deg lng, 0.32 deg lat,
  consistent with measurement noise). The engine's map label for SDN would sit
  at LABEL_X/Y (29.26, 16.33), 0.94 deg (36 px) west of the real label.
- The RSF badge does NOT invert to one lng/lat under any camera. With
  per-second cameras its implied position drifts (29.26, 11.97) at late 0:03
  to (21.75, 11.07) at 0:07, a 7.5 deg westward drift, while its size scales
  with the zoom. It moves relative to the map, so no map-fixed badge can
  express it. It is keyframed screen-space instead.
- The map module's labels are navy pills at fixed 48 px (background and size
  are hardcoded in `src/map/runtime.mjs`; the scene `ground` field is ignored).
  The real labels are plain white text, no pill, scaling 44 to 180 px. The map
  badge is a navy hexagon at fixed size with no colour, shape, or icon option.
  So SUDAN, the badge, EL FASHER, and the dot are text/shape nodes with
  timeline tracks keyframed from the trace. If the camera moves are ever
  changed, these keys must be re-derived: they are coupled to this camera.
- SUDAN keys (frames 24/48/78/90/96/120/144/168): centres
  (1032,669)/(1028,647)/(1010,589)/(982,521)/(968,487)/(975,503)/(982,525)/
  (984,528), widths 44/65/98/132/147/162/179/180. Base box is the 0:07 label
  (Montserrat Bold 47 px, width 180); scale = width/180, x/y = centre offset.
  At 47 px the rendered cap is 33 px vs measured 31; width is the anchor.
- Badge square keys (frames 90/96/120/144/168): centres
  (982,646)/(968,597)/(799,666)/(699,727)/(693,732), sizes
  118x68/130x135/143x148/158x166/160x166. Base box is the 0:07 badge.
  The RSF text node shares the square's x/scale keys; its y keys are corrected
  by 58x(scale-1) so the text stays glued to the square's bottom as it scales.
- EL FASHER label: box is the measured bbox [787,625,918,652], centre
  (850,638). Anton 35 px: width 132 exactly, cap 30 vs measured 27.
  Montserrat cannot fit 132x27 at any size (39 px gives width 227; 22.7 px
  gives cap 16). Font identity is NOT in the trace; Anton is inferred from
  the width/cap ratio and flagged here.
- El Fasher dot: ellipse 11 px at measured centre (783,646), fill #C6C6C6.
  Halo: ellipse 31 px (extends ~15 px, trace) at opacity 0.19 (trace: luminance
  87 at 8 px out vs background 47; 47 + 208x0.19 = 87). Both fade in with the
  label. Dot lng/lat from the settled camera is (24.08-24.82, 13.07-13.29)
  vs the real city (24.35, 13.63), within ~20 px, consistent with the trace's
  y uncertainty; the dot is placed from its measured screen position, not
  from lng/lat.
- October 2025: box is the measured bbox [264,473,1521,606], centre (959,539).
  Montserrat Bold 190 px gives cap height 133 exactly (trace `cap_height`).
  Letter-spacing -6 px is derived: Montserrat 190 advances 1333 px for the
  string vs measured 1257; -6 px over 12 gaps gives 1261. Box top 443 puts the
  cap top at 473 by the font metrics (ascent 968, cap 700, line-height 1.0).
  Font identity is NOT in the trace; Montserrat is the closer fit
  (width/cap 9.45 needed; Montserrat 10.02, Anton 6.20). If the render check
  flags the title width, the font is the first thing to revisit.
- The rifle icon in the badge is not drawn: no measured geometry exists for
  it and the engine has no icon asset. The badge is an orange square + RSF
  text. The layout check segments the orange square, so this does not affect
  it; SSIM/LPIPS will see a small missing detail inside the badge.
- The subject stroke is forced by the engine: Sudan gets a 7 px #E63946 red
  outline + 11 px casing whenever it is the focus subject. The trace records
  no red outline on Sudan. This needs a runtime switch or a trace re-check
  against a real frame; the scene cannot turn it off.

## Focus and timing

- Focus event `sudan` at frame 18 (0.75 s), subject SDN, flood #06332A,
  point El Fasher (24.35, 13.63, real city coords, geography not trace).
  The highlight appears somewhere inside 0:00-0:01 (trace: absent at 0:00,
  present at 0:01); frame 18 is an interpolation that puts the 6-frame dim
  ramp fully done by frame 24, so every checked frame sees the settled land.
  At frame 0 the fill is the base #082721 (no highlight), matching the trace.
- October 2025 opacity keys: 0 at frame 0, 1 at 24, 1 at 48, 0 at 72.
  Trace pins visible at 0:00, full at 0:01, fading at 0:02, gone by 0:03;
  the fade-in curve over the first second is interpolated.
- EL FASHER, dot, halo opacity keys: 0 at 144, 1 (0.19 halo) at 156.
  Trace pins absent early 0:06, full late 0:06; the 12-frame fade is
  interpolated. Real EL FASHER contrast is 6.30:1, below the 7:1 bar; the
  label is kept at the real white, not darkened to pass a bar the real
  video misses.
- Badge visible from frame 90 (late 0:03, first measured frame). Its 0:03-late
  height is 68 px (half pop-in); the scene renders 123 px there because a
  uniform scale cannot do a height-only pop-in. Frame 90 is not a sampled
  second. At the sampled seconds the badge height is exact.
- Far continents (Americas, east Asia) are not in the map include list: at
  the 0:01 wide framing they sit at the frame edges as water-coloured ground.
  The v4 include list (22 countries) is kept; it covers every checked frame.

## Interpolated, not measured (complete list)

- Camera between the 8 knots (easeInOutCubic per segment); the trace cannot
  resolve intra-second velocity, and the path overshoots, so knots are exact
  and segments are smooth guesses. Possible slight velocity pulsing at knots.
- Label/badge positions and sizes between keyframes (linear).
- October 2025 fade-in curve (frames 0-24) and fade-out curve (48-72).
- EL FASHER fade duration (12 frames inside 0:06).
- Focus start frame 18 (highlight appears inside 0:00-0:01, exact frame unknown).
- Opening camera equals the 0:01 state (0:00 framing unmeasured).
- Badge visible.from frame 90; RSF text offset +58 px from the badge centre;
  halo as a flat 31 px disc at 0.19 (real halo is a soft radial falloff).
- October 2025 letter-spacing -6 px and font Montserrat; EL FASHER font Anton.
  Both fonts are inferred from measured width/cap ratios, not identified in
  the trace.

## Guessed: none for colours or positions

Every colour and every position in the scene comes from a trace measurement
listed above. The only non-measured choices are the font identities, the
sub-second timings, and the small offsets listed under "Interpolated", each
flagged there with its derivation.

## Validation results

- Schema validation: 0 errors, 0 warnings.
- Engine self-check (own `computeMapState` + `sampleScene` vs trace):
  Sudan width and bbox centre within 2 px at all 8 measured seconds; SUDAN
  label centre and width within 1 px; badge centre and size within 1 px at
  frames 96/120/144/168 (height within 2 px at 144); focus fills correct
  (frame 0 SDN base #082721, frame 24 SDN flood #06332A, frame 24 EGY dimmed
  #0E221E pre-grain); visibility and opacity correct at every checked frame.
- Compile: OK, 1,202,270 byte page.html, fonts and Natural Earth present.

## Open for the render step

- Verify rendered colours on the final profile (grain lift may differ from
  the draft-measured +14/+9/+10); correct the bases if needed.
- Verify the October 2025 title width (font unidentified) and the red subject
  stroke (trace records none) against a real frame.
- Watch for velocity pulsing at the camera knots; if visible, replace the
  per-second knots with a smoother fitted curve.
- Engine gaps to fix separately (not scene work): map labels need a
  transparent ground and zoom-scaled size; badges need a square mode, a
  colour, and an icon; the subject stroke needs an off switch; the focus dim
  needs an off switch; land/water need a per-scene override instead of
  global tokens.
