# 01 Scene format

## Purpose
Write the JSON scene format and the code that validates and evaluates it. An agent writes a scene as JSON. The renderer (prompt 02), map module (03) and chart/text module (04) read it. The frame checker (05) compares the render to a reference.
Core rule: the picture at frame N is a pure function of the scene and N. Nothing else.

## Inputs
- Stage 1 facts: canvas 1920x1080, 24 fps. 24 fps is assumed until measured, so fps is a scene field and never a constant in code.
- Stack: Node 20 or newer, ESM (`.mjs`), JSDoc types, tests with `node:test`. No bundler, no TypeScript build step.
- Companion schemas owned by other prompts: `src/map/map.schema.json` (03) and `src/chart/chart.schema.json` (04). If a companion file does not exist yet, treat that node's `props` as opaque and print the warning `UNCHECKED_PROPS`.

## Outputs
- `src/scene/scene.schema.json` (JSON Schema 2020-12, `additionalProperties: false` everywhere except `meta.notes`)
- `src/scene/easing.mjs` (named curves, bezier solver)
- `src/scene/evaluate.mjs` (`sampleScene(scene, frame)`)
- `src/scene/validate.mjs` (library and CLI)
- `src/scene/random.mjs` (`rand(seed, ...keys)`)
- `src/scene/profiles.json` (previs, draft, final)
- `src/scene/lint-determinism.mjs`
- `tests/fixtures/scene-min.json` (1 text, 1 shape, 3 keyframes, 240 frames) and `tests/fixtures/bad/*.json` (one file per error code below)
- `tests/scene/*.test.mjs`

## Format
Top level: `schema` (exactly `"hme.scene/1.0"`), `meta`, `fonts`, `palette`, `nodes`, `timeline`, `events`.
- `meta`: `id`, `fps` (integer, default 24), `width` 1920, `height` 1080, `duration` (frames, integer), `seed` (integer), `register` (`light` or `dark`), `notes` (free text).
- `fonts`: `[{family, weight, src}]`. `src` is a local file path. No URLs.
- `palette`: name to `#rrggbb`. Nodes use palette names or `#rrggbb`. A measured reference colour goes here with `source` (reference frame number).
- `nodes`: `id` (unique), `type` (`text|shape|image|map|chart`), `parent` (id or null), `z` (integer), `box` `{x,y,w,h}` in canvas px, `transform` `{x,y,scale,rotation,opacity}`, `visible` `{in,out}` frames, `props` (per type).
  - text: `text`, `font {family,weight,size,letterSpacing,lineHeight}`, `color`, `align`, `maxWidth`, `ground` (id of a pill or bar node).
  - shape: `kind` (`rect|ellipse|polygon|path|line`), `fill`, `stroke {color,width,casing}`, `radius`, `d`.
  - image: `src` (local file), `fit` (`cover|contain|none`).
  - map and chart: `props` validated by the companion schema.
- `timeline`: `[{node, prop, keys:[{f, v, ease}]}]`. `prop` is a dotted path such as `transform.x` or `props.fill`.
- `events`: `[{id, f, note}]`. Named moments. Map camera and focus (03) key off these.

Keyframe rules:
- `f` is an integer frame. Keys strictly increase and sit in `[0, duration]`.
- `ease` on key k shapes the segment from key k-1 to key k. The first key has no `ease`.
- Number, point (array of numbers) and colour values interpolate. Strings and booleans step.
- Colours interpolate in sRGB. Results round to integers per channel.
- Before the first key the value is the first key's value. After the last key it is the last key's value.

## Easing curves
A name, or `{"bezier":[x1,y1,x2,y2]}` with x1 and x2 in [0,1]. Standard cubic-bezier values:
- `linear` (0,0,1,1) | `hold` (value steps to the key at its frame)
- `easeInSine` (0.12,0,0.39,0) | `easeOutSine` (0.61,1,0.88,1) | `easeInOutSine` (0.37,0,0.63,1)
- `easeInQuad` (0.11,0,0.5,0) | `easeOutQuad` (0.5,1,0.89,1) | `easeInOutQuad` (0.45,0,0.55,1)
- `easeInCubic` (0.32,0,0.67,0) | `easeOutCubic` (0.33,1,0.68,1) | `easeInOutCubic` (0.65,0,0.35,1)
- `easeInQuart` (0.5,0,0.75,0) | `easeOutQuart` (0.25,1,0.5,1) | `easeInOutQuart` (0.76,0,0.24,1)
- `easeInQuint` (0.64,0,0.78,0) | `easeOutQuint` (0.22,1,0.36,1) | `easeInOutQuint` (0.83,0,0.17,1)
- `easeOutBack` (0.34,1.56,0.64,1) | `easeInOutBack` (0.68,-0.6,0.32,1.6): stamps and verdict moments only.
Solver: Newton with at most 8 steps, then bisection with at most 40 steps, tolerance 1e-7. Fixed counts, no time-based exits.

## Determinism rules
- `sampleScene(scene, frame)` returns plain JSON: `{nodeId: {prop: value}}`. It reads only its two arguments.
- Banned in `src/`: `Date`, `performance.now`, `Math.random`, `crypto.randomUUID`, `Intl`, `toLocaleString`, `requestAnimationFrame` used as a clock, `setTimeout` or `setInterval` inside evaluators, CSS `animation` and `transition`, WAAPI, `<video>`.
- Randomness: `rand(seed, ...keys)` returns a number in [0,1) from a hash of the keys (for example `rand(meta.seed, nodeId, "particle", 17)`). It never draws from a running sequence, so frame order cannot change a value.
- Every number written to the DOM goes through `fmt(n)` = `Number(n.toFixed(3))`.
- Profiles (`profiles.json`). Layout is always computed at 1920x1080. A profile changes only supersample factor, output scale and encode settings:
  - `previs`: output 854x480, supersample 1, CRF 28, preset veryfast.
  - `draft`: output 1920x1080, supersample 1, CRF 20, preset fast.
  - `final`: output 1920x1080, supersample 2 then Lanczos down, CRF 14, preset slow.

## Check
Run each command. All must give the stated result.
1. `node --test tests/scene/` exits 0.
2. `node src/scene/validate.mjs tests/fixtures/scene-min.json` prints `OK scene-min 240 frames 24 fps` and exits 0.
3. Each file in `tests/fixtures/bad/` exits 1 and prints its code on line 1. Codes: `SCHEMA_VERSION`, `DUP_ID`, `BAD_PARENT`, `PARENT_CYCLE`, `UNKNOWN_EASE`, `KEY_ORDER`, `KEY_RANGE`, `UNKNOWN_FONT`, `PROP_TYPE`, `UNKNOWN_FIELD`. Each error also prints a JSON pointer path.
4. Order test: sample all 240 frames forward, reversed, and in a seeded shuffle. The SHA-256 of each frame's JSON is identical in all three orders.
5. Easing test: every curve returns 0 at 0 and 1 at 1 (within 1e-6). Non-overshoot curves are monotonic over 1000 samples. `easeInOutCubic(0.5)` equals 0.5 within 1e-6. A custom bezier equal to a named curve gives the same values.
6. `node src/scene/lint-determinism.mjs src` exits 0. Run on a fixture that uses `Math.random` it exits 1 and prints `file:line`.

## Constraints
- Frames are integers. Seconds appear only in docs and helper functions: `framesFromSeconds(s, fps) = Math.ceil(s * fps)`.
- Unknown fields are errors, not warnings. Unknown major version is an error.
- Error shape: `{code, path, message}`. One line each. Stop after 20 errors.
- Keep each file under 300 lines. Names say what the thing is.

## Forbidden
- Do not write the renderer, map, chart or checker. Do not read the network.
- Do not store derived state between frames. No caches keyed by time.
- Do not add fields the format list does not name. If a field is missing, name the gap in your final message.
- Do not weaken a rule to make a test pass. Fix the code.
