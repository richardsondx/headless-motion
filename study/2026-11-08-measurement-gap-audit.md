# Measurement gap audit, Seg4 clone

Date: 2026-11-08. Question: what dimensions are we not measuring when we compare
our render to the real video, pixel to pixel and in depth? This audit reads the
checker as built (src/checker/stages.py S0-S8, metrics.py, color.py, layout.py,
text.py, motion.py, events.py, map g8.mjs/g9.mjs) and the stills check that
produced the v5 verdict, and lists what each one misses. No threshold is
changed here. This is a list of gaps, not a new verdict.

## What we measure now

The full checker (needs a reference video, which Seg4 does not have yet):
S0 shape (fps, frame count, 1920x1080, profile must be final). S1 flat colour
(Delta E on medians in set rects, plus a check the reference region is flat).
S2 events (frame-diff energy peak size and timing in set rects). S3 text (ink
box shift under 2 px, ink IoU over 0.5, crop SSIM flags a font swap under 0.9).
S4 motion (global phase shift per frame under 2 px, jump under 4 px, per-target
shift). S5 SSIM and PSNR per frame (floor 0.90, hard floor 0.85) and means.
S6 LPIPS mean. S7 map gates G8 contrast and G9 focus/camera. S8 layout
(informational only): ratios, border distances, zoom curve, pair gaps.
Verdict needs a human gate file for PASS; that gate has never run.

The stills check (what v5 actually got) is a subset: SSIM, PSNR, LPIPS and
Delta E at 4 seconds, layout at 4 seconds, contrast at 7 seconds. No S0, no
S2, no S4, no S7, no human gate.

## Gap 1: coverage. We check 4 of 192 frames.

The stills check covers 2 percent of the video. 188 frames are unmeasured.
Sub-second timing is unmeasured: the badge pop-in (frames 83-101) and the
label fades (frames 0-24 and 144-156) are checked only as present or absent
at whole seconds. Fade curves (opacity over frames) are never compared.
Fix: the reference video. Only a real video unlocks the full checker.

## Gap 2: zoom velocity. The camera move is never measured as a move.

S4 measures one global translation per frame by phase correlation. A zoom is
a scale change, not a translation, so phase correlation is blind to it. The
zoom rate (how fast Sudan grows, frame to frame) is never compared, and the
easing curve is never fitted. The v5 scene uses 9 camera knots, and the build
note warns to watch for velocity pulsing at the knots. Nothing would catch
pulsing. Fix: compare the Sudan width curve per frame, both videos, and the
first difference of that curve (the velocity).

## Gap 3: shape. We measure boxes, not outlines.

Layout measures bbox, centroid and width. The actual outline of Sudan (the
Nile bend, the Red Sea coast, the southern border wiggles) is never compared
as a contour. Width can pass while the shape is wrong. Only Sudan is
segmented at all; Egypt, Saudi, Libya and the rest are never checked, so a
projection error there is invisible except through SSIM. Fix: contour
distance (Chamfer or Hausdorff) between the real and ours Sudan outlines,
and bbox checks for the neighbouring countries.

## Gap 4: motion blur, grain, and time. The video moves; our frames do not.

Motion blur during the fast zoom (0:02-0:03) is never measured. Our render
has no blur; each frame is a crisp still. Temporal noise is never measured:
our grain is one static tile, the same pattern every frame, while the real
video's noise changes every frame. A frozen grain pattern would look wrong
in motion and nothing measures it. Fix: frame-difference energy in static
regions, and an edge-width measure for blur.

## Gap 5: vignette. We add one; the real video may not have one.

The renderer paints a vignette over every frame. Nobody has measured whether
the real video has one. If ours darkens the corners and the real does not,
that is a systematic difference in every frame, and median colour sampling
(which samples the centre) cannot see it. Fix: compare corner against centre
luminance in both videos.

## Gap 6: colour beyond medians.

S1 samples medians in set rects. The whole-frame colour histogram is never
compared. A subtle gradient in the real land, or a colour shift in the water,
would pass the medians and fail the picture. The halo around the El Fasher
dot is a flat disc at 0.19 opacity in our scene; the real halo's radial
falloff is never measured as a profile. Fix: histogram comparison, and a
radial profile for the halo.

## Gap 7: depth and layering. What sits on top of what.

When elements overlap (EL FASHER label against the badge corner, dot against
badge, title against map), the stacking order is never checked directly, only
the positions. If our z-order is wrong at an overlap, SSIM drops but no
check names the cause. Shadows and glows are never measured: our labels are
flat, and nobody has checked whether the real labels carry a shadow. The
badge interior is never measured as parts: the rifle position inside the
badge and the RSF text position inside the badge are one orange region to
the checker. Fix: an overlap check (which element wins each shared pixel)
and a shadow test (a soft dark fringe beside bright text).

## Gap 8: type beyond the box.

S3 checks the ink box (position and overlap) and crop SSIM (which flags a
font swap under 0.9). It never measures glyph shape: per-letter overlap,
letter spacing, kerning, stroke weight. The title's letter spacing (-6 px
in our scene) is a guess the checker cannot test. Anti-aliasing of glyph
edges is never compared. Fix: the font-ID module (template matching, already
designed in the WhatTheFont study) plus a per-letter overlap score.

## Gap 9: calibration. We do not know what a perfect clone would score.

This is the most important gap. We have never run a control: take our own
render, put it through the same path as the reference (same player, same
screenshot, same resize), and measure it against the clean render. That
number is the ceiling. If the ceiling is 0.85 SSIM, the 0.96 bar is
unreachable by construction and the predicate is wrong for stills. If the
ceiling is 0.98, the gap is real. Related: the caption bar, player chrome,
watermark and cursor in the real frames are listed as limits but never
masked out of the comparison, so they drag every number down by an unknown
amount. The 4 percent vertical stretch is never corrected for. LPIPS was
trained on photos, not flat graphics, so it responds weakly to flat colour
shifts; DISTS is not implemented. The 0.02 layout tolerance and the Delta E
bar are adopted, not calibrated to this content or to Richardson's eye.
Fix: run the control experiment first (cheap, no video needed), mask the
non-video regions out of the stills comparison, and compare our render
after YouTube-like compression, not before it.

## Gap 10: process. The human gate and the missing segments.

The human blind gate (full speed and 0.25x, stills at 1, 5, 9 seconds) has
never run. PENDING_HUMAN is the honest verdict for anything that passes the
numbers. Seg1 and Seg2 are not built and there is no chart fixture, so those
segments are unmeasured by definition. The checker's own determinism (same
inputs give the same verdict) is not routinely verified.

## Verdict on the video capture

Yes, there is a gap in our measurement, and it is large. The capture fixes
Gap 1 (coverage), the sub-second timing, and it removes the screenshot
distortions (stretch, chrome, captions). It does not fix Gaps 2-9. The right
order is: run the control experiment first (it quantifies how much of the
0.77 is measurement artifact, and it needs no video), mask the non-video
regions, then capture the video, then add the missing dimensions (zoom
velocity, contour shape, vignette, grain over time, z-order) to the checker
as the video enables them. Capturing first without the control would leave
us unable to say how much of the next number is real progress.

## Control experiment results (2026-11-08, ~10:03 EST)

Ran. Screenshots taken locally with Playwright (the managed browser could
not load the hosted page, muse.ai is blocked by its policy, and it refuses
file:// URLs). 8 shots, all at the exact target second, paused, 1920x1080
video. Measured with measure-control.py, same method as measure-v5.py.
Full JSON at verify-seg4/evidence/work/control-ceiling.json.

Clean arm (screenshot + resize only): mean SSIM 0.9708, PSNR 38.11,
LPIPS 0.0425, worst Delta E 1.99. Passes pred-v1 Seg4. The screenshot and
resize path costs almost nothing. The 4 percent stretch is not the problem.

YouTube-like arm (screenshot + resize + x264 crf 28): mean SSIM 0.9346,
PSNR 35.97, LPIPS 0.1079, worst Delta E 1.74. Fails pred-v1 (SSIM under
0.96, LPIPS over 0.08). Compression is the dominant penalty, and LPIPS
sees it most (0.0425 clean against 0.1079 compressed).

Caveat: crf 28 is harsher than YouTube (0.95 Mbps against YouTube's
roughly 4.5 to 8 Mbps for 1080p), so the true YouTube ceiling sits
between 0.9346 and 0.9708. The 0.96 bar sits at the top of that range.
A recalibrated arm at YouTube-realistic bitrate would pin it.

Actual v5 against real: SSIM 0.7727. So the clone gap is 0.16 to 0.20
SSIM, larger than the measurement penalty of 0.03 to 0.07. Both gaps are
real. The measurement gap does not excuse the clone gap, and the clone
gap does not hide the measurement gap.

Consequence: the pred-v1 bar is likely unreachable against screenshot
references, because a perfect clone fails it. The fix is the capture
(real video, full checker on all 192 frames) plus compressing our render
the same way before comparing, so both sides carry the same compression.
Then the 0.96 bar means something again.

## 192-frame check, Nov 8, 2026 (map-only verdict)

Full 192 frames vs the captured video: mean SSIM 0.7941, PSNR 20.21,
LPIPS 0.6312, all 192 frames below 0.85. Verdict FAIL vs pred-v1
(0.96, 35, 0.08). Full report: verify-seg4/evidence/work/full-192/
full192-report.json. Map-only means: full-192/map-only-means.json.

Cut is frame 186 (7.75 s), not 8.0 s. Sudan-teal pixels drop from
about 2,017,000 to 43,023. The map is 186 frames (0 to 7.708 s).
Frames 186 to 191 are phone footage. The 192-frame worst frames
(186 to 190, SSIM 0.68) are map against footage, not a clone error.

Map-only (frames 0 to 185): mean SSIM 0.7975, PSNR 20.41, all 186
below 0.85. FAIL. The footage frames barely move the mean (0.7941
to 0.7975), so the verdict does not change.

Worst map-only frames are 39 to 43 (1.6 to 1.8 s, SSIM 0.774), the
title fade plus small Sudan plus red stroke. Every second scores
0.776 to 0.808. Worst second is 1 s (0.7761). Best are 6 s and 7 s
(0.808). The error is everywhere. No second is close to passing.

The 4 s and 5 s Delta E failures are a badge-position error, not a
colour error. Real badge at 5.0 s is (966, 594). v5 has it at
(864, 634). The trace 5 s position (799, 666) is the real position at
5.75 s. v5 moves the badge about 0.75 s too early and has it full
size from 4 s, while the real badge is still growing (15,200 px at
5.0 s to 23,108 px at 7.0 s). The sample points swap contents at 5 s:
the real Sudan point hits the badge (brown #6E402C) and the real RSF
point hits Sudan teal (#123A34), so Delta E reads 35.51 and 48.69.
Colours are fine. At 7 s, when positions agree, Sudan Delta E is 1.88
and RSF is 0.66.

The clone gap (0.16 to 0.20 SSIM below the ceiling) is real, not a
measurement gap. The control ceiling says a perfect clone scores
about 0.96 here. v5 scores 0.80. That is the work for v6: re-time the
badge path from exact frames, kill the stroke and borders (already
built), render the rifle (needs the image-node fix), and fix the
camera and fonts.
