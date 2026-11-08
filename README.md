<p align="center">
  <img src="assets/brand/logo.svg" width="120" alt="Headless Motion logo">
</p>

# Headless Motion

Motion graphics from JSON scenes. No timeline UI, no manual keyframes.

An agent writes a scene, the engine renders the video, and a checker scores every frame against a reference. The goal is animation on par with top YouTube animation channels, produced end to end without a human opening an editor.

## Why headless

After Effects is built for a human hand on a timeline. An agent cannot scrub, drag keyframes, or judge a frame by eye. Headless Motion turns the whole job into files an agent can write and check: a scene is JSON, a render is one command, and the verdict is numbers, not an opinion.

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

The frozen pass bar for the four test segments is:

| Segment | SSIM | PSNR | LPIPS | Flat colour |
| --- | --- | --- | --- | --- |
| Kurzgesagt 1 and 2 | 0.98 | 38 dB | 0.05 | under 3 Delta E |
| TED-Ed glue vs tape | 0.95 | 35 dB | 0.08 | under 3 Delta E |
| Search Party map | 0.96 | 35 dB | 0.08 | under 3 Delta E |

A render also has to be deterministic: two runs of the same profile give a byte identical video. The checker never scores a frame it has already seen with a lowered bar.

## Speed

Measured November 7, 2026, on a 4 core Linux VM with no GPU, 10 second clip at 1920x1080 and 24 fps:

| Profile | Time |
| --- | --- |
| draft | 76 to 88 s |
| final | 140 to 243 s |

The bottleneck is capture, not encoding: in one measured draft run, ffmpeg encoded all 240 frames in 52 seconds while Chromium screenshots took the other 640. The fast render path now being built attacks exactly that: a layer cache that draws each still layer once and moves it per frame, plus a real-time preview mode that records the scene as it plays.

## Project structure

```
src/
  scene/      scene format, profiles, lint, chart and text
  renderer/   headless Chromium capture, ffmpeg encode, CLI
  map/        geography, projection, map visual system
  checker/    SSIM, PSNR, LPIPS, colour, layer layout
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
- The Seg3 and Seg4 clones do not pass yet. Seg4 v4 scores SSIM 0.69 against a 0.96 bar, with the coral flood as the biggest gap. The fix order is written in `verify-seg4/evidence/layout-check-report.md`.
- The fast render path (layer cache plus real-time preview) is in progress.

Roadmap: fast render path, then the Seg4 v5 true clone, then ten new sequences with a side by side play page, then a native Skia renderer that drops the browser entirely.

## Development

Pushes go through the GitHub git database API, because the stored GitHub credential is scoped to `api.github.com` and does not work for git over HTTPS:

```bash
~/workspace/custom-connectors/custom.legacy-github/bin/gh_push.py \
  --repo richardsondx/headless-motion --branch main --message "msg" \
  $(git ls-files | awk '{print $1"="$1}')
```

## License

MIT. See `LICENSE`.
