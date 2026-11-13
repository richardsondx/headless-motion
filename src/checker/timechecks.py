"""Time checks: trajectory, saturation, and scale over time.

These checks read motion, color, and camera over time. The fail-fast
stages S0 to S7 in stages.py read single frames only, so a clip with
static photos, color photos, and a static camera passed every machine
check twice and failed the human gate twice. The ledger holds
per-frame rows, so the data exists. These checks read it.

Thresholds live here as named constants with their source, NOT in
predicate.json (pred-v1 is frozen). This follows the S9 precedent in
stages.py.
"""
import numpy as np

# Trajectory bar, 2 px on every component. Source: the Stage 1 package
# for run stage2-verifier-checks-2026-11-10-01. The bar is the same bar
# the ledger checks already use. The reference Trump photo centroid
# moves up 13 px from f01 to f09, measured from the reference frames.
TRAJECTORY_BAR_PX = 2.0

# Saturation bar, mean per-pixel channel spread (max minus min across
# R, G, B). Source: the Stage 1 package. The reference Trump face
# mean RGB is 138.5, 135.4, 138.6, spread 3.2, grayscale. Our still
# is 129.3, 134.7, 148.3, spread 19, full color. The bar 5 sits
# between 3.2 and 19. Grayscale passes at 5 or less. Color passes
# above 5.
SATURATION_GRAYSCALE_MAX = 5.0

# Scale bar, 0.01 on the growth ratio. Source: the Stage 1 package.
# The camera run proved a 5 percent push-in (a marker grows 400 to
# 420 px, exactly 5.000 percent). A static camera reads 1.00. The bar
# 0.01 leaves room for pixel noise.
SCALE_RATIO_BAR = 0.01

# The ledger camera column reads zoom ratio 1 for scene cameras. That
# gap is queued from the camera run (stage2-camera-zoom-2026-11-10-01).
# Until it closes, a scene camera scale check must read pixel-measured
# marker growth instead. The ledger camera value is never treated as
# proof of a scene camera move without that note.
LEDGER_CAMERA_GAP = ("ledger camera column reads zoom ratio 1 for "
                     "scene cameras (queued gap from the camera run)")


def _row_at(ledger, element_id, frame):
    """Return the ledger row for one element at one frame, or None."""
    for row in ledger.get("rows", []):
        if row.get("element_id") == element_id and row.get("frame") == frame:
            return row
    return None


def _camera_zoom_at(ledger, frame):
    """Return the ledger camera zoom ratio at one frame, or None."""
    for row in ledger.get("rows", []):
        if row.get("frame") == frame:
            zoom = (row.get("camera") or {}).get("zoom_ratio")
            if zoom is not None:
                return float(zoom)
    return None


def _fail(check, entry, message, **extra):
    result = {"check": check, "verdict": "fail", "message": message}
    result.update(extra)
    return result


def check_trajectory(ledger, entry):
    """Check one element's displacement over a window.

    ledger is a ledger dict in schema hme.ledger/1.0. entry names the
    element, the window (start_frame and end_frame), the planned
    displacement [dx, dy] in px, and the source of the planned value.
    The check reads the ledger centre at the start and end frames and
    compares the measured displacement to the planned displacement.
    It passes when every component is within TRAJECTORY_BAR_PX of
    planned.

    A points-shape element is not excluded. Its ledger row uses the
    box approximation, so the check inherits the points-shape ledger
    gap (right edge 21 px off, bottom 91 px off, measured in the
    ledger scaleX run). Pass entry["points_shape"] as True for such
    an element and the result carries a warning naming the gap.
    """
    element_id = entry.get("element_id")
    window = entry.get("window", {})
    start = window.get("start_frame")
    end = window.get("end_frame")
    planned = [float(v) for v in entry.get("planned_displacement", [0, 0])]
    base = {"element_id": element_id, "window": window,
            "planned_displacement": planned,
            "source": entry.get("source"),
            "bar_px": TRAJECTORY_BAR_PX}
    if entry.get("points_shape"):
        base["warning"] = ("points-shape element: ledger centre uses "
                           "the box approximation, so this check inherits "
                           "the points-shape ledger gap (right edge 21 px "
                           "off, bottom 91 px off, ledger scaleX run)")
    start_row = _row_at(ledger, element_id, start)
    end_row = _row_at(ledger, element_id, end)
    if start_row is None or end_row is None:
        return _fail("trajectory", entry,
                     f"element {element_id} has no ledger row at frame "
                     f"{start if start_row is None else end}", **base)
    start_centre = start_row.get("centre_px")
    end_centre = end_row.get("centre_px")
    if start_centre is None or end_centre is None:
        return _fail("trajectory", entry,
                     f"element {element_id} has no centre at frame "
                     f"{start if start_centre is None else end}", **base)
    measured = [float(end_centre[0] - start_centre[0]),
                float(end_centre[1] - start_centre[1])]
    errors = [abs(measured[i] - planned[i]) for i in range(2)]
    passed = all(e <= TRAJECTORY_BAR_PX for e in errors)
    result = {"check": "trajectory",
              "verdict": "pass" if passed else "fail",
              "measured_displacement": [round(v, 2) for v in measured],
              "component_errors_px": [round(v, 2) for v in errors],
              "message": (f"element {element_id} moved "
                          f"{measured[0]:.2f}, {measured[1]:.2f} px over "
                          f"frames {start} to {end}, planned "
                          f"{planned[0]:.2f}, {planned[1]:.2f} px")}
    result.update(base)
    return result


def check_saturation(frames, entry):
    """Check the color treatment of one region over a window.

    frames is a sequence of RGB frames (numpy arrays) indexed by
    frame number. entry names the region [x, y, w, h], the treatment
    ("grayscale" or "color"), the window, and the source of the
    planned treatment. The check computes the mean per-pixel channel
    spread (max minus min across R, G, B) over the region, sampled at
    the start, middle, and end frames of the window. Grayscale passes
    when the mean spread is SATURATION_GRAYSCALE_MAX or less. Color
    passes when the mean spread is above it.
    """
    region = entry.get("region", [0, 0, 0, 0])
    treatment = entry.get("treatment")
    window = entry.get("window", {})
    start = window.get("start_frame", 0)
    end = window.get("end_frame", start)
    base = {"region": region, "treatment": treatment, "window": window,
            "source": entry.get("source"),
            "bar": SATURATION_GRAYSCALE_MAX}
    if treatment not in ("grayscale", "color"):
        return _fail("saturation", entry,
                     f"treatment must be grayscale or color, got {treatment}",
                     **base)
    x, y, w, h = (int(v) for v in region)
    sample_frames = sorted(set([start, (start + end) // 2, end]))
    spreads = []
    for f in sample_frames:
        if f is None or f < 0 or f >= len(frames) or frames[f] is None:
            return _fail("saturation", entry,
                         f"no rendered frame {f} for the saturation check",
                         **base)
        frame = np.asarray(frames[f])
        patch = frame[y:y + h, x:x + w]
        if patch.size == 0:
            return _fail("saturation", entry,
                         f"region {region} is empty on frame {f}", **base)
        spread = patch.max(axis=2).astype(float) - patch.min(axis=2).astype(float)
        spreads.append(float(spread.mean()))
    mean_spread = float(np.mean(spreads))
    if treatment == "grayscale":
        passed = mean_spread <= SATURATION_GRAYSCALE_MAX
    else:
        passed = mean_spread > SATURATION_GRAYSCALE_MAX
    result = {"check": "saturation",
              "verdict": "pass" if passed else "fail",
              "measured_mean_spread": round(mean_spread, 2),
              "per_frame_spreads": [round(v, 2) for v in spreads],
              "sampled_frames": sample_frames,
              "message": (f"region {region} mean channel spread "
                          f"{mean_spread:.2f} over frames {sample_frames}, "
                          f"treatment {treatment}, bar "
                          f"{SATURATION_GRAYSCALE_MAX}")}
    result.update(base)
    return result


def measure_marker_growth(frames, marker):
    """Measure a marker's distance growth from a zoom centre in pixels.

    frames is a sequence of RGB frames indexed by frame number.
    marker names the zoom centre [x, y], the search rects
    [x, y, w, h] for the start and end frames, the window, and the
    luma threshold that separates the marker from the ground. The
    marker centroid in each search rect is the mean position of the
    pixels above the threshold. The growth is the end distance over
    the start distance, both measured from the centre. Returns
    (start_px, end_px, growth_ratio).
    """
    centre = marker.get("centre", [0, 0])
    threshold = float(marker.get("luma_threshold", 100))
    window = marker.get("window", {})
    start = window.get("start_frame", 0)
    end = window.get("end_frame", start)
    rects = marker.get("search_rects", {})
    distances = []
    for frame_no, key in ((start, "start"), (end, "end")):
        rect = rects[key]
        x, y, w, h = (int(v) for v in rect)
        frame = np.asarray(frames[frame_no])
        patch = frame[y:y + h, x:x + w].astype(float)
        luma = 0.2126 * patch[:, :, 0] + 0.7152 * patch[:, :, 1] + 0.0722 * patch[:, :, 2]
        ys, xs = np.nonzero(luma > threshold)
        if len(xs) == 0:
            raise ValueError(f"no marker pixels above luma {threshold} "
                             f"in {key} search rect {rect} at frame {frame_no}")
        cx = x + float(xs.mean())
        cy = y + float(ys.mean())
        distances.append(float(np.hypot(cx - centre[0], cy - centre[1])))
    return distances[0], distances[1], distances[1] / distances[0]


def check_scale(ledger, entry, marker_growth=None):
    """Check one growth ratio over a window.

    ledger is a ledger dict in schema hme.ledger/1.0. entry names the
    kind ("element" or "camera"), the window, the planned growth
    ratio, and the source of the planned value. The check passes when
    the measured ratio is within SCALE_RATIO_BAR of planned.

    An element scale reads the ledger bbox width at the start and end
    frames. Its source is "ledger-bbox-width". A camera scale reads
    the pixel-measured marker growth when marker_growth is given as
    (start_px, end_px); its source is "pixel-marker-growth". Without
    marker growth it reads the ledger camera zoom ratio; its source
    is "ledger-camera-zoom-ratio", and the result carries the ledger
    camera gap note, because the ledger camera column reads 1 for
    scene cameras.
    """
    kind = entry.get("kind", "element")
    window = entry.get("window", {})
    start = window.get("start_frame")
    end = window.get("end_frame")
    planned = float(entry.get("planned_ratio", 1.0))
    base = {"kind": kind, "window": window, "planned_ratio": planned,
            "source": entry.get("source"), "bar": SCALE_RATIO_BAR}
    if kind == "camera" and marker_growth is not None:
        start_px, end_px = (float(v) for v in marker_growth)
        if start_px <= 0:
            return _fail("scale", entry,
                         f"marker start distance {start_px} is not positive",
                         **base)
        ratio = end_px / start_px
        base["measurement_source"] = "pixel-marker-growth"
        base["marker_start_px"] = round(start_px, 2)
        base["marker_end_px"] = round(end_px, 2)
    elif kind == "camera":
        start_zoom = _camera_zoom_at(ledger, start)
        end_zoom = _camera_zoom_at(ledger, end)
        if start_zoom is None or end_zoom is None:
            return _fail("scale", entry,
                         f"no ledger camera zoom at frame "
                         f"{start if start_zoom is None else end}", **base)
        if start_zoom == 0:
            return _fail("scale", entry,
                         "ledger camera zoom is 0 at the start frame", **base)
        ratio = end_zoom / start_zoom
        base["measurement_source"] = "ledger-camera-zoom-ratio"
        base["ledger_camera_gap"] = LEDGER_CAMERA_GAP
        base["start_zoom"] = round(start_zoom, 4)
        base["end_zoom"] = round(end_zoom, 4)
    else:
        element_id = entry.get("element_id")
        base["element_id"] = element_id
        start_row = _row_at(ledger, element_id, start)
        end_row = _row_at(ledger, element_id, end)
        if start_row is None or end_row is None:
            return _fail("scale", entry,
                         f"element {element_id} has no ledger row at frame "
                         f"{start if start_row is None else end}", **base)
        start_box = start_row.get("bbox_px")
        end_box = end_row.get("bbox_px")
        if start_box is None or end_box is None:
            return _fail("scale", entry,
                         f"element {element_id} has no bbox at frame "
                         f"{start if start_box is None else end}", **base)
        start_w = float(start_box[2] - start_box[0])
        end_w = float(end_box[2] - end_box[0])
        if start_w <= 0:
            return _fail("scale", entry,
                         f"element {element_id} bbox width {start_w} is not "
                         f"positive at frame {start}", **base)
        ratio = end_w / start_w
        base["measurement_source"] = "ledger-bbox-width"
        base["start_width_px"] = round(start_w, 2)
        base["end_width_px"] = round(end_w, 2)
    error = abs(ratio - planned)
    passed = error <= SCALE_RATIO_BAR
    result = {"check": "scale",
              "verdict": "pass" if passed else "fail",
              "measured_ratio": round(ratio, 4),
              "ratio_error": round(error, 4),
              "message": (f"{kind} growth ratio {ratio:.4f} over frames "
                          f"{start} to {end}, planned {planned:.4f}, "
                          f"error {error:.4f} against bar {SCALE_RATIO_BAR}")}
    result.update(base)
    return result


def run_timechecks(ledger, frames, plan):
    """Run every check in a plan file and return one report dict.

    ledger is a ledger dict. frames is a sequence of RGB frames
    indexed by frame number, or None when no frames were supplied.
    plan is a plan dict with a "checks" list. Each entry has a
    "check" key: "trajectory", "saturation", or "scale". A camera
    scale entry may carry a "marker" dict; the marker growth is then
    measured from the rendered frames. The report verdict is "pass"
    only when every check passes.
    """
    results = []
    for entry in plan.get("checks", []):
        name = entry.get("check")
        if name == "trajectory":
            results.append(check_trajectory(ledger, entry))
        elif name == "saturation":
            if frames is None:
                results.append(_fail("saturation", entry,
                                     "no rendered frames supplied for the "
                                     "saturation check",
                                     region=entry.get("region"),
                                     treatment=entry.get("treatment"),
                                     window=entry.get("window"),
                                     source=entry.get("source"),
                                     bar=SATURATION_GRAYSCALE_MAX))
            else:
                results.append(check_saturation(frames, entry))
        elif name == "scale":
            marker_growth = None
            if entry.get("kind") == "camera" and entry.get("marker") is not None:
                if frames is None:
                    results.append(_fail("scale", entry,
                                         "no rendered frames supplied for "
                                         "the pixel marker measurement",
                                         kind="camera",
                                         window=entry.get("window"),
                                         planned_ratio=entry.get("planned_ratio"),
                                         source=entry.get("source"),
                                         bar=SCALE_RATIO_BAR))
                    continue
                try:
                    marker_growth = measure_marker_growth(frames, entry["marker"])
                except (ValueError, IndexError, KeyError) as e:
                    results.append(_fail("scale", entry,
                                         f"marker measurement failed: {e}",
                                         kind="camera",
                                         window=entry.get("window"),
                                         planned_ratio=entry.get("planned_ratio"),
                                         source=entry.get("source"),
                                         bar=SCALE_RATIO_BAR))
                    continue
            results.append(check_scale(ledger, entry,
                                       marker_growth=marker_growth))
        else:
            results.append(_fail(name, entry,
                                 f"unknown check {name!r} in plan file"))
    verdict = "pass" if results and all(r["verdict"] == "pass" for r in results) else "fail"
    return {"schema": "hme.timechecks-report/1.0",
            "plan": plan.get("clip"),
            "verdict": verdict,
            "checks": results}
