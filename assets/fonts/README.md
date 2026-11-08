# Fonts in the engine

Files in this folder, verified 2026-11-07 by reading the TrueType name
table with fontTools (no eyeballing):

- `Montserrat-Bold.ttf` — family "Montserrat Bold", weight 700,
  sha256 `247f052d2f5b84a5bbe7831c3b08a71ca391ff54f1dfb9be88a3d3da569e3a38`
- `Anton-Regular.ttf` — family "Anton Regular", weight 400,
  sha256 `a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab`

The same two files are copied to `tests/fixtures/fonts/` so scene files
in `tests/fixtures/` can declare them with a relative `src`
(`fonts/Montserrat-Bold.ttf`). The two copies are byte-identical;
keep them in sync if either is replaced.

## Source, honestly

These files were added to the engine on 2026-11-07 during the Seg4
style-match work. No download log is recorded in this repo, so the
download source cannot be verified from the files alone. The project
instruction names Google Fonts as the source, and the name tables match
Google's Montserrat Bold and Anton, but treat "from Google Fonts" as
per instruction, not as a verified download record. If provenance
matters (licence audit, redistribution), re-download from Google
Fonts and compare sha256 values above.

## How the renderer loads them

1. A scene declares its fonts in `fonts[]` (`family`, `weight`, `src`
   relative to the scene file). The validator rejects any text node
   whose family/weight is not declared.
2. `src/renderer/compile.mjs` embeds each font as a `data:` URI in an
   `@font-face` rule. No network at render time.
3. `src/renderer/runtime.mjs` runs `document.fonts.load()` for each
   declared font before `ready` resolves, then checks
   `document.fonts.check()`. A missing font fails the render with
   `FONT_MISSING` instead of silently falling back.
4. Map labels use the Montserrat family from `src/map/tokens.json`
   ("Montserrat Bold" for geography, Anton display-only, never under
   40px, never on geography — see `src/text/lint-text.mjs`).

## What changed in v2 (2026-11-07)

The frozen benchmark fixtures (`map-sample`, `scene-min`,
`text-sample`) previously declared a stand-in, `FixtureSans` backed by
`LiberationSans-Bold.ttf`. They now declare the real faces above.
That changes their rendered pixels and video hashes, so the v1
benchmark hashes are a different baseline; see
`benchmark/results-2026-11-07-v2.json`. Segment 3 (`seg3-scene.json`)
was left on the stand-in on purpose: its characters are a hand-drawn
TED-Ed reconstruction, and neither Montserrat nor Anton is the
reference typeface there.
