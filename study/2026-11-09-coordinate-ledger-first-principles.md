# Coordinate ledger: first-principles ladder

Date: 2026-11-09. Trigger: Richardson, approving the Stage 1 draft for the vector-path system, added a second need. His words: agents need some sort of coordinate ledger to understand the position of things in a frame; he does not know the right shape and form; use the first-principles skill to figure it out; the insight is to completely close the gap where an AI agent has to guess when it analyses a reference or figures out how to make a scene.

Skill: `~/workspace/custom-skills/local-first-principles-questions/SKILL.md`. Outcome 3, full ladder. Budget: 8 claims, all 8 tested. This record feeds the Stage 1 package at `~/workspace/handover-headless-motion-paths/stage1-package.md`. No build is approved by this record.

## Step 1: Name the decision

- Decision: what shape and form the coordinate ledger takes, so an agent never guesses a position.
- Action that follows: draft the Stage 1 package for the path system plus the ledger, for Richardson's approval, then build it under Handover.
- What happens if wrong: the ledger becomes a sixth place that holds positions, next to the five that already hold them, and agents keep guessing which file, which unit, and which anchor to trust.

## Step 2 and 3: Claims, tests, status

Positions today live in five places, in different units, under different identities. That is the gap, measured before this ladder:

- Scene JSON: box x, y, w, h in 1920x1080 px, plus transform x, y, scale, rotation, opacity, plus parent chains and rig pivots. Node ids exist. No per-frame on-screen box is written anywhere.
- Teardown and trace profile: per-colour mask centroid plus area fraction per frame at native fps, zoom curve as bbox width, badge trajectory as centroid plus bbox of a radius-30 mask, label tracking as bright-component clusters by position, never named.
- Layout check: centroid ratio, bbox, bbox ratio, area ratio, four border gaps, per element, at checked frames only.
- Layering: badge bbox, dot position, ink bbox, z-order overlap winner, one frame at a time, Seg4-specific code.
- Contour: worst outline point with x and y in both frames plus compass sector, per frame pair.

Fetch and test list. Each claim was tested by reading the engine source itself, a direct test on our own content:

- `src/reference/teardown.py`, header and Pass 5: what the teardown records.
- `src/cli/trace.mjs`, header: what the trace profile records, and the no-OCR limit.
- `src/checker/layout.py`, `_geom`: what the layout check records.
- `src/renderer/runtime.mjs` and `src/scene/evaluate.mjs`, `sampleScene`: what the engine can compute per frame.
- `src/cli/contour.mjs`: how shape separates from camera today.
- `src/rig/expand.mjs`, header: pivot versus centre rotation.
- `out/showcase-2026-11-09/data-story/render-report.json`: what a render report records.
- `grep ledger src/ tests/`: whether a ledger exists.

| # | Claim | Load bearing | Status | Source and one line of evidence |
| --- | --- | --- | --- | --- |
| L1 | Reference elements have no stable ids today. Labels are tracked by position, never named. | Yes | Verified | `trace.mjs` header: "Text identity is UNMEASURED: there is no OCR in the toolchain, so clusters are reported by position, never named after a text." |
| L2 | Our-render positions are not written per frame anywhere. No ledger exists. | Yes | Verified | `render-report.json` keys: status, profile, scene sha, frames captured, dedup counts. No positions. `grep ledger` across `src/` and `tests/` returns zero hits. |
| L3 | Positions mix three unit systems, with no per-value conversion stated. | Yes | Verified | `trace.mjs` header: positions in native video px, and in 1920x1080 space as ratios times 1920/1080. `layout.py` `_geom` gives bbox in px and bbox ratio side by side. |
| L4 | The anchor is unstated per value. Centroid, bbox top-left, and element centre are three different points. | Yes | Verified | `layout.py` `_geom` returns centroid ratio and bbox. `expand.mjs` header: CSS rotates about the element centre, a joint rotates about its pivot, and the flat tracks translate the centre to fake the pivot. |
| L5 | A shared schema for reference and ours makes the diff mechanical. The mechanism already works for one element. | Yes | Verified | `contour.mjs`: aligned Hausdorff centres and uniformly scales the ours contour onto the ref contour first, so shape separates from camera. The ledger generalises that alignment to every element. |
| L6 | The ledger is small. One file holds a full clip. | Yes | Verified by calculation | 240 frames times 10 elements times 12 numbers is 28,800 numbers. At about 10 bytes per number in JSON, that is about 300 KB. Calculation shown, no source needed. |
| L7 | Provenance must differ by side. Ours positions are computed exactly. Reference positions are measured and carry sampling plus tolerance. | Yes | Verified | `sampleScene` returns full per-node state for any frame, pure function of scene plus frame. Teardown Pass 5 measures per-frame mask centroids at native fps. Computed and measured are different kinds of fact. |
| L8 | Camera state per frame is required, or shape versus camera cannot be separated. | Yes | Verified | `contour.mjs` exists for exactly this reason: aligned Hausdorff separates shape from camera. `layout.py` gives zoom as a ratio curve. Without camera state in the ledger, every position diff confuses the two. |

What was dropped: the idea that the ledger is a better teardown report. A teardown report is reference-only, colour-keyed, and unnamed. The ledger must hold both sides under shared ids, or the agent still guesses the mapping.

## Step 4: Counter cases

Counter case 1: teardown plus layout plus contour already give positions, just read them. Observable fact that would prove it: a fresh agent can answer where the RSF badge is at frame 120, in px and ratios, in both the reference and ours, from those files, with no guess. Check: the badge has a trajectory, but labels are unnamed clusters, Sudan is a colour mask, and no single file holds all elements under shared ids. The counter fails on identity and on single-file grounds.

Counter case 2: embed positions in the scene file. Observable fact that would prove it: the scene file is the right home for output data. Check: the scene is the input. Positions are the output of sampling plus rendering. `sampleScene` reads scene plus frame and returns state. Embedding output in input breaks that separation. The counter fails.

## Step 5: Rebuild from true facts

True facts used, from the table only: L1, L2, L3, L4, L5, L6, L7, L8.

What follows from the true facts alone. The ledger shape:

- One JSON file per video or render: `ledger.json`, schema `hme.ledger/1.0`. One file, not one file per element. An agent opens one file and finds every position.
- Rows are per frame times per named element. Element identity is a stable id, shared between reference and ours through an alias table. The alias table maps a reference colour or cluster to an element id. No OCR is invented. A cluster with no alias is listed as unnamed, never silently named.
- Each row states its anchor in the row: centre in px, centre as a ratio, bbox in px, bbox as a ratio, area ratio, four border gaps in px and ratios, z, and visible. Both px and ratios appear in every row, so no conversion is ever guessed.
- Each row states its camera state: for a map, centre lon/lat plus zoom; otherwise the zoom ratio. Shape versus camera stays separable.
- Each row states its provenance: computed or measured, source frame, tolerance, sampling. Ours rows are computed from `sampleScene`, exact, no render needed. Reference rows are measured per frame, or at a stated sampling, with the sampling stated in the file.
- Two builders, one schema: `hme ledger` builds from a scene (computed) and from a video (measured). One diff command, `hme ledger diff`, lists per shared element per frame the delta in px and ratios, plus the worst element.
- The proof that guessing is closed is a blind-drawer test: a fresh agent with only the ledger plus the scene, and no frames, writes a correction that lands the named element within 2 px of target. If the agent needs a frame, the ledger failed.

What the plan is not: not a GUI overlay, not a new reference format, not a replacement for the checker. The checker still judges. The ledger only states positions, so the agent stops guessing them.

## Step 6: Decide and record

- Decision: build the ledger as one JSON file per video or render, shared schema for reference and ours, shared element ids via an alias table, px plus ratios plus border gaps plus camera state plus provenance in every row, with a build command, a diff command, and a blind-drawer proof.
- Claim: all 8 claims tested, 8 verified, 0 assumed load-bearing, 0 failed. Sources are the engine files listed above.
- True facts used: reference elements are unnamed clusters; no ledger exists; three unit systems mix; anchors are unstated; shared-schema alignment works for one element; the file is about 300 KB; ours is computed, reference is measured; camera state is required to separate shape from camera.
- Biggest open risk: the alias table. It maps reference colours and clusters to element ids by hand, and a wrong alias silently maps every position of one element onto another. The proof must include an alias check, or the ledger will state wrong positions confidently.
- What would change my mind: a single existing file that already lists every named element per frame in px plus ratios for both sides, or a demonstration that a fresh agent can answer a position question from today's files with no guess.
- Open questions: exact sampling for reference rows in the proof window (every frame, or stated sampling); the alias table file format and where it lives; whether the ledger also carries path node positions per frame, or element boxes only, in the first version.

Next step, not yet approved: the Stage 1 package at `~/workspace/handover-headless-motion-paths/stage1-package.md` covers the path system plus this ledger. Nothing builds until Stage 1 and Stage 2 are approved.
