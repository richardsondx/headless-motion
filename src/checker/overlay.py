"""Overlay match: the programmatic version of onion-skinning.

A human in a GUI would lay the original on top of the render at 50%
opacity and nudge the render until the two line up. This module does
the same thing with numbers, so a headless agent can correct by
measurement instead of by eyeballing.

What it returns for one pair of same-size RGB frames (real, ours):
  blend_overlay: the 50/50 mix, the onion skin itself.
  amplified_diff: the per-channel absolute difference, amplified 4x,
    so a 10-level gap reads as 40 and a gap over 64 saturates white.
  layer_differences: mean absolute difference per layer (Sudan, base,
    RSF badge, October title, white text), over the union of the two
    frames' masks for that layer, so a missing element counts.
  element_shifts: for each element, the shift that aligns ours onto
    real, from skimage.registration.phase_cross_correlation on the
    element's binary mask, plus the overlap (IoU) before and after
    shifting. A shift of (dx=+12, dy=+4) means: move ours 12 px right
    and 4 px down to line up with real.
  stroke and rifle counts: measured facts about the two known
    defects. The red subject stroke is counted as signal-red pixels
    around Sudan. The rifle is counted as dark non-orange pixels
    inside the RSF badge (the badge orange is excluded, the white RSF
    text is excluded by luma).

Segmentation is reused from layout.segment_frame and layout.rgb_mask.
Nothing here reimplements it. Vectorized numpy and skimage only, no
per-pixel Python loops, no model downloads. Deterministic: the same
two frames always give the same numbers and the same PNG bytes.
"""
import numpy as np
from scipy import ndimage as _ndi
from skimage.registration import phase_cross_correlation

from checker import layout

SIGNAL_RED = (230, 57, 70)   # #E63946, the forced subject stroke colour
SIGNAL_RED_TOL = 25
BADGE_ORANGE = (204, 71, 38)  # #CC4726, the RSF badge fill
RIFLE_DIST_MIN = 40   # colour distance from badge orange that is not orange
RIFLE_LUMA_MAX = 150  # above this the pixel is the white RSF text, not the rifle
DIFF_GAIN = 4         # amplification for the diff image
SHIFT_MIN_PX = 1.0    # a smaller shift is noise, not a correction
LAYER_DIFF_MIN = 15.0  # mean level gap that counts as a colour correction
MIN_MASK_PIXELS = 20  # a smaller mask cannot be correlated reliably

_REC709 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _check_same_shape(real, ours):
    if real.shape != ours.shape:
        raise ValueError(
            f"frames differ in shape: real {real.shape}, ours {ours.shape}")
    if real.ndim != 3 or real.shape[2] != 3:
        raise ValueError(f"frames must be RGB, got shape {real.shape}")


def blend_overlay(real, ours):
    """The 50/50 onion skin: the mean of the two frames, as uint8."""
    _check_same_shape(real, ours)
    return ((real.astype(np.float32) + ours.astype(np.float32)) * 0.5
            ).round().astype(np.uint8)


def amplified_diff(real, ours, gain=DIFF_GAIN):
    """Per-channel absolute difference, amplified by gain, clipped to 255."""
    _check_same_shape(real, ours)
    d = np.abs(real.astype(np.float32) - ours.astype(np.float32)) * gain
    return np.clip(d, 0, 255).round().astype(np.uint8)


def _white_mask(frame):
    """Bright text pixels, caption and control bar cut off at the bottom."""
    luma = frame.astype(np.float32) @ _REC709
    mask = luma >= layout.WHITE_LUMA_MIN
    mask[layout.CAPTION_CUT_Y:, :] = False
    return mask


def _bright_mask(frame, luma_min):
    """Pixels at or above a luma floor, caption bar cut off at the bottom."""
    luma = frame.astype(np.float32) @ _REC709
    mask = luma >= luma_min
    mask[layout.CAPTION_CUT_Y:, :] = False
    return mask


def _largest_component(mask):
    """Largest connected component of a boolean mask, or all-False."""
    from skimage import measure as _measure
    lab = _measure.label(mask, connectivity=1)
    if lab.max() == 0:
        return np.zeros_like(mask)
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    k = int(np.argmax(counts))
    return lab == k


def _label_components(frame, luma_min=170, min_n=20):
    """Bright components for label finding, in layout._regions shape.

    The white-text layer uses luma 200, but the real labels are dimmer
    than that after YouTube compression: EL FASHER glyph cores read
    about 167 at the 90th percentile, in fragments of 22 to 36 px.
    layout.match_label_near uses 180 for the same reason; label
    finding uses 170 with a 20 px minimum so those fragments survive.
    Returns component dicts with n, bbox [x0, y0, x1, y1] and
    centroid [x, y].
    """
    from skimage import measure as _measure
    mask = _bright_mask(frame, luma_min)
    lab = _measure.label(mask, connectivity=1)
    if lab.max() == 0:
        return []
    out = []
    for props in _measure.regionprops(lab):
        if props.area < min_n:
            continue
        y0, x0, y1, x1 = props.bbox
        cy, cx = props.centroid
        out.append({"n": int(props.area), "bbox": [int(x0), int(y0), int(x1), int(y1)],
                    "centroid": [float(cx), float(cy)]})
    return out


def _bbox_fill(mask):
    """Pixels over bbox area: a scattered-noise mask has near-zero fill."""
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return 0.0
    area = (xs.max() + 1 - xs.min()) * (ys.max() + 1 - ys.min())
    return len(xs) / max(area, 1)


def layer_masks(frame):
    """Full-resolution boolean mask per layer, same palette as layout.py."""
    return {
        "sudan": layout.rgb_mask(frame, layout.PALETTE["sudan"], layout.TOL["sudan"]),
        "base": layout.rgb_mask(frame, layout.PALETTE["base"], layout.TOL["base"]),
        "rsf": layout.rgb_mask(frame, layout.PALETTE["rsf"], layout.TOL["rsf"]),
        "october": layout.rgb_mask(frame, layout.PALETTE["october"], layout.TOL["october"]),
        "white_text": _white_mask(frame),
    }


def _mean_abs_diff(real, ours, mask):
    """Mean absolute RGB difference over mask pixels, pooled over channels."""
    if not mask.any():
        return None
    d = np.abs(real[mask].astype(np.float32) - ours[mask].astype(np.float32))
    return round(float(d.mean()), 2)


def layer_differences(real, ours):
    """Per-layer mean absolute difference, over the union mask of both frames.

    The union is what makes a missing element count: if ours has no
    badge where real has one, the badge pixels still enter the mean.
    """
    _check_same_shape(real, ours)
    rm = layer_masks(real)
    om = layer_masks(ours)
    rseg = layout.segment_frame(real)
    oseg = layout.segment_frame(ours)
    out = {}
    for name in ("sudan", "base", "rsf", "october", "white_text"):
        union = rm[name] | om[name]
        inter = rm[name] & om[name]
        out[name] = {
            "real_pixels": int(rm[name].sum()),
            "ours_pixels": int(om[name].sum()),
            "union_pixels": int(union.sum()),
            "mean_abs_diff": _mean_abs_diff(real, ours, union),
            "intersection_pixels": int(inter.sum()),
            "mean_abs_diff_intersection": _mean_abs_diff(real, ours, inter),
            "real_median_hex": rseg[name].get("median_hex"),
            "ours_median_hex": oseg[name].get("median_hex"),
            "present_real": bool(rseg[name]["present"]),
            "present_ours": bool(oseg[name]["present"]),
        }
    return out


def _bbox_union(b1, b2):
    """Union of two [x0, y0, x1, y1] boxes, or whichever one exists."""
    if b1 is None:
        return b2
    if b2 is None:
        return b1
    return [min(b1[0], b2[0]), min(b1[1], b2[1]),
            max(b1[2], b2[2]), max(b1[3], b2[3])]


def stroke_counts(real, ours):
    """Signal-red pixels in the whole frame and around Sudan.

    Returns counts for both frames. The real video has no red outline,
    so any red around Sudan in ours is the forced subject stroke.
    """
    _check_same_shape(real, ours)
    rseg = layout.segment_frame(real)
    oseg = layout.segment_frame(ours)
    box = _bbox_union(rseg["sudan"].get("bbox"), oseg["sudan"].get("bbox"))
    out = {}
    for name, frame in (("real", real), ("ours", ours)):
        mask = layout.rgb_mask(frame, SIGNAL_RED, SIGNAL_RED_TOL)
        n_all = int(mask.sum())
        n_sudan = None
        if box is not None:
            x0, y0, x1, y1 = box
            n_sudan = int(mask[y0:y1, x0:x1].sum())
        out[name] = {"red_pixels_whole_frame": n_all,
                     "red_pixels_around_sudan": n_sudan}
    out["sudan_bbox"] = box
    return out


def _badge_bbox(real, ours):
    rseg = layout.segment_frame(real)
    oseg = layout.segment_frame(ours)
    return _bbox_union(rseg["rsf"].get("bbox"), oseg["rsf"].get("bbox"))


def rifle_counts(real, ours):
    """Dark non-orange pixels inside the RSF badge: the rifle.

    The badge orange is excluded by colour distance, the white RSF
    text is excluded by luma, so what is left is the rifle icon (and
    compression noise, which is small). The count is taken inside each
    frame's own badge bbox, from segment_frame: counting inside the
    union bbox would also catch the dark land around the badge.
    Ours has a plain orange badge, so it should count near zero.
    """
    _check_same_shape(real, ours)
    rseg = layout.segment_frame(real)
    oseg = layout.segment_frame(ours)
    out = {}
    for name, frame, seg in (("real", real, rseg), ("ours", ours, oseg)):
        box = seg["rsf"].get("bbox")
        out[name + "_bbox"] = box
        if box is None or not seg["rsf"]["present"]:
            out[name] = None
            continue
        x0, y0, x1, y1 = box
        patch = frame[y0:y1, x0:x1].astype(np.int32)
        d2 = np.sum((patch - np.array(BADGE_ORANGE, dtype=np.int32)) ** 2, axis=2)
        luma = frame[y0:y1, x0:x1].astype(np.float32) @ _REC709
        mask = (d2 > RIFLE_DIST_MIN * RIFLE_DIST_MIN) & (luma < RIFLE_LUMA_MAX)
        out[name] = int(mask.sum())
    return out


def _cluster_mask(frame, cluster, luma_min=180):
    """Bright pixels inside one label cluster's bbox.

    Luma 180, not the white-text 200: the real labels read dimmer
    after compression (EL FASHER glyph cores are about 186).
    """
    mask = _bright_mask(frame, luma_min)
    x0, y0, x1, y1 = cluster["bbox"]
    out = np.zeros_like(mask)
    out[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
    return out


def _dot_mask(frame, label_cluster):
    """Bright core pixels of the El Fasher dot, one component only.

    The dot sits just left of the EL FASHER label, about 4 px from the
    E. Taking all bright pixels near it would also catch the E glyph
    and pull the centroid, so the mask is the single bright component
    nearest the expected spot, the same selection layout.find_dot
    makes. Returns the mask and its centroid, or (None, None).
    """
    from skimage import measure as _measure
    x0 = label_cluster["bbox"][0]
    cy = label_cluster["centroid"][1]
    ex, ey = int(x0 - 10), int(cy)
    box = layout.DOT_BOX
    px0, py0 = max(0, ex - box), max(0, ey - box)
    px1, py1 = min(frame.shape[1], ex + box), min(frame.shape[0], ey + box)
    patch = frame[py0:py1, px0:px1].astype(np.float32) @ _REC709
    lab = _measure.label(patch >= layout.DOT_LUMA_MIN, connectivity=1)
    if lab.max() == 0:
        return None, None
    best = None
    for props in _measure.regionprops(lab):
        if props.area < layout.DOT_MIN_N:
            continue
        cy2, cx2 = props.centroid
        d2 = (cx2 + px0 - ex) ** 2 + (cy2 + py0 - ey) ** 2
        if best is None or d2 < best[0]:
            best = (d2, props)
    if best is None:
        return None, None
    props = best[1]
    cy2, cx2 = props.centroid
    mask = np.zeros(frame.shape[:2], dtype=bool)
    mask[py0:py1, px0:px1] = lab == props.label
    return mask, [round(cx2 + px0, 1), round(cy2 + py0, 1)]


def element_masks(real, ours):
    """Binary masks per element, in both frames, plus centroids.

    Elements: sudan, rsf, october (from the layer masks), sudan_label
    and el_fasher_label (from the white-text clusters), el_fasher_dot
    (from the bright core left of the EL FASHER label). Each entry
    carries the two masks and the two centroids, or None where the
    element is absent.
    """
    _check_same_shape(real, ours)
    rm = layer_masks(real)
    om = layer_masks(ours)
    rseg = layout.segment_frame(real)
    oseg = layout.segment_frame(ours)
    out = {}
    # Sudan and the badge are single solid shapes: correlate the largest
    # component only. The raw colour mask also catches scattered grain
    # and compression specks across the frame, which drag the
    # correlation to a wrong peak.
    for name in ("sudan", "rsf"):
        out[name] = {
            "real_mask": _largest_component(rm[name]),
            "ours_mask": _largest_component(om[name]),
            "real_centroid": rseg[name].get("centroid"),
            "ours_centroid": oseg[name].get("centroid"),
        }
    out["october"] = {
        "real_mask": rm["october"], "ours_mask": om["october"],
        "real_centroid": rseg["october"].get("centroid"),
        "ours_centroid": oseg["october"].get("centroid"),
    }
    # Labels are found at luma 170 with a 20 px minimum (see
    # _label_components): the real labels read dimmer than the
    # white-text layer's 200 after compression, and the 200 threshold
    # misses them entirely. Clusters wider than 400 px are dropped
    # before naming: they are the YouTube caption sentence, not a map
    # label (the widest real label is 181 px, the caption is 812 px).
    r_clusters = [c for c in layout.text_clusters(_label_components(real))
                  if c["bbox"][2] - c["bbox"][0] <= 400]
    o_clusters = [c for c in layout.text_clusters(_label_components(ours))
                  if c["bbox"][2] - c["bbox"][0] <= 400]
    r_names = layout.identify_labels(r_clusters)
    o_names = layout.identify_labels(o_clusters)
    for key in ("sudan", "el_fasher"):
        r_cl = r_names.get(key)
        o_cl = o_names.get(key)
        out[key + "_label"] = {
            "real_mask": _cluster_mask(real, r_cl) if r_cl else None,
            "ours_mask": _cluster_mask(ours, o_cl) if o_cl else None,
            "real_centroid": r_cl["centroid"] if r_cl else None,
            "ours_centroid": o_cl["centroid"] if o_cl else None,
        }
    r_dot, r_dot_c = _dot_mask(real, r_names["el_fasher"]) \
        if r_names.get("el_fasher") else (None, None)
    o_dot, o_dot_c = _dot_mask(ours, o_names["el_fasher"]) \
        if o_names.get("el_fasher") else (None, None)
    out["el_fasher_dot"] = {
        "real_mask": r_dot, "ours_mask": o_dot,
        "real_centroid": r_dot_c, "ours_centroid": o_dot_c,
    }
    return out


def _iou(a, b):
    inter = int(np.count_nonzero(a & b))
    union = int(np.count_nonzero(a | b))
    if union == 0:
        return None
    return round(inter / union, 4)


def _shifted(mask, dy, dx):
    """Shift a binary mask by a float shift, nearest neighbour, no wrap."""
    return _ndi.shift(mask.astype(float), shift=(dy, dx), order=0,
                      mode="constant", cval=0.0) > 0.5


def shift_between(real_mask, ours_mask, upsample_factor=10):
    """Shift that aligns ours onto real, from phase cross-correlation.

    Returns dx and dy in px (apply to ours), the magnitude, and the
    overlap (IoU) before and after shifting. None when either mask is
    empty or too small to correlate reliably.
    """
    if real_mask is None or ours_mask is None:
        return None
    if int(real_mask.sum()) < MIN_MASK_PIXELS or int(ours_mask.sum()) < MIN_MASK_PIXELS:
        return None
    shift, error, _ = phase_cross_correlation(
        real_mask.astype(float), ours_mask.astype(float),
        upsample_factor=upsample_factor)
    dy, dx = float(shift[0]), float(shift[1])
    moved = _shifted(ours_mask, dy, dx)
    return {
        "dx_px": round(dx, 1), "dy_px": round(dy, 1),
        "magnitude_px": round(float(np.hypot(dx, dy)), 1),
        "phase_error": round(float(error), 4),
        "iou_before": _iou(real_mask, ours_mask),
        "iou_after_shift": _iou(real_mask, moved),
    }


SHIFT_AGREE_PX = 15.0  # phase shift and centroid delta must agree within this


def element_shifts(real, ours):
    """Shift vector per element, plus the centroid delta as a cross-check.

    A shift only counts as measured when two independent measures
    agree: the phase correlation must improve the overlap (IoU after
    shifting above IoU before), and it must agree with the centroid
    delta within 15 px per axis. Otherwise the row is marked
    unreliable and no correction is built from it; the numbers stay
    in the report so the failure is visible, not hidden. A scattered
    noise mask also fails the fill gate (pixels over bbox area under
    0.02), so a gone title cannot produce a phantom shift.
    """
    _check_same_shape(real, ours)
    elems = element_masks(real, ours)
    out = {}
    for name, e in elems.items():
        rm, om = e["real_mask"], e["ours_mask"]
        if rm is None and om is None:
            status = "absent_in_both"
        elif rm is None:
            status = "absent_in_real"
        elif om is None:
            status = "absent_in_ours"
        elif int(rm.sum()) < MIN_MASK_PIXELS or int(om.sum()) < MIN_MASK_PIXELS \
                or _bbox_fill(rm) < 0.02 or _bbox_fill(om) < 0.02:
            status = "too_small_to_measure"
        else:
            status = "measured"
        row = {"status": status, "shift": None, "reliable": None,
               "centroid_delta_px": None,
               "real_pixels": int(rm.sum()) if rm is not None else 0,
               "ours_pixels": int(om.sum()) if om is not None else 0}
        # The centroid delta is only meaningful when the element is
        # genuinely present in both frames. For absent or noise-only
        # rows it would be a centroid of specks, so it stays None.
        if status == "measured":
            rc, oc = e["real_centroid"], e["ours_centroid"]
            if rc is not None and oc is not None:
                row["centroid_delta_px"] = {
                    "dx_px": round(oc[0] - rc[0], 1),
                    "dy_px": round(oc[1] - rc[1], 1)}
        if status == "measured":
            row["shift"] = shift_between(rm, om)
            s = row["shift"]
            reliable = s["iou_after_shift"] > s["iou_before"]
            cd = row["centroid_delta_px"]
            if reliable and cd is not None:
                reliable = abs(s["dx_px"] - cd["dx_px"]) <= SHIFT_AGREE_PX \
                    and abs(s["dy_px"] - cd["dy_px"]) <= SHIFT_AGREE_PX
            row["reliable"] = bool(reliable)
            if not reliable:
                row["status"] = "unreliable"
        out[name] = row
    return out


def _move_words(dx, dy):
    """Plain-words move for one shift: '12 px right, 4 px down'."""
    parts = []
    if abs(dx) >= SHIFT_MIN_PX:
        parts.append(f"{abs(dx):.0f} px {'right' if dx > 0 else 'left'}")
    if abs(dy) >= SHIFT_MIN_PX:
        parts.append(f"{abs(dy):.0f} px {'down' if dy > 0 else 'up'}")
    return ", ".join(parts)


_DISPLAY = {
    "sudan": "Sudan",
    "rsf": "RSF badge",
    "october": "October 2025 title",
    "sudan_label": "SUDAN label",
    "el_fasher_label": "EL FASHER label",
    "el_fasher_dot": "El Fasher dot",
}


def build_corrections(layers, shifts, stroke, rifle):
    """Plain-words list of what to fix, from the measured numbers only."""
    out = []
    for name, row in shifts.items():
        if row["shift"] is None:
            continue
        if row["status"] == "measured":
            words = _move_words(row["shift"]["dx_px"], row["shift"]["dy_px"])
            if words:
                out.append(f"{_DISPLAY[name]}: move {words}")
        elif row["status"] == "unreliable" and row["centroid_delta_px"] is not None:
            cd = row["centroid_delta_px"]
            words = _move_words(cd["dx_px"], cd["dy_px"])
            # The dot is excepted when the two masks differ in size by
            # more than 3x: in ours the dot touches the E glyph and the
            # two merge into one component, so the centroid is pulled
            # toward the E and is not a measure of the dot alone.
            if name == "el_fasher_dot":
                lo = min(row["real_pixels"], row["ours_pixels"])
                hi = max(row["real_pixels"], row["ours_pixels"])
                if lo == 0 or hi / lo > 3.0:
                    words = ""
            if words:
                out.append(f"{_DISPLAY[name]}: move {words} "
                           f"(from centroids; phase correlation disagreed)")
    ours_red = stroke["ours"]["red_pixels_around_sudan"]
    real_red = stroke["real"]["red_pixels_around_sudan"]
    if ours_red is not None and real_red is not None \
            and ours_red >= 100 and real_red < 100:
        out.append(
            f"Sudan: remove the red subject stroke "
            f"(ours has {ours_red} red pixels around Sudan, real has {real_red})")
    if rifle.get("real") is not None and rifle.get("ours") is not None \
            and rifle["real"] >= 100 and rifle["ours"] < 0.25 * rifle["real"]:
        out.append(
            f"RSF badge: add the rifle "
            f"(real has {rifle['real']} rifle pixels inside the badge, "
            f"ours has {rifle['ours']})")
    for name, row in layers.items():
        inter = row["intersection_pixels"]
        union = row["union_pixels"]
        diff = row["mean_abs_diff_intersection"]
        if diff is not None and diff >= LAYER_DIFF_MIN \
                and inter >= 100 and inter >= 0.25 * union:
            out.append(
                f"{_DISPLAY.get(name, name)} fill: colours differ by "
                f"{diff:.1f} levels on average over the shared area, "
                f"re-measure the colour")
    if not out:
        out.append("No correction larger than 1 px found, and no missing element found.")
    return out


def overlay_report(real, ours, label="overlay check"):
    """Full report for one pair: numbers, shifts, and corrections."""
    _check_same_shape(real, ours)
    d = np.abs(real.astype(np.float32) - ours.astype(np.float32))
    layers = layer_differences(real, ours)
    shifts = element_shifts(real, ours)
    stroke = stroke_counts(real, ours)
    rifle = rifle_counts(real, ours)
    return {
        "label": label,
        "shape": [int(real.shape[0]), int(real.shape[1]), int(real.shape[2])],
        "mean_abs_diff": round(float(d.mean()), 2),
        "mean_abs_diff_by_channel": [round(float(v), 2) for v in d.mean(axis=(0, 1))],
        "layers": layers,
        "shifts": shifts,
        "stroke": stroke,
        "rifle": rifle,
        "corrections": build_corrections(layers, shifts, stroke, rifle),
        "method": {
            "blend": "50/50 mean of the two frames",
            "diff_gain": DIFF_GAIN,
            "shift_method": ("skimage.registration.phase_cross_correlation, "
                             "upsample 10, on each element binary mask; "
                             "the shift is what to apply to ours to align it onto real"),
            "overlap": "IoU of the two masks before and after applying the shift",
            "stroke": "signal-red #E63946 pixels (tol 25) around the Sudan bbox",
            "rifle": ("pixels inside each frame's own RSF badge bbox more "
                      "than 40 levels from badge orange #CC4726 and under "
                      "150 luma, so the white RSF text is excluded"),
            "layers": ("mean absolute RGB difference over the union mask of "
                       "both frames; the colour correction uses the "
                       "intersection instead, so pixels present in only one "
                       "frame (captions, cursor) cannot fake a colour gap"),
            "reliability": ("a shift counts as measured only when shifting "
                            "improves the overlap and the shift agrees with "
                            "the centroid delta within 15 px per axis; "
                            "otherwise the row is marked unreliable and the "
                            "correction falls back to the centroid delta"),
            "labels": ("found at luma 170 with a 20 px minimum, not the "
                       "white-text 200: the real labels read dimmer after "
                       "compression, and 200 misses them entirely; clusters "
                       "wider than 400 px are dropped as caption text"),
        },
        "limits": [
            "Real frames are screenshots of a compressed YouTube stream, not studio frames. They carry a caption bar and player control bar at the bottom, a channel watermark, and a mouse cursor in some frames. All of it raises the mean difference against the clean render.",
            "Real frames were stretched from 1.845:1 to 16:9 (about 4% vertical). A vertical scale is not a translation, so phase correlation on tall elements (Sudan) finds a compromise shift and the overlap after shifting stays below 1.",
            "The rifle count includes compression noise inside the badge, so it is an upper bound, not an exact pixel count of the rifle.",
            "The RSF overlap is capped by the rifle hole in the real badge, so IoU stays low even when the badge is aligned; the centroid delta is the better badge measure.",
            "The real EL FASHER label is faint, so its centroid comes from the bright glyph fragments, not the full glyphs, and can be off by a few px.",
            "Label masks are the bright pixels inside each label cluster bbox at luma 170. A bright mark touching a bbox edge can add a few stray pixels, and the El Fasher dot can join the EL FASHER cluster.",
        ],
    }
