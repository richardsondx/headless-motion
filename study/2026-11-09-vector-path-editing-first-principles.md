# Vector path editing: first-principles ladder

Date: 2026-11-09. Trigger: Richardson, after the 4 showcase renders. His words: the gaps are texture, drawn characters, and squash and stretch; even shape and curve do not match at all; polygon formation does not match; the tool must be much better at vector path editing (node editing, vertex manipulation, point pulling). He asked for the first-principles skill to figure out how to address it.

Skill: `~/workspace/custom-skills/local-first-principles-questions/SKILL.md`. Outcome 3, full ladder. Budget: 8 claims, all 8 tested. No build is approved by this record. The next step is a Stage 1 package for approval, then Stage 2, under Handover rules.

## Step 1: Name the decision

- Decision: what to build first to close the shape and form gap, so an agent can make a shape match a reference outline exactly and deform it over time.
- Action that follows: draft a Stage 1 package for a structured vector-path system, for Richardson's approval, then build it under Handover.
- What happens if wrong: weeks of work on tracing, texture, or more primitives that still cannot fix a single outline point, while the clone scores stay stuck (Seg3 baseline SSIM 0.686 vs 0.95 bar; contour Hausdorff 16 to 130 px on the Sudan outline).

## Step 2 and 3: Claims, tests, status

Fetch and test list. Each claim was tested by reading the engine source itself, which is a direct test on our own content. Files read and what each settled:

- `src/scene/scene.schema.json`, shapeProps and node transform: what a shape is in the format.
- `src/renderer/compile.mjs`, nodeHtml and shapeSvgDefs: what the renderer does with a path.
- `src/renderer/runtime.mjs`, apply() lines 95-175: what changes per frame.
- `src/scene/evaluate.mjs`, lines 28-70: what interpolates and what steps.
- `src/reference/trace-import.py`, header and converter: what tracing produces.
- `src/cli/contour.mjs` and `src/checker/dimensions.py`: what shape error is measured in.
- `src/rig/expand.mjs`, header: how rotation about a pivot is faked today.
- `README.md`, authoring tools table: tracing and rig status as reported.

| # | Claim | Load bearing | Status | Source and one line of evidence |
| --- | --- | --- | --- | --- |
| C1 | A path outline is frozen at compile time. The engine cannot change it per frame. | Yes | Verified | `compile.mjs`: `d` is copied verbatim into `<path d="...">`. `runtime.mjs` apply() sets only fill and stroke on that path element, never `d`. |
| C2 | The timeline cannot morph a path smoothly. A keyframed `d` would jump, not blend. | Yes | Verified | `evaluate.mjs`: numbers and arrays interpolate; strings step (`stepsOnly`, returns `va`). `d` is a string in the schema. |
| C3 | Tracing can copy a flat silhouette exactly as a static path, but the result is uneditable. | Yes | Verified | `trace-import.py`: each traced SVG path becomes one shape node, `d` copied verbatim, fill copied. Monster trace SSIM 0.90 (README). No node identity survives: the outline is one opaque string. |
| C4 | Shape error is already measured in px, and shape can be separated from camera error. | Yes | Verified | `contour.mjs`: headline is Hausdorff on full contour point sets, full res, badge masked; aligned Hausdorff scales and centres ours onto ref first, so shape separates from camera. Known numbers: outline Hausdorff 16.4 / 60.0 / 130.4 / 64.1 px at 1s / 4s / 5s / 7s (contour ladder, Nov 8). |
| C5 | Squash and stretch is impossible in the current format. | Yes | Verified | Schema transform has one `scale` number, about the element centre (rig notes: rotation and scale are about the centre). One uniform scale cannot make a shape wider and shorter at once, and there is no per-vertex deform. |
| C6 | Texture is a real gap but a separate one: fills are flat or gradient only, plus glow and blur. No grain, no brushed texture. | No, for path editing; yes, for the Kurzgesagt look | Verified | `compile.mjs`: gradient fills (linear, radial), glow as drop-shadow, soft as blur. Showcase report: no grain or vignette pass; reference sky is brushed, engine sky is a smooth gradient. |
| C7 | An agent can only fix what it can name. With no node ids, there is no way to say "move node 7 by 12 px" in scene terms or in a checker correction. | Yes | Verified | Schema: `d` is one string, no node list, no handles, no ids. The checker can report a worst contour point in px, but nothing maps that point to an editable thing. |
| C8 | Any fix must keep determinism: the picture at frame N is a pure function of the scene and N, byte-identical re-renders. | Yes | Verified | `prompts/01-scene-format.md` determinism rules; `evaluate.mjs` rounds through `fmt` (3 decimals). The path system must live inside these rules, not beside them. |

What was dropped: the idea that more tracing accuracy alone closes the gap. C3 plus C1 kills it. A perfect trace is still a frozen string. Accuracy at import is not editability after import.

## Step 4: Counter cases

Counter case 1: tracing plus pixel cutouts is enough, no editing needed. Observable fact that would prove it: a traced shape already passes its bar with no post-trace correction. Check: monster trace SSIM 0.90 vs the Seg3 bar 0.95, it fails; Sudan outline Hausdorff runs 16 to 130 px. The counter fails.

Counter case 2: whole-node transform is enough for squash and stretch, just scale the node. Observable fact that would prove it: one scale number can widen and shorten at once. Check: schema has one `scale`, about the centre. It cannot. The counter fails.

## Step 5: Rebuild from true facts

True facts used, from the table only: C1, C2, C3, C4, C5, C7, C8. C6 is true but belongs to a separate track.

What follows from the true facts alone:

1. The missing piece is not a better tracer. It is path as data. A path must be a list of named nodes in the scene file: anchor point, in-handle, out-handle, command (line, cubic, smooth), closed or open. The renderer compiles that list to `d`. The old `d` string stays as a compiled fallback for already traced scenes, so nothing built so far breaks.
2. Editing must be commands an agent can run, each producing a new versioned scene file, never editing in place (same rule as the automated fixer): move node, pull handle, insert node, delete node, convert line to curve and back, smooth a run of nodes, simplify a run within a px tolerance. Each command names node ids, so a checker correction can say exactly what to move.
3. Morphing must be interpolation over node lists. The evaluator already interpolates arrays, so a path point list can interpolate once it is an array of numbers. Guard: both keyframes must share node count and command sequence, or the render fails loudly instead of silently jumping. Strings stepping is the current behaviour and must not be carried into the new format.
4. Squash and stretch needs two things, in order: first non-uniform scale (scaleX and scaleY about a chosen anchor, not only the centre), then true vertex deform driven by the same node list (move a subset of nodes, or a bend op). ScaleX and scaleY alone give squash and stretch for simple shapes. Vertex deform gives it for drawn characters.
5. Measurement must close the loop. The contour tool already finds the worst outline point in px. Extend it to name the nearest path node and emit the correction in scene terms: "move node 7 by (-12, +8) px". Without that mapping, the agent sees the error and still cannot fix it. This is the step that turns measurement into editing.
6. Texture stays separate. Grain, brushed fills, and vignette are fill and post steps, not geometry. Bundle them into the path build and both halves get weaker. Sequence: path system first, texture second.

What the plan is not: not a GUI node editor (the interface stays JSON plus CLI, agent-first); not a new tracer; not a full vector library adopted blindly (paper.js, fabric.js, or a path-data parser are implementation choices inside the build, gated on determinism: no Math.random, no Date, no locale).

## Step 6: Decide and record

- Decision: build a structured vector-path system first, in layers (path as data, edit commands, morph, squash and stretch, contour-to-node correction), with texture as a separate later track.
- Claim: all 8 claims tested, 8 verified, 0 assumed load-bearing, 0 failed. Sources are the engine files listed above.
- True facts used: paths are frozen strings today; strings step, arrays interpolate; tracing copies silhouettes but leaves them uneditable; contour already measures outline error in px; the format has one uniform scale; no node ids exist; determinism is a hard constraint.
- Biggest open risk: the morph topology guard (same node count and command sequence) may prove too strict for real reference shapes, where the traced node count changes frame to frame, and the build may need a re-topology step nobody has scoped yet.
- What would change my mind: a traced shape passing its bar with zero post-trace edits, or a demonstration that whole-node transform alone can match a reference outline within the contour bar.
- Open questions: does the new path format live in scene schema v1.1 as an additive field, or replace `d` outright; what px bar should the contour-to-node correction aim at (aligned Hausdorff under 5 px is a candidate, not a decision); which implementation library, if any, survives the determinism gate.

Next step, not yet approved: draft a Handover Stage 1 package for the path system (predicate, units, budget, envelope) and present it for Richardson's tap. Nothing builds until Stage 1 and Stage 2 are approved.
