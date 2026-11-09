# Tool-side measurement, MCP, and agent insight

Design, Nov 8, 2026. Richardson's direction: measurements belong in the
tool as CLI commands, the tool needs proper MCP, and the tool should hand
the agent insight it can act on, not raw numbers it has to interpret.
Intelligence stays with the agent. Smarter models should get better
results from the same tool.

## Audit: what is tool-side today, what is agent-side

No `bin` in package.json. Nothing is installed as a command. The agent
runs paths by hand. There is no MCP server, no MCP dependency, no tool
definition anywhere in the repo. A new model has to read the repo and
reinvent the measurement before it can do any work.

Tool-side already (real code in src/):

- `src/renderer/cli.mjs`: render a scene to video (draft, final, preview-rt).
- `src/checker/cli.py` (`python -m checker run`): stages S0 to S8, verdict,
  blind gate. Needs a segment config and a 10 s, 240-frame reference. It
  has never run end to end on a real comparison.
- `src/checker/layout.py` + `run-layout-check.py`: layout gaps vs a trace.
- `src/checker/overlay.py` + `run-overlay-check.py`: overlay, diff, and a
  corrections list in plain words. This is the closest thing to the
  insight format below, and it works.
- `run-player-pass.py`: screenshots of our video through the player path.
- `src/map/cli.mjs`: map gates G8 and G9.
- `src/scene/validate.mjs`, `src/scene/lint-determinism.mjs`: scene checks.
- `src/reference/teardown.py`: a real 5-pass teardown (energy and cuts,
  palette and geometry, warp interval, VTracer traces, per-colour
  trajectories). But it is hardcoded to one file
  (`REF = .../ozempic-full-1080p60.mp4`) and to 60 fps. It is a one-off
  script, not a command an agent can call on any video.

Agent-side (hand-rolled scripts in verify-seg4/evidence/work/, written
during the Seg4 work because no tool command existed):

- `measure-v5.py`, `measure-full192.py`, `map-only-means.py`: the
  frame-by-frame compare (SSIM, PSNR, LPIPS, Delta E). The 192-frame
  verdict came from these, not from the checker CLI.
- `extract-rifle.py`: pixel extraction by colour distance.
- `control-shots.py`, `measure-control.py`, `yt21-shots.py`,
  `recalibrate.py`: the control experiment (screenshot ceiling).
- The Seg4 trace itself (`seg4-trace.json`): measured by hand from
  screenshots and by eye. Hours of work.
- Badge trajectory and cut detection: measured ad hoc on Nov 8 with
  `layout.rgb_mask` in a one-off command. The cut is frame 186 (7.75 s).
  The real badge at 5.0 s is (966, 594); the trace said (799, 666),
  which is the real position at 5.75 s. That finding is exactly what a
  tool command should have produced.
- Font identification: manual browser work, no tool at all. The design
  exists (study 2026-11-08-whatthefont-reverse-engineering.md), the
  tool does not.

## The `hme` command

One binary, installed via package.json `bin`. Every command takes paths
as arguments, writes one JSON report, and exits non-zero on FAIL.
Nothing is hardcoded to a video, a segment, or a frame count.

Render and author (mostly packaging what exists):

- `hme render <scene> --profile draft|final|preview-rt --out`
- `hme validate <scene>`
- `hme gates <scene>`

Measure (the shift: promote the ad-hoc scripts to commands):

- `hme compare <ref.mp4> <ours.mp4> --out`
  Frame-by-frame SSIM, PSNR, LPIPS, Delta E. Finds the cut itself
  (where the reference stops being the thing being cloned) and reports
  map-only means separately from the full span. Per-second means, floor
  counts, worst frames, verdict vs the frozen bar. Replaces
  measure-full192.py and map-only-means.py.
- `hme trace <video> --start-s --end-s --out`
  Generalize teardown.py: any video, any fps. Energy and cuts, palette
  and geometry, per-colour trajectories (the badge path), camera and
  zoom curve (subject width per frame, the zoom-velocity dimension the
  audit flagged as unmeasured), label positions over time, event
  timings. Writes reference-profile.json. This is the most valuable
  command and the hardest to build: it replaces hours of manual tracing.
- `hme diagnose <ref-frame> <ours-frame> --scene <scene>`
  The overlay and layout corrections as structured JSON in scene terms.
  Promotes overlay.py. Stable schema, so the agent can apply the
  corrections without re-reading the code.
- `hme control <video> [--crf]`
  The control experiment as a command: screenshot the video through the
  player path, measure clean vs screenshotted, report the ceiling.
  Replaces control-shots.py and measure-control.py.
- `hme extract <frame> --colour <hex> --out`
  Pixel extraction by colour distance plus largest component. Replaces
  extract-rifle.py.
- `hme fonts <frame> --text "EL FASHER"`
  Font identification by template matching over Google Fonts, per the
  study design. New build.
- `hme player-pass <video> --seconds ...`
  Promotes run-player-pass.py under `hme`.

## MCP server

- `hme mcp` speaks MCP over stdio, the standard transport. One tool per
  command above, each with a JSON schema for its arguments.
- Resources the agent can read without touching the repo:
  `hme://predicate` (the frozen bar), `hme://ceiling` (the control
  ceiling), `hme://rules/map` (the Harris map rules), `hme://schema/scene`
  (the scene schema, compact form).
- Tool results return the same structured JSON as the CLI, plus a
  `summary` in plain words. The agent never parses stdout.
- This is what makes a smarter model better: it spends no context
  learning the repo layout and no tokens writing measurement scripts.
  It calls `hme.compare` and gets a verdict, corrections, and a next
  step.

## Insight format: what every measurement returns

Raw numbers are for the record. The agent acts on the rest. Every
measure, diagnose, and compare output has the same five parts:

- `verdict`: PASS or FAIL, and which bar failed.
- `numbers`: the raw metrics (SSIM, PSNR, LPIPS, Delta E, counts).
- `corrections`: structured, in scene terms, directly applicable. Each
  one names the element, the kind of error, the measured positions on
  both sides, the shift, and the fix in plain words.
- `context`: the thresholds used, the control ceiling, and what the
  numbers mean. Example: a perfect clone scores about 0.96 here, so
  0.79 is a real clone gap, not a measurement gap.
- `next`: the single most useful next command.
- `limits`: what this measurement cannot see, so the agent does not
  over-trust a number.

Concrete example, from the Nov 8 badge measurement. This is what
`hme compare` should have returned for frame 120, instead of the agent
having to measure it by hand:

```json
{"element": "badge-rsf", "kind": "timing", "at_s": 5.0,
 "ours": {"x": 864, "y": 634, "px": 29406},
 "real": {"x": 966, "y": 594, "px": 15200},
 "shift_px": {"dx": 102, "dy": -40},
 "fix": "Move the badge path 0.75 s later. It is still growing from 5 s to 7 s. Do not set it full size at 4 s.",
 "source": "hme compare, frame 120"}
```

## Context engineering: `hme context`

One call that returns everything an agent needs to work on a clone, so
it does not burn context assembling it:

- The frozen bar (pred thresholds).
- The control ceiling (what a perfect clone scores here).
- The Harris map rules (compact).
- The scene schema (compact form).
- The current scene state and the last check's verdict plus corrections.
- The open gaps (from the audit) and what each one needs.

The agent starts with `hme context`, then measures, then acts. No repo
archaeology, no script writing, no guessing what a number means.

## Build order

Phase 1 (packaging, highest leverage, mostly wiring and schemas):
`hme` binary, `compare`, `diagnose`, `player-pass`, `control`,
`extract`, the insight JSON schema, `hme context`, and the MCP server
wrapping those commands. No new algorithms.

Phase 2 (the hard one): `hme trace`. Generalize teardown.py to any
video and any fps, add the zoom curve and label tracking. This replaces
the most labour-intensive agent work.

Phase 3 (new measurement): `hme fonts`, plus the missing checker
dimensions as `hme compare` gains (zoom velocity, contour shape,
vignette, grain over time, z-order).

## What stays with the agent

The tool never designs a scene, never chooses a fix, never decides a
tradeoff, and never asks the user anything. It measures, diagnoses in
scene terms, and suggests the next command. The agent decides, the user
approves, the tool executes. The human blind gate stays human.
