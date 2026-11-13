# Fable feedback on both frame 184 approach grids

## Run record

- Model: anthropic/claude-fable-5.2 on OpenRouter, reasoning effort low, max_tokens 8000.
- Generation ID: gen-1794584469-hgT45Ms7FoHI9d3DY358.
- Finish reason: stop, so the model completed its output within the 8000 token budget.
- Usage: 6037 prompt tokens plus 5374 completion tokens equals 11411 total tokens, with 2970 reasoning tokens inside the completion count.
- Cost: $0.263256 from the usage object, because the generation endpoint returned 404 as it did on earlier runs.
- Key route: transient $2-capped key named frame184-fable-feedback, minted, used once, deleted, verified absent.
- Prompt file: fable-grid-feedback-prompt.md, SHA a8f2e2dd6e7d3257f8a497e72f99bccc6a2d6cdcaa48141c3c47f7d5f2c0839c, 16140 chars, built from prompt v8 (43 claims), the comparison log honest reads, the measured numbers, and the known misses.
- Raw response file: fable-grid-feedback-raw.md, SHA cb7c1f857a75b937179656d19f527445b91abe18f34f17e8edee0cc7980ec755, 6071 chars.
- Result: 15 numbered recommendations, with the top 5 clearly marked, covering both grids.
- Date: 2026-11-13, run at about 10:40 EST, one generation only with no retry.

## Full Fable feedback text (verbatim)

# Feedback on the frame 184 grids

I worked only from the written reads and measurements. Any thickness or proportion I give that is not in your numbers is a starting estimate to calibrate against the reference.

The code-model grid loses on drawing, and most of that is fixable by construction, not by better freehand SVG. The width misses for Terra (0.22) and Fable (0.39) are mainly a pose miss. The 0.60 target is the arm span, from the left elbow at x 0.28 to the right arm extent at 0.8505, so arms hanging at the sides can never reach it.

## Code-model grid (Terra, Fable, Headless Motion)

1. **TOP 5. Trace body parts and bind them to the rig. Fixes Headless Motion.**
   - Change: run VTracer on separated parts: hair with head, torso, white top, shorts, upper arm, forearm, hand blob. Snap the fills to the prompt hexes and attach each part to its bone in place of the stick paths.
   - Why: the skeleton is already right (hand on hip, arm extended, blob hand) and the descent is exact (f4 to f8 is 50.3 px vs 57.3 expected, hold exact at 95.2). Only visual mass is missing.
   - Caveat: if tracing the reference feels like leakage, trace Sunburst's output and label the panel as traced.

2. **TOP 5. Drive the arms with IK. Fixes Terra and Fable.**
   - Change: stop letting the models place arms freehand. Pick the nearest of the 13 named arm poses for hand on hip (left) and extended low (right).
   - Then set the IK targets: left hand at 0.32, 0.71 with the elbow at 0.28, 0.55; right hand at 0.81, 0.67 with the elbow at 0.67, 0.52.
   - Check the elbow angles against 129.8 and 145.6 degrees.
   - Why: this fixes the stance, and moves width from 0.22 and 0.39 toward 0.57 before any thickness is added.

3. **TOP 5. Make limbs thick capsules. Fixes all three code panels.**
   - Change: draw each arm as one continuous shape from shoulder through elbow to hand, with round caps and a round elbow join. Start at about 0.06 of frame width at the upper arm, tapering to about 0.045 at the wrist. End the right arm in one rounded blob about 1.3 times the wrist width (C31).
   - Do not build arms from separate rectangles and circles. That is the "assembled shapes" look.
   - Why: Headless Motion reads 0.570 against the reference 0.598. That 0.028 gap is about half a limb thickness on each side, so thick limbs close it.

4. **TOP 5. Build the torso as one closed, layered silhouette. Fixes all three code panels.**
   - Change: draw one skin shape from the shoulders (x 0.37 to 0.60 at y 0.24) to the bottom edge. Widen it to roughly 0.30 at the hips, since the hand touches the hip at x 0.32. Use curved sides and rounded shoulders.
   - Layer the shorts, white top and waistband on top of it, in that order.
   - Widen the Headless Motion top from 0.233 to 0.253.
   - Why: a narrow rectangle torso has no mass. Layering also removes Fable's V, which came from the midriff shape dipping between the legs.

5. **TOP 5. Resize the head to the measured hair width. Fixes Terra, Fable and Headless Motion.**
   - Change: make the hair 0.2495 wide (x 0.34 to 0.59), which is wider than the 0.234 shoulder span. Put the head center at y 0.10 so the crown sits well above the frame.
   - Shorten the neck to a small stub. Shoulders at 0.24 leave little room below the jaw.
   - Scale the eyes to about 0.03 of frame width each, and make the brows and mouth thick strokes.
   - Why: the small head, dot eyes and long neck make Fable's crop read as a complete small head and not the reference close-up.

6. **Flatten the shorts top edge. Fixes Terra and Fable.**
   - Change: make it one shallow curve from y 0.71 at the sides to y 0.78 at center, a 0.07 dip with no point.
   - Why: C35 was over-read as a deep V, while the reference reads straight across.

7. **Reshape the crown patch. Fixes Terra, Fable and Headless Motion.**
   - Change: hold it to x 0.38 to 0.58 so navy hair shows on both sides. Give it a curved lower edge, not a parallel-edged band or rectangle.
   - Why: a full-width band reads as a headband.

8. **Make the hair one solid shape. Fixes Headless Motion and both text models.**
   - Change: use a single rounded bob outline with a straight hairline at y 0.03, ending at y 0.15. Fuse the tuft at x 0.34 to 0.36 into the same shape. Draw the face on top.

9. **Remove Fable's sleeves.**
   - Change: cut the armholes inside the shoulder points so bare peach shoulders show.

10. **Convert coordinates to pixels once. Fixes Terra and Fable.**
    - Change: convert x by frame width and y by frame height at the start, then draw only in pixels.
    - Why: tall narrow figures are a typical sign of mixed units.

11. **Nudge the Headless Motion descent. Low impact.**
    - Change: raise f4 by 7.5 px at 480p (17 px at 1080, 1.6 percent of frame height) to match the reference 37.4.

## Image-model grid (Flare, Sunburst)

12. **Fix crop and width in one deterministic step. Fixes Flare and Sunburst.**
    - Change: scale the figure by 1.095 for Flare (0.548 to 0.60) and 1.126 for Sunburst (0.533 to 0.60). Shift it so the head center lands at 0.50, 0.10. This pushes the crown out of frame.
    - Composite the figure over a regenerated exact gradient and shadow. The crop would otherwise shift the stops. Both currently pass at 3.00 per row against the cap of 4.
    - Why: both models ignored the numeric crop in v6 and v8, so more coordinates will not fix it.

13. **State the crop as composition, not coordinates. Fixes Flare and Sunburst.**
    - Change: describe a tight crop where the frame slices through the forehead hair and hair fills the top edge. Remove any wording that implies a whole head.

14. **Add an explicit sleeveless claim. Fixes Flare.**
    - Change: say sleeveless with thin straps and bare shoulders. Add a claim that the shorts run nearly straight across.
    - Why: v8 never says sleeveless. C32 only gives the top's color and hem, so Sunburst's tank top was luck.

15. **Fix Flare's hand.**
    - Change: describe a mitten-like rounded shape, with no finger lines, in the stance section next to the arm.
