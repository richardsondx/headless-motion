# Clone disambiguation: what "we can create a clone" means

Nov 8, 2026. Method: the thesis-disambiguator skill, adapted. A stock
thesis splits into demand, product, commercial, valuation, timing. A
clone thesis splits into pixel, visual, structural, tool, and bar.
Each claim below is testable, with supporting evidence, disconfirming
evidence, and what would falsify it. No claim is averaged with another.

## What the thesis seems to be

"We can create a clone of the Seg4 opening map (0:00-0:08) with the
headless motion tool." The v5 verdict (FAIL, SSIM 0.80) seems to say
we cannot. That reading smuggles in five ambiguities.

## Ambiguities to remove

1. "Clone" is three claims, not one. Pixel-identical (the pred-v1
   bar: SSIM at least 0.96, PSNR at least 35, LPIPS at most 0.08).
   Visually indistinguishable (a human cannot tell them apart in a
   blind side-by-side). Same structure (same elements, colours,
   positions, timings). v5 fails the first. The second was never
   tested. The third is partly true.
2. "Unable" is two claims, not one. Permanently unable (the tool
   cannot do it) versus not yet done (v5 has known fixable defects).
   The v5 FAIL does not distinguish them.
3. "The issue" is singular, but the measurement shows many things
   wrong at once: borders, red stroke, missing rifle, badge timing
   and scale, camera, fonts, compression. There is no single issue.
4. The bar is at the top of the reachable range. A perfect clone
   scores about 0.96 against a YouTube-like re-encode (control arm
   crf 21: 0.9608, passes by 0.0008; crf 28: 0.9346, fails). So FAIL
   could mean "not a clone" or "the bar leaves no margin." Different
   claims, different fixes.
5. The reference is a compressed copy (1920x1038, 23.976 fps, VP9),
   not the original upload. We compare against a compressed copy.
   Our render is clean. That asymmetry is part of the score.

## Clean testable thesis

Pixel claim: v6, with the known fixes, scores SSIM at least 0.96,
PSNR at least 35, LPIPS at most 0.08 against the captured video, with
our render compressed the same way before comparing.

Visual claim: a human cannot tell v6 from the real in a blind
side-by-side. The blind gate has never run.

Structural claim: v6 has the same elements, colours, positions, and
timings as the real. Layout gaps at most 0.02, flat colours Delta E
under 3, badge path within 15 px.

Tool claim: the engine can render every element the real video has
(map, labels, badge, rifle, camera, fonts). The only known engine
defects are the two image-node bugs (already diagnosed, fix pending
approval).

Bar claim: the pred-v1 bar is reachable. A perfect clone scores at
least 0.96. True only at YouTube-realistic bitrate, and only if our
render is compressed the same way.

## Evidence needed

- Pixel: the v6 render plus the full 192-frame check, with our render
  compressed to match the reference.
- Visual: the blind gate, human, side by side, no labels.
- Structural: the layout check plus overlay plus the badge trajectory
  from exact frames.
- Tool: the image-node fix proven by the rifle rendering (12-frame
  previs, rifle pixels counted). The font test (medium condensed sans
  for EL FASHER, not Anton).
- Bar: the control ceiling at the right bitrate. crf 21 gave 0.9608.
  The true YouTube ceiling sits between 0.9346 and 0.9708.

## What would falsify it

- Pixel: v6 with all known fixes still scores below 0.90 SSIM. Then
  the gap is not the known defects. Something structural is wrong
  (camera, projection, grain, vignette).
- Visual: the blind gate shows a human can tell them apart even when
  the pixel numbers pass. Then the pixel bar is not the right measure
  of clone.
- Structural: layout gaps stay above 0.02 after re-timing from exact
  frames. Then the trace or the projection is wrong.
- Tool: the image-node fix does not make the rifle render, or a
  needed element cannot be rendered at all. Then the tool is the
  bottleneck.
- Bar: a perfect clone (all defects fixed, render compressed the same
  way) still scores below 0.96. Then the bar is unreachable and needs
  reapproval. That is a predicate change, not a fix.

## Open question: the 5 s framing

The two 5 s frames look different to the eye: the real looks tight
on Sudan, ours looks like it shows all of Africa. But the layout
check says Sudan's position and width match at 5 s. The most likely
cause is the borders, not the camera: ours has white country outlines
everywhere, the real has none, and the outlines make the whole
continent visually prominent. The overlay check, which measures
per-element shifts, can settle it. Until then it is a hypothesis, not
a confirmed defect.

## Next analytical step

Fix the known defects and measure again. That experiment separates
"not yet done" from "unable." v6: badge re-timed from exact frames,
stroke and borders off, rifle through the image-node fix, EL FASHER
font tested. Report the three claims separately for v6 (pixel numbers,
blind gate, structural checklist), not one FAIL. And decide the
compression question for the checker: compress our render the same way
before comparing. That is a method change. It needs Richardson's say,
because it changes what the numbers mean.
