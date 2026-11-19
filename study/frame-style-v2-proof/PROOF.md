# Frame-style v2 proof run (Nov 19, 2026)

## What ran

- Command: `node src/cli/hme.mjs frame-style refs/shorts-2026-11-09/_HU37rX4G1U.mp4 --start-s 0 --end-s 4.5 --out hu37-4s5-prompt.md --report hu37-4s5-report.json --csv hu37-4s5-frames.csv`
- Clip: 4.5 s news-edit short, 360x640, 30 fps. Two stacked headline cards ("MY EDIT" Trump card, "ORIGINAL" Musk card) joined by a dissolve.
- No Kurzgesagt footage was on disk, so no Kurzgesagt numbers are claimed here. The Studio description's _y9JuojAIg0 study is not reproduced; this proof uses footage that exists.

## Measured numbers (from hu37-4s5-report.json)

- 135 frames at 30 fps, changed fraction 0.5597, mean change 0.775 levels per frame.
- Longest static run 6 frames. Median gap between changed frames 1. Cadence mixed.
- Shot cuts 0. The join between the two cards is a dissolve, not a hard cut: peak MAD is 3.744 at frame 64, far under the 22.0 cut bar, with centre MAD 8.444 and border MAD 1.483.
- Camera vs subject: 10 camera-led steps, 85 subject-led steps, 4 both, 35 neither. Median border MAD 0.126, median centre MAD 0.896, ratio 0.141. Subject-led, as the cards show: the middle moves while the edges hold.
- Palette top 8: #141414 (22.28%), #4C4C4C (9.09%), #DCDCD4 (7.85%), #CCCCCC (3.94%), #1C1C1C (3.30%), #444444 (3.12%), #C4C4C4 (2.57%), #E4E4DC (2.56%).
- Gradient stops (row medians): top RGB (72.5, 72.5, 72.5), 25% (189.2, 191.8, 189.1), 50% (51.5, 114.9, 194.2), 75% (219, 217.1, 212.7), bottom (23, 23, 23). Max row step 142.56, mean row step 2.13.
- Flat-fill ratio 0.8387, outline density 0.012, grain (mean absolute Laplacian) 9.547, mean luma 114.99.
- CSV holds 136 lines: 1 header plus 135 frame rows.

## Gate checks

- Own frame (t=2 s) against its own report: PASS, all 5 bars pass, no fixes. Exit 0.
- Pure black still against the same report: FAIL, exit 1. Failed bars: Palette Adherence, Flat Fill Integrity, Outline Contract, Luminance Balance. Grain Floor passed, because black is perfectly smooth. Fixes emitted: FIX-1, FIX-2, FIX-3, FIX-5.
- Synthetic tests: `node --test tests/cli/frame-style.test.mjs`, 6 tests, 6 pass. Includes the gate on a real testsrc frame and the black-still failure above.

## What v2 fixes against v1

- v1 would have reported only the changed fraction and the static run. It could not tell the dissolve from a cut, could not tell camera from subject motion, and carried no palette, flatness, outline, or grain numbers at all.
- v2 separates the dissolve (centre-led, no cut) from a hard cut, names cadence mixed with a median gap of 1, and puts the palette, flatness, outline, grain, and luminance bounds in the report for the gate to check.

## Limits found in this run

- The 5-stop gradient assumes a full-bleed background. On card-layout footage the stops jump at card edges: max row step 142.56 against a mean of 2.13. Read the stops with the layout in mind; a high max step names a card edge, not a gradient break.
- The cut bar (MAD over 22.0) catches hard cuts only. Dissolves show as centre-led motion with no cut, which is correct, but a slow dissolve and a slow subject move read the same way in the headline pace numbers. The border and centre split is what tells them apart.
- The palette is quantized to 5 bits per channel, so near colours merge into one hex.
- The smoke renders in this repo (renders/smoke-1.mp4, smoke-2.mp4) are black frames and a static title card. They were measured and rejected as proof footage: smoke-1 is black for all 10 seconds (mean luma 0.38, changed fraction 0).
