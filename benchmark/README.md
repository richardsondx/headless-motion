# Headless Motion Engine benchmark

Purpose: compare this tool against other motion approaches on the same
jobs, so Richardson knows what to improve. Every number here is either
measured on this machine (labelled **measured**) or a published number
with a source (labelled **secondary**). Nothing is invented. A secondary
number is not a measurement; re-measure before citing it as fact.

## Frozen test set

Same scenes, same size, same predicate, every run.

- Size: 1920x1080, 24 fps, 240 frames (10 s).
- Scenes, in `tests/fixtures/`:
  - `map-sample.json`: synthetic map, Abu Dhabi to El Fasher, seed 7.
    157 lines, 3,115 bytes.
  - `text-sample.json`: kinetic title, count-up, bar race, seed 42.
    1,452 bytes.
  - `scene-min.json`: minimal scene, 58 lines, 1,435 bytes.
- Predicate: `src/checker/predicate.json`, version pred-v1. Mean SSIM
  at least 0.98 (segments 1-2), 0.95 (segment 3), 0.96 (segment 4);
  per-frame SSIM at least 0.90, no frame below 0.85; mean PSNR at least
  38 dB (1-2), 35 dB (3-4); LPIPS at most 0.05 (1-2), 0.08 (3-4);
  motion error under 2 px, no jump over 4 px unless in the reference;
  text shift under 2 px; flat colour under 3 Delta E; map also passes
  Harris G8 (text at least 7:1, line at least 3:1) and G9 (one focus,
  travel-land-hold, 1.2 s hold after labels).

Gap, not hidden: the brief asked for a chart scene, and no chart
fixture exists yet. The bar race inside `text-sample.json` is not a
chart. Freeze a `chart-sample.json` before any chart claim is made.

## Scorecard

Seven separate scores. Never one blended number. A tool can be fast
and wrong at the same time; a single number hides that.

1. **Visual quality**: checker verdict and means (SSIM, PSNR, LPIPS,
   Delta E) against the reference, per pred-v1.
2. **Motion smoothness**: frame-to-frame change from
   `benchmark/motion-smoothness.py` (mean/median/max change, jump list),
   plus checker S4 motion error and S5 easing.
3. **Determinism**: two runs, same scene, same profile. Pass is
   byte-identical video sha256.
4. **Render speed**: wall seconds per 10 s clip and seconds per frame,
   measured outside the renderer (see the timing note below).
5. **Agent time to first good frame**: prompt lines and scene lines
   needed, plus fix cycles spent, to reach a checker PASS.
6. **Cost per clip**: marginal dollars to re-render one 10 s clip,
   plus any licence or seat cost that gates use.
7. **Ease of change**: time to change one label or one number and
   re-render at draft profile.

## Measured results, 2026-11-07

Machine: Linux VM, 7.7 GB RAM, 4 cores, shared load (other agents
running, load average near 7.9 during renders). These are wall seconds
on this machine, not a clean bench. Full data:
`benchmark/results-2026-11-07.json`. Videos:
`benchmark/runs/<scene>-<profile>/video.mp4`.

Timing note: `render-report.json` records `elapsed_s=0` by design
(no wall clock in the report, for determinism). Speed must be timed
externally. `benchmark/run-benchmark.py` does that.

| Scene | Profile | Wall | s/frame | sha256 (first 16) | Bytes |
|---|---|---|---|---|---|
| map-sample | draft | 88.2 s | 0.368 | 26368909019e4ee9 | 364,952 |
| map-sample | final | 242.6 s | 1.011 | d20dac929c0029f0 | 540,789 |
| text-sample | draft | 78.3 s | 0.326 | 5a70aeb13a605768 | 136,191 |
| text-sample | final | 179.1 s | 0.746 | 47785df8286cc323 | 190,289 |
| scene-min | draft | 75.9 s | 0.316 | dba0671b5d56b25c | 108,920 |
| scene-min | final | 140.4 s | 0.585 | 7bfca3d2c9e804eb | 159,713 |

Why final is 2 to 3 times draft: final captures at 2x supersample
(3840x2160, then downscaled), CRF 14 with preset `slow`, and ffmpeg
is pinned to `-threads 1` in `src/renderer/render.mjs`. Capture is
also serial: one screenshot per frame, no concurrency. See
`src/scene/profiles.json` for the profile values.

## Measured results, 2026-11-07 v2 (attempted, blocked by the environment)

What changed in v2: final is now supersample 1.5 with preset `medium`
(CRF 14 kept); the old final lives on as `final-max` (supersample 2,
preset `slow`). The ffmpeg `-threads 1` pin is gone (default auto).
Frame capture is parallel (2 workers, frame order preserved). The
CLI exits explicitly after a render instead of lingering ~25 s while
a dead Chromium child's stdio pipe stays open. Frozen fixtures now
use Montserrat Bold and Anton instead of the Liberation stand-in.
One-label edits are a `--set` flag or a compact scene file, and
`render-report.md` records real wall time (kept out of the hashed
`render-report.json`).

The v2 benchmark run did not produce numbers. All 9 renders (3 scenes
x draft, final, final-max) failed in about 1 s each with exit 5:
`EPERM: operation not permitted, write` on the first file write, at
the validate stage, before Chromium launched. Each render was retried
4 times over ~95 s and failed the same way every time. Full data:
`benchmark/results-2026-11-07-v2.json` (9 rows, all exit 5). Cause:
starting Nov 7 ~20:48 UTC, exec-spawned processes cannot write files
in this VM; the same block hit the parallel Seg4 coordinator's render
and other chats that evening, and is now recorded in `AGENTS.md`
(exec writes to workspace files fail, file tools work). No v2 wall
time, sha, or video exists, so no v2 table row is claimed here.
Re-run when exec writes work again:
`python3 benchmark/run-benchmark.py --profiles draft,final,final-max --tag v2`.

Small-scale numbers, measured before the block on 12-frame previs
renders of `scene-min` (not the 240-frame benchmark, do not compare
them to the v1 table): process wall time 11.2 s with the exit fix,
against 36-50 s for the same render before it; the renderer's own
wall time inside that was 9.0 s; the video sha was identical across
runs (`99adf50257f6e535a9...`). The final-vs-final-max picture-cost
comparison, the Seg3 final re-render and checker re-run, the full
240-frame determinism proof, and the fresh-context verifier are all
queued behind the same write block.

Side effect of the failed attempts: the CLI deletes `video.mp4` from
the out dir when a render fails, so the v1 videos under
`benchmark/runs/` are gone. The v1 shas survive in
`benchmark/results-2026-11-07.json`.

### Determinism: measured, pass

- `scene-min` final is byte-identical across two runs hours apart
  (sha256 `7bfca3d2c9e804eb...` both times).
- Within one run, run-a and run-b were byte-identical for min-final,
  map-sample, text-sample, seg3-final, seg4-final-v3 (fixcycle report).
- `map-sample` draft sha differs from the earlier
  `out/map-sample-det/run-a` file, so cross-day determinism for
  map-sample is NOT claimed; the fixture may have changed between runs.

### Motion smoothness: measured

From `benchmark/motion-smoothness.py` (320x180 gray frames, 0-255 scale):

| Clip | Mean change | Median | Max change | Jumps |
|---|---|---|---|---|
| map-sample final | 0.307 | 0.004 | 29.766 at frame 119 | 119, 120 |
| text-sample final | 0.090 | 0.043 | 0.463 at frame 62 | none |
| scene-min final | 0.278 | 0.166 | 1.042 at frame 60 | none |

The map jump at frames 119-120 is the 5 s scene cut, expected, not
jitter. No mid-beat jumps in any clip. The diff-of-diff sign-flip
count (89-149 of 237) is dominated by quantization noise on
near-static frames; read it with the jump list, not alone.

### Visual quality: measured, FAIL on the one reference check

Segment 3 checker, full run (`out/seg3-check-full/report.json`):
mean SSIM 0.6857 vs 0.95 target, mean PSNR 9.96 dB vs 35, mean LPIPS
0.656 vs 0.08, 240 HARD_FLOOR rows, 720 MOTION_ERR, 119 MOTION_JUMP.
Verdict FAIL. Cause, measured: the segment is a code-drawn
reconstruction of a hand-drawn original, not a pixel copy, and the
reference is 23.976 fps while the scene is 24 fps. No other segment
has a reference check yet, so no quality pass is claimed anywhere.

Font and palette gaps, measured: Montserrat Bold and Anton are still
missing (Liberation Sans Bold is used instead). The Seg4 palette was
never measured from a reference frame, and its ring is a schematic
2.0-degree circle, not the real perimeter.

### Cost and agent efficiency: measured

- Marginal cost per re-render: $0. The render path makes no API calls.
- Build cost so far: $4.70 Sonnet (OpenRouter), remaining balance
  $12.32. The rest of the work used Muse Spark at $0. That $4.70 is
  a one-time build cost, not a per-clip cost.
- Authoring cost: 5 prompt files, 362 lines; engine source about
  2,527 lines; a 10 s scene is 157 lines (map) to 259 lines (Seg4
  clone). Fix cycles used: 2 of a fresh 3-cycle budget.

## HyperFrames native: measured locally, plus published

Measured on this VM, 2026-11-07, on `hf-smoke/` (a trivial static
title card: empty GSAP timeline, black background, 1920x1080, 30 fps,
300 frames). This is a lower bound, NOT the frozen scenes.

| Run | Wall | Frames | sha256 | Bytes |
|---|---|---|---|---|
| 1 | 74.4 s | 300 | 26b9c89ed414c6c5 | 29,706 |
| 2 | 65.5 s | 300 | 26b9c89ed414c6c5 | 29,706 |

Byte-identical across runs. Capture took 57.3 s and 50.3 s of the
wall time; HyperFrames warned screenshot capture is slower because
BeginFrame did not run. First attempt failed on low `/tmp` space
(0.4 GB free on a 512 MB tmpfs); the rerun used
`TMPDIR=benchmark/tmp`.

Published (secondary, socialvik.com, 2026-10-16): 10 s, 1080p, 30 fps,
stock warm-grain example, median 34.1 s on a Ryzen 5 5625U laptop,
33.9-35.5 s range, 4 of 4 runs byte-identical. A 3 s title card
re-rendered in 3.7 s wall, byte-identical. The published laptop
number is faster than our VM number; different hardware, and our VM
was under shared load. Both point the same way: capture is the
bottleneck, not the encode.

## Other approaches: secondary numbers only

All of these are published numbers, not measurements on this machine.
Do not present them as if we ran them.

| Approach | 10 s clip, 1080p (secondary) | Cost | Agent fit |
|---|---|---|---|
| Remotion | about 1 min local; Lambda under 30 s for 60 s | Lambda about $0.05-0.20 per minute; licence cost above 3 people | React code per scene; frame is a pure function; Lambda scales |
| Motion Canvas / Revideo | conflicting: one source claims 5-20 ms/frame (1 min video in 3-10 s); another table says 30-60 s per 10 s | open source | code-first, upkeep slowing; do not use as base |
| Manim | 60 s 1080p took 5 min 30 s on an M3 MacBook Pro in one comparison; complex 5-min video 10-20 min | open source, $0 | Python code; strong for math, weak for brand motion |
| After Effects (aerender) | 10 s, 1920x1080, 60 fps with effects can take 10 min; human design time is the bigger cost (2 hours for 10 s in one creator post) | subscription; quality ceiling | not agent-first; ExtendScript is a poor agent interface |
| Blender Python | 3D only; not a 2D comparison | open source, $0 | Python API; wrong tool for 2D motion design |
| Template APIs (Shotstack, Creatomate, Plainly) | tens of seconds per render; queue dominates at volume | per finished 1080p minute: Renderly $0.10, Shotstack $0.20, Creatomate $0.84 Essential / $0.21 Beyond, Plainly $1.38; entry plans $29-69/mo | API-first but template-bound; no custom motion design |
| Vork | 3D/VFX only; no 2D motion design, no text, charts, maps, easing, timeline, typography, or audio | licence unclear | not a 2D comparison; do not build 2D on it |

Sources: HyperFrames numbers from socialvik.com 2026-10-16; Remotion,
Manim, After Effects, and template API numbers from published
comparisons gathered 2026-11-07 (see the handover research notes).
Re-verify before citing any of them in public.

## Ranked comparison

No blended score. Ranked per dimension, on the evidence above.

- **Determinism**: tied first, this tool and HyperFrames native.
  Both byte-identical across runs. No other approach has a measured
  determinism claim here.
- **Cost per clip**: tied first, this tool and HyperFrames native at
  $0 marginal (own machine). Template APIs and Remotion Lambda charge
  per minute.
- **Agent fit**: this tool first. JSON scene plus prompt pack plus a
  checker with a frozen predicate is the only setup where an agent can
  author, render, and verify without a human in the loop. HyperFrames
  native is second (Studio is human-first; no scene JSON, no
  predicate). Remotion and Manim are code-first. After Effects is last.
- **Render speed (10 s clip)**: HyperFrames native published fastest
  (34.1 s, laptop). Remotion about 60 s and Manim about 55 s (scaled
  from the 60 s numbers) sit next. This tool draft is 76-88 s on this
  VM; this tool final is 140-243 s, slowest of the measured set. The
  local HyperFrames number (65-74 s, trivial scene) shows the VM
  itself is slow at capture, so the gap is partly machine, partly our
  final profile.
- **Visual quality**: After Effects is the ceiling (human craft).
  This tool is last on the only measured reference check (Seg3 FAIL,
  SSIM 0.686 vs 0.95). No other approach has a measured quality score
  here, so no other quality rank is claimed.

Obvious advantages so far: determinism (byte-identical re-renders),
$0 marginal cost per clip, and agent fit (JSON scenes, prompts, and
a checker an agent can run alone). Speed and pixel quality are not
advantages yet; they are the work.

## Top 3 improvements, in order

1. **Cut final-profile render time.** Remove the `-threads 1` pin
   on ffmpeg, test preset `slow` against `medium`, and test
   supersample 2 against 1.5. Then parallelize frame capture. The
   final map clip took 242.6 s, 2.7 times draft; the encode and the
   2x capture dominate. Target: final within 1.5 times draft on the
   same machine, re-measured with `run-benchmark.py`.
2. **Close the style gap with measured references, not more code
   drawing.** Seg3 SSIM 0.686 against a 0.95 target says code-drawn
   reconstruction of hand-drawn art does not reach the predicate.
   Install Montserrat Bold and Anton, measure palette and grain from
   real reference frames, and trace where drawing cannot match. The
   Seg4 style-match work running in parallel is building that route;
   Seg3 needs the same route, not another drawing pass.
3. **Shrink authoring cost and fix the timing blind spot.** A 10 s
   scene is 157-259 lines of JSON, and every speed claim needs an
   external timer because `render-report.json` records
   `elapsed_s=0`. Add a compact authoring form so one label or number
   change is a one-line edit with a draft-only re-render, and record
   real wall time in the report (kept out of the deterministic hash).

## How to run the benchmark

Our tool, all frozen scenes, both profiles (about 15 minutes on
this VM):

```bash
cd ~/workspace/headless-motion-engine
python3 benchmark/run-benchmark.py
```

One scene, one profile, timed by hand:

```bash
cd ~/workspace/headless-motion-engine
time node src/renderer/cli.mjs render tests/fixtures/map-sample.json \
  --profile draft --out benchmark/runs/map-sample-draft
sha256sum benchmark/runs/map-sample-draft/video.mp4
ffprobe -v error -show_entries stream=width,height,r_frame_rate,nb_frames,duration \
  -of csv benchmark/runs/map-sample-draft/video.mp4
```

Motion smoothness for a rendered clip:

```bash
python3 benchmark/motion-smoothness.py benchmark/runs/map-sample-final/video.mp4
```

Quality check against a reference (needs a segment config with a
reference file; Seg3 is the only one that has one):

```bash
./run-checker.sh run --segment tests/segments/seg3.json \
  --render out/seg3-final/run-a/video.mp4 \
  --ref refs/seg3-glue-tape-240f.webm --out out/seg3-check-full --full
```

HyperFrames native, trivial scene only (needs disk space; `/tmp`
is a 512 MB tmpfs and the first attempt failed there):

```bash
cd ~/workspace/headless-motion-engine/hf-smoke
mkdir -p ../benchmark/tmp
TMPDIR=$PWD/../benchmark/tmp npx --yes hyperframes@0.9.20 render
```

## Verification process for the benchmark itself

Poteto style: Launch, Doctor, Drive, Evidence, Cleanup, with a
fresh-context verifier. The generator never verifies its own work.

- **Launch**: freeze the scenes, the predicate (`pred-v1`, check
  `src/checker/predicate.sha256`), the machine description, and the
  commands in this file before any run. Record the freeze in the
  results file.
- **Doctor**: check disk space (`df -h /tmp`), Chrome and ffmpeg
  versions, and that no other heavy job is running. A run under
  shared load is labelled as such.
- **Drive**: run `benchmark/run-benchmark.py`. Record wall time,
  exit code, sha256, and ffprobe facts per run. Never read speed
  from `render-report.json`.
- **Evidence**: keep the results JSON, the videos under
  `benchmark/runs/`, and the checker reports. Evidence survives
  cleanup; never overwrite an old results file, write a new dated one.
- **Cleanup**: clear `benchmark/tmp/` after HyperFrames runs. Keep
  the runs and results.
- **Fresh-context verifier**: a second agent, with no memory of the
  first run, re-runs one scene and one profile and compares sha256
  and wall time. Determinism passes only if the sha matches.
  Wall time passes if it is within 25% (shared-load allowance).
- **Predicate frozen, no relaxing**: a FAIL stays a FAIL. Changing
  a threshold means a new predicate version (`pred-v2`), a new
  results file, and the old scores stay untouched.

## How to add a new approach without changing old scores

1. Copy the frozen scenes into the new approach's own format. Do not
   edit the frozen scene files.
2. Render each scene at 1920x1080, 24 fps, 240 frames, on the same
   machine if possible. If the machine differs, say so in the results.
3. Write a new dated results file (`benchmark/results-<date>-<approach>.json`)
   with the same fields: wall seconds, seconds per frame, exit code,
   sha256, bytes, ffprobe facts. Never edit an old results file.
4. Run the checker against the same references where they exist, and
   record the verdict with the predicate version.
5. Add one row per scene to the tables in this file, labelled
   measured or secondary, with the source. Never change an existing
   row. If a re-run disagrees with an old row, add a new row and note
   the disagreement; do not rewrite history.
6. If the new approach cannot do a scene (for example, a 3D-only
   engine cannot do the 2D chart), record "not applicable" with the
   reason. Do not score it zero and do not skip the row.
