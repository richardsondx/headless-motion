# Seg4 v4 vs real: layer layout check

Date: 2026-11-07. Four paired seconds only (1, 4, 5, 7). Not a 240-frame check.
Overall: FAIL, 0 of 4 pairs pass pred-v1 Seg4.
Wall time: 31.1 s for the whole check (8 frames, stride-2 segmentation).
Tolerances: position, border, zoom, pair gap all 0.02 as ratios.
Pred-v1 is frozen: SSIM >= 0.96, PSNR >= 35 dB, LPIPS <= 0.08, flat Delta E < 3.

## Worst gaps first

- Sudan top border is 0.4815 off at 1s. Real Sudan starts halfway down the frame. Ours fills from near the top.
- SUDAN label to Sudan centre gap is 0.4264 at 5s. Real distance 0.008. Ours 0.435. The label sits on the coral flood, 830 px from the remaining teal land.
- SUDAN label to Sudan centre gap is 0.4242 at 7s. Real distance 0.005. Ours 0.430. Same cause as 5s.
- Sudan is 0.3687 too wide at 1s. Real width ratio 0.078. Ours 0.455.
- Sudan left border is 0.3406 off at 5s. Ours starts at the frame edge. Real starts a third of the way in.
- Sudan is 0.3365 too wide at 4s. Real width ratio 0.279. Ours 0.624.
- RSF badge is absent in v4 at 4s, 5s, 7s. Real has it. Delta E at the badge point is 45 to 48.
- October 2025 title is absent in v4 at 1s. Real has a 133 px centred title.
- EL FASHER dot is absent in v4 at 7s. Real has an 11 px dot with a halo. Ours has a ring.
- Base colour fails at 4s, 5s, 7s. CIEDE2000 5.33, 5.33, 3.55. CIE76 6.16, 6.16, 4.19.

## What passes

- Base colour at 1s passes. CIEDE2000 2.07, CIE76 2.43. Real #1C2826, v4 #182627.
- SUDAN label to Sudan centre at 1s passes. Gap 0.0195, tolerance 0.02. Only just.
- Sudan colour at 1s and 4s passes by point sample (Delta E 1.2, 2.18). The layer check cannot confirm this: v4 Sudan is not colour-separable from v4 land, so no Sudan colour layer check is possible.

## Zoom curve (Sudan width / frame width)

- Real (trace): 0.078 at 1s, 0.279 at 4s, 0.308 at 5s, 0.339 at 7s.
- Ours (segmented teal region, flagged merged): 0.455, 0.624, 0.432, 0.431.
- Gaps: 0.377, 0.345, 0.125, 0.092. All fail the 0.02 bar.
- Ours is an upper bound, not a true Sudan width. V4 colours Sudan and land the same teal, so the teal region is the whole visible map, not Sudan.

## Pair gaps (distance / frame width)

- SUDAN label to Sudan centre. Real 0.003, 0.005, 0.008, 0.005. Ours 0.022, 0.037, 0.435, 0.430. The label sits at Sudan's centre in the real video. Ours drifts as the flood lands.
- EL FASHER label to RSF badge corner at 7s. Real 0.041. Ours undefined, badge absent.
- EL FASHER dot to label centre at 7s. Real 0.035. Ours undefined, dot absent.

## Existing numbers (reused, not re-run)

- Mean SSIM 0.686 (need 0.96). Per pair 0.64, 0.81, 0.60, 0.70.
- Mean PSNR 14.6 dB (need 35). Per pair 17.6, 19.8, 10.6, 10.6.
- Mean LPIPS 0.786 (need 0.08). Per pair 0.84, 0.69, 0.84, 0.76.
- Worst flat Delta E (CIEDE2000): 8.8 land at 1s, 47.6 badge at 4s, 51.7 Sudan at 5s, 51.5 Sudan at 7s.
- Worst flat Delta E (CIE76): 10.7, 84.6, 87.2, 87.3. CIE76 overrates the saturated colours by about 35 to 40 points versus CIEDE2000. Same verdict either way: fail.

## Method check (segmentation vs trace, real side)

- Sudan width from segmentation matches the trace within 0.010 at all four seconds.
- RSF badge box from segmentation matches the trace within 5 px on every edge.
- SUDAN label centre from bright-pixel matching matches the trace within 2 px at 4s, 5s, 7s. At 1s the label is a 35x6 px blob and matching finds nothing.
- El Fasher dot from nearest bright component matches the trace within 7 px.
- The method is sound on the real side. The gaps above are v4 gaps, not measurement noise.
- Real y positions carry about 15 px uncertainty from the 1.845:1 to 16:9 stretch (0.014 as a ratio). Inside the 0.02 tolerance.

## What this changes for v5

- Kill the coral flood first. It is the biggest colour gap and it breaks the Sudan layer, the zoom curve, and the label-to-centre gap at 5s and 7s.
- Colour Sudan differently from land. Until v4 does, no layer check can measure Sudan on our side.
- Match the camera. Ours shows 5.8 times as much teal width at 1s and 2.2 times at 4s. The zoom curve is the second biggest gap.
- Add the RSF badge, the October 2025 title, and the El Fasher dot. All three are absent, and each is a hard fail on its own.
- Base colour is close at 1s (Delta E 2.07) and drifts to 5.33 later. Fix it after the flood and camera.

## Open

- DreamSim feel score: not run. Weights absent, no download attempted.
- Full 240-frame layout run: not done. This check is 4 stills only by design.
- v5 re-render: blocked until a render can write through the EPERM gate.
- Regression: 10 of 11 layout unit tests pass. The 11th (S8 wiring leaves existing checker output unchanged) is still running; the VM load average is 21 from other work, so one 30-frame run_check is crawling. The full 13-test existing checker suite could not finish under that load and remains open.
