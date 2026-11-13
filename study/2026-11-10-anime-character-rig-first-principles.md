# Anime character rig: first-principles ladder

Date: 2026-11-10. Trigger: Richardson, after the recolor-only variant was approved as first. His words: after the recolor, address the gaps so much that we could do exactly what we wanted, turn the right rabbit to show her back to the left rabbit, angry, and make the characters do something completely different. Then run the other variant runs with Handover once the gaps are addressed.

Skill: `~/workspace/custom-skills/local-first-principles-questions/SKILL.md`. Outcome 3, full ladder. Budget: 8 claims, all 8 tested. No build is approved by this record. The next step is a Stage 1 package for approval, then Stage 2, under Handover rules.

Context: the recolor Stage 1 (stage1-anime-recolor-2026-11-10-01, target crimson red #DC143C) was approved Nov 10, 2026, 02:32 EST. The recolor is the baseline variant. This ladder is for the turn-back angry variant and the different-action variant. The clone it builds on passed its judge verdict PASS WITH GAPS (units/F/verdict.md, Nov 10, 2026): Gate 2 mean SSIM 0.9948, mean PSNR 39.71 dB, 168 frames, LPIPS 0.0056, max Delta E 1.801, motion 0.0 px sampled.

This ladder builds on three earlier records, and re-checks each one against the engine as it stands today (HEAD b0a2d93). The engine has moved since those records were written. Two of their claims are now out of date, and this ladder says so plainly where that matters.

- Vector-path ladder, Nov 9: path `d` frozen at compile time, strings step, tracing copies silhouettes but leaves them uneditable, one uniform scale, no node ids. Status today: the path system is built (paths run U1 to U7 all pass; commit 61616ec morph per-frame d, non-uniform squash, vertex deform). Points lists now morph, scaleX and scaleY exist, and `hme path` edits named nodes. The old C1, C2, and C5 are closed for points-list shapes. They still hold for `d`-string traced shapes, which is exactly what the anime clone is made of.
- Coordinate-ledger ladder, Nov 9: reference elements have no stable ids, no ledger exists, three unit systems mix, anchors unstated. Status today: the ledger is built (src/cli/ledger.mjs, schema hme.ledger/1.0, build from scene computed exact, build from video measured with an alias table, diff). The alias-table risk from that ladder still stands.
- Character rig Stage 1, Nov 9: parent field dead, evaluator supports x/y/scale/rotation/opacity, rotation unused in shipped scenes, face and limb mapping onto transform tracks ASSUMED. Status today: the rig run finished units R through F (all pass) and the verifier passes; the judge has not run yet (units.json judge passes false). The rig exists (src/rig/expand.mjs, src/rig/rig.schema.json, src/cli/rig.mjs). The assumed face mapping is now partly settled: the proof rig moves eyes by scale (closed 0.08, open 1, wide 1.3), brows by y (-20), arms by rotation (165 deg) with intermediate keys so the swing follows the arc. Mouth shape is still not a rig primitive.

## Step 1: Name the decision

- Decision: what to build first so the right rabbit can turn her back to the left rabbit, angry, and so both rabbits can do something completely different from the 7 seconds, exactly as authored, with a number proving each step.
- Action that follows: draft a Stage 1 package for the rig-gap build, for Richardson's approval, then build it under Handover.
- What happens if wrong: work spends weeks on a rig that moves whole parts but cannot change a face, or on a turn that spins the rabbit like a wheel, or on tracing 168 new frames that do not exist to trace, while the variant still cannot be authored at all.

## Step 2 and 3: Claims, tests, status

Fetch and test list. Each claim was tested by reading the engine source itself or the measured anime evidence, which is a direct test on our own content. Files read and what each settled:

- `src/rig/expand.mjs`, header and VALUE_FIELDS: what a rig pose can write.
- `src/rig/rig.schema.json`, `$id hme.rig/1.0`: what a rig file holds.
- `~/workspace/handover-character-rig/kit/capability-map.md` and `playbook.md`: what the proof rig did, and what it cannot do.
- `src/scene/evaluate.mjs`, lines 5, 45-76, 98-116, 129-158, 216-246: what interpolates, what steps, what the topology guard throws on.
- `src/renderer/runtime.mjs`, lines 109-129, 186-193, 234-238: what changes per frame, and how rotation and scale are applied.
- `src/renderer/compile.mjs`, lines 72, 222-234: points list wins over `d`; `d` stays as the fallback for traced scenes.
- `src/reference/trace-import.py`, header: what tracing produces.
- `~/workspace/handover-anime-7s/units/D/scene.json`, head: what the clone scene actually holds.
- `~/workspace/handover-anime-7s/units/A/reference-profile.json`: one shot, palette, trajectories, traces, warp.
- `~/workspace/handover-anime-7s/units/B/pick.json`, verdict lines 83, 581, 1081, 1575: what the picker fitted and what it refused.
- `src/scene/pick-ease.mjs`, header lines 1-38: the two picker modes.
- `~/workspace/handover-anime-7s/comparison/comparison-report.md`, sections 4-7 and M7: the beats, the stills, the picker gap.
- `~/workspace/handover-anime-7s/units/F/verdict.md` and `units/D/clone-report.md`: the gate numbers and the build timing.
- `~/workspace/handover-anime-7s/comparison/stills/sbs-f0-ref0.jpg` and `sbs-f48-ref48.jpg`: the rabbits as they look, viewed directly.
- `src/cli/ledger.mjs`, header lines 1-38: what the ledger holds and how it is built.
- `src/scene/lint-determinism.mjs`, RULES: what breaks determinism.
- `src/cli/contour.mjs`, lines 250, 291: nearest node plus px correction.
- `~/workspace/handover-anime-7s-variants/stage1-package.md`, claims C2, C3, C5, C8: the measured fills and the missing back view.

| # | Claim | Load bearing | Status | Source and one line of evidence |
| --- | --- | --- | --- | --- |
| R1 | The rig moves whole parts only. It cannot change a part's outline. | Yes | Verified | `expand.mjs` line 89: VALUE_FIELDS is x, y, scale, rotation, opacity only. Kit capability-map line 15: no mouth-shape, blink-curve, or squash-and-stretch primitive exists in this run. |
| R2 | The clone's rabbits have no part identity. They exist only as per-frame colour-layer traces. | Yes | Verified | Clone `scene.json` holds one node, a rect called frame; meta notes motion comes from the per-frame traces only. `trace-import.py` header: each SVG path becomes one shape node, `d` copied verbatim, no part names. Profile trajectories are keyed by palette hex, never by a part name. |
| R3 | No back view exists in the 7 seconds. | Yes | Verified | Profile: 1 shot, 0 cuts, frames 0 to 167. Recolor Stage 1 C8: no back view exists in the 7 seconds. Viewed stills f0 and f48 show the right rabbit in left-facing profile only. |
| R4 | A front-to-back change cannot morph. The topology guard throws on any node-count, id, command, or handle change, so the change must swap node sets. | Yes | Verified | `evaluate.mjs` lines 74-76: interpolatePoints throws PATH_TOPOLOGY_MISMATCH when lists differ in count, ids, commands, or handle presence. Front and back sets differ in all four. |
| R5 | A turn cannot be a rotation track. Rotation is in-plane, about the element centre. | Yes | Verified | `runtime.mjs` lines 186-193: rotation is a CSS rotate about the centre or anchor. `expand.mjs` lines 27, 47: pivot math moves the centre for in-plane rotation. A 180 degree rotation track would spin the profile like a wheel, not show her back. |
| R6 | Anger has no checker measure today. It must be measured as node geometry from sampled points and ledger rows. | Yes | Verified | The checker measures layout, contour, motion, colour, defects, and text. No file measures expression. `ledger.mjs` header lines 10, 38: build from a scene is computed exact from sampleScene; rows hold centre, bbox, area, and camera per frame. Brow angle, eye height, mouth height, ear angle, and shoulder height are all computable from that data, but no command computes them today. |
| R7 | The picker cannot fit a new action from a reference, because no reference exists for a new action, and it returns NO_FIT for shape-change moves. The --intent mode can rank eases by a numeric envelope, and that is how it helps a new action. | Yes | Verified | `pick-ease.mjs` header lines 7, 18: --fit needs a reference profile; --intent ranks eases against a numeric envelope with no reference. `pick.json` lines 83, 581: mouth NO_FIT, hand-rise NO_FIT, with the reason that no colour centroid follows a shape change. Line 1081: head-bow WEAK_FIT, indicative only. |
| R8 | Determinism is checkable today and holds when new code stays inside its rules. It breaks if back-view art is regenerated per render, or if a matching step has order-dependent ties. | Yes | Verified | `lint-determinism.mjs` RULES bans Date, Math.random, randomUUID, Intl, locale strings, CSS animation, and video elements. `evaluate.mjs` header: the picture at frame N is a function of scene and N only. Precedent: the box.w run re-rendered twice byte-identical (MEMORY.md Nov 10, 02:09 EST). `path.mjs` header: edits write a new versioned file, never in place. `expand.mjs` header: expansion returns a new scene object, never mutates its inputs. |

What was dropped: the idea that the clone method can make the variant. The clone traces every frame of a reference that exists. A new pose has no reference frames to trace. Tracing copies; it cannot invent. The variant needs authored art plus a rig, not a better tracer.

What was corrected from the Nov 9 ladders: path morph, non-uniform scale, and vertex deform now exist (paths run U1 to U7 all pass), so the old claim that a path outline is frozen is false for points-list shapes. It still holds for `d`-string traced shapes, and the anime rabbits are `d`-string traces. The ledger now exists, so positions can be stated per frame under shared ids, but the alias table still maps reference colours to ids by hand.

## Step 4: Counter cases

Counter case 1: just rotate the right rabbit 180 degrees with a rotation track. Observable fact that would prove it: a rotation track turns a left-facing profile into a back view. Check: `runtime.mjs` applies rotation as a CSS rotate about the centre. That spins the profile in the picture plane. Her face would end up upside down, not turned away. The counter fails.

Counter case 2: trace every frame of the variant the way the clone did. Observable fact that would prove it: the variant frames exist as a reference to trace. Check: no reference frames exist for a turn, an angry face, or a different action. The clone scene holds one rect node and its motion comes from per-frame traces of the reference file. With no reference, there is nothing to trace. The counter fails.

## Step 5: Rebuild from true facts

True facts used, from the table only: R1, R2, R3, R4, R5, R6, R7, R8.

### (1) What a character rig means for these two rabbits

The scene, from viewed stills f0 and f48, at 1280x720:

- Left rabbit, centre-left, three-quarter view facing right. Long upright ears. Pink long-sleeve shirt, flat fill #D2A097 at (360,320). Blue apron, flat fill #3C6F90 at (450,480), shade range #2D5C78 to #3E708E, front pocket. Olive pants, flat fill #98A776 at (470,600). White shoes. She holds a small brown pot of pink and red flowers in both hands at chest height. Face: two eyes, two brows, small red mouth, whiskers. Measured fills from the recolor Stage 1, frames 6 and 84.
- Right rabbit, right side, left-facing profile. One tall ear with a black tip, a second shorter ear. Cream striped long-sleeve shirt. Blue apron, same flat fill #3C6F90 at (900,480). Bare white legs, flat brown shoes. Arms at her sides at frame 0. One visible eye, one visible brow, small mouth.
- What moves in the original 7 seconds: left rabbit mouth opens, frames 0 to 16, peak frame 11. Sweat drops appear on her cheek, frames 12 and 84. Right rabbit right hand rises, frames 21 to 54, hand to chin at frame 48. Right rabbit head bows, frames 90 to 147, peak frame 93, full-frame energy 1.615 to 2.628 in frames 90 to 99 against a median of 0.28. Hand leaves the chin at frames 112, 132, 147. Nothing else moves. The background is static: window, wreath, pink bells, counter, cash register, shelves, flower pots, basket. Motion sampled 0.0 px.
- The pot is a prop attached to the left rabbit's hands. It never leaves her hands in frames 0 to 167. In a variant where the right rabbit takes it, that is a prop transfer: the pot node must move from the left hands to the right hands at a named hand-off frame. No tool supports attachment transfer today. A transfer is authored as position and opacity keyframes on a pot node, with the hand-off frame named in the beat map.

The rig, as it stands, maps one character to named parts, each part to one scene node, with joints that rotate or translate and poses that name states per part. Pose states carry only x, y, scale, rotation, opacity (R1). So for these rabbits the rig can do today:

- Head: neck joint rotation (bow, turn of the head within the visible range), head y (bow dip).
- Ears: ear-base rotation (flatten, perk). Each ear is its own part with its own pivot.
- Eyes: scale (closed 0.08, open 1, wide 1.3, from the proof rig), scaleY for narrowing.
- Brows: y (raise -20 in the proof) and rotation (angle down for anger).
- Mouth: scale only. A closed line becoming an open oval is a shape change, and the rig cannot write it.
- Arms: shoulder rotation with pivot math (proof: 165 deg, intermediate keys at frames 60 and 66, 82 and 125 deg, so the swing follows the arc), elbow chains, hand y.
- Shoulders and torso: y (rise, tense), scaleX and scaleY (squash and stretch about an anchor).
- Legs and shoes: rotation and y for stance changes.
- Pot: x, y, rotation, opacity as a prop node. No attachment to a hand exists in the rig format.

What the rig cannot do for these rabbits, until the build in section (7): change a mouth shape, change an ear shape, swap a front set for a back set, or transfer the pot between hands. Each of those needs a points-track write, a node-set swap, or a hand-off keyframe, none of which the rig writes today.

### (2) What back-view art is missing, and how it gets made

Missing, for the right rabbit only (the left rabbit does not turn): the back of her head, both ears from behind with their black tips, the back of her cream striped shirt, the back of her blue apron with its ties (not the front pocket), the back of her legs, and her shoes from behind. No back view exists in the 7 seconds (R3). The clone holds no back-view frame to trace, and no back-view node set to reuse.

Three routes, in order of evidence strength:

- Route A, trace a real back view from the same video. The source is a 24 minute Shimajiro compilation; the 7 seconds are 1:35 to 1:42. Another segment may show the same rabbits from behind, in the same style, with the same palette. That is the strongest match if it exists. Test, not yet run, and no download was made in this ladder: scan the full video outside 1:35 to 1:42 for a back view of the right rabbit. If one is found, trace it with the finer preset and convert it to a points list, not a `d` string, so the rig can move it and `hme path` can edit it.
- Route B, draw the back set as points-list nodes with `hme path` commands, matching measured fills: apron #3C6F90, shirt pink #D2A097, pants olive #98A776, fur white #D2DBDC, outline dark #424934 (3.67 percent share in the profile). Line weight is unmeasured today. It must be measured from the reference before drawing starts: the edge profile width at a known outline, in px, on frames 6 and 84. A drawn back set that does not match the line weight will read as a different character even if the palette matches.
- Route C, mirror the front set. This fails and is dropped. A mirror is not a back view: the apron back has ties, not a pocket; the ears sit differently; the face is absent. Mirroring would also flip the black ear tip to the wrong side.

Match checks for the back set, set in Stage 1, not decided here: palette Delta E 3 or less on 5x5 patches (the pred-v1 colour bar), outline colour match, line weight within the measured tolerance, and the human gate at full speed and 0.25x. The back set must be points-list nodes, not a `d`-string trace: a traced back view would be frozen (compile.mjs lines 232-234, points wins over `d`, `d` is the fallback), and the rig could only move it whole, never edit an ear.

### (3) How a pose change propagates across 168 frames

Three mechanisms exist, with different costs and different limits:

- Keyframe plus morph. Two points lists interpolate when they share topology: same node count, same ids, same commands, same handle presence (evaluate.mjs lines 74-76). The evaluator lerps every coordinate and rounds through fmt. A pose change inside one view, mouth closed to mouth open, arm down to arm up, keeps topology when both keyframes are authored with the same ids, so it morphs. A deform track steps, it never blends (evaluate.mjs lines 115-116, array of objects returns the earlier value), so a deform-driven pose jumps between keys unless it is keyed every frame. Rotation, x, and y interpolate linearly, so a large swing follows the chord, not the arc (expand.mjs line 72); the rig proof added intermediate arm keys at frames 60 and 66 so the swing followed the arc.
- Per-frame redraw. The clone method: trace every frame, zero warps. Gate 2 build took 1609.5 seconds for 168 frames, 9.58 seconds per frame (clone-report.md timing). That cost buys a copy of existing frames. For a new pose it buys nothing, because the frames to trace do not exist. Drawing 168 new frames by hand or by agent is the work; tracing is not the work. Per-frame redraw is the fallback only if a pose cannot be expressed as keyframes at all.
- Node-set swap. The front set fades or squashes out and the back set fades or squashes in, driven by opacity tracks and scaleX tracks. No morph runs between the sets, so the topology guard never fires. scaleX and scaleY about an anchor exist (scene.schema.json lines 614-622; runtime.mjs lines 234-236 scales points about the anchor). The classic turn is squash to scaleX 0, swap sets, squash back to scaleX 1. The swap frames need a named count in Stage 1. A swap with no squash reads as a pop; a crossfade with no squash reads as a ghost. One of the two must be chosen in Stage 1 and measured at 0.25x.

The topology guard problem, stated plainly: the front set and the back set differ in node count, ids, commands, and handle presence, so interpolatePoints throws PATH_TOPOLOGY_MISMATCH (R4). Any plan that morphs front into back fails loudly at the first render. The fix is not to relax the guard. The fix is to author both sets with a shared id scheme for the parts that persist, ears keep ids ear-L and ear-R in both sets, and to swap the rest by opacity and scaleX. Shared ids do not make the lists morphable unless counts, commands, and handles also match. The swap is the honest mechanism. A re-topology step that forces two different drawings onto one shared list is a separate build, and it must prove its matching is deterministic (R8) before it can be load bearing.

Frame budget: the turn takes N frames, set in Stage 1. The original bow takes about 57 frames, 90 to 147. The remaining frames hold the new pose with small secondary motion, breathing and ear twitch, via rig keyframes. The 168-frame count stays: 7.0 seconds at 24 fps, slots 0 to 167, slot 168 dropped as in the clone.

### (4) How anger shows, and what the checker measures for it

While the face is visible, before the turn: brows angle down toward the nose, a V shape, which is brow rotation per part (the rig writes rotation). Eyes narrow, which is eye scaleY below 1 (the rig writes scale). Mouth opens in a shout or flattens to a line. A shout is a shape change, which needs a points morph the rig cannot write today. A flat line is a scaleY squash, which the rig can write. Ears flatten back, which is ear rotation. Shoulders rise, which is shoulder y. Each of these is a named rig pose state except the mouth shape.

After the turn, no face is visible. Anger must read in the body: shoulders up, ears flat and back, arms stiff at the sides or fisted, head tilted down, stance wide. The checker cannot see a face that is not there. The expression measure must switch from face geometry to body geometry at the swap frame, and Stage 1 must name that switch frame.

What the checker measures today: layout (bbox, centroid, area ratio, border gaps), contour (outline Hausdorff, nearest node plus px correction), motion (phase cross-correlation), colour (Delta E), defects, text. Nothing measures expression (R6). The new measure is node geometry, all computable from sampled points lists and ledger rows: brow angle in degrees, eye-open height in px, mouth-open height in px, ear angle in degrees, shoulder height in px. The ledger already holds centre, bbox, area, and camera per frame per named element (ledger.mjs header). The proof pattern is the rig run's: named-state frames judged side by side (rig predicate item 3), plus numeric geometry bars. The numeric bars are not set in this ladder. They are set by measuring the drawn anger pose in Stage 1. Any bar invented here would be an unmeasured number.

### (5) How a completely different action gets authored

A new action needs, in order: a beat map, ease picks, keyframes, and a verification that has no reference to compare against.

- Beat map: one line per beat, frame number and what changes. The original's beats are mouth frames 0 to 16, hand rise frames 21 to 54, bow frames 90 to 147. A new action needs the same table before any keyframing starts. No beat map exists for any new action today.
- Tracks: rig keyframes for the whole-part moves (VALUE_FIELDS), points morph tracks for shape changes (mouth, ears), deform keys for vertex moves (keyed every frame where they must blend, because deform steps). Timing runs at 24 fps, 168 frames.
- Easing: 18 named cubic-beziers plus hold (easing.mjs; pick-ease.mjs header line 3). The picker helps a new action through --intent mode: it ranks every named ease against a numeric envelope, peak velocity ratio, time-to-peak fraction, overshoot cap, settle fraction, with no reference and no adjective (pick-ease.mjs header lines 18-30). That is the correct route for choosing an ease for a move nobody has filmed.
- The picker fails a new action through --fit mode. --fit needs a reference profile, and on this clip --fit shot-01 failed with NO_USABLE_TRACK because the tool reads 60 fps fields the anime profile does not carry (pick.json method note). On the reference mode it returned NO_FIT for mouth and hand-rise and WEAK_FIT for head-bow (R7). The reason is in the verdict text: no colour centroid follows a shape change. A new action has no reference at all, so --fit has nothing to fit. The shape-change tracking mode queued as gap G-F6, track mask area and edge profile, not centroid alone, would let the picker measure an authored move, but it cannot invent a reference for one.
- Proof without a reference: three checks, none of which is SSIM against a reference. First, the action reads as intended at full speed and 0.25x, human gate. Second, the ledger positions match the authored timing envelope within 2 px, the blind-drawer bar from the ledger ladder. Third, motion smoothness: no jumps between adjacent authored frames, measured by the motion checker or by adjacent-frame SSIM with a bar set in Stage 1. If the action cannot pass the human gate, no number saves it.

### (6) What breaks determinism, and what keeps it

What keeps it, all verified in source: the evaluator is a pure function of scene and frame (evaluate.mjs header). Numbers round through fmt to 3 decimals. The runtime bans Date, Math.random, timers, CSS animation, and network (runtime.mjs header). lint-determinism scans for those tokens (lint-determinism.mjs RULES). Path edits write a new versioned file, never in place (path.mjs header). Rig expansion returns a new scene object and never mutates its inputs (expand.mjs header). The ledger has fixed frame, element, and row order, so the same inputs give the same bytes (ledger.mjs header). Precedent: the box.w run re-rendered twice byte-identical.

What breaks it: back-view art regenerated per render. The back set must be a versioned file, drawn once, then read. Any step that matches front nodes to back nodes by heuristic must have a deterministic order: stable sort, named ids, no dependence on object key order. The alias table is the known risk from the ledger ladder: it maps reference colours and clusters to element ids by hand, and a wrong alias silently maps every position of one element onto another. The unmasked detail plate is the safe precedent: deterministic Python, versioned file, commit 12582ae, judged a correction and not a copy (verdict section 12). Every new file in this build must pass lint-determinism, and every variant must re-render byte-identical before it claims DONE.

### (7) The ordered build list

Each step names what it proves, with a number, and what it depends on. No step starts before its dependency proves.

- Step 0, rabbit part set. Redraw both rabbits as named points-list nodes: head, ears, eyes, brows, mouth, torso, apron front, arms, hands, legs, shoes, pot. Proves: each part matches its reference region within the pred-v1 colour bar, Delta E 3 or less, and a full-frame still reads SSIM 0.95 or more against the reference frame. Depends on: nothing. Blocks: every later step.
- Step 1, back-view art. Draw the right rabbit's back set in the same style, as points-list nodes. Proves: palette Delta E 3 or less, outline colour match, and a side-by-side still passes at 0.25x. Depends on: Step 0, plus the line-weight measurement from the reference. Blocks: Steps 2 and 3.
- Step 2, turn mechanism. Squash-and-swap: scaleX to 0, swap sets, scaleX to 1, with the swap frame count set in Stage 1. Proves: the turn reads as a turn at full speed and 0.25x, and adjacent-frame SSIM at the swap stays above the bar set in Stage 1. Depends on: Step 1. Blocks: Steps 3 and 4.
- Step 3, rig extension. The rig writes props.points keys (morph) and props.deform keys, so poses can change mouth and ear shape, plus turn and anger poses. Proves: a rig-authored anger frame matches a hand-keyframed anger frame within 2 px on the ledger diff. Depends on: Steps 0, 1, 2. Blocks: Steps 4, 5, 6.
- Step 4, picker shape-change mode. Gap G-F6: track mask area and edge profile, not centroid alone, so the picker can measure authored motion timing. Proves: the picker reports the turn's velocity profile matching the authored envelope within the RMS error bar set in Stage 1. Depends on: Step 2. Blocks: Step 6.
- Step 5, expression checker. Brow angle, eye and mouth height, ear angle, shoulder height, computed from sampled points and ledger rows. Proves: the anger frame reads brow angle and eye height past the bars set by measuring the drawn pose. Depends on: Steps 0 and 3.
- Step 6, new-action authoring. Beat map, --intent ease picks, keyframes, ledger verification. Proves: ledger positions match the authored envelope within 2 px, and the human gate passes at full speed and 0.25x. Depends on: Steps 0, 3, 4.
- Step 7, determinism gates. lint-determinism on all new files, byte-identical re-render, versioned art. Proves: two runs byte-identical, lint passes. Runs alongside each step. Final gate before any variant claims DONE.

## Step 6: Decide and record

- Decision: build in the order Step 0 to Step 7 above, starting with the rabbit part set and the back-view art, because every later step needs named parts and a back set to work on.
- Claim: all 8 claims tested, 8 verified, 0 assumed load-bearing, 0 failed. Sources are the engine files and the measured anime evidence listed in Step 2 and 3.
- True facts used: the rig writes only x, y, scale, rotation, opacity per part; the clone's rabbits are per-frame traces with no part identity; no back view exists in the 7 seconds; the topology guard throws on any front-to-back morph; rotation is in-plane; no checker measures expression; the picker fits references but cannot fit a new action, while --intent ranks eases by numbers; determinism holds under lint plus versioned files and breaks on regeneration or order-dependent matching.
- Biggest open risk: the rabbits exist only as roughly 100,000-path per-frame traces with no part identity, and no one has proven an agent-drawn part set can match the reference style within the pred-v1 bars (SSIM 0.95, PSNR 35 dB). If the redrawn parts do not match, the variant fails its own visual bar no matter how good the rig is. Step 0 is the riskiest step, and it comes first for that reason.
- What would change my mind: a redrawn rabbit part set that matches its reference frame within the pred-v1 bars, which would retire the biggest risk early; or a back-view frame found in the same Shimajiro video, which would replace the drawn back set with a traced one; or a demonstration that a rotation track can show a back view, which would retire the swap mechanism.
- Open questions: the outline line weight in px, unmeasured, measure it on frames 6 and 84; whether a back view exists in the same video outside 1:35 to 1:42, test by scanning it; the numeric anger bars, set by measuring the drawn anger pose; squash-and-swap or crossfade for the turn, decided in Stage 1; the frame count of the turn, set in Stage 1; whether the pot changes hands in the different-action variant, decided in the beat map.

Next step, not yet approved: draft a Handover Stage 1 package for Step 0 and Step 1 (rabbit part set plus back-view art), with predicate, units, budget, and envelope, and present it for Richardson's tap. Nothing builds until Stage 1 and Stage 2 are approved.
