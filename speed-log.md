# Speed log — headless motion engine

Purpose: track how long each step takes, so we can see the slow steps and tell whether a change made it faster. Richardson cares about speed and efficiency. Every run logs here.

## Format

One line per timed step. Columns, separated by ` | `:

`date | run | unit | task | frames | duration | sec-per-frame | notes`

- date: YYYY-MM-DD HH:MM EST
- run: character-rig, illustration-tracing, gradients-glow, particles, fixer, or the tool name
- unit: the unit id, or `baseline`, `proof`, `regression`, `other`
- task: short words, what ran
- frames: number of frames rendered, or `-` if none
- duration: seconds, or `mm:ss`, or `h:mm`
- sec-per-frame: duration divided by frames, or `-`
- notes: gate closed, VM slow, profile used, anything that explains the time

## History (known numbers, before this log started)

### Fast render path, Nov 8, 2026 (quiet machine, 10s at 1920x1080, 24fps, 240 frames)
- 2026-11-08 | fast-render | before | map draft | 240 | 88.2s | 0.37 | before cache and dedup
- 2026-11-08 | fast-render | after | map draft | 240 | 34.6s | 0.14 | after cache and dedup, 2.5x faster
- 2026-11-08 | fast-render | before | map final | 240 | 242.6s | 1.01 | before
- 2026-11-08 | fast-render | after | map final | 240 | 57.0s | 0.24 | after, 4.3x faster
- 2026-11-08 | fast-render | before | text draft | 240 | 78.3s | 0.33 | before
- 2026-11-08 | fast-render | after | text draft | 240 | 25.1s | 0.10 | after
- 2026-11-08 | fast-render | before | text final | 240 | 179.1s | 0.75 | before
- 2026-11-08 | fast-render | after | text final | 240 | 37.5s | 0.16 | after
- 2026-11-08 | fast-render | before | scene-min draft | 240 | 75.9s | 0.32 | before
- 2026-11-08 | fast-render | after | scene-min draft | 240 | 28.6s | 0.12 | after
- 2026-11-08 | fast-render | before | scene-min final | 240 | 140.4s | 0.59 | before
- 2026-11-08 | fast-render | after | scene-min final | 240 | 51.1s | 0.21 | after

### Baselines, Nov 9, 2026 (authoring runs)
- 2026-11-09 | particles | baseline | v5/v6/v7 baseline capture | 576 | ~2h | ~12.5 | about 2 hours total for all three
- 2026-11-09 | particles | baseline | v7 render | 192 | - | ~11 | v7 at 80/192 frames at 10:55 UTC, about 11 s per frame
- 2026-11-09 | gradients-glow | baseline | v5 baseline | 192 | - | - | v5 done 192/192, took hours at this pace
- 2026-11-09 | gradients-glow | baseline | v6 baseline | 192 | - | - | v6 at 96/192 when last checked
- 2026-11-09 | illustration-tracing | baseline | v7 baseline | 192 | - | - | v7 complete 192/192
- 2026-11-09 | illustration-tracing | baseline | v6 baseline | 192 | - | - | v6 complete 192/192

## Log (new entries go below)

- 2026-11-09 05:52 EST | particles | baseline | v7 render, gate-open retry | 192 | 522s | 2.72 | started 10:52:17 UTC, exited 0 at 11:00:59 UTC; earlier ~12 s/frame was the gate-throttled first attempt
- 2026-11-09 07:24 EST | particles | U4 | particle sample render | 120 | 160.8s | 1.34 | profile draft; write gate closed at check time, commit blocked until 12:53 UTC
- 2026-11-09 07:53 EST | particles | U4 | check re-render from committed code | 120 | 42.5s | 0.35 | same video hash as the first render, faster, cause not measured
- 2026-11-09 08:08 EST | particles | proof | quick render, 5 key frames | 5 | 19.2s | 3.84 | profile draft; command took 29 s end to end
- 2026-11-09 08:12 EST | particles | proof | full determinism render run-a | 121 | 121.1s | 1.00 | profile draft, --verify-determinism, byte-identical to run-b
- 2026-11-09 08:14 EST | particles | proof | full determinism render run-b | 121 | 118.4s | 0.98 | profile draft, --verify-determinism, byte-identical to run-a

- 2026-11-09 04:06 EST | illustration-tracing | A | v5 baseline render, previs | 192 | 29m | ~9.06 | 09:06-09:35 UTC, slowed by shared load, other runs rendering at the same time
- 2026-11-09 04:36 EST | illustration-tracing | A | v6 baseline attempt 1, full render | 179 | 26m | ~8.72 | 09:36-10:02 UTC, died EPERM writing odd frame 167, gate closed
- 2026-11-09 05:06 EST | illustration-tracing | A | v6 baseline attempt 2, full render retry | 0 | 7m | - | 10:06-10:13 UTC, exit 1, no output, gate closed
- 2026-11-09 05:15 EST | illustration-tracing | A | v6 baseline attempt 3, full render retry | 0 | 7m | - | 10:15-10:22 UTC, died EPERM, gate closed
- 2026-11-09 05:23 EST | illustration-tracing | A | v6 baseline attempt 4, split render 167:192 | 0 | 7m | - | 10:23-10:30 UTC, unreadable report plus EPERM, gate closed
- 2026-11-09 05:31 EST | illustration-tracing | A | v6 baseline attempt 5, split render retry | 0 | 7m | - | 10:31-10:38 UTC, unreadable report plus EPERM, gate closed
- 2026-11-09 05:40 EST | illustration-tracing | A | v6 baseline attempt 6, split render, probe first | 0 | 7m | - | 10:40-10:47 UTC, 1.6 MB probe landed but render still died EPERM, probe does not predict render processes
- 2026-11-09 | illustration-tracing | A | v6 baseline completion, split render 167:192 | 25 | 61s | 2.44 | gate open in this window, cheaper completion route, exit 0, exact start time not recorded
- 2026-11-09 | illustration-tracing | A | v7 baseline partial render | 40 | 10m | ~15.0 | exit 1 EPERM mid-render, gate closed, report files 0 bytes, exact start time not recorded
- 2026-11-09 | illustration-tracing | A | VTracer monster crop trace | - | 0.6s | - | 108 paths, 33795 bytes, VTracer 0.6.15, single 165x288 crop
- 2026-11-09 | illustration-tracing | C | VTracer skulls crop trace | - | 0.6s | - | 36 paths, 12370 bytes, VTracer 0.6.15, single 90x32 crop

- 2026-11-09 06:02 | character-rig | D | proof render, previs | 3 | 10.6s | 3.53 | probe render, only 3 frames captured (0/48/72), browser startup dominates, not a per-frame render cost

### Fixer run, Nov 9, 2026
- 2026-11-09 06:19 EST | fixer | F | proof 1 render (fix1 scene, profile final) | 192 | 2h20m | 43.75 | includes failed attempts (FONT_MISSING, then ~30 min capture fail); EPERM gate blocked node writes 10:06-10:52 UTC; 12 frames deduped, 180 unique
- 2026-11-09 09:05 EST | fixer | F | proof 2 render (fix2 scene, profile final) | 192 | 26m24s | 8.25 | gate open throughout, eperm_retries 0, 12 frames deduped, 180 unique, exit 0
- 2026-11-09 09:31 EST | fixer | F | proof 2 trace attempt 1 | 192 | 372s | 1.94 | all passes ran (energy, palette, keyframes, trajectories, zoom/badge, labels), final profile write failed EPERM, 0-byte profile, gate closed at end

- 2026-11-09 03:59 EST | gradients-glow | baseline | v5 baseline resume 87:192 | 105 | 21:02 | 12.02 | draft, map scene, chunked capture after first capture was killed at 49 min
- 2026-11-09 04:20 EST | gradients-glow | baseline | v6 baseline chunk0 0:96 | 96 | 16:04 | 10.04 | draft, map scene
- 2026-11-09 04:36 EST | gradients-glow | baseline | v6 baseline chunk1 96:192 | 96 | 11:46 | 7.35 | draft, map scene
- 2026-11-09 07:58 EST | gradients-glow | regression | v6 regression chunk1 96:192 | 96 | 4:10 | 2.60 | draft, gate open, Chromium recovered
- 2026-11-09 08:02 EST | gradients-glow | regression | v7 regression chunk0 0:96 | 96 | 4:46 | 2.98 | draft
- 2026-11-09 08:07 EST | gradients-glow | regression | v7 regression chunk1 96:192 | 96 | 5:11 | 3.24 | draft

- 2026-11-09 08:19 EST | gradients-glow | E | compare-e.py, 576 frame hashes | - | 27.9s | - | E PASS, 576/576 identical, no renders; gate open

- 2026-11-09 08:24 EST | gradients-glow | F | kit baseline render, test scene, draft | 12 | 44s | 3.67 | kit test scene, 12 frames, all one hash a296a612, pixel-verified (bokeh core, band peak, glow halo, flat control exact)
- 2026-11-09 08:26 EST | gradients-glow | F | kit check CLI run 1, draft | 12 | 32s | 2.67 | render 29s; 19 checks pass, exit 0; evidence showed 17 passed at write time (pre-cleanup ordering), fixed after
- 2026-11-09 08:28 EST | gradients-glow | F | kit check CLI run 2, draft | 12 | 30s | 2.50 | render 24s; 19 checks pass, exit 0; evidence reads back 19 passed, 0 failed

- 2026-11-09 06:06 EST | character-rig | E | npm test, scene + renderer suites | - | ~396s | - | 11:06-11:13 UTC, 67 tests, 66 pass, 1 pre-existing lint failure (determinism lint false positive)
- 2026-11-09 06:09 EST | character-rig | E | v5 regression render, previs, double render | 384 | ~18m | ~2.81 | 11:09-11:27:01 UTC, run-a + run-b, 192 each, 0 differing frames, video hash identical
- 2026-11-09 06:27 EST | character-rig | E | v6 regression render, previs, double render | 384 | ~16m | ~2.58 | 11:27-11:43:29 UTC, run-a + run-b, 192 each, 0 differing frames, video hash identical
- 2026-11-09 06:43 EST | character-rig | E | v7 regression attempt 1, previs, double render | 12 | ~8m | ~41 | 11:43:39-11:51:51 UTC, failed, write gate EPERM, run-a stalled at 12/192, run-b never started, exit 1
- 2026-11-09 07:53 EST | character-rig | E | v7 regression re-run, previs, double render | 384 | 12m37s | 1.97 | 12:53:29-13:06:06 UTC, gate open after 62 min closed, run-a + run-b, 192 each, 0 differing frames, video hash identical
- 2026-11-09 08:21 EST | character-rig | F | kit check.sh doctor | - | 16.9s | - | ALL CHECKS PASSED, help/define/keyframe/expand/validate, 10 number checks, no frames rendered
- 2026-11-09 08:10 EST | character-rig | verifier | independent verification run | - | ~14m | - | 08:10-08:23:47 EST, all 8 items + R gap checked, npm test 82 tests 13:12-13:19 UTC, no renders, report filed
- 2026-11-09 08:33 EST | character-rig | judge | independent judge verdict, PASS WITH GAPS | - | 2m20s | - | recomputed predicate hash, 11 vs 42 keys, re-diffed v5/v6/v7 frame hashes (0 mismatches each), viewed 7 frames, no builds or tests re-run

### GPU-opt ladder probes, Nov 9, 2026 (probe script: tmp-work/gpu-opt-probe.mjs, in-memory compile, no file writes)
### Showcase run, Nov 9, 2026 (gate-blocked, no renders)
- 2026-11-09 09:44 EST | showcase | smoke | 1-frame draft smoke, data-story | 1 | 509s | - | write gate closed the whole run, 10 fresh processes all blocked, 0 frames captured, EPERM validate stage; all 4 showcase scenes validate OK, renders queued on the gate reopening

- 2026-11-09 08:40 EST | gpu-opt | ladder | compile scene-min attempt | - | 10.3s | - | EPERM gate closed, retry.mjs exhausted, 0-byte page.html (removed after)
- 2026-11-09 08:41 EST | gpu-opt | ladder | chromium launch probe, full 1248 + shell 1248 | - | - | - | SIGTRAP exit 133 on every headless launch, --version works; /tmp 512M 99% full, verif-b2 473M; 5 render CLIs alive, 0 chrome processes
- 2026-11-09 08:44 EST | gpu-opt | ladder | exec write gate probe | - | - | - | printf write exit 1, 0-byte file, gate still closed after 90 s wait
- 2026-11-09 08:45 EST | gpu-opt | ladder | system facts | - | - | - | 4 cores, ~8G RAM, no /dev/dri, ffmpeg 8.1.2 libx264, no h264_videotoolbox here; Chromium 1243/1248 + headless shell cached; disk 150G, 116G used, 31G free

### Verifier V, gradients-glow, Nov 9, 2026 (write gate closed ~08:35 EST onward)
- 2026-11-09 08:30 EST | gradients-glow | V | validate fixtures scene-min + seg4 v5/v6/v7 + seg3 | - | 4.5s | - | all exit 0
- 2026-11-09 08:31 EST | gradients-glow | V | validate kit scene + 4 invalid scenes | - | 6.2s | - | kit OK 12 frames; 4 invalid rejected exit 1 with schema code
- 2026-11-09 08:35 EST | gradients-glow | V | compile kit + v5/v6/v7 pages | - | 17.7s | - | diff vs baselines is C runtime only, 4 hunks
- 2026-11-09 08:40 EST | gradients-glow | V | render kit test scene, fresh C check | 12 | 403s | - | FAILED on EPERM write gate, 0 frames, environment not engine
- 2026-11-09 08:47 EST | gradients-glow | V | compare-e.py re-run | 576 | 29.3s | - | E PASS, 576/576 identical
- 2026-11-09 08:50 EST | gradients-glow | V | D pixel re-measurement, measure-d2.py + own CIE76 checks | - | - | - | runs 1-8s each; bokeh worst dE 1.46, clouds worst dE 1.41
- 2026-11-09 09:00 EST | gradients-glow | V | npm test subset, 8 read-only suites | - | 505s | - | authoring test failed on EPERM gate only; pure suites 61/61 pass
- 2026-11-09 09:05 EST | gradients-glow | V | pure test suites, 7 files, run one by one | - | 11.0s | - | easing 8, order 2, random 3, particles 12, validate 24, evaluate 9, framekey 3, all pass
- 2026-11-09 09:15 EST | gradients-glow | V | gate waits for check.sh + npm test, 600s + 900s + 600s | - | 2100s | - | gate never opened, check.sh not run
- 2026-11-09 09:24 EST | gradients-glow | V | /tmp cleanup, removed broken /tmp/verif-b2 copy | - | 0.5s | - | freed 473M, /tmp 99% full to 7% used
- 2026-11-09 09:39 EST | gradients-glow | V | gate probe after verifier report, coordinator check | - | 0.02s | - | gate still closed, exit 1, 0 bytes; V blocked, run stopped per brief
- 2026-11-09 10:08 EST | gradients-glow | F | kit check CLI re-run 3, draft | 12 | 106s | 8.83 | render 95s; 19 checks pass, exit 0; evidence reads back 19 passed, 0 failed; gate open, other runs rendering at the same time
- 2026-11-09 10:12 EST | gradients-glow | other | full npm test, scene + renderer suites | - | 902s | - | 82 tests, 81 pass, 1 fail; authoring/render tests all pass; single failure is the determinism lint test on vignette help text (pre-existing, other run's commit c46872d9), not this run's code
- 2026-11-09 10:17 EST | fixer | F | trace retry attempt 2, render-fix2 video, fresh process | 192 | 1253s | 6.53 | 09:56:58-10:17:51 UTC, profile write succeeded 274,175 bytes, CLI exit 1 on trailing bad-JSON parse after write
- 2026-11-09 10:21 EST | fixer | F | timing rerun 2, ref vs trace-fix2 profile, fresh process | - | 5s | - | median dt -0.62 s FAIL (threshold 0.25 s), 18 samples window 4.208-4.917 s, exit 1, output 112,284 bytes
- 2026-11-09 10:17 EST | showcase | map-flight | showcase-map-flight, draft, 120f | 120 | 1063.3s | 8.86 | gate reopened 14:52 UTC; first attempt killed at 260s by tool timeout, reran in background; 120 frames captured, 106 unique, 14 deduped; 2 other renders ran at the same time on shared CPU; sha 4aaf36b5fb9d, 1920x1080 24fps 5.0s
- 2026-11-09 10:27 EST | showcase | data-story | showcase-data-story, draft, 120f | 120 | 259s | 2.16 | 120 frames captured, 83 unique, 37 deduped; sha fe64208a37cd, 1920x1080 24fps 5.0s
- 2026-11-09 10:41 EST | showcase | particles-night | showcase-particles-night, draft, 120f | 120 | 422.2s | 3.52 | 120 frames captured, 120 unique, 0 deduped; sha 956deecff9ad, 1920x1080 24fps 5.0s
- 2026-11-09 10:51 EST | showcase | character-rig | showcase-character-rig, draft, 120f | 120 | 370s | 3.08 | 120 frames captured, 119 unique, 1 deduped; sha 90f29805f782, 1920x1080 24fps 5.0s; hand-written rig tracks verified on screen, blink, brow raise, arm lift, mouth open all play and return to rest
- 2026-11-09 10:34 EST | gradients-glow | J | judge re-checks: predicate hash, blame, logs, commits | - | 5s | - | hash matches pred-v1 exactly; blame all 4 lint lines c46872d9 (Nov 8); kit run-05 19/19 exit 0; npm log 81 pass 1 fail
- 2026-11-09 10:36 EST | gradients-glow | J | judge re-runs: compare-e.py + measure-d2.py | - | 55s | - | E 576/576 ok; D bokeh worst dE 1.46, clouds band 1.41, puff 1.65, sky/ground 0.00 — exact match to evidence
- 2026-11-09 10:38 EST | gradients-glow | J | judge re-runs: A validation, 5 fixtures + 4 bad + 1 good | - | 35s | - | fixtures PASS 0 errors; bad angle/stop/glow/soft rejected PROP_TYPE; good gradient PASS
- 2026-11-09 10:40 EST | gradients-glow | J | judge re-run: kit/check.sh end to end | 12 | 78s | 6.50 | exit 0, 19/19 checks, 67s render, frame 0 hash matches baseline; log kit/check-run-judge.log
- 2026-11-09 10:42 EST | gradients-glow | J | verdict written: PASS WITH GAPS | - | 2s | - | judge-verdict.md, 7768 bytes; 4 queued gaps, none touching a predicate bar
- 2026-11-09 10:33 EST | fixer | F | gate probe: write + read back ~/workspace/tmp-work/gate-probe-fixer-cron.txt | - | 1s | - | gate open, 42 bytes, content read back intact
- 2026-11-09 10:50 EST | fixer | A | D5 fix cycle 4: fixer suite (6 fix test files) after no-shift-outside-window change | - | 57s | - | 49 pass, 0 fail

### GPU-opt U2 capture-path fixes, Nov 9, 2026 (pre-fix baselines on the current tree; load avg 35 at start, 3 at end)
- 2026-11-09 11:15 EST | gpu-opt | U2 | pre-fix baseline scene-min final | 240 | 683s | 2.85 | load avg 35 at start; 238 unique, 2 deduped, workers 2; 0 frame-hash diffs vs v3 baseline, video sha matches v3 c3f9780f23bf2472
- 2026-11-09 11:26 EST | gpu-opt | U2 | pre-fix baseline map-sample final | 240 | 676s | 2.82 | load avg 12-29; 149 unique, 91 deduped, workers 2; 0 frame-hash diffs vs v3 baseline, video sha matches v3 58b4d35b126b899a
- 2026-11-09 12:06 EST | fixer | F | scene suite tests/scene/ | - | 87s | - | 62 pass, 0 fail; vignette blocker cleared by a8f4154
- 2026-11-09 12:11 EST | fixer | F | fix3 render attempt 1, killed by parent for load | 192 | 367s wall | - | wall_s 366.9, 0 frames captured, PAGE_ERROR browser closed on kill; parent kill, not a renderer defect
- 2026-11-09 12:16 EST | fixer | F | vm-health check before render restart | - | 3s | - | DEFER, load per CPU 10.90, free 265 MB, swap 317 MB used, hatch 96.0% CPU, ffmpeg 13.1%; render NOT restarted
- 2026-11-09 12:06 EST | gpu-opt | U2 | Fix 3 verification scene-min final (fromSurface:false) | 240 | 485s | 2.02 | load avg 5.2 at start, 7.5 at end; 240/240 frame-hash diffs vs pre-fix baseline — FAILED pixel check; capture 1920x1080 not 2880x1620 (clip scale ignored, supersampling lost); video sha differs; NOT committed, reverted
- 2026-11-09 12:41 EST | gpu-opt | U2 | Fix 4 measurement scene-min final, HME_WORKERS=4 | 240 | 722s | 3.01 | load avg 31.2 at start, 2.9 at end; 0 frame-hash diffs, video sha matches baseline c3f9780f23bf2472; 5.7% SLOWER than workers-2 baseline 683s — no scaling, no commit
- 2026-11-09 13:01 EST | gpu-opt | U2 | Fix 2 verification scene-min final (dirty-check apply) | 240 | 685s | 2.85 | load avg 3.8 at start, 36.2 at end; 0 frame-hash diffs, video sha matches baseline c3f9780f23bf2472; +0.3% vs baseline 683s — no measurable gain, no commit
- 2026-11-09 13:13 EST | gpu-opt | U2 | Fix 2 verification map-sample final (dirty-check apply) | 240 | 679s | 2.83 | load avg 31.4 at start, 4.2 at end; 0 frame-hash diffs, video sha matches baseline 58b4d35b126b899a; +0.4% vs baseline 676s — no measurable gain, no commit
2026-11-09 | stage2-followup-trace-rig-man | T1 | trace 3 frames VTracer | 3 frames | 28.93s | 9.64s/frame | paths 45/594/497; SSIM 0.8307/0.8905/0.9109; fills 100%
2026-11-09 | stage2-followup-trace-rig-man | T2 | Terra labeling 2 calls | 3 frames | 101s | - | $0.1276; call1 32s, call2 69s; grouping deterministic after both calls failed; face IoU 0.915
2026-11-09 | stage2-followup-trace-rig-man | T4 | mac tarball build, working tree minus node_modules/out/.git/renders/.tmp/verify-seg4/.venv/__pycache__ | - | 7.9s | - | 24,103,860 bytes, sha 68a76a45; Mac SSH down, staged for later
2026-11-09 | stage2-followup-trace-rig-man | T4 | linux diagnostic render frame 0, profile final, staged scene copy | 1 | 23.3s | 23.3 | Mac SSH down, diagnostic only; video sha a88ba281
2026-11-09 | stage2-followup-trace-rig-man | T4 | linux diagnostic render frames 48,72, profile final, staged scene copy | 2 | 28.4s | 14.2 | Mac SSH down, diagnostic only; video sha a6c1baed
2026-11-09 | stage2-followup-trace-rig-man | T4 | SSIM + face/27/hands/creatures measurement, 3 frames | 3 | 25.4s | 8.5 | SSIM 0.8291/0.8815/0.9053 mean 0.8720; face element IoU 0.9152; 27 present; hands present; creatures at 2s/3s
2026-11-09 | stage2-followup-trace-rig-man | F1 | hme validate, face-cutout scene | - | 5.1s | - | PASS, 1142 nodes, 0 errors, 0 warnings
2026-11-09 | stage2-followup-trace-rig-man | F1 | render frames 0,48,72 profile final, face-cutout scene | 3 | 53.8s | 17.9 | SSIM 0.8325/0.8920/0.9165 mean 0.8803; temple leak 4176 to 0
2026-11-09 | stage2-followup-trace-rig-man | F1 | render frame 60 profile final, mid-swing check | 1 | 55.9s | 55.9 | no arm crosses face rect; faint cutout seam at hair edge
2026-11-09 | stage2-followup-trace-rig-man | F1 | VTracer fine params (color_precision 8, layer_difference 4), 3 frames | 3 | 32.3s | 10.8 | paths 656/3505/3552; trace SSIM 0.9800/0.9715/0.9709 mean 0.9741
2026-11-09 | stage2-followup-trace-rig-man | F1 | SSIM + leak recount, attempt A renders, 3 frames | 3 | 34.8s | 11.6 | T4 method mean 0.8803; uniform/upscale cross-check mean 0.8750
2026-11-09 | stage2-followup-trace-rig-man | T1b | VTracer fine params (color_precision 8, layer_difference 4), 3 frames, fresh run | 3 | 3.2s | 1.1 | paths 656/3505/3552; byte-identical to F1 evidence files
2026-11-09 | stage2-followup-trace-rig-man | T1b | Sharp raster + SSIM (T4 method), 3 frames | 3 | 6.5s | 2.2 | SSIM 0.9800/0.9715/0.9709 mean 0.9741; PSNR 39.70/31.28/32.27 dB
2026-11-09 | stage2-followup-trace-rig-man | T1b | trace-import.py convert, 3 traces | 3 | 5.7s | 1.9 | 656/3505/3552 nodes, all path kind, all hex fills
2026-11-09 | stage2-followup-trace-rig-man | T2b | analytic Bezier boxes (boxes.py), 7713 paths | 3 | 23.2s | 7.7 | max exact-vs-sampled diff 0.0004 px; commands C/M/Z only
2026-11-09 | stage2-followup-trace-rig-man | T2b | visible-region render (visible.py), 7713 paths | 3 | 43.0s | 14.3 | full coverage 921600 px; fully-hidden 0/2/3; PIL-vs-Sharp diff>12: 0.50/2.33/2.05%
2026-11-09 | stage2-followup-trace-rig-man | T2b | Terra big-path labeling (top 40/frame), 1 call, script wall time | 3 | 56.0s | 18.7 | 120/120 assigned; $0.0239 token pricing, $0.0264 usage cost; key deleted 200
2026-11-09 | stage2-followup-trace-rig-man | T2b | grouping (group.py), 7713 paths | 3 | 6.9s | 2.3 | face 2s box [414,153,749,425] IoU 0.954; partition 656/3505/3552
2026-11-09 | stage2-followup-trace-rig-man | T2b | part map build (build_partmap.py) | 3 | 18.9s | 6.3 | containment PASS; raster face IoU 0.948; 16 element files
2026-11-09 | stage2-followup-trace-rig-man | T2b | independent verification (verify_t1b2.py) on installed files | 3 | 4.8s | 1.6 | ALL PASS: partition exact, face IoU 0.9544, 27 overlap 205x57
2026-11-09 | stage2-followup-trace-rig-man | T3b | analytic Bezier boxes + dense cross-check (200 steps), 7713 paths | 3 | 527.8s | 175.9 | max analytic-vs-dense diff 0.000394 px at 2s path 57; part-map element-box unions within 0.005 px
2026-11-09 | stage2-followup-trace-rig-man | T3b | build rig.json + scene-base.json | 3 | 52.7s | 17.6 | 676 parts/joints; 7716 nodes; IK wrist error 0.0014/0.0012 px; face 2s scene box [621, 229.5, 1123.5, 637.5]
2026-11-09 | stage2-followup-trace-rig-man | T3b | rig define + 6 keyframe CLI calls | 3 | 26.5s | 8.8 | rig define PASS 0 errors; 6 keys recorded (arms-down 0/48, mid 60, high 66, raised 72, hands-placed 72)
2026-11-09 | stage2-followup-trace-rig-man | T3b | rig expand to scene.json | 3 | 14.3s | 4.8 | 6804 keys across 2028 tracks; expanded scene passes validate
2026-11-09 | stage2-followup-trace-rig-man | T3b | hme validate scene.json | 3 | 22.1s | 7.4 | exit 0, 0 errors, 0 warnings; 7716 nodes, 2028 tracks, 73 frames
2026-11-09 | stage2-followup-trace-rig-man | T3b | independent verification (verify.py) | 3 | 39.1s | 13.0 | exit 0, 0 failures; boxes/fills/d/pivots/rotations/timeline all recompute
2026-11-09 | stage2-followup-trace-rig-man | T3b | diagnostic render frames 0/48/72, profile final | 3 | 172.5s | 57.5 | exit 0, deterministic; video 0af0fe23; frames c8f9dab3/32cd2f81/e5c6565c
2026-11-09 | stage2-followup-trace-rig-man | T4-retry | Linux diagnostic render frame 0, profile final | 1 | 11.7s | 11.7 | exit 0; video 2e58bcb1; frame c8f9dab3; byte-identical to T3b frame
2026-11-09 | stage2-followup-trace-rig-man | T4-retry | Linux diagnostic render frames 48,72, profile final | 2 | 14.4s | 7.2 | exit 0; video 23510cce; frames 32cd2f81/e5c6565c; byte-identical to T3b frames
2026-11-09 | stage2-followup-trace-rig-man | T4-retry | SSIM + checks on Linux diagnostics | 3 | 15.3s | 5.1 | SSIM 0.9777/0.9508/0.9537 mean 0.9607; skimage cross-check mean 0.9586; face IoU 0.9544; temple 0 px
2026-11-09 | stage2-followup-trace-rig-man | T4-retry | Mac proof render, 73 frames, profile final | 73 | 26.6s | 0.36 | exit 0; video dd6cf4d1; 1920x1080 scene, frames 2880x1620; npm ci + render in one SSH session
2026-11-09 | stage2-followup-trace-rig-man | T4-retry | Mac SSIM + checks on proof render | 3 | 16.6s | 5.5 | SSIM 0.9770/0.9465/0.9496 mean 0.9577; skimage cross-check mean 0.9554; face IoU 0.9544; temple 0 px

2026-11-09 | stage2-followup-trace-rig-man | T5 | regression render v5, profile previs | 192 | 118s | 0.61 | exit 0; 192/192 frames match baseline, video 0695257a identical; 0 mismatched
2026-11-09 | stage2-followup-trace-rig-man | T5 | regression render v6, profile previs | 192 | 111s | 0.58 | exit 0; 192/192 frames match baseline, video fb1041bf identical; 0 mismatched
2026-11-09 | stage2-followup-trace-rig-man | T5 | regression render v7, profile previs | 192 | 110s | 0.57 | exit 0; 192/192 frames match baseline, video 8909b18e identical; 0 mismatched
2026-11-09 | stage2-followup-trace-rig-man | T5 | npm test | 116 | 81s | 0.70 | 116 pass, 0 fail, exit 0; known non-rig failures did not appear
2026-11-09 | stage2-followup-trace-rig-man | T5 | kit check.sh doctor + drive | 0 | 2s | - | ALL CHECKS PASSED both, exit 0; define 8 parts 6 joints 9 poses, expand 10 tracks 42 keys
2026-11-09 | stage2-followup-trace-rig-man | T5 | drive reproduction render, scene.json frames 0/48/72, profile final | 3 | 35s | 11.7 | exit 0 both; frames byte-identical to T4 Linux diagnostics c8f9dab3/32cd2f81/e5c6565c
2026-11-09 | stage2-followup-trace-rig-man | verifier | SSIM recompute Mac+Linux, two methods | 6 | 21.6s | 3.6 | Mac mean 0.9577/0.9554, Linux 0.9607/0.9624; both clear bars
2026-11-09 | stage2-followup-trace-rig-man | verifier | regression frame compare v5/v6/v7 | 576 | 36.2s | 0.06 | 0 mismatches, videos match
2026-11-09 | stage2-followup-trace-rig-man | verifier | npm test | 116 | 104.1s | 0.90 | 116 pass, 0 fail, exit 0
2026-11-09 | stage2-followup-trace-rig-man | verifier | kit doctor + drive | 0 | 3s | - | ALL CHECKS PASSED both, exit 0
2026-11-09 | stage2-followup-trace-rig-man | verifier | scene validate + pixel checks | 6 | 45s | 7.5 | validator PASS 0 errors; face IoU 0.9544; 27 exact; temple 0 px
2026-11-09 | stage2-followup-trace-rig-man | judge | verdict | 0 | 302s | - | overall PASS WITH GAPS; read verify-report.md, units.json, compare-report.md, regression.md, kit-proof.md, ledger, trail; spot-checked hashes (pred-v1, scene, rig, part-map, traces, Mac video/frames, regression videos) and counts (grep 656/3505/3552; scene 7716 nodes; rig 676/676); wrote final-report.md and verdict.md
