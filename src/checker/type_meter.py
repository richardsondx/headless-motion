"""Type measurement core for `hme type`.

Measures letterforms in two labels (the October 2025 title and the
EL FASHER label) on paired reference / render frames.

Method, from the Stage 1 predicate (stage1-type-meter-2026-11-08-02,
section 3) and the first-principles ladder (tested on the real Seg4
frames, not re-derived):

- Ink is adaptive: a pixel brighter than its local background median
  by 40. The background median is the median luma of a 12 px ring
  around the label box in the full frame, because glyphs cover most
  of the EL FASHER ours crop, so the crop median is glyph luma there
  (226.9) and a crop-median threshold finds no ink at all. The ring
  median is dark map on both labels (about 24 to 50). The fixed 180
  numbers are also reported, only for the U9 reproduction check.
- Segmentation fix, in order: exclude a disc of radius 12 px around
  the known El Fasher dot centre; keep only components whose
  y-interval overlaps the glyph row band by at least half their own
  height; split merged letters at vertical projection valleys (a
  valley column with at most 8 ink px, with at least 40 px of glyph
  on each side); merge fragments that share a letter slot (their
  x-intervals overlap by at least half the narrower width); drop
  specks shorter than a quarter of the tallest letter. The trace box
  clips the October title: the "5" sits outside it, so the crop is
  extended 25 px at a time while the 25 px strip just outside an
  edge holds ink that spans at least half the crop height inside
  the glyph band. A component lying entirely outside the original
  trace box counts only when it shares the glyph row top and
  baseline, so badge and dot junk pulled in by the extension does
  not count. The ladder's "one merge in October ref" is wrong on
  the pixels: there is no merge, the "5" is outside the box and
  pops in between frames 12 and 14, so frame 12 has 10 letters
  and frame 24 has 11.
- Per-letter overlap: letters match by order only when counts are
  equal, else the counts are reported and the pairing is refused.
  Each letter is normalised to its own bbox, resampled to a 32x32
  grid, and IoU of ink masks is computed. Cap height ratio and
  centroid shift are reported separately, so shape is not
  conflated with size or position.
- Spacing: median gap in px and as gap over cap height, plus the
  full per-pair gap list. Stroke: twice the median distance
  transform inside the ink, in px and over cap height, with the
  quantisation stated. Anti-aliasing: edge transition width in px
  on a straight stem scanline, plus the U9 fraction with its caveat.
- Frames are per label, not one set. EL FASHER uses 156, 168, 180.
  October ref uses 12 and 24, ours uses 24 and 36. The label
  numbers come from each side's fullest frame (most letters, then
  most ink), and both frames are named.

Reuse rule: the fixed 180 reproduction calls
checker.dimensions.type_metrics directly, with no re-derivation.
The adaptive stroke, gap, and AA numbers use the same formulas
as type_metrics (median gap between x boxes, twice the median
distance transform, share of erosion edge pixels with luma 40 to
200), applied to the fixed segmentation instead of the raw mask.

U9 ground truth (u9-compare.json, dimensions.type, EL FASHER only,
frames 156, 168, 180, per-frame dot window): ref letters mean 8.6667,
ours 8, ref median gap 3 px, ours 2 px, ref median stroke 2 px, ours
4 px, ref AA fraction 0.184, ours 0.1987. U9 does not use the static
trace dot centre (783, 646). On each frame it finds the dot from the
RSF badge top-right corner with layout.find_dot (bright component
nearest the corner, luma at least 170, at least 20 px, within 30 px
of the corner), then windows x int(dx) - 10 to int(dx) + 220 and
y int(dy) - 25 to int(dy) + 25 around the detected centroid, and
calls dimensions.type_metrics (connectivity 2, min 3 px) at fixed
threshold 180. The detected ref centroids are (804.9, 626.4) at
frame 156, (788.1, 649.0) at 168, and (788.0, 650.4) at 180, so the
windows give ref letters 8, 9, 9, total 26, mean 8.6667. The static
trace-centre window gives 10, 9, 9, mean 9.3333, and no static centre
within plus or minus 4 px of (783, 646) gives 26 with the min 3 px
rule (81 centres tried: totals 27 or 28). The trace-box window is
kept in the report for the record only.
"""
import json
from functools import lru_cache

import numpy as np
from PIL import Image
from scipy import ndimage
from skimage import measure as _measure

from checker import dimensions, layout

ADAPTIVE_DELTA = 40
FIXED_THRESHOLD = 180
DOT_DISC_RADIUS = 12
RING_WIDTH = 12
EXTEND_STEP = 25
EXTEND_MAX = 12
VALLEY_MAX_INK = 8
VALLEY_MIN_SIDE = 40
GRID = 32

# U9 ground truth, EL FASHER only, frames 156, 168, 180.
U9 = {
    "ref_letters_mean": 8.6667,
    "ours_letters_mean": 8,
    "ref_median_gap_px": 3,
    "ours_median_gap_px": 2,
    "ref_median_stroke_px": 2,
    "ours_median_stroke_px": 4,
    "ref_aa_fraction": 0.184,
    "ours_aa_fraction": 0.1987,
}


def _load_luma(path):
    """Rec.709 luma of a frame, cached by path.

    The same frame is measured twice (once for the label, once for
    the fixed 180 reproduction) and October frames recur in the fade
    curve, so caching cuts the run from about 70 s to about 40 s.
    """
    return _load_luma_cached(path)


@lru_cache(maxsize=64)
def _load_luma_cached(path):
    return dimensions.luma_of(np.array(Image.open(path).convert("RGB")))


def _label_components(mask, min_n=3):
    """Connected components of a boolean mask, sorted by x0.

    Each entry has pixel count n and bbox [x0, y0, x1, y1] in mask
    coordinates. Connectivity 2, min 3 px, the type_metrics rule.
    """
    if mask is None or not mask.any():
        return []
    lab = _measure.label(mask, connectivity=2)
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    out = []
    for k in range(1, len(counts)):
        if counts[k] >= min_n:
            ys, xs = np.where(lab == k)
            out.append({"n": int(counts[k]),
                        "x0": int(xs.min()), "x1": int(xs.max()) + 1,
                        "y0": int(ys.min()), "y1": int(ys.max()) + 1})
    return sorted(out, key=lambda c: c["x0"])


def _tight(mask_slice, x0, y0):
    """Tight bbox and mask of a mask slice, or None when empty."""
    if not mask_slice.any():
        return None
    ys, xs = np.where(mask_slice)
    return {"mask": mask_slice[int(ys.min()):int(ys.max()) + 1,
                                int(xs.min()):int(xs.max()) + 1],
            "x0": x0 + int(xs.min()), "x1": x0 + int(xs.max()) + 1,
            "y0": y0 + int(ys.min()), "y1": y0 + int(ys.max()) + 1,
            "n": int(mask_slice.sum())}


def _split_letter(mask, letter):
    """Split one letter at vertical projection valleys, recursively.

    A valley is a column with at most VALLEY_MAX_INK ink px and at
    least VALLEY_MIN_SIDE px of glyph on each side. A single glyph
    can hold a deeper-looking valley in its own shape (the "r"
    notch is 16 px at its narrowest), so the 8 px ceiling is what
    keeps the split to real bridges between glyphs.
    """
    sub = mask[letter["y0"]:letter["y1"], letter["x0"]:letter["x1"]]
    prof = sub.sum(axis=0).astype(float)
    w = len(prof)
    best = None
    for i in range(VALLEY_MIN_SIDE, w - VALLEY_MIN_SIDE):
        if prof[i] <= VALLEY_MAX_INK and (best is None or prof[i] < best[1]):
            best = (i, float(prof[i]))
    if best is None:
        return [letter]
    i, _ = best
    out = []
    for piece in (_tight(sub[:, :i], letter["x0"], letter["y0"]),
                  _tight(sub[:, i + 1:], letter["x0"] + i + 1, letter["y0"])):
        if piece is not None:
            out.extend(_split_letter(mask, piece))
    return out


def _merge_fragments(letters):
    """Merge fragments that share a letter slot.

    Two pieces merge when their x-intervals overlap by at least half
    the narrower width, which is a glyph split across rows (a dot
    over a stem, a glyph cut by the crop edge), not two letters
    side by side, which never overlap in x by that much.
    """
    out = []
    for letter in sorted(letters, key=lambda c: c["x0"]):
        if out:
            prev = out[-1]
            overlap = min(prev["x1"], letter["x1"]) - max(prev["x0"], letter["x0"])
            narrower = min(prev["x1"] - prev["x0"], letter["x1"] - letter["x0"])
            if overlap >= 0.5 * narrower:
                x0 = min(prev["x0"], letter["x0"])
                y0 = min(prev["y0"], letter["y0"])
                x1 = max(prev["x1"], letter["x1"])
                y1 = max(prev["y1"], letter["y1"])
                canvas = np.zeros((y1 - y0, x1 - x0), dtype=bool)
                canvas[prev["y0"] - y0:prev["y1"] - y0,
                       prev["x0"] - x0:prev["x1"] - x0] |= prev["mask"]
                canvas[letter["y0"] - y0:letter["y1"] - y0,
                       letter["x0"] - x0:letter["x1"] - x0] |= letter["mask"]
                tight = _tight(canvas, x0, y0)
                out[-1] = tight if tight is not None else prev
                continue
        out.append(letter)
    return out


def _band_of(components):
    """Glyph row band: median top and median bottom of the tall comps."""
    heights = np.array([c["y1"] - c["y0"] for c in components], dtype=float)
    tall = [c for c in components if c["y1"] - c["y0"] >= 0.5 * heights.max()]
    return (float(np.median([c["y0"] for c in tall])),
            float(np.median([c["y1"] for c in tall])))


def _ring_background(luma_full, box):
    """Median luma of a ring around the label box in the full frame."""
    x0, y0, x1, y1 = [int(v) for v in box]
    h, w = luma_full.shape
    xa, xb = max(0, x0 - RING_WIDTH), min(w, x1 + RING_WIDTH)
    ya, yb = max(0, y0 - RING_WIDTH), min(h, y1 + RING_WIDTH)
    ring = luma_full[ya:yb, xa:xb].copy().astype(float)
    ring[y0 - ya:y1 - ya, x0 - xa:x1 - xa] = np.nan
    return float(np.nanmedian(ring))


def _disc(mask_shape, dot_rel):
    yy, xx = np.mgrid[0:mask_shape[0], 0:mask_shape[1]]
    return np.hypot(xx - dot_rel[0], yy - dot_rel[1]) > DOT_DISC_RADIUS


def segment_label(luma_full, box, dot=None):
    """Segment one label crop into letters with the ladder fix.

    Returns background median, threshold, the extended crop box in
    frame coordinates, raw counts, the letters (each with its ink
    mask in crop coordinates and bbox), ink counts, and present.
    Boxes are in crop coordinates; add crop[0], crop[1] for frame
    coordinates.
    """
    x0, y0, x1, y1 = [int(v) for v in box]
    crop_h = y1 - y0
    bg = _ring_background(luma_full, box)
    thr = bg + ADAPTIVE_DELTA

    def masked(ex0, ex1):
        m = luma_full[y0:y1, ex0:ex1] > thr
        if dot is not None:
            m = m & _disc(m.shape, (dot[0] - ex0, dot[1] - y0))
        return m

    def strip_has_tall_ink(ex0, ex1, side):
        """True when the 25 px strip outside an edge holds tall ink.

        Tall means the strip ink spans at least half the crop height
        inside the glyph band, with at least 50 ink px. A horizontal
        slice through the October "5" is three short bands, so the
        test uses the ink span, not one component's height.
        """
        if side == "left":
            sx0, sx1 = max(0, ex0 - EXTEND_STEP), ex0
        else:
            sx0, sx1 = ex1, min(luma_full.shape[1], ex1 + EXTEND_STEP)
        if sx1 <= sx0:
            return False
        strip = luma_full[y0:y1, sx0:sx1] > thr
        if dot is not None:
            strip = strip & _disc(strip.shape, (dot[0] - sx0, dot[1] - y0))
        if int(strip.sum()) < 50:
            return False
        ys = np.where(strip.any(axis=1))[0]
        if len(ys) == 0:
            return False
        span = int(ys.max()) - int(ys.min()) + 1
        if span < 0.5 * crop_h:
            return False
        comps = _label_components(masked(ex0, ex1))
        if not comps:
            return False
        b0, b1 = _band_of(comps)
        overlap = max(0, min(int(ys.max()) + 1, b1) - max(int(ys.min()), b0))
        return overlap > 0

    ex0, ex1 = x0, x1
    for _ in range(EXTEND_MAX):
        grew = False
        if strip_has_tall_ink(ex0, ex1, "left"):
            ex0 = max(0, ex0 - EXTEND_STEP)
            grew = True
        if strip_has_tall_ink(ex0, ex1, "right"):
            ex1 = min(luma_full.shape[1], ex1 + EXTEND_STEP)
            grew = True
        if not grew:
            break

    mask = masked(ex0, ex1)
    adaptive_ink = int(mask.sum())
    raw = len(_label_components(mask))
    comps = _label_components(mask)
    if comps:
        b0, b1 = _band_of(comps)
        comps = [c for c in comps
                 if max(0, min(c["y1"], b1) - max(c["y0"], b0))
                 >= 0.5 * (c["y1"] - c["y0"])]
    letters = []
    for comp in comps:
        piece = _tight(mask[comp["y0"]:comp["y1"], comp["x0"]:comp["x1"]],
                       comp["x0"], comp["y0"])
        if piece is not None:
            letters.extend(_split_letter(mask, piece))
    letters = _merge_fragments(letters)
    if letters:
        tallest = max(c["y1"] - c["y0"] for c in letters)
        letters = [c for c in letters if c["y1"] - c["y0"] >= 0.25 * tallest]
        b0, b1 = _band_of(letters)
        band_h = b1 - b0
        kept = []
        for c in letters:
            ax0, ax1 = ex0 + c["x0"], ex0 + c["x1"]
            outside = ax1 <= x0 or ax0 >= x1
            if outside and (abs(c["y0"] - b0) > 0.2 * band_h
                            or abs(c["y1"] - b1) > 0.2 * band_h):
                continue
            kept.append(c)
        letters = kept
    letters = sorted(letters, key=lambda c: c["x0"])
    present = adaptive_ink >= 10 and len(letters) >= 1
    return {"background_median": round(bg, 1),
            "threshold": round(thr, 1),
            "crop": [ex0, y0, ex1, y1],
            "raw_letters_adaptive": raw,
            "adaptive_ink_px": adaptive_ink,
            "letters": letters,
            "present": present}


def fixed180_metrics(luma_full, box):
    """type_metrics on the trace-box crop at fixed threshold 180.

    This is the U9 reproduction: the same function, the same
    threshold, the same frames. No segmentation fix is applied here.
    """
    x0, y0, x1, y1 = [int(v) for v in box]
    crop = luma_full[y0:y1, x0:x1]
    return dimensions.type_metrics(crop, crop >= FIXED_THRESHOLD)


def _stroke_aa(luma_crop, mask):
    """Stroke and AA fraction with the type_metrics formulas."""
    if mask is None or not mask.any():
        return None, None
    dt = ndimage.distance_transform_edt(mask)
    stroke = round(float(2 * np.median(dt[mask])), 2)
    edge = mask & ~ndimage.binary_erosion(mask)
    edge_luma = luma_crop[edge] if edge.any() else np.array([])
    aa = None
    if edge_luma.size:
        aa = round(float(np.mean((edge_luma > 40) & (edge_luma < 200))), 4)
    return stroke, aa


def _gaps(boxes):
    """Per-pair x gaps between sorted letter boxes, in px."""
    return [boxes[i + 1]["x0"] - boxes[i]["x1"] for i in range(len(boxes) - 1)]


def _cap_height(letters):
    """Median height of the cap-height letters, else None."""
    if not letters:
        return None
    heights = [c["y1"] - c["y0"] for c in letters]
    tallest = max(heights)
    cap = [h for h in heights if h >= 0.8 * tallest]
    return round(float(np.median(cap)), 2)


def _resample(mask):
    """Resample a boolean mask to a GRID x GRID grid, nearest."""
    h, w = mask.shape
    rows = np.minimum((np.arange(GRID) * h / GRID).astype(int), h - 1)
    cols = np.minimum((np.arange(GRID) * w / GRID).astype(int), w - 1)
    return mask[np.ix_(rows, cols)]


def letter_iou(mask_a, mask_b):
    """IoU of two letter masks, each normalised to its own bbox."""
    a = _resample(mask_a)
    b = _resample(mask_b)
    inter = int(np.logical_and(a, b).sum())
    union = int(np.logical_or(a, b).sum())
    if union == 0:
        return None
    return round(inter / union, 4)


def _aa_transition(luma_crop, letters, bg):
    """Edge transition width in px on a straight stem scanline.

    For each letter, the middle row of its bbox is scanned from 8 px
    left of the bbox to 8 px inside it. The core is the 95th
    percentile luma inside the letter mask. The ramp runs from
    background plus 20 percent of (core minus background) to
    background plus 80 percent. The median over letters that yield
    a clean ramp is the number; letters without one are skipped.
    """
    widths = []
    for letter in letters:
        core_vals = luma_crop[letter["y0"]:letter["y1"],
                               letter["x0"]:letter["x1"]][letter["mask"]]
        if core_vals.size == 0:
            continue
        core = float(np.percentile(core_vals, 95))
        if core - bg < 40:
            continue
        row = letter["y0"] + (letter["y1"] - letter["y0"]) // 2
        x_start = max(0, letter["x0"] - 8)
        x_end = min(luma_crop.shape[1], letter["x0"] + 8)
        if x_end - x_start < 4 or row >= luma_crop.shape[0]:
            continue
        scan = luma_crop[row, x_start:x_end].astype(float)
        lo = bg + 0.2 * (core - bg)
        hi = bg + 0.8 * (core - bg)
        above_hi = np.where(scan >= hi)[0]
        if len(above_hi) == 0:
            continue
        i80 = int(above_hi[0])
        below_lo = np.where(scan[:i80 + 1] <= lo)[0]
        if len(below_lo) == 0:
            continue
        i20 = int(below_lo[-1])
        width = i80 - i20
        if 0 <= width <= 8:
            widths.append(width)
    if not widths:
        return None, 0
    return round(float(np.median(widths)), 2), len(widths)


def _side_numbers(luma_full, seg, frame):
    frame = int(frame)
    """Numbers for one side from one segmented frame."""
    letters = seg["letters"]
    crop = seg["crop"]
    luma_crop = luma_full[crop[1]:crop[3], crop[0]:crop[2]]
    final_mask = np.zeros(luma_crop.shape, dtype=bool)
    for letter in letters:
        final_mask[letter["y0"]:letter["y1"],
                   letter["x0"]:letter["x1"]] |= letter["mask"]
    stroke, aa = _stroke_aa(luma_crop, final_mask)
    gaps = _gaps(letters)
    cap = _cap_height(letters)
    transition, n_transition = _aa_transition(luma_crop, letters,
                                              seg["background_median"])
    centroids = []
    for letter in letters:
        ys, xs = np.where(letter["mask"])
        centroids.append([round(float(xs.mean()) + crop[0] + letter["x0"], 1),
                          round(float(ys.mean()) + crop[1] + letter["y0"], 1)])
    return {"frame": frame,
            "present": seg["present"],
            "ink_px": int(final_mask.sum()),
            "adaptive_ink_px": seg["adaptive_ink_px"],
            "background_median": seg["background_median"],
            "threshold": seg["threshold"],
            "crop": crop,
            "raw_letters_adaptive": seg["raw_letters_adaptive"],
            "letters": len(letters),
            "gaps_px": gaps,
            "gap_median_px": round(float(np.median(gaps)), 2) if gaps else None,
            "stroke_px": stroke,
            "aa_fraction": aa,
            "aa_transition_px": transition,
            "aa_transition_letters": n_transition,
            "cap_height_px": cap,
            "centroids": centroids,
            "boxes": [[c["x0"] + crop[0], c["y0"] + crop[1],
                       c["x1"] + crop[0], c["y1"] + crop[1]] for c in letters],
            "_letters": letters,
            "_crop": crop}


def _measure_label(label, side_frames, box, dot, text, fade_frames):
    """Measure one label on both sides.

    side_frames: {"ref": {frame: path}, "ours": {frame: path}}.
    fade_frames: {frame: path} per side for the fade curve, or None.
    """
    per_frame = {}
    for side in ("ref", "ours"):
        per_frame[side] = []
        for frame in sorted(side_frames[side], key=lambda f: int(f)):
            luma_full = _load_luma(side_frames[side][frame])
            fixed = fixed180_metrics(luma_full, box)
            seg = segment_label(luma_full, box, dot)
            nums = _side_numbers(luma_full, seg, frame)
            nums["fixed180"] = fixed
            per_frame[side].append(nums)

    def fullest(side):
        cands = [n for n in per_frame[side] if n["present"]]
        if not cands:
            return None
        return max(cands, key=lambda n: (n["letters"], n["ink_px"]))

    best = {"ref": fullest("ref"), "ours": fullest("ours")}
    chars = [c for c in text if c != " "] if text else []
    out = {"per_frame": {side: [{k: v for k, v in n.items()
                                 if not k.startswith("_")}
                                for n in per_frame[side]]
                         for side in ("ref", "ours")},
           "fullest_frame": {side: (best[side]["frame"] if best[side] else None)
                             for side in ("ref", "ours")},
           "letters": {side: (best[side]["letters"] if best[side] else 0)
                       for side in ("ref", "ours")},
           "present": {side: bool(best[side]) for side in ("ref", "ours")}}

    for side in ("ref", "ours"):
        b = best[side]
        if b is None:
            out[side] = {"measured": False,
                         "reason": "present False on the %s side after adaptive ink"
                                   % side}
            continue
        out[side] = {"measured": True,
                     "frame": b["frame"],
                     "letters": b["letters"],
                     "gaps_px": b["gaps_px"],
                     "gap_median_px": b["gap_median_px"],
                     "gap_over_cap_height":
                         (round(b["gap_median_px"] / b["cap_height_px"], 4)
                          if b["gap_median_px"] is not None and b["cap_height_px"]
                          else None),
                     "stroke_px": b["stroke_px"],
                     "stroke_over_cap_height":
                         (round(b["stroke_px"] / b["cap_height_px"], 4)
                          if b["stroke_px"] is not None and b["cap_height_px"]
                          else None),
                     "aa_fraction": b["aa_fraction"],
                     "aa_transition_px": b["aa_transition_px"],
                     "aa_transition_letters": b["aa_transition_letters"],
                     "cap_height_px": b["cap_height_px"],
                     "ink_px": b["ink_px"],
                     "background_median": b["background_median"]}
    if best["ref"] is None or best["ours"] is None:
        out["overlap"] = {"paired": False,
                          "reason": "one side has no fullest frame",
                          "letters_ref": out["letters"]["ref"],
                          "letters_ours": out["letters"]["ours"]}
    elif best["ref"]["letters"] != best["ours"]["letters"]:
        out["overlap"] = {"paired": False,
                          "reason": "letter counts differ",
                          "letters_ref": best["ref"]["letters"],
                          "letters_ours": best["ours"]["letters"]}
    else:
        per_letter = []
        shifts = []
        for i, (la, lb) in enumerate(zip(best["ref"]["_letters"],
                                        best["ours"]["_letters"])):
            iou = letter_iou(la["mask"], lb["mask"])
            per_letter.append({"index": i + 1,
                               "char": chars[i] if i < len(chars) else None,
                               "iou": iou})
            ca = best["ref"]["centroids"][i]
            cb = best["ours"]["centroids"][i]
            shifts.append(round(float(np.hypot(ca[0] - cb[0], ca[1] - cb[1])), 1))
        ious = [p["iou"] for p in per_letter if p["iou"] is not None]
        worst = min(per_letter, key=lambda p: p["iou"] if p["iou"] is not None else 2)
        cap_ref = best["ref"]["cap_height_px"]
        cap_ours = best["ours"]["cap_height_px"]
        out["overlap"] = {"paired": True,
                          "frame_ref": best["ref"]["frame"],
                          "frame_ours": best["ours"]["frame"],
                          "mean_iou": round(float(np.mean(ious)), 4) if ious else None,
                          "worst_letter": worst["char"] or ("letter %d" % worst["index"]),
                          "worst_letter_index": worst["index"],
                          "worst_iou": worst["iou"],
                          "per_letter": per_letter,
                          "cap_height_ratio":
                              (round(cap_ours / cap_ref, 4)
                               if cap_ref and cap_ours else None),
                          "centroid_shift_px": round(float(np.mean(shifts)), 1) if shifts else None,
                          "centroid_shift_max_px": max(shifts) if shifts else None}
    if fade_frames is not None:
        out["fade"] = _fade_curve(fade_frames, box)
    return out


def _fade_curve(fade_frames, box):
    """October fade curve: adaptive ink per sampled frame, both sides."""
    x0, y0, x1, y1 = [int(v) for v in box]
    out = {}
    for side in ("ref", "ours"):
        ink_by_frame = {}
        for frame in sorted(fade_frames[side], key=lambda f: int(f)):
            luma_full = _load_luma(fade_frames[side][frame])
            bg = _ring_background(luma_full, box)
            crop = luma_full[y0:y1, x0:x1]
            ink_by_frame[str(frame)] = int((crop > bg + ADAPTIVE_DELTA).sum())
        peak = max(ink_by_frame.values()) if ink_by_frame else 0
        first_full = None
        last_visible = None
        if peak > 0:
            for frame in sorted(fade_frames[side], key=lambda f: int(f)):
                if ink_by_frame[str(frame)] >= 0.9 * peak and first_full is None:
                    first_full = int(frame)
                if ink_by_frame[str(frame)] >= 0.1 * peak:
                    last_visible = int(frame)
        out[side] = {"ink_by_frame": ink_by_frame,
                     "peak_ink_px": peak,
                     "first_full_frame": first_full,
                     "last_visible_frame": last_visible}
    ref, ours = out["ref"], out["ours"]
    out["difference"] = (
        "Reference title is full at frame %s and gone after frame %s; "
        "ours is full at frame %s and gone after frame %s."
        % (ref["first_full_frame"], ref["last_visible_frame"],
           ours["first_full_frame"], ours["last_visible_frame"]))
    return out


def _u9_dot_window(rgb, luma):
    """U9 dot window for one frame, or (None, None) when no dot.

    This is compare.mjs exactly: the RSF badge is the extent of the
    badge-colour mask, the dot is layout.find_dot from the badge
    top-right corner, gated to 30 px from that corner, and the
    window is x int(dx) - 10 to int(dx) + 220, y int(dy) - 25 to
    int(dy) + 25, clipped to the frame. The dot centre moves per
    frame, so the window moves with it; the static trace centre
    (783, 646) is not used here. Returns (dot_centre, window).
    """
    h, w = luma.shape
    badge = dimensions.mask_extent(
        layout.rgb_mask(rgb, layout.PALETTE["rsf"], layout.TOL["rsf"]))
    if badge is None:
        return None, None
    dot = layout.find_dot(rgb, (badge["bbox"][2], badge["bbox"][1]))
    if dot is None:
        return None, None
    cx, cy = dot["centroid"]
    if float(np.hypot(cx - badge["bbox"][2], cy - badge["bbox"][1])) > 30:
        return None, None
    window = [max(0, int(cx) - 10), max(0, int(cy) - 25),
              min(w, int(cx) + 220), min(h, int(cy) + 25)]
    return [cx, cy], window


def _reproduction(el_frames, box, dot):
    """Fixed 180 reproduction of the U9 numbers, EL FASHER only.

    Runs type_metrics on the trace-box crop and, for the record, on
    U9's per-frame dot window, at frames 156, 168, 180, both sides.
    The dot window is U9's exact method: the dot is found per frame
    from the badge corner (see _u9_dot_window), not taken from the
    trace. A frame with no dot is left out of the dot-window means,
    as U9 leaves it out of type_rows, and is recorded with
    letters None. Means are compared with the U9 targets: ref and
    ours letters exact, gap within 1 px, stroke within 0.5 px, AA
    within 0.02.
    """
    result = {"frames": sorted((int(f) for f in el_frames["ref"])),
              "u9": U9,
              "trace_box": {}, "dot_window": {}}
    for window, get_box in (
            ("trace_box", lambda: box),
            ("dot_window", lambda: None)):
        for side in ("ref", "ours"):
            vals = []
            for frame in sorted(el_frames[side], key=lambda f: int(f)):
                path = el_frames[side][frame]
                luma_full = _load_luma(path)
                if window == "trace_box":
                    vals.append(fixed180_metrics(luma_full, get_box()))
                else:
                    rgb = np.array(Image.open(path).convert("RGB"))
                    centre, win = _u9_dot_window(rgb, luma_full)
                    if win is None:
                        vals.append({"present": False, "letters": None,
                                     "median_gap_px": None,
                                     "median_stroke_px": None,
                                     "aa_fraction": None, "ink_px": 0,
                                     "dot_centre": None, "window": None})
                    else:
                        m = fixed180_metrics(luma_full, win)
                        m["dot_centre"] = centre
                        m["window"] = win
                        vals.append(m)
            counted = [v for v in vals if v["letters"] is not None]
            means = {"letters_mean": (round(float(np.mean(
                         [v["letters"] for v in counted])), 4)
                     if counted else None),
                     "median_gap_px_mean": (round(float(np.mean(
                         [v["median_gap_px"] for v in counted
                          if v["median_gap_px"] is not None])), 2)
                     if counted else None),
                     "median_stroke_px_mean": (round(float(np.mean(
                         [v["median_stroke_px"] for v in counted
                          if v["median_stroke_px"] is not None])), 2)
                     if counted else None),
                     "aa_fraction_mean": (round(float(np.mean(
                         [v["aa_fraction"] for v in counted
                          if v["aa_fraction"] is not None])), 4)
                     if counted else None),
                     "per_frame": vals}
            result[window][side] = means
    result["dot_window"]["method"] = (
        "Per-frame dot from the RSF badge top-right corner "
        "(layout.find_dot, luma >= 170, min 20 px, within 30 px of the "
        "corner); window x int(dx)-10 to int(dx)+220, y int(dy)-25 to "
        "int(dy)+25; type_metrics, threshold 180, connectivity 2, "
        "min 3 px. Trace dot centre (783, 646) is not used.")
    tb = result["trace_box"]
    dw = result["dot_window"]
    result["within_tolerance"] = {
        "letters_ref_exact": dw["ref"]["letters_mean"] == U9["ref_letters_mean"],
        "letters_ours_exact": dw["ours"]["letters_mean"] == U9["ours_letters_mean"],
        "letters_ref_mean": dw["ref"]["letters_mean"],
        "letters_ref_u9": U9["ref_letters_mean"],
        "letters_ref_note":
            "Dot-window ref mean is 8.6667 against U9 8.6667: the "
            "per-frame dot at frame 156 is (804.9, 626.4), so its "
            "window gives 8 letters, while frames 168 and 180 give "
            "9 each. The static trace-centre window gives 9.3333 "
            "and the trace box gives 9.0; both are kept for the "
            "record. The segmentation fix removes the dot fragment "
            "in the adaptive measurement, giving 8.",
        "gap_within_1px":
            abs(dw["ref"]["median_gap_px_mean"] - U9["ref_median_gap_px"]) <= 1
            and abs(dw["ours"]["median_gap_px_mean"] - U9["ours_median_gap_px"]) <= 1,
        "stroke_within_0_5px":
            abs(dw["ref"]["median_stroke_px_mean"] - U9["ref_median_stroke_px"]) <= 0.5
            and abs(dw["ours"]["median_stroke_px_mean"] - U9["ours_median_stroke_px"]) <= 0.5,
        "aa_within_0_02":
            abs(dw["ref"]["aa_fraction_mean"] - U9["ref_aa_fraction"]) <= 0.02
            and abs(dw["ours"]["aa_fraction_mean"] - U9["ours_aa_fraction"]) <= 0.02}
    return result


def measure(config):
    """Measure both labels. Config holds frame paths, trace, frames.

    config: {"ref": {"october": {frame: path}, "el-fasher": {...}},
             "ours": {...},
             "trace_path": str,
             "frames": {"october": {"ref": [...], "ours": [...]},
                        "el-fasher": {"ref": [...], "ours": [...]}},
             "fade_frames": {"ref": {frame: path}, "ours": {frame: path}} or None}
    """
    with open(config["trace_path"], encoding="utf-8") as f:
        trace = json.load(f)
    labels = trace.get("labels", {})
    october = labels.get("october_2025", {})
    fasher = labels.get("el_fasher", {})
    dot_label = labels.get("el_fasher_dot", {})
    boxes = {"october": october.get("bbox_1920x1080"),
             "el-fasher": fasher.get("bbox_1920x1080")}
    if not boxes["october"] or not boxes["el-fasher"]:
        raise ValueError("trace lacks october_2025 or el_fasher bbox_1920x1080")
    dot = dot_label.get("centre_1920x1080")
    texts = {"october": october.get("text", ""),
             "el-fasher": fasher.get("text", "")}
    fade = config.get("fade_frames")
    out = {"labels": {
        "october": _measure_label(
            "october",
            {"ref": config["ref"]["october"], "ours": config["ours"]["october"]},
            boxes["october"], None, texts["october"],
            {"ref": fade["ref"], "ours": fade["ours"]} if fade else None),
        "el-fasher": _measure_label(
            "el-fasher",
            {"ref": config["ref"]["el-fasher"], "ours": config["ours"]["el-fasher"]},
            boxes["el-fasher"], dot, texts["el-fasher"], None)}}
    out["reproduction"] = _reproduction(
        {"ref": config["ref"]["el-fasher"], "ours": config["ours"]["el-fasher"]},
        boxes["el-fasher"], dot)
    return out
