# Which gaps need a specific tool: first principles record

Date: 2026-11-08. Decision: which measurement gaps need a standalone tool
(built via Handover, one side chat each, turned into a CLI after).

## Step 1: the decision

- Decision: which gaps get a standalone tool, and which do not.
- Action: create one side chat per tool-gap and run a Handover build in each.
- If wrong: side chats and Handover runs for gaps that need no tool (wasted
  time and budget), or a missing tool for a gap that needs one (a hole in
  the measurement).

## Step 2: what must be true

- A gap needs a specific tool if the measurement is a distinct algorithm,
  reusable across videos, that an agent would invoke on its own. (Load
  bearing. Source: the user's instruction.)
- U9 built all 10 audit dimensions into compare. (Load bearing. Source:
  the U9 verifier report.)
- A dimension in compare is not a standalone tool. (Load bearing. Source:
  reasoning plus the user's "turn into cli after".)
- Gap 1 (coverage) is fixed by capture, not a tool. (Load bearing. Source:
  the audit.)
- Gap 10 (process) is a human gate plus missing segments, not a tool.
  (Load bearing. Source: the audit.)
- Gap 9's calibration part (masking plus DISTS) is preprocessing plus a
  metric, not a standalone tool. (Load bearing. Source: the audit plus
  U9 dists_lite.)
- The timing inference (naming a timing error) is not in compare and
  needs a tool. (Load bearing. Source: the judge verdict plus the user's
  question.)

## Step 3: test each claim

- U9 built all 10 dimensions: verified. Verifier report lists numeric
  counts per dimension (zoom velocity 8, contour 32, motion blur 4,
  grain 8, vignette 2, colour 27, depth 18, type 11, events 13,
  calibration 4).
- A dimension is not a standalone tool: verified. hme has 12 commands
  (render, validate, gates, compare, trace, diagnose, control, extract,
  fonts, player-pass, context, mcp). The U9 dimensions live inside
  compare. An agent cannot call "zoom velocity" on its own. A tool is a
  command an agent invokes for one measurement.
- Gap 1 fixed by capture: verified. The capture ran (1920x1038,
  23.976 fps), the 192-frame check ran, the cut is frame 186.
- Gap 10 is process: verified. The human blind gate has never run; Seg1
  and Seg2 are not built. No tool measures a human gate.
- Gap 9 calibration is preprocessing: verified. Masking is a step before
  compare, not a measurement. DISTS is a metric already in compare
  (dists_lite).
- Timing inference needs a tool: verified. The judge ran diagnose at 5s
  and it returned kind position, not kind timing. No filed evidence ever
  ran diagnose at 5s. The timing error (0.75s early) is a cross-time
  inference one frame pair cannot see. The user's question names this
  gap directly.

## Step 4: what would break it

- Strongest counter case: U9 already measures all 10 gaps, so no new
  tool is needed; the dimensions in compare are enough.
- Check: the counter case confuses a number in a report with a tool.
  Compare reports the zoom velocity as one number among many. An agent
  that wants only the zoom velocity (to check "is the camera pulsing?")
  must run a full compare. A standalone tool gives one measurement on
  demand, with its own inputs and its own report. The user asked for
  tools that could become CLIs, which means standalone commands. The
  counter case fails on that reading.
- Second counter case: eight side chats is too many; group the gaps.
- Check: the user said "each of the gap" and "build each tool in side
  chat each". Grouping would go against the instruction. The counter
  case is noted but not followed.

## Step 5: rebuild from true facts

True facts: U9 dimensions exist inside compare (verified). hme has 12
commands, none of which is a standalone zoom, contour, blur, vignette,
colour, layering, type, or timing command (verified from the command
list). The timing inference is missing (verified by the judge). Gap 1
is fixed by capture (verified). Gap 10 is process (verified).

Answer from true facts alone: eight gaps need a standalone tool.

1. Zoom velocity (Gap 2). Width curve per frame plus first difference.
2. Contour diff (Gap 3). Chamfer or Hausdorff distance between outlines.
3. Blur and grain meter (Gap 4). Frame-difference energy in static
   regions plus edge-width for blur.
4. Vignette meter (Gap 5). Corner against centre luminance.
5. Colour histogram and halo profiler (Gap 6). Histogram comparison
   plus halo radial profile.
6. Layering checker (Gap 7). Overlap winner plus shadow test.
7. Type meter (Gap 8). Per-letter overlap, letter spacing, kerning,
   stroke weight, anti-aliasing. (Font ID is already U8; this measures
   the letterforms.)
8. Timing diff (Gap 9, timing part). Track a named object across time
   in two videos, report the time offset. (The fix cycle teaches
   diagnose; this is the standalone command. It reuses the trace's
   trajectory code.)

Not tools: Gap 1 (capture fixed it), Gap 9 calibration part
(preprocessing plus a metric), Gap 10 (process).

## Step 6: decide and record

- Decision: build eight tools, one side chat each, via Handover.
- What must be true: each tool is a distinct algorithm, reusable
  across videos, invocable on its own.
- What I tested: the U9 dimension counts, the hme command list, the
  audit's Fix lines, the judge's diagnose 5s failure, the capture.
- What would change my mind: if a gap's measurement is already a
  standalone hme command (then no new tool for that gap), or if the
  user groups gaps (then fewer side chats).
- Open questions: does the timing tool duplicate the fix cycle's
  diagnose work? (No: the fix cycle teaches diagnose; the timing tool
  is a new standalone command that reuses the trajectory code from
  trace.) Is vignette too small for a full Handover run? (The user
  said each gap; a small tool is a fast run.)
