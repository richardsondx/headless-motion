# Verify Seg4 — Poteto-style side-by-side verification for the Search Party UAE map clone

Project-local verification skill for one segment only: Seg4, Search Party / Sam Ellis
"How the UAE got too powerful to punish", YouTube fUrNOVjWUVM, 00:00–00:10, map frames only.
Predicate: pred-v1 in `~/workspace/handover-headless-motion-engine/stage1-package.md` §3.
Frozen. Never relaxed to claim a pass. A gap without evidence does not count as a pass.
Generator never verifies its own work. Verifier and judge run in fresh context, with only
the predicate, the reference, and the clone — never the builder's notes.

## Feature map (one entry per visible element)

| # | Element | What is checked | Pass bar |
|---|---|---|---|
| 1 | Land | flat fill hex, measured from reference and clone at same frame | Delta E ≤ 3 |
| 2 | Water / sea | flat fill hex, Red Sea edge in frame at 5 s and 9 s | Delta E ≤ 3, sea visible, not cropped out |
| 3 | Sudan flood | flood hex, onset frame, coverage | Delta E ≤ 3, onset within 2 frames |
| 4 | El Fasher ring | ring shape, radius in px, line width, casing, draw duration | position within 2 px, radius within 5 px, draw within 2 frames |
| 5 | EL FASHER label | font name, size px, bar hex, position px, leader line | no font swap at 200% zoom, position within 2 px |
| 6 | RSF badge | badge shape, bar hex, position px | position within 2 px, bar text ≥ 7:1 |
| 7 | SUDAN label | font, size, bar, position | position within 2 px, ≥ 7:1 |
| 8 | Neighbour countries | borders 1–1.5 px, dim state during focus | exactly one focus at full strength |
| 9 | Camera move | travel-land-hold, target error per frame, easing | target error < 2 px, no jump > 4 px unless reference has it |
| 10 | Grain / texture | grain present, constant through events, not a focus change | present and constant, measured std-dev within 20% |
| 11 | Palette / register | light vs dark register, base 2 values + ≤3 floods + 1 accent | register matches reference, count matches |
| 12 | Typography | Montserrat Bold geography, Anton display-only, letterspacing +6% | font files present in assets/fonts, no Liberation stand-in unless named |

## Launch

Start from the real reference and the real clone. No placeholders, no guessed palette.
Inputs, all must exist or Launch fails and the run stops:
- Reference: `verify-seg4/refs/seg4-ref-240f.mp4` (1920×1080, 24 fps, 240 frames, 00:00–00:10) OR
  `verify-seg4/refs/seg4-ref-frames/fNNN.png` at 1 fps (11 frames, 0–10 s) if no video is obtainable.
  Record provenance in `verify-seg4/refs/PROVENANCE.md`: source URL, how it was obtained
  (live browser capture / yt-dlp / public still), date, and who obtained it.
- Clone: `out/seg4-final-vN/run-a/video.mp4` (1920×1080, 24 fps, 240 frames) plus its frames dir.
- Predicate: `src/checker/predicate.json`, verified against `src/checker/predicate.sha256`
  (tamper exits 7, do not proceed on tamper).
- Fonts: `assets/fonts/Montserrat-Bold.ttf` and `assets/fonts/Anton-Regular.ttf` must be
  present, or the run records FONT_MISSING and the typography rows fail.

## Doctor

Run before any comparison. Any failure is a dead end for that run, not a warning to skip.
1. `ffprobe` both videos: width, height, fps, frame count, duration. Must match exactly
   (1920×1080, 24 fps, 240 frames, 10.000 s). Record the ffprobe output in evidence/.
2. Clone determinism: run-a and run-b video sha must be identical. If not, B fails, stop.
3. Fonts: `fc-list` / file check for Montserrat Bold and Anton. Record family, weight, file.
4. Checker health: `./run-checker.sh` with a synthetic identical pair must return PASS
   (SSIM 1.0, PSNR 100). If LPIPS is unavailable, record LPIPS_UNAVAILABLE and the
   verdict can only be INCOMPLETE, never PASS.
5. Reference provenance: if `refs/PROVENANCE.md` is missing or says "guessed", Doctor fails.
   Do not proceed to Drive on a guessed reference.

## Drive

Operate the real artifacts only. No builder notes, no screenshots of screenshots.
1. Extract frames at the same timestamps from both videos:
   0, 1, 2, 5, 9 seconds (frames 0, 24, 48, 120, 216 at 24 fps), plus every frame for metrics.
   Command: `ffmpeg -i <mp4> -vf fps=1 verify-seg4/evidence/<side>-f%03d.png` for the
   contact sheet, and full-frame extraction for the checker.
2. Build the side-by-side contact sheet, reference left, clone right, same scale:
   `verify-seg4/evidence/side-by-side-vN.png` — 5 rows (0/1/2/5/9 s), 2 columns,
   each cell 960×540, labels "REF 0s" / "CLONE 0s" burned in at top-left of each cell,
   plus a difference map per row in a third column (absolute per-pixel difference,
   amplified ×4, with a scale note). Use PIL / ffmpeg hstack, never a hand-drawn mock.
3. Run the frame checker end to end:
   `./run-checker.sh run --segment tests/segments/seg4.json --render <clone mp4> --ref <ref mp4> --out verify-seg4/evidence/check-vN/`
   It must run stages S0–S6 on all 240 frames with LPIPS. Record `report.json` verbatim.
4. Measure palette per frame (0, 24, 48, 120, 216): sample flat regions (land, water,
   Sudan flood, label bar, ring) with a 21×21 px median, record hex + Delta E
   (reference vs clone) in `verify-seg4/evidence/palette-vN.csv`. No eyeballed hexes.
5. Measure labels: font (from scene + fc-match), size, bar hex, centre px, leader
   endpoints, in `verify-seg4/evidence/labels-vN.csv`. Measure camera: track the
   El Fasher dot / Sudan centroid per frame, record target error in px in
   `verify-seg4/evidence/camera-vN.csv`.
6. Read every contact-sheet row at full size and at 25% thumbnail scale. Record what
   a viewer can name from the thumbnail alone (El Fasher? RSF? Sudan?).

## Evidence

Everything below must exist in `verify-seg4/evidence/` or the verdict is INCOMPLETE.
Survives cleanup. Keep it, do not delete it to make a run look clean.
- `side-by-side-vN.png` (contact sheet, ref left, clone right, diff column)
- `check-vN/report.json` (full checker output, S0–S6, all 240 frames)
- `metrics-vN.csv` — one row per sampled frame (0, 24, 48, 120, 216) plus means:
  SSIM, PSNR, LPIPS, per-frame min SSIM, Delta E per flat region
- `palette-vN.csv` — measured hexes, ref vs clone, Delta E per element
- `labels-vN.csv` — font, size, bar hex, position px per label per sampled frame
- `camera-vN.csv` — camera target error px per sampled frame
- `g8-g9-vN.json` — G8 contrast (text ≥ 7:1, line ≥ 3:1) and G9 focus/camera per sampled frame
- `verdict-vN.md` — fresh verifier's verdict only: PASS / FAIL / INCOMPLETE, with the
  failing rows quoted by number, never by prose alone

Pass bar (pred-v1, Seg4): mean SSIM ≥ 0.96, per-frame min SSIM ≥ 0.90, no frame < 0.85,
mean PSNR ≥ 35 dB, LPIPS ≤ 0.08, motion error < 2 px, no jump > 4 px, text shift ≤ 2 px,
no font swap at 200% zoom, any flat colour Delta E > 3 fails, any missing event or
wrong-place label fails even if mean SSIM passes. G8 and G9 must also pass.

## Cleanup

- Keep: everything in `verify-seg4/evidence/`, `verify-seg4/refs/`, the skill itself,
  the clone video and its frames, the scene json that produced it.
- Remove only: temp renders in `tmp-work/`, duplicate run-b frames after the sha check,
  intermediate contact-sheet drafts that are superseded (record their names in the run report).
- Never remove: a failing report, a failing still, a reference frame, or a verdict file.
- After cleanup, re-list `verify-seg4/evidence/` and confirm every file in Evidence is
  still present. If one is gone, the run is INCOMPLETE.

## Stuck ladder (max 3 fix cycles for this style-match run)

Each cycle must change a measured value (a hex, a font file, a zoom, an easing, a radius),
not just wording. Log cycle, measured value changed, old → new, and the new metric.
1. Retry with corrected input (wrong frame alignment, wrong fps).
2. Switch the source or evidence route (different reference capture route).
3. Replace the method (different palette token, different font, different camera token).
After 3 distinct approaches for the same failure class, hold that element, record it as
a gap with the exact approval it needs, and continue the rest. Never relax the predicate.
