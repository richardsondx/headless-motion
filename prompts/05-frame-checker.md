# 05 Frame checker

## Purpose
Compare a rendered segment to its reference, frame by frame, against the Stage 1 finish predicate (pred-v1). Give a verdict and the evidence. The checker never lowers a threshold to pass, and never fixes the render.
Stack: Python 3.11 or newer, run with `python -I`. Packages: numpy, scikit-image, pillow, torch, lpips, pytest. FFmpeg and ffprobe from the system.

## Inputs
- `render`: the MP4 from prompt 02, profile `final`. `ref`: the reference clip for the same 10 s. `segment`: a JSON config (below).
- References live in `refs/` inside this workspace, are never copied elsewhere, and are never pushed or published.
- Both videos are decoded to RGB with `-vf scale=in_range=tv:in_color_matrix=bt709,format=rgb24`, frame by frame, at 1920x1080. If the reference is another size, resize with Lanczos and write `REF_RESIZED` in the report.
- The checker measures the reference fps with ffprobe. If it is not the segment's `fps` (24 assumed), stop with `FPS_MISMATCH` and print the measured value. Do not resample.
- Segment config `tests/segments/seg{1..4}.json`: `id`, `ref_start_frame`, `fps`, `flat_regions [{id, rect, frames}]`, `events [{id, rect, window:[f0,f1]}]`, `labels [{id, rect, frames, text}]`, `targets [{id, rect, frames}]` (camera uses the full frame), `map` (true for segment 4).

## Outputs
- `src/checker/predicate.json` and `src/checker/predicate.sha256`. Values below, copied exactly.
- `src/checker/{decode,metrics,color,motion,text,events,stages,report,blind,cli}.py`
- CLI: `python -I -m checker run --segment <cfg> --render <mp4> --ref <mp4> --out out/<seg>/check [--full]`
- `out/<seg>/check/`: `report.json`, `report.md`, `frames.csv` (one row per frame: ssim, psnr, lpips, motion_err, shift_x, shift_y), `worst/` (diff PNGs for the 5 worst frames), `blind/` (see Gate).
- `tests/checker/*.py`, `tests/checker/make_fixtures.py` (seeded, writes synthetic clips with ffmpeg)

## Predicate (pred-v1, Stage 1 section 3)
Per-segment minimums:
- Mean SSIM: seg 1 and 2 at least 0.98; seg 3 at least 0.95; seg 4 at least 0.96.
- Mean PSNR: seg 1 and 2 at least 38 dB; seg 3 and 4 at least 35 dB.
- LPIPS (mean): seg 1 and 2 at most 0.05; seg 3 and 4 at most 0.08.
- Same for all: every frame SSIM at least 0.90, and no frame below 0.85. Stage 1 wording is ambiguous here. Implement the strict reading: any frame under 0.90 fails, and frames under 0.85 are also listed as `HARD_FLOOR`. A looser reading needs Richardson's written approval, not a code change.
- Motion: camera or target error under 2 px; no jump over 4 px between consecutive frames.
- Text: no label shifted more than 2 px; no font swap at 200% zoom.
- Fail fast, whatever the means are: any flat fill over 3 Delta E; any missing event; any label in the wrong place.
- Segment 4 only: G8 (text 7:1, line 3:1) and G9 (one focus, travel-land-hold, 1.2 s hold after labels), run by `node src/map/cli.mjs check`; its report is read and quoted.
Comparators match Stage 1 wording exactly ("at least", "under", "over"). The checker has no flag that changes a value.

## Method (fail-fast order, stop at the first failing stage unless `--full`)
1. `S0 shape`: same width, height and frame count as the segment, profile is `final`. Else `FAIL`. Other profiles give `NOT_FINAL`, never `PASS`.
2. `S1 colour`: for each flat region, median Lab in the render versus the reference. Delta E over 3 is `COLOR_FAIL`. Compute CIEDE2000 and CIE76 and fail if either is over 3 (Stage 1 does not name the formula; report both). If the reference region is not flat (95th percentile Delta E from its median over 2), the config is wrong: `ROI_NOT_FLAT`.
3. `S2 events`: per event, frame-difference energy inside the rect over the window, reference versus render. Missing means the render's peak is under 50% of the reference's peak, or the peak frame differs by more than 1 frame. `EVENT_MISSING`. (50% and 1 frame are checker defaults, not Stage 1. Write them in the report.)
4. `S3 text`: per label, ink box inside the rect on both frames (Otsu threshold on luma). Edge shift over 2 px on any side is `TEXT_SHIFT`. Box overlap (IoU) under 0.5 is `LABEL_WRONG_PLACE`. Crop SSIM at 2x Lanczos under 0.90 is `FONT_SWAP_SUSPECT`. That one is a flag for the human zoom check, not a proof.
5. `S4 motion`: phase correlation (`skimage.registration.phase_cross_correlation`, `upsample_factor=20`) on luma, whole frame for the camera and the rect for each target. Error is the shift magnitude. Over or equal to 2 px is `MOTION_ERR`. The jump is `|e(f) - e(f-1)|`, over 4 px is `MOTION_JUMP`. A frame whose correlation cannot be measured is listed as `UNMEASURABLE`. Any `UNMEASURABLE` makes the verdict `INCOMPLETE`, never `PASS`.
6. `S5 SSIM and PSNR`: SSIM on Rec.709 luma, Gaussian window sigma 1.5, data range 255. PSNR on RGB, per-frame capped at 100 dB (identical frames), then averaged. Check the means, the 0.90 per-frame rule and the 0.85 floor.
7. `S6 LPIPS`: `lpips.LPIPS(net="alex")`, inputs scaled to [-1, 1], mean over frames. If the weights cannot load, verdict `INCOMPLETE` with `LPIPS_UNAVAILABLE`. Never skip it and never substitute another metric.
8. `S7 map` (segment 4): read `out/<seg>/g8-g9-report.json`. A missing or failing report fails the segment.

## Gate (human, blind)
- `blind.py` writes to `out/<seg>/check/blind/`: side-by-side MP4 at full speed (`sbs-1x.mp4`) and at 0.25x (`sbs-0.25x.mp4`, `setpts=4*PTS`), and stills at 1 s, 5 s, 9 s (frames 24, 120, 216 at 24 fps), each as a side-by-side PNG plus a 200% crop of every label.
- Which side holds the render is chosen by a seeded random draw per clip. The mapping goes only in `blind-key.json`. The report and file names never reveal it.
- `human-gate.json` is written by a person only. The checker reads it and never writes it. Missing file means the verdict is `PENDING_HUMAN`.
- Final verdict `PASS` needs: all stages pass, profile `final`, and `human-gate.json` says `passed: true`.

## Check
Run `python -I -m pytest tests/checker -q`. All pass. The synthetic fixtures prove:
1. Identical clips: SSIM 1.0, PSNR 100 (capped), LPIPS 0, motion 0, verdict `PENDING_HUMAN` (the automatic stages pass).
2. A 3 px shift of a label gives `TEXT_SHIFT` and `MOTION_ERR`. A 1 px shift passes.
3. A flat fill off by about 5 Delta E gives `COLOR_FAIL`. The report shows `stages_run` stopping at `S1`.
4. One frame at SSIM about 0.80 in a clip with mean SSIM above 0.98 fails on the frame rule.
5. A removed event gives `EVENT_MISSING`.
6. A label moved 40 px gives `LABEL_WRONG_PLACE`.
7. A `draft` render gives `NOT_FINAL`. No `human-gate.json` gives `PENDING_HUMAN`.
8. Editing `predicate.json` in a test copy makes the CLI exit 7 with `PREDICATE_TAMPERED`. A test also asserts every number above against literals in the test file.
9. Two runs on the same inputs give byte-identical `report.json` (no timestamps in it; put the time in `report.md` only).

## Constraints
- Every report row shows the measured value, the threshold, and the comparator.
- Worst-frame diffs are saved for any failure, with frame numbers.
- Reference offset is set in the config. A `--diagnose-offset` mode may print the best offset in the range of 6 frames either way. It never changes a verdict.
- Keep each file under 300 lines.

## Forbidden
- Never lower, round, widen or skip a threshold. Never exclude frames, regions or stages to improve a score. Never re-score held-out frames.
- Never write `human-gate.json`. Never reveal the blind mapping in the report.
- Never read or edit the render's source scene. The checker gets two videos and a config.
- Do not push, upload or publish reference frames.
