# Compact authoring

A full scene file is 150-260 lines. Most edits are one label or one
number. Compact authoring keeps the full scene as the base and records
only the change.

## Two forms, same mechanism

### 1. `--set` flags on the CLI (one-line edit, no file)

```bash
node src/renderer/cli.mjs render tests/fixtures/text-sample.json \
  --profile draft --out out/text-edit \
  --set 'nodes.title.props.text="VIEWS"' \
  --set nodes.views.props.to=25000
```

Paths: `nodes.<id>.<dot.path>` into that node, `palette.<key>`,
`meta.<key>`. Values are JSON-parsed when possible, else plain
strings. The patched scene is written to `.tmp/patched-<sha>.json`
and that file is what gets rendered, so `render-report.json`'s
`scene_sha256` covers the overrides. The overrides are also listed in
`render-report.json` (`overrides`) and in `render-report.md`.

### 2. Compact scene file (one-line edit, checked in)

```json
{
  "base": "text-sample.json",
  "set": {
    "nodes.title.props.text": "VIEWS",
    "nodes.views.props.to": 25000
  }
}
```

`base` is relative to the compact file. Render it like any scene:

```bash
node src/renderer/cli.mjs render tests/fixtures/text-sample.compact.json \
  --profile draft --out out/text-compact
```

Example: `tests/fixtures/text-sample.compact.json`.

## Wall time

`render-report.json` records `elapsed_s: 0` by design — a wall clock
in the JSON would break byte-identical reports across runs. Real wall
time is recorded in `render-report.md` next to it (profile, scene,
status, `wall_s`, video sha, overrides), measured by the CLI harness
with `Date.now`. Never read speed from `render-report.json`.

## Measured-reference path (quality)

Do not hand-draw a reference you have not measured. The route is:

1. Get reference frames (browser capture; YouTube download is blocked
   in this environment — see the Seg4 reports).
2. Measure them with `verify-seg4/measure-palette.py` (21x21 median
   samples; every hex comes from pixels, never eyeballed). That script
   lives with the Seg4 style-match work; read it, do not edit it.
3. Put the measured hexes, line weights, and grain values into the
   scene's palette/tokens, with a note naming the reference frame and
   sample coordinates.
4. Run the checker against the reference. A scene built from measured
   values is a reconstruction; a scene built from guessed values is a
   drawing. Only the first can pass pred-v1 on a real segment.

If no measured reference exists for a segment, record that as a gap.
Do not invent palette or geometry values to fill it.
