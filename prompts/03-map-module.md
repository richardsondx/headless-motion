# 03 Map module (MapLibre + D3 + GeoJSON)

## Purpose
Write the `map` node: real geometry, Harris tokens, a drone-style camera, route draws, country floods, one focus at a time. Write the two gates that judge it, G8 (contrast) and G9 (focus and camera).
Design source: `sources/harris-map-motion-skill.md`. Read it fully first. Its numbers are law. Where this prompt and the skill disagree, the skill wins and you report the difference.

## Inputs
- Scene format and renderer from prompts 01 and 02. Map frames render through the renderer's `waiters` hook.
- Natural Earth 10m admin-0 countries GeoJSON at `assets/natural-earth/ne_10m_admin_0_countries.geojson`. Local file. If it is missing, stop with `NE_MISSING`. Do not download.
- Fonts: Montserrat Bold file at `assets/fonts/`. Missing means `FONT_MISSING`.
- 24 fps assumed. All times below are in seconds and are turned into frames with `Math.ceil(s * fps)`. At 24 fps: 0.2 s = 5 frames, 1.2 s = 29 frames.
- Pixel tokens in the skill are authored on a 1280x720 grid. Multiply by `tokenScale` = width / 1280 = 1.5 at 1920x1080. This is an assumption. Keep `tokenScale` in `tokens.json`.

## Outputs
- `src/map/tokens.json`: every token in the skill, each with a `source` note.
  - Light register: navy #14213D, paper #F4F1EA, signal red #E63946, tan land #C6AD7A.
  - Floods: coral #E4572E, dusty blue #4E7FA6, mustard #D9A441 (deepen to #B07C1F on light grounds if G8 needs it), mauve #9B6B9E, sage #7FA05A.
  - Dark register: land near #205044, water near #1B2121. These are a neighbourhood, not exact. Segment values are measured from reference frames and go in the scene `palette` with their frame number.
  - Lines: base 1 to 1.5 px; subject border 4 to 5 px with glow; route 3.5 px tapered 100% to 40%, traveling dot at the draw head; casing 1.5 px dark ink.
  - Focus: `desaturate` 0.25, `valueDrop` 0.12, `stagger` 0.2 s, `ramp` 6 frames.
  - Camera: `arriveBefore` 0.2 s, `hold` 1.2 s, `focalArea` 0.6 x 0.6 of the frame, centred (assumed, edit here, never in the gates).
  - Type: Montserrat Bold, caps, +6% letterspacing, 30 to 38 px on the 1280 grid.
  - `edgeBlurPx`: null until measured from a reference frame. Dark register only.
- `src/map/map.schema.json`: `props` for a map node. Fields: `register`, `geometry {countries, include (ISO_A3 list)}`, `camera [{event, center, zoom, bearing, pitch, travel (s), ease}]`, `focus [{event, subject, flood}]`, `routes [{id, coords, start, draw (s), ease}]`, `labels [{id, target (ISO_A3 or [lng,lat]), text, at, mode (pill|curved|leader)}]`, `badges`.
- `src/map/compile.mjs`: map props to a frame state. Pure function of frame.
- `src/map/runtime.mjs`: in-page. MapLibre draws land, borders and floods from local GeoJSON in a style with no tile sources. Call `map.jumpTo` for each frame, never `easeTo`. D3 (`d3-geo`) does path, centroid and `geoInterpolate` math. An SVG overlay draws routes, dots and labels.
- `src/map/project.mjs`: `projectToScreen(frameState, [lng,lat])`, used by prompt 04 for labels.
- `src/shared/color.mjs`: sRGB to linear, relative luminance, contrast ratio, HSV, Lab, CIEDE2000.
- `src/map/g8.mjs`, `src/map/g9.mjs`, `src/map/cli.mjs` (`check <scene.json>`).
- `tests/fixtures/map-sample.json`: a synthetic fixture, not segment 4 content. Abu Dhabi [54.37, 24.45] to El Fasher [25.35, 13.63], 240 frames.
- `tests/map/*.test.mjs`

## Behaviour
Camera law:
- Every move is travel, land, hold. One continuous easing curve per move. Default `easeInOutCubic`.
- The camera lands at `event.f - ceil(0.2 * fps)`. Never later.
- Hold at least `ceil(1.2 * fps)` frames after the last label of that event lands. Zero camera motion during hold.
- During a route draw the camera centre follows the draw head for exactly the draw's duration, with the same ease.
- If there is no room for travel, error `CAMERA_NO_ROOM`. Do not shorten the hold or the lead.
- Nothing moves the camera outside a declared travel. No drift.

Focus:
- Event order: base, then flood or stroke, then badge, then label. Gap 0.2 s (5 frames).
- On an event all non-subject land changes: saturation x 0.75, value x 0.88 (HSV), ramp 6 frames `easeOutCubic`.
- Exactly one focus per frame. Overlapping `focus` windows are `FOCUS_OVERLAP`.
- Grain, hillshade and edge blur stay constant through events.
- Flood pairs differ in luminance by at least 0.08. Colour never carries meaning alone: pair a flood with a label or badge.

Labels:
- Montserrat Bold only. Labels sit on a navy #14213D pill, never naked on land. A label belongs to the map: placed inside or along its polygon and projected through the camera each frame. Dashed leader from the geo point to the pill when the territory is too small.
- Anton never appears on a map label.

## Check
1. `node --test tests/map/` exits 0. It includes these ratios: red #E63946 on tan #C6AD7A is 1.92 (within 0.02), red on paper #F4F1EA is 3.7 (within 0.1).
2. `node src/map/cli.mjs check tests/fixtures/map-sample.json` exits 0 and writes `out/map-sample/g8-g9-report.json` with `"g8":"pass"` and `"g9":"pass"`. Sampled frames: each event frame, each camera landing frame, the end of each hold, and every 12th frame during a draw.
3. G8 per sampled frame: (a) each text against the fill of its own pill, at least 7:1; (b) the emphasis line against every land value it crosses, at least 3:1, and when raw contrast is under 3:1 a 1.5 px casing must exist and the line against the casing is at least 3:1; (c) flood pairs differ in luminance by at least 0.08. Land values come from resolved fills at that frame, after dimming.
4. G9 per sampled frame: (a) the subject's projected centroid is inside `focalArea` during every hold; (b) exactly one undimmed focus during any event window; (c) the camera lands at least `ceil(0.2 * fps)` before each event and holds still at least `ceil(1.2 * fps)` after the last label, with zero camera speed outside travel windows; (d) the draw head is inside `focalArea` at every sampled frame of a draw.
5. Negative fixtures in `tests/fixtures/map-bad/` each exit 1 with the right code: `CAMERA_LATE`, `HOLD_SHORT`, `CAMERA_DRIFT`, `FOCUS_OVERLAP`, `G8_TEXT`, `G8_LINE_NO_CASING`, `G9_HEAD_OUT`, `NAKED_LABEL`.
6. Render the sample at `draft` through prompt 02, twice. Per-frame SHA-256 values match.
7. Dim test: a non-subject fill of #C6AD7A during an event equals HSV s x 0.75, v x 0.88 within one 8-bit step.

## Constraints
- If a measured reference colour breaks G8, do not pick a side. Report `CONFLICT_REF_G8` with both numbers and stop for a decision.
- Tokens change in `tokens.json`. The gates never change.
- Geometry is real. No hand-drawn outlines. Registration must use one projection for plate, routes, dots and labels.
- No WebGL means stop with `MAP_WEBGL`. Do not swap in another drawing method silently.
- Keep each file under 300 lines.

## Forbidden
- No Mapbox, no tile servers, no network, no CARTO or OSM raster tiles.
- No screen-space sticker labels. No naked text on terrain.
- No camera drift, no overshoot on camera or floods, no more than one focus.
- No palette beyond 2 base values, 3 flat floods and 1 accent on screen at once.
- Do not edit the skill file or the Stage 1 numbers.
