# SAM workaround: first-principles record

Date: Nov 9, 2026. Decision: how to track any object for measurement without SAM.

## Step 1: Name the decision

- Decision: How do we track any object in a video for measurement (trajectory, timing, shape) without depending on SAM?
- Action: Choose and build a tracking approach using only local, $0, CPU-friendly tools.
- If wrong: the measurement tools (trace, timing, contour, layering) fail on objects that are not flat-coloured badges, or we depend on SAM and the tools cannot run locally (too heavy, too slow), so the tool-side measurement breaks.

## Step 2: List what must be true

1. SAM is too heavy to run locally in our tool (needs GPU or is too slow on CPU, large weights). Load bearing. Source: SAM 2 model specs and CPU benchmarks.
2. Colour segmentation only works for distinct flat colours. It fails on textured, multi-colour, or background-similar objects. Load bearing. Source: our own work (badge works because it is flat orange).
3. The measurement tools need the object's position/trajectory over time, and some need its outline/mask. Timing needs centroid/trajectory. Trace needs bbox/position. Contour needs outline. Layering needs object region. Load bearing. Source: our tools' designs (U9 dimensions, run workspaces).
4. A lightweight tracker (OpenCV KCF/CSRT/MOSSE) can track a bounding box for any object given an initial box, on CPU, with no neural model. Load bearing. Source: OpenCV documentation and benchmarks.
5. A bbox trajectory is sufficient for timing and trace; a mask within the bbox (via colour segmentation constrained to the bbox) is sufficient for contour and layering. Load bearing. Source: design reasoning (needs a test).
6. The initial bbox can come from the trace (hand-measured) or from the user (click/box), so the tracker does not need to detect the object from scratch. Load bearing. Source: our trace already provides bboxes (seg4-trace.json).

## Step 3: Test each claim

1. SAM too heavy: VERIFIED. SAM 2 Tiny on CPU runs at 2-5 FPS on 1024x1024 images; Small at 1-3 FPS; Base+ at 0.5-2 FPS. SAM 2.1 Hiera Tiny averages 1.5-2.8s per frame during video propagation on modern CPUs. SAM2-b is 162 MB, 80.8M params, 28,867 ms per image on CPU (vs YOLO11n-seg at 24.3 ms). For 192 frames, SAM Tiny would take 38-96s at 2-5 FPS, or 288-538s at 1.5-2.8s/frame for video propagation. That is too slow for a fast local tool, and it needs 40-78 MB of weights plus torch.
2. Colour segmentation only for flat colours: VERIFIED (from our own work). The badge is flat orange #CC4726 and colour segmentation works. A textured object, or one whose colour matches the background, would fail. The trace and contour tools rely on colour, and the U9 dimensions note the segmentation is colour-based.
3. Tools need position/trajectory/outline: VERIFIED (from our tools' designs). Timing computes the time offset from the centroid trajectory. Trace records bbox/position. Contour computes Chamfer/Hausdorff from the outline. Layering needs the object region.
4. OpenCV trackers work on CPU, no GPU, no neural model: VERIFIED. CSRT retains 96.2% of markers with mean deviation 1.94 pixels at 56.9 FPS, on CPU, no GPU backend used. KCF runs at 445.4 FPS (single-thread CPU) with the same deviation but fails under occlusion (retains 64.1%). MOSSE reaches ~12,500 FPS but retains only 49.6%. CSRT is described as one of the best general-purpose trackers in OpenCV, high accuracy, robust to scale changes, partial occlusion, and illumination variations. CSRT runs at 30-40 FPS; KCF at 200-250 FPS.
5. Bbox sufficient for timing/trace; mask-within-bbox sufficient for contour/layering: PARTLY VERIFIED, needs refinement. Timing needs the centroid; a tracker bbox centre gives it. Trace needs the bbox; a tracker gives it directly. So bbox is sufficient for timing and trace on ANY object. Contour needs the outline; colour within the bbox gives a mask for flat objects, but for textured objects colour within the bbox may not give a clean outline. So the claim holds for timing/trace on any object, and for contour/layering on flat objects. For textured objects' contour, a fallback is needed (bbox as coarse outline, or edge detection within the bbox).
6. Initial bbox from trace or user: VERIFIED (from our work). seg4-trace.json provides bboxes for the badge, labels, and Sudan. The tool can take a bbox as input.

Fetch list:
- SAM 2 model size and CPU speed: search "SAM 2 Segment Anything model size weights CPU performance requirements" (done, see claim 1).
- OpenCV KCF/CSRT/MOSSE tracker CPU performance: search "OpenCV KCF CSRT MOSSE tracker CPU no GPU bounding box tracking" (done, see claim 4).

## Step 4: Ask what would break it

Counter case 1: The OpenCV tracker will drift or lose the object, so the trajectory will be wrong. Observable fact that would prove it: CSRT deviation on the Seg4 badge vs the trace exceeds ~5 px, or retention drops. Check: the MDPI study shows CSRT retains 96.2% with 1.94 px deviation, and CSRT is robust to scale changes. The badge grows (118x68 to 160x166) and moves, which CSRT handles. But the study was on faces with markers, not our map badge. This needs a test: run CSRT on the Seg4 badge and measure deviation vs the trace. Not yet run. If it drifts, the plan needs a re-initialization step (re-detect every N frames) or a different tracker.

Counter case 2: SAM Tiny on CPU is actually fast enough (2-5 FPS), so we should just use SAM. Observable fact: SAM Tiny at 2-5 FPS means 192 frames take 38-96s. That is not terrible for a one-off, but our tool runs many checks and needs to be fast. SAM also needs 40-78 MB of weights plus torch installed, which breaks the tool's $0/fast/local constraints (no heavy install). The OpenCV tracker is 30-57 FPS (CSRT) with no weights download. So SAM is a viable fallback if the OpenCV tracker fails, but it is not the best choice for our constraints. Counter case does not hold for our constraints.

## Step 5: Rebuild from true facts

True facts:
- SAM 2 Tiny on CPU is 2-5 FPS (or 1.5-2.8s/frame for video propagation), needs 40-78 MB weights plus torch. Too slow and heavy for our fast local tool.
- OpenCV CSRT runs at 30-57 FPS on CPU, no GPU, no weights, 96.2% retention, 1.94 px deviation.
- Colour segmentation only works for distinct flat colours.
- Timing needs centroid/trajectory; trace needs bbox; contour needs outline; layering needs region.
- A bbox from a tracker gives the centroid (timing) and bbox (trace) for ANY object, regardless of colour.
- Colour within the bbox gives a mask for flat objects (contour/layering), but not reliably for textured objects.

Rebuilt answer: Use an OpenCV CSRT tracker, initialized from the trace bbox (or a user box), to track the object's bbox across frames. This gives the trajectory for timing and trace on ANY object. For the mask (contour, layering), use colour segmentation constrained to the tracked bbox. This works for flat objects and is more robust than global colour segmentation because the bbox excludes most background. For textured objects' contour, fall back to the bbox as a coarse outline or use edge detection within the bbox. Do NOT use SAM: it is too slow on CPU (2-5 FPS, 1.5-2.8s/frame) and needs large weights plus torch, which breaks the tool's $0/fast/local constraints. The OpenCV tracker is the right tool: 30-57 FPS, no weights, CPU only.

Dropped: the idea that colour segmentation alone is sufficient for all objects (it is not). The idea that SAM is the only way to track any object (it is not; OpenCV trackers do it on CPU).

## Step 6: Decide and record

- Decision: Use OpenCV CSRT tracker (bbox) plus colour-within-bbox (mask) for object measurement, not SAM.
- Claim 1 (SAM too heavy): verified, SAM 2 Tiny 2-5 FPS on CPU, 1.5-2.8s/frame video propagation, 40-78 MB weights plus torch.
- Claim 2 (colour only for flat colours): verified, from our own work (badge is flat orange).
- Claim 3 (tools need position/trajectory/outline): verified, from our tools' designs.
- Claim 4 (OpenCV trackers CPU, no GPU): verified, CSRT 96.2% retention, 1.94 px deviation, 56.9 FPS, CPU only, no GPU backend.
- Claim 5 (bbox sufficient for timing/trace; mask-within-bbox for contour/layering): partly verified. Bbox is sufficient for timing and trace on any object. Mask-within-bbox is sufficient for contour/layering on flat objects; textured objects need a fallback (bbox as coarse outline or edge detection).
- Claim 6 (initial bbox from trace or user): verified, seg4-trace.json provides bboxes.
- True facts used: SAM CPU speed and weight size; CSRT CPU speed, retention, and deviation; colour segmentation limits; tools' input requirements; bbox gives centroid and position.
- Biggest open risk: the CSRT tracker may drift on our specific content (the badge grows and moves fast); it needs a test on the Seg4 badge vs the trace.
- What would change my mind: if CSRT drifts more than ~5 px on the Seg4 badge, or if SAM Tiny proves fast enough in practice (under 30s for 192 frames) and the install burden is acceptable.
- Open questions: (1) Run CSRT on the Seg4 badge and measure deviation vs the trace. (2) For textured objects' contour, is the bbox as a coarse outline good enough, or is edge detection within the bbox needed? (3) Does the engine venv have OpenCV (cv2 is not in the venv; it would need to be added, or the tracker runs in the system python).

## CSRT test result (Nov 9, 2026, ~01:20 EST) — FAIL

Ran CSRT on the Seg4 reference video (1920x1038, 23.976 fps), initialized at 4s with the trace bbox (903, 508.9, 130, 129.8 in video coords). Compared the CSRT centre (converted to 1920x1080) to the trace centre at 5s, 6s, 7s. Full JSON: verify-seg4/evidence/work/csrt-badge-test.json. Script: verify-seg4/evidence/work/csrt-badge-test.py. OpenCV 5.0.0 in /tmp/csrt-venv (opencv-contrib-python-headless, CSRT available).

- At 5s: CSRT (953.5, 554.6) vs trace (799, 666). Deviation 190.49 px.
- At 6s: CSRT (738.0, 651.8) vs trace (699, 727). Deviation 84.67 px.
- At 7s: CSRT (682.0, 683.1) vs trace (693, 732). Deviation 50.16 px.
- Verdict: FAIL against the 5 px bar, by a wide margin.

What happened: CSRT lags the badge. At 5s it is still near the 4s position (968, 597), not the 5s position (799, 666). It catches up partway by 6s and 7s but stays 50-85 px off. The badge moves ~182 px in one second (4s to 5s) while the camera zooms, so the background is moving too. CSRT's correlation filter cannot keep up with the fast motion plus the zooming background.

Consequence for the decision: the CSRT tracker approach does NOT work for the Seg4 badge as implemented. Claim 4 (CSRT works on CPU) is true in general (from the study: 96.2% retention, 1.94 px deviation), but it fails on this content. The decision to use CSRT is WRONG for this content. The approach needs a fix: re-initialize CSRT every second from a colour detection (hybrid: colour finds the badge, CSRT tracks within the second), or use a different method (template matching with a scale pyramid, or colour segmentation alone for this flat-coloured badge). The colour segmentation we already have works for the badge because it is flat orange; CSRT was meant to generalize to non-flat objects, but it fails here. The record's Step 5 rebuild is therefore not validated for the Seg4 badge.
