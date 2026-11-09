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
- 2026-11-09 | illustration-tracing | baseline | v7 baseline | 192 | - | - | v7 at 40/192 frames when last checked
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

- 2026-11-09 03:59 EST | gradients-glow | baseline | v5 baseline resume 87:192 | 105 | 21:02 | 12.02 | draft, map scene, chunked capture after first capture was killed at 49 min
- 2026-11-09 04:20 EST | gradients-glow | baseline | v6 baseline chunk0 0:96 | 96 | 16:04 | 10.04 | draft, map scene
- 2026-11-09 04:36 EST | gradients-glow | baseline | v6 baseline chunk1 96:192 | 96 | 11:46 | 7.35 | draft, map scene
- 2026-11-09 07:58 EST | gradients-glow | regression | v6 regression chunk1 96:192 | 96 | 4:10 | 2.60 | draft, gate open, Chromium recovered
- 2026-11-09 08:02 EST | gradients-glow | regression | v7 regression chunk0 0:96 | 96 | 4:46 | 2.98 | draft
- 2026-11-09 08:07 EST | gradients-glow | regression | v7 regression chunk1 96:192 | 96 | 5:11 | 3.24 | draft

- 2026-11-09 08:19 EST | gradients-glow | E | compare-e.py, 576 frame hashes | - | 27.9s | - | E PASS, 576/576 identical, no renders; gate open

- 2026-11-09 06:06 EST | character-rig | E | npm test, scene + renderer suites | - | ~396s | - | 11:06-11:13 UTC, 67 tests, 66 pass, 1 pre-existing lint failure (determinism lint false positive)
- 2026-11-09 06:09 EST | character-rig | E | v5 regression render, previs, double render | 384 | ~18m | ~2.81 | 11:09-11:27:01 UTC, run-a + run-b, 192 each, 0 differing frames, video hash identical
- 2026-11-09 06:27 EST | character-rig | E | v6 regression render, previs, double render | 384 | ~16m | ~2.58 | 11:27-11:43:29 UTC, run-a + run-b, 192 each, 0 differing frames, video hash identical
- 2026-11-09 06:43 EST | character-rig | E | v7 regression attempt 1, previs, double render | 12 | ~8m | ~41 | 11:43:39-11:51:51 UTC, failed, write gate EPERM, run-a stalled at 12/192, run-b never started, exit 1
- 2026-11-09 07:53 EST | character-rig | E | v7 regression re-run, previs, double render | 384 | 12m37s | 1.97 | 12:53:29-13:06:06 UTC, gate open after 62 min closed, run-a + run-b, 192 each, 0 differing frames, video hash identical
- 2026-11-09 08:21 EST | character-rig | F | kit check.sh doctor | - | 16.9s | - | ALL CHECKS PASSED, help/define/keyframe/expand/validate, 10 number checks, no frames rendered
- 2026-11-09 08:10 EST | character-rig | verifier | independent verification run | - | ~14m | - | 08:10-08:23:47 EST, all 8 items + R gap checked, npm test 82 tests 13:12-13:19 UTC, no renders, report filed
