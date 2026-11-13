# Anime rig gaps: first-principles ladder, after the failed run

Date: 2026-11-10. Trigger: Richardson, after the run verdict FAIL and after his own eye rejected both stills. His words: looks like it is getting better but there is still gaps to analyze, understand and fix first principle.

Skill: `~/workspace/custom-skills/local-first-principles-questions/SKILL.md`. Outcome 3, full ladder. Budget: 8 claims, all 8 tested. No fix is approved by this record. The next step is a Stage 1 package for the fix run, for Richardson's approval, then Stage 2, under Handover rules. Nothing builds until Stage 1 and Stage 2 are approved.

Run under analysis: stage2-anime-rig-2026-11-10-01. Judge verdict FAIL, pilot-gate stop, not a section 8 dead end. Final report at `~/workspace/handover-anime-rig/final-report.md`. Judge verdict at `~/workspace/handover-anime-rig/units/J/verdict.md`. Verifier report at `~/workspace/handover-anime-rig/units/V/verification-report.md`. Predicate pred-anime-rig-v1, SHA 1b236b588f33f9e9. Cost $0, spawns 6 of 8, fix cycles 1 of 5, time 1326.3 seconds.

Richardson's own eye, Nov 10, 2026, 07:33 EST: thumbs-down on the frame 6 side-by-side, thumbs-down on the frame 84 side-by-side, thumbs-up on the back-view candidate at 3:25. P6 fails on his eye for the part set. The back view is confirmed real by his eye.

This ladder builds on the first ladder in this chat (`~/workspace/headless-motion-engine/study/2026-11-10-anime-character-rig-first-principles.md`, 8 claims, all verified). That ladder named the biggest open risk: no one had proven an agent-drawn part set can match the reference within the pred-v1 bars. The run tested that risk. The risk is confirmed, not retired. V1 SSIM 0.641 and 0.6344, v2 flat SSIM 0.6425 and 0.6393, bar 0.95.

## Step 1: Name the decision

- Decision: what to fix first, in what order, with what proof, before any retry run.
- Action that follows: draft a Stage 1 package for the fix run, for Richardson's approval, then build it under Handover.
- What happens if wrong: the retry burns the 4 remaining fix cycles on the same method, and fails the same way, because the check, the predicate, and the background were never fixed.

## Step 2 and 3: Claims, tests, status

Fetch and test list. Each claim was tested by reading the run records and re-checking the numbers in them, which is a direct test on our own content. Files read and what each settled:

- `~/workspace/handover-anime-rig/final-report.md`, full: the verdict, the unit list, the 5 Fixed and 17 Queued gaps, the cost and time.
- `~/workspace/handover-anime-rig/units/J/verdict.md`, full: the FAIL verdict, the P1 to P8 rulings, the gap reclassification, the next step options.
- `~/workspace/handover-anime-rig/units/V/verification-report.md`, full: every number re-run, the fur fill measurement, the composite SSIM rule, the probe counts, the gap misclassification.
- `~/workspace/handover-anime-rig/units/A/fix-cycle-1-report.md`, full: the v2 patch tables for frames 6 and 84, the composite rule, the flat numbers.
- `~/workspace/handover-anime-rig/units/A/check-p2-v2.json`, keys and patch tables: the per-patch Delta E values behind the counts.
- `~/workspace/handover-anime-rig/budget-ledger.md`, full: spawns 6 of 8, fix cycles 1 of 5, time 1326.3 seconds.
- `~/workspace/handover-anime-rig/units/R/back-view-scan-report.md`, head: the back view at 3:25, head and shoulders only, download attempts, anchor check.

| # | Claim | Load bearing | Status | Source and one line of evidence |
| --- | --- | --- | --- | --- |
| G1 | The flat SSIM 0.64 is mostly a background test, not a parts test. The ground covers 81.5 percent of the frame. | Yes | Verified | Verifier re-run table: ground pixels 751162 of 921600 on frame 6, 752318 on frame 84. Composite SSIM rises to 0.8931 when ground pixels are replaced with reference pixels. |
| G2 | The parts themselves still fail. Fixing the background alone does not pass P2. | Yes | Verified | Verifier re-run table: composite SSIM 0.8931 frame 6 and 0.8929 frame 84, bar 0.95. Both fail with the background replaced. |
| G3 | Most frame 84 patch failures are check errors, not drawing errors. The patch centres are stale, or they sit on shadow. | Yes | Verified | Verifier re-measurement: the patch labelled L-mouth at (472,173) is the frame 84 eye, not the mouth. L-ear and R-ear patches sit on reference shadow (#9CA9AF, #7F7B78). L-brow fails by only 0.538. |
| G4 | The frame 6 thin-line failures are a check and drawing mismatch, not missing strokes. The strokes draw, but a 5x5 median cannot pass for a 2 px line. | Yes | Verified, with one inference marked | Verifier: v2 left eye padded box holds 9 dark pixels under 70, 21 under 100; min luma 54.6 versus 227.0 in v1. The strokes draw. The medians fail: L-eye 40.765, L-brow 10.118, R-brow 16.802. Inference, not proof: no alternative drawing was tested, so the median test failure is fitted to the numbers, not proven as the only cause. |
| G5 | The engine drops thin open polylines in tiny boxes. The cause is unknown. | Yes | Verified pattern, unknown cause | Verifier probe: exact v1 eye copy in a tiny box gives 0 dark pixels at every threshold (70, 100, 128, 180). Stroke width 8 in the same box also gives 0. A padded box draws. The shift is confirmed: dark pixels sit at rows 209 to 215 while the authored box is rows 200 to 204.5. No mechanism test established the cause. |
| G6 | The predicate fur fill #D2DBDC is wrong. Measured fur is #E4E4E4. | Yes | Verified | Verifier: head median #E4E4E4 at (455,140) on frames 6 and 84. Exact #D2DBDC pixels in the reference: 62 in frame 6, 82 in frame 84, of 921600. Exact #D2DBDC pixels in the v2 renders: 751162 and 752318. #D2DBDC is the render ground colour, not the fur. |
| G7 | The run stopped at the pilot gate after 1 approach. It is not a dead end. | Yes | Verified | Judge verdict: section 8 needs 3 distinct approaches, only 1 ran. Fix cycles used 1 of 5, spawns 6 of 8 per the budget ledger, cost $0. The judge ruled the stop justified and the dead-end label not established. |
| G8 | Seven gaps were marked Accepted with no acceptance and no owner. P8 fails on classification, not on the work. | Yes | Verified | Verifier gap section: 7 gaps marked Accepted, no Richardson acceptance recorded anywhere, no owner or next step. Judge P8 FAIL on the same ground. The judge reclassified 6 as Queued with owner coordinator. |

What was dropped: the idea that v2 was a new method. V1 and v2 used the same approach: draw the parts from mask traces, check with the same predicate. V2 fixed 5 gaps and raised composite SSIM from 0.64 to 0.89, but flat SSIM did not move (0.641 to 0.6425 frame 6). The fix cycle was a repair inside one approach, not a distinct approach. Section 8 counts distinct approaches, and only 1 ran.

What was corrected from the first ladder: the fur fill. The first ladder listed fur white #D2DBDC from the profile palette (27.12 percent share). That number is the k-means cluster centre for the white regions, and it is also the render ground colour. The measured head fur is #E4E4E4. The profile cluster is not a measured fill. A future predicate must use measured fills, not cluster centres.

## Step 4: Counter cases

Counter case 1: just redraw the parts better and re-run P2. Observable fact that would prove it: v2 redrew the parts and flat SSIM moved. Check: v2 flat SSIM reads 0.6425 frame 6 and 0.6393 frame 84, against v1 0.641 and 0.6344. Flat SSIM did not move, because 81.5 percent of the frame is flat ground. Redrawing parts alone cannot move flat SSIM past 0.95 while the ground stays flat. The counter fails.

Counter case 2: just fix the predicate fur fill and re-run. Observable fact that would prove it: v2 already drew the fur as #E4E4E4, and the head patches read 0.000. Check: L-head and R-head patches pass at Delta E 0.000 on frame 6, yet flat SSIM reads 0.6425. The fur fix was already applied in the drawing, and the SSIM gap stayed. The predicate error does not explain the SSIM gap. The counter fails.

## Step 5: Rebuild from true facts

True facts used, from the table only: G1, G2, G3, G4, G5, G6, G7, G8.

### (1) What the numbers actually say

P2 failed in two different places at once, and the run never separated them. Flat SSIM 0.6425 and 0.6393, bar 0.95. Composite SSIM 0.8931 and 0.8929, bar 0.95. The difference between flat and composite is the ground: 751162 of 921600 pixels on frame 6, 752318 on frame 84, about 81.5 percent of the frame, all flat #D2DBDC. The render has no shop interior. The reference has shelves, a counter, a register, pots, and a basket. So flat SSIM measures the missing background first and the parts second. Composite SSIM replaces the ground with reference pixels and still reads 0.89, so the parts carry the remaining gap. The two gaps are different sizes: the background is worth about 0.25 SSIM points, the parts are worth about 0.06 SSIM points. Both must close. Neither closes alone.

The patches tell the same story at part level. Frame 6 fails 4 of 24: L-eye 40.765, L-brow 10.118, R-brow 16.802, R-hand 5.275. Frame 84 fails 8 of 24: L-ear 22.768, L-brow 3.538, L-arm 34.649, L-hand-left 13.691, R-ear 38.768, R-brow 26.756, R-mouth 4.936, R-hand 48.883. The large failures are not all the same kind. L-arm 34.649 and R-hand 48.883 are wrong-part errors: the patch centre lands on a different colour entirely. L-eye 40.765 and R-brow 26.756 are thin-line median errors: the stroke draws, the median fails. L-ear 22.768 and R-ear 38.768 are shadow errors: the reference patch median is shadow, not the ear. L-brow 3.538 fails by 0.538: a stale centre, nearly passing. Each kind needs a different fix. One redraw cannot fix all four kinds.

### (2) The causes, separated

Five causes, not one. Each gap belongs to one cause. Mixing them is why the fix cycle improved the numbers without passing the bar.

- Cause A, missing background. The render ground is flat #D2DBDC over 81.5 percent of the frame. The reference background is a shop interior. This cause owns the flat-to-composite SSIM difference, about 0.25 points. Fix: draw the shop interior, or scope SSIM to the parts region. The bar stays 0.95 either way.
- Cause B, check errors. Patch centres were measured on frame 6 and reused on frame 84, where the pose moved. Some centres sit on shadow. The thin-line median test cannot pass for a 2 px line. The P1 profile list does not reproduce, and the dark-pixel counts have no stated threshold. This cause owns most frame 84 patch failures and the P1 reproducibility gaps. Fix: re-measure centres per frame, move centres off shadow, change the thin-line check, state every threshold, record every exclusion.
- Cause C, drawing errors. The L-arm over-moved on frame 84 (render #456C71 against reference pink #D19B8F, Delta E 34.649). The head contours carry zigzag notches from the mask trace. The bouquet, the right details, and the right hand shading are omitted. This cause owns the large Delta E failures and the visible omissions. Fix: measure per-part shifts, rework the head contour, draw the omitted parts or get his acceptance per gap.
- Cause D, engine gap. Thin open polylines vanish or shift in tiny boxes. The pattern is confirmed, the cause is unknown. Stroke width does not explain it: width 8 in the same tiny box still gives 0 dark pixels. The shift is confirmed: dark pixels sit at rows 209 to 215 while the authored box is rows 200 to 204.5. This cause owns the thin-line drawing risk. Fix: run a mechanism test first, then fix the engine or keep the padded-box workaround on evidence.
- Cause E, predicate and process errors. The fur fill #D2DBDC is wrong (G6). Seven gaps were marked Accepted with no acceptance (G8). The manifest holds two stop rules that contradict each other (section 6 pilot gate, section 8 dead end). This cause owns P8 and the fur confusion. Fix: a new predicate version, one stop rule, every gap with an owner and a next step, no Accepted without his named acceptance.

### (3) Each gap: cause, fix, proof

- R1, sub-5-second back view missed between samples. Cause: the scan sampled 1 frame every 5 seconds, 290 frames over 1449.5 seconds. Fix: run a 1 second scan of the full video. Proof: the scan report names every back-view candidate frame, or states none exists.
- R2, last 4.5 seconds unsampled. Cause: the scan stopped at 1445 seconds. Fix: view frames 1445 to 1449 seconds. Proof: the frames are viewed and named in the report.
- R3, no true reference for shirt back, apron ties, legs, shoes. Cause: the 3:25 candidate is head and shoulders only, confirmed by Richardson's thumbs-up and by the verifier re-extraction. Fix: draw those parts. Proof: the back-view set holds a reference or a drawn part for every item in the section 2 list.
- Flat background. Cause A. Fix: draw the shop interior, or scope SSIM to the parts region. Proof: flat SSIM reflects the parts, not the missing background. Decision in Stage 1, recommended: scope to parts first, because the background is a separate drawing task that would dominate the retry. The bar stays 0.95.
- Head contours, zigzag notches. Cause C. Fix: rework the mask trace without zigzag notches, by smoothing the traced polyline or fitting curves to it. Proof: the head outline patches pass, L-ear and R-ear frame 84 included.
- Frame 84 pose, 56-track pose unchecked. Cause C. Fix: check the 56-track pose against frame 84 patch centres, then rebuild the pose from per-part shifts measured on the reference. Proof: L-arm frame 84 Delta E falls under 3.
- Pot flowers and bouquet omitted. Cause C. Fix: draw the bouquet, or record Richardson acceptance. Proof: the pot patch passes and the bouquet is drawn, or his acceptance names the gap and states the reason.
- Right details omitted: shirt stripes, whiskers, ear pink, sweat drops, embroidery, laces, toe caps, collar. Cause C. Fix: draw the details, or record Richardson acceptance per gap. Proof: each detail is drawn and checked, or his acceptance names it.
- Right hand shading. Cause C. Fix: shade the hand grey, reference #D1DADB, or record Richardson acceptance. Proof: R-hand patch Delta E falls under 3 on both frames, or his acceptance names the gap.
- Composite SSIM 0.8931 and 0.8929 versus bar 0.95. Cause A plus Cause C. Fix: close the background gap and the part gaps, then re-measure. Proof: composite SSIM reads 0.95 or more, and flat SSIM reads 0.95 or more under the new predicate method.
- L-eye, L-brow, R-brow frame 6 medians fail though strokes draw. Cause B plus Cause D. Fix: change the check for thin features to dark-pixel count or min luma in the patch, and run the thin-line mechanism test. Proof: the new check passes where the stroke draws, and the mechanism test names the engine cause.
- R-hand, L-ear, R-ear frame 84 patches sit on reference shadow. Cause B. Fix: move the patch centres off shadow. Proof: the reference patch median is the part colour, not shadow, and the Delta E reads the part.
- Frame 84 patch centres stale. Cause B. Fix: move the centres to frame 84 positions, measured on frame 84. Proof: the patch labelled L-mouth sits on the frame 84 mouth, not the eye. Centres: L-eye, L-brow, R-brow, R-mouth.
- L-arm frame 84 over-moved. Cause C. Fix: measure arm-specific frame 84 shifts from the reference, rebuild the arm pose from that shift. Proof: L-arm frame 84 Delta E falls under 3.
- L-hand-left frame 84. Cause B. Fix: re-measure the patch centre at (405,380) on frame 84. Proof: the centre sits on the frame 84 hand.
- Engine thin polylines. Cause D. Fix: run the mechanism test, then fix the engine drop or keep the padded-box workaround on evidence. Proof: the test names the cause (offset, culling, or scale), and the chosen fix holds the stroke in the box.
- R-mouth frame 84 patch outside head. Cause B plus Cause C. Fix: check the head contour near y200, move the patch centre onto the head. Proof: the patch centre sits on the frame 84 mouth.
- P1 profile list does not reproduce. Cause B. Fix: record the exclusion per profile, state the distance limit for the dip rule, make the code enforce the rule it describes. Proof: the verifier rebuilds the exact 10-profile list from the filed scripts.
- Probe counts do not reproduce. Cause B. Fix: state the dark threshold in every count. Proof: the verifier reproduces the counts 38, 6, 39, 22, 94 at the stated threshold, or the counts are restated with the threshold.
- P8 misclassification. Cause E. Fix: reclassify the 7 gaps as Queued with owner and next step, or get Richardson to accept each one by name with a reason. Proof: every gap ends Fixed, Queued, or Accepted with owner and next step.
- Manifest stop-rule contradiction. Cause E. Fix: write one stop rule in the next Stage 1 and Stage 2. Proof: the next run stops once, under one rule, and the judge can tell a gate stop from a dead end.

### (4) What to fix first

The order follows the causes, not the gap list order. The predicate and the check come before the drawing, because a drawing cannot pass a check that measures the wrong thing. The mechanism test comes before the engine decision, because the cause is unknown.

- Step 0, new predicate version. Fur #E4E4E4. Per-frame patch centres. Stated dark threshold. Thin-line check by dark-pixel count or min luma, not median. SSIM scoped to parts, or background drawn, decided in Stage 1. One stop rule. Proves: the predicate measures what it claims. Depends on: nothing. Blocks: the retry run.
- Step 1, per-frame patch centres. Re-measure every centre on frame 84, move centres off shadow, fix the L-mouth label. Proves: the patch failures that remain are drawing errors, not check errors. Depends on: Step 0. Blocks: the retry P2.
- Step 2, background decision. Draw the shop interior, or scope SSIM to the parts region. Proves: flat SSIM reflects the parts. Depends on: Step 0. Blocks: the retry P2.
- Step 3, thin-line mechanism test. Render the same polyline in boxes of increasing size and padding, find the threshold where it appears, test whether the shift is a constant offset. Proves: the cause is named, and the engine fix or the padded-box workaround is chosen on evidence. Depends on: nothing. Blocks: the thin-line drawing method.
- Step 4, per-part frame 84 shifts. Measure each part shift from frame 6 to frame 84 on the reference, rebuild the pose per part. Proves: L-arm frame 84 Delta E falls under 3. Depends on: Step 1. Blocks: the retry P2 frame 84.
- Step 5, head contour rework. Smooth or fit the mask trace, remove the zigzag notches. Proves: the head outline patches pass. Depends on: Step 1. Blocks: the retry P2.
- Step 6, omitted details. Draw the bouquet, the right details, and the right hand shading, or get his acceptance per gap. Proves: the omitted-detail gaps close, or his acceptance names each one. Depends on: Step 0. Blocks: the retry P2 patches and P6.
- Step 7, back-view completion. Run the 1 second scan, view 1445 to 1449 seconds, draw shirt back, apron ties, legs, shoes. Proves: the back-view set has a reference or a drawn part for every item. Depends on: nothing. Blocks: P3 and P4.
- Step 8, process fixes for the next run. One stop rule. Every gap with owner and next step. Every count states its threshold. Every exclusion recorded per profile. No Accepted without his named acceptance. Proves: P8 passes on classification. Depends on: nothing. Blocks: the retry P8.

### (5) What the next run needs

- A new predicate version, pred-anime-rig-v2, with the Step 0 changes. The v1 predicate stays frozen. A new version voids no old verdict.
- A Stage 1 package that names the five causes and the ordered fix list, and states the background decision (draw or scope) and the thin-line check change.
- A Stage 2 manifest with one stop rule, the tools allowlist, and the units for Steps 0 to 8.
- No retry inside the old run. The old run stopped at the pilot gate with 4 fix cycles and 2 spawns unused. Those do not carry over. A retry needs a fresh approval.
- Richardson's call on the omitted details: drawn, or accepted by name. No gap carries Accepted without him naming it and stating the reason.

## Step 6: Decide and record

- Decision: fix in the order Step 0 to Step 8 above, starting with the predicate and the check, because a drawing cannot pass a check that measures the wrong thing.
- Claim: all 8 claims tested, 8 verified, 0 assumed load-bearing, 0 failed. Sources are the run records listed in Step 2 and 3.
- True facts used: the flat SSIM is mostly a background test (G1). The parts still fail with the background replaced (G2). Most frame 84 patch failures are check errors (G3). The thin-line failures are a check and drawing mismatch (G4). The engine drops thin polylines for an unknown cause (G5). The predicate fur fill is wrong (G6). The run is not a dead end (G7). P8 fails on classification (G8).
- Biggest open risk: the engine thin-line gap has an unknown cause. If the engine drops thin strokes for a reason no workaround can hold, then no drawn part set with 2 px features can pass a patch-median check, and the check must change or the engine must change. The mechanism test in Step 3 is what retires or confirms this risk.
- What would change my mind: a mechanism test that names the engine cause; a redrawn part set that passes P2 under the new predicate; or a demonstration that the composite SSIM 0.89 gap is all background, which the numbers already rule out.
- Open questions: the engine thin-line cause; draw or scope for the background, decided in Stage 1; whether Richardson accepts the omitted details or wants them drawn, his call per gap; whether the 1 second scan finds another back view, answered by Step 7.

Next step, not yet approved: draft a Handover Stage 1 package for the fix run, covering Steps 0 to 8, with predicate pred-anime-rig-v2, units, budget, and envelope, and present it for Richardson's tap. Nothing builds until Stage 1 and Stage 2 are approved.

## Addendum: Richardson's eye on the v2 render, Nov 10, 2026, 07:41 EST

- His words: it was close, but the finishing of the shape needs work. He recognizes the character and the overall shape, but it looks like an unfinished rough draft where the edges were not finished correctly.
- His read matches the head-contour gap and extends it to every outline, not only the head.
- Measured cause: the v2 scene holds 36 nodes, and every outline uses line commands only. Zero curve commands exist in the file. L-head has 22 points, R-head 18, ears 8 to 11, all straight segments between sparse vertices. The reference outlines are smooth curves. Straight segments between sparse vertices read as facets. That is the rough-draft look.
- The engine already supports curve commands in points lists. PointsToD compiles M, L, C, S, Z. The builder emitted no C or S commands. The fix is expressible today: fit curves to the outlines, or add vertices where the edge bends most.
- Step 5 in the fix list now covers all outlines, not only the head contour. The proof stays the same: the head outline patches pass, and the stills read as finished curves on his eye.
- His read on the back-view candidate, Nov 10, 2026, 07:42 EST: it looks exactly like the style. He asked whether it was drawn. It was not drawn. It is a real frame from the source video at 205 seconds, frame 4920, extracted by Unit R and confirmed by the verifier by re-extraction. It looks like the style because it is the original art. The drawn part set is the rough one. The gap between the real frame and the drawn set is the gap the fix run must close.
