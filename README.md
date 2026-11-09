<p align="center">
  <img src="assets/brand/logo.svg" width="120" alt="Headless Motion logo">
</p>

# Headless Motion

![Headless Motion hero](assets/brand/hero.png)

Motion graphics from JSON scenes. No timeline UI, no manual keyframes.

An agent writes a scene, the engine renders the video, and a checker scores every frame against a reference. The goal is animation on par with top YouTube animation channels, produced end to end without a human opening an editor.

## Why headless

After Effects is built for a human hand on a timeline. An agent cannot scrub, drag keyframes, or judge a frame by eye. Headless Motion turns the whole job into files an agent can write and check: a scene is JSON, a render is one command, and the verdict is numbers, not an opinion.

## How it works

![Render pipeline](assets/brand/architecture.svg)

## The interface is a language

Headless Motion has no timeline to drag. Its interface is three things an agent can read and write.

1. A scene file. One JSON file, schema `hme.scene/1.0`, holds the whole video: nodes, palette, fonts, and the timeline.
2. A command. One line renders it: `node src/renderer/cli.mjs render <scene> --profile final --out <dir>`.
3. A verdict. One check scores every frame against the reference and says pass or fail, with the numbers behind it.

An agent drives it through five prompt files in `prompts/`, which teach it the scene format, the renderer, the map system, the chart and text module, and the frame checker. Nothing in the tool needs a human hand, a mouse, or an eye. That is why an agent can run it end to end, and why the proof is a number, not a feeling.

If you can write the scene, you can make the video. If you can read the check, you can tell if it worked.

## Tools

Each tool is a file an agent can call, not a screen to open. Status is what the last independent check said.

### Core tools

| Tool | File | What it does | Status |
| --- | --- | --- | --- |
| Reference teardown | `src/reference/teardown.py` | Measures a reference video into a profile: palette with source frame and coords, geometry as ratios, shots, cuts, events, per-colour trajectories, VTracer traces per keyframe | Pass, judge confirmed |
| Easing and timing picker | `src/scene/pick-ease.mjs` | Ranks easing curves and springs by measured error against a reference trajectory, and ranks flow-guided warp intervals per shot | Pass, judge confirmed |
| Defect taxonomy and log | `src/checker/defects.json`, `src/checker/defects.py` | Maps every checker failure code to a defect class, likely cause, and suggested fix; logs one row per failure and writes a summary | Pass, judge confirmed |
| Banned list | `banned.json` | Patterns that must never ship again, linted before rendering; grows from confirmed defects | Pass, judge confirmed |
| Frame checker | `src/checker/` | Scores every frame against a reference: SSIM, PSNR, LPIPS, flat colour, motion, text shift, layer layout | In use, Gate 3 LPIPS still being measured |
| Renderer | `src/renderer/` | Headless Chromium capture plus ffmpeg encode, deterministic, 1920x1080 at 24 fps | In use |
| Map module | `src/map/` | Draws real Natural Earth geography with a fixed visual system | In use |
| Chart and text module | `src/scene/` | Bars, lines, and kinetic type | In use |
| CLI | `src/cli/hme.mjs` | One command surface for render, check, compare, and player pass | In use |
| Player pass | `run-player-pass.py` | Screenshots our own video the same way the reference is screenshotted, so the check compares like with like | In use |

The three new tools in this table, teardown, picker, and taxonomy with banned list, were built in November 2026 to fix what the engine could not do before: it could not see a reference style, it could not pick an ease by numbers, and it forgot every failure it found.

### Measurement tools

One `hme` command measures one thing, and every measurement returns the same shape: a verdict, the numbers, a correction in scene terms, the next most useful command, and its limits. Run them from the repo root as `node src/cli/hme.mjs <command>`. An agent reads the correction and applies it; it does not guess from a score.

| Tool | Command | What it measures | Status |
| --- | --- | --- | --- |
| Compare | `hme compare` | Full frame scores: SSIM, PSNR, LPIPS, flat colour | In use |
| Diagnose | `hme diagnose` | Names the kind of error and the fix, from a frame pair | In use |
| Trace | `hme trace` | Profiles a video: palette, labels, trajectories, cuts | In use |
| Control | `hme control` | The ceiling a perfect clone can reach, by re-encoding our own video | In use |
| Extract | `hme extract` | Cuts a pixel region out of a reference frame, such as the rifle | In use |
| Fonts | `hme fonts` | Ranks free fonts by glyph shape against a reference label | In use |
| Zoom velocity | `hme zoom-velocity` | Zoom speed curve per second, and flags knots where the curve bends | Done, judge confirmed |
| Contour | `hme contour` | Shape difference between two outlines, Hausdorff and Chamfer distance | Done, judge confirmed |
| Blur and grain | `hme blur-grain` | Blur and grain ratios, reference vs ours | Built, judge not yet run |
| Vignette | `hme vignette` | Corner darkness, matched mean ratio | Done, judge confirmed |
| Colour and halo | `hme colour` | Whole-frame colour histograms and halo falloff around a centre | Done, judge confirmed |
| Layering | `hme layering` | Z-order and pixel counts per layer: badge, text, halo, dot | Done, judge confirmed |
| Type | `hme type` | Typography: font match, glyph shape, spacing, weight | Judge confirmed |
| Timing | `hme timing` | Timing offset per object, median and warp table, not one global shift | Built, judge not yet done |

Two facts an agent should know before trusting a number. First, the ceiling: a perfect clone scores about 0.96 SSIM, not 1.00, because YouTube compression alone costs 0.03 to 0.07. The control tool measures that ceiling for the exact pair. Second, the timing offset is not constant: on the Seg4 map the badge is 0.46 to 1.08 seconds early depending on the second, median 0.71. A single delay leaves about 20 px of error; the warp table leaves about 2 px. The timing tool reports both.

### Authoring tools

These close the gaps the measurement tools found in the Kurzgesagt "Alcohol is AMAZING" first 5 seconds. Each one is a Handover run with its own predicate, verifier, and judge. Status is from each run's own status file, November 9, 2026.

| Tool | What it adds | Status |
| --- | --- | --- |
| Character rig | A skeleton with named parts and pivots, so eyes open, eyebrows raise, and arms lift by keyframing joints instead of hand-drawing every shape | 70%, proof render done |
| Illustration tracing | Converts reference art into vector paths with VTracer, Potrace fallback, and a pixel cutout fallback for subjects that will not trace | 20%, monster traces at SSIM 0.90, skulls pass as pixel cutout at 0.99 |
| Gradients and glow | Gradient fills, glow as a crisp shape plus halo, and soft blurred edges, for clouds, bokeh, and foam shading | 50%, proof passes within the colour bar |
| Particle system | Deterministic particles from a seed, so the same scene renders byte-identical: foam bubbles, sparkles, drifting clouds | Built, final verification pending |
| Automated fixing | Reads a measurement report and applies the correction to the scene, writing a new versioned file, never editing in place | 60%, five fixer functions done |

A note on scope: the rig proves the mechanism with simple shapes. A faithful character still needs traced shapes for hair, face shading, and clothing, which is the tracing run's job. The two runs compose; neither replaces the other.

## What it renders

These are actual frames from real renders, not mockups.

<img src="assets/brand/frame-map.png" width="49%" alt="Actual rendered map frame"> <img src="assets/brand/frame-title.png" width="49%" alt="Actual rendered title frame">

Left: map-sample, final profile, 5 seconds in. Right: scene-min, final profile, 5 seconds in.

## Quickstart

Requirements: Node 20 or newer, ffmpeg, and Chromium (installed through Playwright).

```bash
npm install
node src/renderer/cli.mjs render tests/fixtures/scene-min.json --profile draft --out out/scene-min
```

That renders a 10 second, 1920x1080, 24 fps clip. Profiles:

| Profile | Size | Supersample | Preset | CRF | Use |
| --- | --- | --- | --- | --- | --- |
| previs | 854x480 | 1 | veryfast | 28 | Fast look, iterate |
| draft | 1920x1080 | 1 | fast | 20 | Check timing and layout |
| final | 1920x1080 | 1.5 | medium | 14 | Deliver |
| final-max | 1920x1080 | 2 | slow | 14 | Best quality |

Render only part of a scene with `--frames 0:120`. Override any scene value without editing the file with repeatable `--set nodes.title.props.text="Hello"`.

## Scene format

A scene is one JSON file, schema `hme.scene/1.0`. Nodes are text, shapes, maps, or charts. A timeline moves node properties between keyframes with named easings. An example (shortened):

```json
{
  "schema": "hme.scene/1.0",
  "meta": { "id": "hello", "fps": 24, "width": 1920, "height": 1080, "duration": 240, "seed": 1337 },
  "fonts": [{ "family": "Montserrat", "weight": 700, "src": "fonts/Montserrat-Bold.ttf" }],
  "palette": { "ground": "#101820", "ink": "#f4f1ea", "accent": { "color": "#e8a33d" } },
  "nodes": [
    { "id": "title", "type": "text", "z": 2,
      "box": { "x": 160, "y": 120, "w": 1600, "h": 160 },
      "props": { "text": "Headless Motion",
        "font": { "family": "Montserrat", "weight": 700, "size": 96 },
        "color": "ink", "align": "left" } },
    { "id": "bar", "type": "shape", "z": 1,
      "box": { "x": 160, "y": 600, "w": 240, "h": 240 },
      "props": { "kind": "rect", "fill": "accent", "radius": 24 } }
  ],
  "timeline": [
    { "node": "bar", "prop": "transform.x",
      "keys": [
        { "f": 0, "v": 0 },
        { "f": 120, "v": 1200, "ease": "easeInOutCubic" },
        { "f": 240, "v": 600, "ease": "easeOutQuint" } ] }
  ]
}
```

Full format docs live in `prompts/01-scene-format.md`. The map module (`src/map/`) draws real Natural Earth geography with a fixed visual system: two registers, a five colour palette, Montserrat labels, one focus at a time. The chart and text module (`src/scene/`) covers bars, lines, and kinetic type.

## Verification

Every render can be scored against a reference, frame by frame. The checker (`src/checker/`) reports SSIM, PSNR, LPIPS, flat colour difference in CIEDE2000, and a layer layout check: element positions as ratios, distances to frame borders, zoom as a ratio curve, and gaps between elements per layer.

![Write, render, check, fix loop](assets/brand/loop.svg)

The frozen pass bar for the four test segments is:

| Segment | SSIM | PSNR | LPIPS | Flat colour |
| --- | --- | --- | --- | --- |
| Kurzgesagt 1 and 2 | 0.98 | 38 dB | 0.05 | under 3 Delta E |
| TED-Ed glue vs tape | 0.95 | 35 dB | 0.08 | under 3 Delta E |
| Search Party map | 0.96 | 35 dB | 0.08 | under 3 Delta E |

A render also has to be deterministic: two runs of the same profile give a byte identical video. The checker never scores a frame it has already seen with a lowered bar.

## Speed

Measured November 7, 2026, on a 4 core Linux VM with no GPU, 10 second clip at 1920x1080 and 24 fps:

| Profile | Time before fast render | Time after fast render |
| --- | --- | --- |
| draft | 76 to 88 s | 25 to 35 s |
| final | 140 to 243 s | 37 to 57 s |

The bottleneck is capture, not encoding: in one measured draft run, ffmpeg encoded all 240 frames in 52 seconds while Chromium screenshots took the other 640. The fast render path, built November 8, attacks exactly that: a map layer cache, frame dedup, and a real-time preview mode. Map final fell from 242.6 s to 57.0 s, a 4.3x gain, with byte-identical output across three runs. Quality held: old vs new renders score SSIM 0.99999. The full numbers live in `benchmark/results-2026-11-07.json` and the run report.

A speed log tracks every timed step across runs, so slow steps stay visible: `speed-log.md`. Each line records the run, unit, task, frames, duration, and seconds per frame. Baselines run 7 to 12 seconds per frame on a loaded VM; regression chunks run 2.6 to 3.2.

## Project structure

```
src/
  scene/      scene format, profiles, lint, chart and text, easing picker
  renderer/   headless Chromium capture, ffmpeg encode, CLI
  map/        geography, projection, map visual system
  checker/    SSIM, PSNR, LPIPS, colour, layer layout, defect taxonomy
  reference/  reference teardown: profile, traces, trajectories
  cli/        hme command surface: measurement tools, authoring tools, MCP
  rig/        character rig schema and expander
  fix/        automated fixing: timing, position, text, refuse, gate
banned.json   patterns that must never ship again, linted before rendering
speed-log.md  per-step timing log: run, unit, frames, duration, sec per frame
tests/        fixtures and unit tests (76 unit, 13 browser)
prompts/      the five prompt files an agent uses to drive the engine
benchmark/    timing runs and before/after results
verify-seg4/  the Search Party map clone: measured trace, numbers, reports
```

## Status

Research preview. What is true today:

- The engine renders, deterministically, at 1920x1080.
- The checker runs with LPIPS on every frame.
- The layer layout check is built and measured: 31 seconds for four paired stills.
- The fast render path (map layer cache, frame dedup, real-time preview) is built and measured: map final 242.6 s to 57.0 s, byte-identical across runs.
- Fourteen measurement commands are built under one `hme` CLI, each returning a verdict, numbers, a correction in scene terms, and its limits.
- Five authoring capabilities are being built to close the gaps the measurement tools found: character rig, illustration tracing, gradients and glow, particle system, and automated fixing.

## Recent benchmarks

Measured November 8, 2026, against the frozen bar (pred-v1: mean SSIM at least 0.95, every frame at least 0.90, PSNR at least 35 dB, LPIPS at most 0.08, flat colour under 3 Delta E, motion under 2 px, text shift under 2 px). "Claimed" means the generator measured it and the independent verifier and judge have not confirmed it yet. "Judge confirmed" means they recomputed it and agreed.

| Test | SSIM | PSNR | LPIPS | Verdict |
| --- | --- | --- | --- | --- |
| Seg3 baseline, old code-drawn rebuild | 0.686 | 9.96 dB | 0.656 | Fail, judge confirmed |
| Seg3 single-frame VTracer trace | 0.967 | 26.09 dB | 0.156 | Trace only, judge confirmed |
| Seg3 flow warp, 1 frame apart | 0.999 | 52.93 dB | 0.0004 | Warp only, judge confirmed |
| Ozempic clone, Gate 1, first 10 s, v8 | 0.994 | 39.80 dB | 0.015 | Claimed pass, standard profile |
| Ozempic clone, Gate 2, first 30 s, v8 | 0.993 | 37.39 dB | 0.015 | Claimed pass, standard profile |
| Ozempic clone, Gate 3, full 75 s, light check | 0.990 | 37.86 dB | Unmeasured | Light check only, LPIPS still running |
| Seg4 map clone, v5, 192 frames | 0.794 | 20.21 dB | 0.631 | Fail, measured |
| Seg4 map clone, v6, 192 frames | 0.996 | 41.13 dB | 0.025 | Pass, agent-measured, LPIPS every 8th frame |

Before and after, on the same Ozempic clone: Gate 1 went from v1 SSIM 0.903 and PSNR 17.78 dB, with 105 frames below the floor, to v8 SSIM 0.994 and PSNR 39.80 dB, with 0 frames below the floor. Gate 2 went from PSNR 33.99 dB, failing by 1.01 dB, to 37.39 dB in v8. The Seg4 map retest with the new tools passed on every bar: SSIM 0.794 to 0.996, PSNR 20.21 dB to 41.13 dB, LPIPS 0.631 to 0.025, and the badge at 5.0 s went from 170.9 px off to 0.1 px off. That clone is trace-based, not a code-drawn scene, so it proves the teardown to trace to check pipeline.

Roadmap: finish the five authoring capabilities, then the Seg4 v5 true clone, then ten new sequences with a side by side play page, then a native Skia renderer that drops the browser entirely.

## Development

Pushes go through the GitHub git database API, because the stored GitHub credential is scoped to `api.github.com` and does not work for git over HTTPS:

```bash
~/workspace/custom-connectors/custom.legacy-github/bin/gh_push.py \
  --repo richardsondx/headless-motion --branch main --message "msg" \
  $(git ls-files | awk '{print $1"="$1}')
```

## License

MIT. See `LICENSE`.
