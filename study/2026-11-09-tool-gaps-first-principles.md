# Tool gaps, first-principles ladder

Date: 2026-11-09. Skill: local-first-principles-questions. Budget: 8 claims.
Trigger: the Vox document clip failed the human gate twice. The user asked what gaps in the tool this exploration exposes.

## Step 1: Name the decision

Decision: which gaps in Headless Motion did the Vox document exploration expose, and which are real tool gaps versus authoring, asset, or measurement gaps?
Action that follows: prioritize what to build or fix next in the tool.
What happens if wrong: build a zoom feature the engine does not need while the real blocker (cutouts) stays unsolved, or keep shipping clips that fail the gate for reasons the machine checks never see.

## Step 2 and 3: Claims and tests

1. The engine can already move a photo up from below a panel edge (rise). NOT a tool gap. VERIFIED by source.
   Evidence: src/scene/evaluate.mjs lines 183-202. Tracks group by node, each track is sampled and written to state[track.prop] for any prop. The schema holds x, y, scale, scaleX, scaleY, opacity. V1 already animated transform.scaleX. A rise is a Y track on the image node. It was never authored because the study beat list described static frames, not entrances. Note: verified by reading code, not by a render test. No rise has rendered yet.

2. The engine cannot make a photo grayscale. Tool gap WITH workaround. VERIFIED.
   Evidence: study. Image nodes take no filter. The soft blur and glow filters live on shape nodes only. Workaround is proven: bake grayscale into the asset with PIL, a deterministic one-line conversion. The gap is real but not blocking.

3. The engine cannot cut a photo out. Tool gap WITHOUT a proven path. VERIFIED.
   Evidence: study. No clipPath or mask exists in the schema or in compile.mjs. Asset-side: rembg is not installed (ModuleNotFoundError, checked 2026-11-09 23:33 EST). Pip install plus the model download is untested in this environment. A PIL-only cutout is unproven. Neither engine-side nor asset-side has a shown method. This is the one hard blocker.

4. The engine cannot zoom a plain scene. Tool gap WITH a per-element workaround. VERIFIED.
   Evidence: grep for camera and cameraMove in scene.schema.json, evaluate.mjs, and runtime.mjs returns zero hits. The map module has cameraMove; plain scenes have no camera. Workaround: per-element scale tracks, scaleX and scaleY exist in the schema (lines 587-595). Each photo or panel can scale 95 to 100 percent. That is not a composition camera, but it is buildable. Note: whether the reference zoom is composition-level is unmeasured. Panel borders are pixel-identical across all 9 reference frames.

5. The measurement side cannot see entrance motion, color treatment, or camera movement. Measurement gap. VERIFIED.
   Evidence: the predicate checks positions (ledger edge within 2 px), focus state, and arrow presence. All are static-frame properties. V1 passed 10 of 10 machine checks and the rebuild passed all machine checks, yet both failed the gate on motion, color, and camera. The ledger holds per-frame rows, so the data exists, but no check reads trajectories, saturation, or scale over time. The gap is in the checks, not the data.

6. The runtime never writes box.w or box.h to rect width. Engine gap, already queued. VERIFIED.
   Evidence: proof-report-u1.json deviations. Round 1 rendered no yellow at all while its ledger showed the sweep. The fix was scene-side (scaleX). The engine behavior is unchanged.

7. The computed ledger ignores transform.scaleX in bbox math. Engine gap, already queued. VERIFIED.
   Evidence: proof-report-u1.json and the rebuild judge verdict. The ledger reads the end edge at every frame, even frame 0 when scale is 0.

8. The engine cannot blur an image node. Tool gap WITH workaround. VERIFIED.
   Evidence: study lines 33-34. The focus pull needs pre-blurred asset copies crossfaded by opacity. The workaround is proven and used twice (paper-blurred.png, content-bottom-blurred.png, baked with PIL).

## Step 4: Counter cases

Counter case 1: the gaps are all authoring failures, not tool gaps. Terra just needed better prompts. Observable fact that would prove it: the rise supports it, the engine could already do it. But claims 3, 6, and 7 break it. No mask exists in the schema at all, and box.w plus ledger scaleX are engine behaviors no prompt can fix. The counter case holds for motion and fails for cutout and engine behaviors.

Counter case 2: the gate failures are about taste, not tool gaps. No tool change would have saved v1 or the rebuild. Observable fact: the rebuild fixed photo realism (the first gate reason) and still failed on three concrete, measurable properties: rise 13 px, grayscale spread 3.2 versus 19, cutout versus rectangle. Each maps to a specific missing capability or check. Taste alone does not explain it. The counter case fails.

## Step 5: Rebuild from true facts

True facts:
- The engine can move a photo up. The study never named the entrance, so Terra never authored it.
- The engine cannot grayscale, blur, mask, or zoom a plain scene at the composition level. Grayscale and blur have proven bake-in workarounds. Zoom has a per-element workaround. Mask has no proven method anywhere.
- The runtime does not apply box.w to rects, and the ledger does not apply scaleX to bbox math. Both are known engine behaviors, queued.
- The checks read static frames only. The ledger holds per-frame data, but no check reads trajectories, saturation, or scale over time.
- The reference photos rise 13 px, are grayscale (face RGB spread 3.2), and are cutouts. Our clip had static color rectangles.

Ranked gaps:
1. Hard blocker, no proven path: photo cutout (mask). Nothing in the engine, no shown asset method.
2. Real gaps with workarounds: grayscale filter on image nodes, blur on image nodes, composition camera or zoom, box.w application to rects.
3. Queued engine bugs: ledger scaleX in bbox math, box.w in the runtime.
4. Authoring gap, not tool: photo rise. The engine can do it. The teardown must name entrances.
5. Measurement gap: checks read static frames only. The ledger data exists, the checks do not use it.

What follows:
- Prove a cutout method first. Test rembg install plus model download, or another matting route, on both staged photos, and view the edges. No Stage 1 promises cutouts before that probe passes.
- Add trajectory, saturation, and scale checks to the verifier, so the next clip cannot pass machine checks while missing motion, color, or camera.
- The rise needs no engine work. It needs a teardown rule: every beat list names how each element enters, not only where it lands.
- Grayscale, blur, and camera stay as bake-in or per-element workarounds unless the cutout work justifies a bigger image-treatment pass.

## Step 6: Record

- Decision: the exploration exposed one hard blocker (cutout), four gaps with workarounds (grayscale, blur, zoom, box.w), two queued engine bugs (ledger scaleX, box.w), one authoring gap (rise), and one measurement gap (checks read static frames only).
- True facts used: generic track sampling in evaluate.mjs; zero camera hits in the schema and evaluator; no mask in the schema or compile.mjs; rembg not installed; box.w and ledger scaleX behaviors from the v1 proof report; static-only predicate checks; measured rise 13 px and grayscale spread 3.2 versus 19.
- Biggest open risk: the cutout has no proven method anywhere, so any Stage 1 that promises cutouts is promising what no one has shown works.
- What would change my mind: a cutout run that produces a clean edge on both staged photos, or a render test showing a rise track working.
- Open questions: does pip install of rembg plus the model download work in this environment? Is the reference zoom composition-level or per-photo? Does a per-element scale read as a zoom to the gate?
