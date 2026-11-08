# 04 Chart and text module

## Purpose
Write the `text` behaviours (kinetic type, pills) and the `chart` node (count-ups, bar races, bars). Write the lint that enforces the type and contrast rules. Everything is a pure function of the frame number.

## Inputs
- Scene format (01), renderer (02), map module (03). Use `src/shared/color.mjs` and `src/map/project.mjs` from 03. Do not rewrite them.
- Fonts are local files under `assets/fonts/`. Montserrat Bold (geography) and Anton (display only). Scenes for other videos may register other fonts. The rule below applies to every font in the scene.
- Type tokens from the Harris skill: country labels 30 to 38 px on a 1280x720 grid, so 45 to 57 px at 1920x1080, caps, +6% letterspacing.
- Floors: text against its ground at least 7:1. Line against land at least 3:1 (map only, owned by 03).
- Palette comes from the scene `palette`. Colours measured from a reference video are entered there with their frame number.

## Outputs
- `src/text/kinetic.mjs`, `src/text/pill.mjs`, `src/text/text.schema.json`
- `src/chart/countup.mjs`, `src/chart/barrace.mjs`, `src/chart/bar.mjs`, `src/chart/chart.schema.json`
- `src/text/lint-text.mjs` (`node src/text/lint-text.mjs <scene.json>`)
- `tests/fixtures/text-sample.json`, `tests/fixtures/text-bad/*.json`
- `tests/text/*.test.mjs`, `tests/chart/*.test.mjs`
- Thumbnail stills for the human gate: `out/text-sample/thumb25/*.png` (25% scale, 480x270)

## Behaviour
Kinetic type (`props.kinetic`):
- `split`: `char | word | line`. `stagger`: integer frames. `from`: `{y, opacity, scale}`. `duration`: frames. `ease`: a named curve.
- Unit i starts at `start + i * stagger`. Animation changes only transform and opacity. Layout is measured once after fonts load, so text never reflows during motion.
- `easeOutBack` is allowed only in `stamp` mode, which is for verdict and number-slam moments.
- Fonts: `font-kerning: normal; text-rendering: geometricPrecision`. A missing font is `FONT_MISSING`. No fallback font.

Count-up (`kind: "countup"`):
- Props: `from`, `to`, `start`, `duration` (frames), `ease`, `format {decimals, thousands, prefix, suffix}`.
- Value is `from + (to - from) * ease(p)`. Round with integer scaling: `Math.round(v * 10^d) / 10^d`. Format with string code. No `Intl`, no `toLocaleString`.
- At the last frame the value equals `to` exactly. Tabular figures on. If the font has none, each digit sits in a fixed-width slot.

Bar race (`kind: "barrace"`):
- Props: `series`, `rows [{f, values}]`, `slide` (frames, default 12), `colors`.
- Ranks are resolved at the keyframe rows only, tie-break by name (A to Z). Between rows each bar slides from its old slot to its new slot with `easeInOutCubic`. Never sort per frame.
- Bar length is interpolated between rows with the row's ease. Value labels use the count-up formatter.

Text grounds:
- Text sits on a pill or bar, or on a flat background node. Never on terrain, an image or a gradient.
- Default label: white #FFFFFF on navy #14213D (8 px vertical, 4 px horizontal padding on the 1280 grid, 6 px gap). Text goes straight on a bar fill only if it measures at least 7:1.
- A text node whose `parent` is a map node needs `anchor.geo` and is projected through the camera each frame. `anchor.screen` there is `SCREEN_LABEL_ON_MAP`.
- Anton: display only (stamps, number slams). Size 40 px or more. Never on geography.

Thumbnail rule (assumption, edit in `src/text/text-tokens.json`): every text node is at least 36 px tall at 1080p, which is 9 px at 25%. A node may carry `thumbnailExempt` with a reason when a reference video uses smaller type. The lint lists every exemption in its output.

## Check
1. `node --test tests/text tests/chart` exits 0.
2. Count-up: monotonic for non-overshoot easing, exact `to` at the last frame, identical output when frames run in reverse or shuffled order.
3. Bar race: for two rows with a rank swap, no bar's slot changes between slide end and the next row. Ties resolve A to Z. Per-frame positions equal the slot interpolation within 1e-6.
4. `node src/text/lint-text.mjs tests/fixtures/text-sample.json` exits 0.
5. Each file in `tests/fixtures/text-bad/` exits 1 with its code: `ANTON_SMALL`, `ANTON_GEOGRAPHY`, `NAKED_TEXT`, `CONTRAST` (prints the measured ratio), `FONT_MISSING`, `SCREEN_LABEL_ON_MAP`, `THUMB_SMALL`, `OVERSHOOT_OUTSIDE_STAMP`.
6. Render the sample at `draft` through prompt 02. Downscale each still with `ffmpeg -vf scale=480:270:flags=area`. Write the stills to `out/text-sample/thumb25/`. A test measures each text node's box on the 25% still: height at least 9 px unless exempt.
7. Two renders of the sample have identical per-frame SHA-256 values.
8. Label placement: a geo-anchored label's screen position at three camera positions equals `projectToScreen` within 0.5 px.

## Constraints
- All text node boxes come from one measurement pass. The evaluator never measures.
- Ground colour and text colour come from the resolved frame state, so contrast is computed on what is drawn.
- Ratios use the WCAG formula in `src/shared/color.mjs`. Do not add a second formula.
- Keep each file under 300 lines.

## Forbidden
- No naked text on terrain, images or gradients. No text with only a shadow for contrast.
- No Anton under 40 px. No Anton for geography. No Montserrat swapped for a similar font.
- No `Intl`, `toLocaleString`, `Date`, `Math.random`, CSS animation or timers.
- No per-frame sorting or per-frame layout measurement.
- Do not lower 7:1 or the 36 px floor to pass. Change the fill or the size.
- No slogans or filler in sample text. Samples use real numbers and real place names.
