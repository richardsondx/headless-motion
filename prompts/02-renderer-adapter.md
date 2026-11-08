# 02 Renderer adapter (HyperFrames)

## Purpose
Turn a validated scene (prompt 01) into an MP4. Base is HyperFrames (HeyGen, Apache 2.0): HTML, CSS and GSAP in headless Chrome, encoded with FFmpeg. Write only the adapter. The renderer is solved, so do not write a new one.
Same scene and same profile must give the same bytes.

## Inputs
- A scene file that passes `node src/scene/validate.mjs`. Profiles from `src/scene/profiles.json` (previs 480p, draft 1080p, final 1080p with 2x supersample).
- Test target: 1920x1080 at 24 fps, 240 frames (10 s). fps comes from `meta.fps`.
- Local only: fonts, images and GeoJSON are files. GSAP is read from `node_modules` and inlined into the page. No network at render time.
- Stack: Node 20 or newer, ESM. Allowed packages: HyperFrames (find the exact npm name in its repository README), `gsap`, `playwright-core`. FFmpeg and ffprobe come from the system.
- Before coding, read the HyperFrames README and examples. Where its way of composing a page differs from this prompt, follow HyperFrames and list each difference in a header comment of `compile.mjs` (5 lines at most). If it cannot be installed or used, stop and report `ADAPTER_BLOCKED`. Do not write a replacement renderer.

## Outputs
- `src/renderer/compile.mjs`: scene to `page.html` (nodes as DOM, fonts as `@font-face` from local files, GSAP inlined).
- `src/renderer/runtime.mjs`: runs in the page. Exposes `window.__hme = {ready, frameCount, seek(f), waiters: []}`.
- `src/renderer/render.mjs`: launch Chrome, seek loop, capture, encode, probe.
- `src/renderer/report.mjs`: writes the report (see Report).
- `src/renderer/cli.mjs`: `node src/renderer/cli.mjs render <scene.json> --profile previs|draft|final --out out/<name> [--frames a:b] [--keep-frames] [--verify-determinism]`
- `tests/renderer/*.test.mjs`
- Per render, under `out/<name>/<profile>/`: `video.mp4`, `frame-hashes.json` (SHA-256 per frame), `page.html`, `render-report.json`, and `frames/%06d.png` only with `--keep-frames`.

## Method
1. Validate the scene. On failure stop with `SCENE_INVALID` and the validator's errors.
2. Compile to `page.html`. Viewport 1920x1080. Device scale factor 1 (previs, draft) or 2 (final).
3. Launch headless Chromium with `--disable-gpu --font-render-hinting=none --force-color-profile=srgb --disable-lcd-text --hide-scrollbars`. Use `file://` or `setContent`. Record the Chrome version. Block every request that is not `file:` or `data:`. A blocked request is a failure (`NETWORK_BLOCKED`), not a warning.
4. Wait for `window.__hme.ready`. It resolves after `document.fonts.ready` and after every font in the scene passes `document.fonts.check`. A missing font is `FONT_MISSING`. Never fall back to another font.
5. GSAP is only the seekable clock. One master timeline, `paused: true`, duration `duration/fps`, ease none, `gsap.ticker.lagSmoothing(0)`. No GSAP tween carries scene easing. Scene easing and values come from the evaluator in `src/scene/evaluate.mjs`, bundled into the page.
6. `seek(f)`: `tl.pause(); tl.time(f / fps, false);` assert `Math.abs(tl.time() * fps - f) < 1e-6` (else `SEEK_MISMATCH`); call `apply(sampleScene(scene, f))`; await every function in `waiters` (modules such as the map register one); then await two `requestAnimationFrame` callbacks.
7. Capture: PNG screenshot of the 1920x1080 clip, with Playwright `animations: "disabled"`. Per-frame timeout 30 s (`CAPTURE_TIMEOUT`). Compute the SHA-256 of each PNG buffer.
8. Encode by piping PNGs to FFmpeg (`-f image2pipe -c:v png`). Settings:
   - Filter: `scale=<w>:<h>:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`
   - Codec: `-c:v libx264 -profile:v high -preset <profile> -crf <profile> -r <fps> -g 48 -threads 1`
   - Reproducibility: `-fflags +bitexact -flags:v +bitexact -map_metadata -1 -an`
   - Colour tags: `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`
   - Container: `-movflags +faststart`
9. Probe with ffprobe. Expect width, height, `r_frame_rate` `<fps>/1`, `nb_frames` equal to `duration`, `pix_fmt yuv420p`, `color_space bt709`. Any difference is `PROBE_MISMATCH`.
10. `--verify-determinism` renders twice into two folders. Compare `frame-hashes.json` and the SHA-256 of `video.mp4`. Any difference exits 6 and names the first frame that differs.

## Report
`render-report.json` is written on success and on failure. Fields: `status` (`ok|failed`), `stage` (`validate|compile|launch|ready|seek|capture|encode|probe`), `code`, `frame` (number or null), `message`, `profile`, `scene_sha256`, `versions` (node, chrome, ffmpeg, gsap, hyperframes), `console_errors`, `blocked_requests`, `ffmpeg_stderr_tail` (last 40 lines), `ffmpeg_command`, `frames_captured`, `elapsed_s`.
On failure also write `failure/last-good-frame.png`, `failure/dom.html` and `failure/console.log`. Delete the partial `video.mp4`.
Codes: `SCENE_INVALID FONT_MISSING ASSET_MISSING BROWSER_LAUNCH PAGE_ERROR NETWORK_BLOCKED SEEK_MISMATCH CAPTURE_TIMEOUT MODULE_WAIT_TIMEOUT ENCODE_FAIL PROBE_MISMATCH NONDETERMINISTIC`.
Exit codes: 0 ok, 2 scene/font/asset, 3 browser, 4 seek/capture/module, 5 encode/probe, 6 nondeterminism.
No automatic retry. Failures stop the run and name the stage, the code and the frame.

## Check
1. `node --test tests/renderer/` exits 0.
2. `node src/renderer/cli.mjs render tests/fixtures/scene-min.json --profile final --out out/min` exits 0. Then ffprobe reports 1920x1080, 24/1, 240 frames, yuv420p, bt709.
3. Same command with `--profile previs` gives 854x480, 240 frames.
4. `--verify-determinism` on the `draft` profile exits 0. On `final` it exits 0 once before this prompt is called done.
5. Page equals evaluator: in the test, for frames 0, 1, 119, 239 compare the DOM state after `seek(f)` with `sampleScene(scene, f)`. They match, numbers within 1e-6.
6. Seek order test: capture frames 200, 5, 120 in that order, then 5, 120, 200. SHA-256 of each frame is identical in both runs.
7. Failure tests, each exits with the stated code and writes a report with the right `code` and `stage`: font file missing (2), scene referencing an `https://` image (4, `NETWORK_BLOCKED`), a module waiter that never resolves (4, `MODULE_WAIT_TIMEOUT`), a bad CRF flag (5), `CHROME_PATH` set to a missing file (3).

## Constraints
- Layout coordinates are identical across profiles. Previs scales the finished frame only.
- The adapter reads the scene and never edits it.
- FFmpeg arguments are an array, never a shell string.
- Keep each file under 300 lines.

## Forbidden
- Do not write a new renderer, compositor or timeline engine. Do not use Remotion in this prompt.
- Do not use CSS animation, transitions, WAAPI, `<video>`, `Date`, `Math.random` or timers in page code.
- Do not retry silently. Do not fall back to another font, browser, codec or resolution. Do not report ok when the probe disagrees.
- Do not push, upload or call any outside service.
