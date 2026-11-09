"""Missing measurement dimensions for `hme compare` (U9).

Every function here is pure: it takes frame arrays and returns plain
numbers. Nothing is hardcoded to a video, a segment, or a frame count.
The caller (the compare driver in src/cli/compare.mjs) decides which
frames to sample and which side is which; this module only measures.

Dependencies are numpy, scipy, and scikit-image only. There is no
cv2 in the engine venv, so the Laplacian and the blur use scipy
convolutions, and contours use skimage. There is no DISTS package and
no VGG weights in the venv, so `dists_lite` applies the DISTS
formula (local mean / local spread, structure plus texture, several
scales, weighted mean) to a plain image pyramid instead of VGG
features. It is a named fallback, not the official DISTS, and the
compare report says so in plain words.
"""
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from skimage import measure as _measure

_REC709 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
_LAPLACIAN = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float32)


def luma_of(rgb):
    """Rec.709 luma of an RGB frame, float32."""
    return rgb.astype(np.float32) @ _REC709


def largest_component_width(mask, min_n=50):
    """Width in px of the largest connected component's bbox.

    Use this for a subject width curve, not the union extent: stray
    pixels of the same colour elsewhere in the frame stretch the
    union across the whole frame, while the largest component is the
    subject itself. On the Seg4 pair the union extent of ours reads
    1800 px while the largest component reads 544 px, the real Sudan.
    """
    comps = components(mask, min_n=min_n, top=1)
    if not comps:
        return 0
    x0, _, x1, _ = comps[0]["bbox"]
    return int(x1 - x0)


def mask_width(mask):
    """Width in px of the union column extent of a boolean mask, else 0."""
    if mask is None or not mask.any():
        return 0
    xs = np.where(mask.any(axis=0))[0]
    return int(xs.max() - xs.min() + 1)


def mask_extent(mask):
    """Union bbox [x0, y0, x1, y1] and centroid of a mask, else None."""
    if mask is None or not mask.any():
        return None
    ys, xs = np.where(mask)
    return {"bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "centroid": [float(xs.mean()), float(ys.mean())],
            "n": int(len(xs))}


def velocity_stats(widths):
    """Zoom-velocity summary of a per-frame width curve.

    widths: list of widths in px, one per frame. Returns mean width,
    mean and max absolute first difference (the zoom rate in px per
    frame), and the first-difference series itself.
    """
    w = np.asarray(widths, dtype=np.float64)
    if w.size == 0:
        return {"mean_width_px": 0.0, "mean_abs_velocity_px_per_frame": 0.0,
                "max_abs_velocity_px_per_frame": 0.0, "velocity_px_per_frame": []}
    vel = np.diff(w) if w.size > 1 else np.zeros(0)
    return {"mean_width_px": round(float(np.mean(w)), 2),
            "mean_abs_velocity_px_per_frame": round(float(np.mean(np.abs(vel))), 3) if vel.size else 0.0,
            "max_abs_velocity_px_per_frame": round(float(np.max(np.abs(vel))), 3) if vel.size else 0.0,
            "velocity_px_per_frame": [round(float(v), 3) for v in vel]}


def series_corr(a, b):
    """Pearson correlation of two equal-length series, else None."""
    x = np.asarray(a, dtype=np.float64)
    y = np.asarray(b, dtype=np.float64)
    if x.size < 2 or y.size < 2 or x.size != y.size:
        return None
    if np.std(x) == 0 or np.std(y) == 0:
        return None
    return round(float(np.corrcoef(x, y)[0, 1]), 4)


def mean_abs_diff(a, b):
    """Mean absolute difference of two equal-length series, else None."""
    x = np.asarray(a, dtype=np.float64)
    y = np.asarray(b, dtype=np.float64)
    if x.size == 0 or x.size != y.size:
        return None
    return round(float(np.mean(np.abs(x - y))), 4)


def laplacian_variance(luma):
    """Motion-blur measure: variance of the Laplacian of luma.

    A crisp frame has high variance; a blurred frame has low variance.
    """
    lap = ndimage.convolve(luma.astype(np.float32), _LAPLACIAN, mode="nearest")
    return round(float(np.var(lap)), 3)


def grain_level(luma):
    """Grain measure: std of luma minus its 3x3 mean blur.

    The high-pass residual holds the per-frame noise. A static grain
    tile gives a near-constant level frame to frame; live noise varies.
    """
    blur = ndimage.uniform_filter(luma.astype(np.float32), size=3, mode="nearest")
    return round(float(np.std(luma.astype(np.float32) - blur)), 3)


def grain_temporal_stats(levels):
    """How the grain level moves over time: mean, std, lag-1 autocorr."""
    x = np.asarray(levels, dtype=np.float64)
    if x.size == 0:
        return {"mean": 0.0, "std_over_time": 0.0, "lag1_autocorr": None}
    ac = None
    if x.size > 2 and np.std(x) > 0:
        ac = round(float(np.corrcoef(x[:-1], x[1:])[0, 1]), 4)
    return {"mean": round(float(np.mean(x)), 3),
            "std_over_time": round(float(np.std(x)), 3),
            "lag1_autocorr": ac}


def vignette_ratio(luma):
    """Corner vs centre luminance: mean of four corner patches over the centre patch.

    Corners are 10% squares; the centre is the middle 40% of the frame.
    A ratio below 1 means the corners are darker than the centre.
    """
    h, w = luma.shape[:2]
    ch, cw = max(1, h // 10), max(1, w // 10)
    corners = np.concatenate([
        luma[:ch, :cw].ravel(), luma[:ch, -cw:].ravel(),
        luma[-ch:, :cw].ravel(), luma[-ch:, -cw:].ravel()])
    cy0, cy1 = h // 2 - h // 5, h // 2 + h // 5
    cx0, cx1 = w // 2 - w // 5, w // 2 + w // 5
    centre = luma[cy0:cy1, cx0:cx1].ravel()
    c_mean = float(np.mean(centre))
    if c_mean <= 0:
        return None
    return round(float(np.mean(corners)) / c_mean, 4)


def histogram_intersection(a_rgb, b_rgb, bins=32):
    """Whole-frame colour histogram comparison, per channel.

    Returns the mean histogram intersection over R, G, B (1 is
    identical histograms) and the per-channel values.
    """
    out = {}
    total = 0.0
    for ch in range(3):
        ha, _ = np.histogram(a_rgb[:, :, ch], bins=bins, range=(0, 256))
        hb, _ = np.histogram(b_rgb[:, :, ch], bins=bins, range=(0, 256))
        ha = ha / ha.sum()
        hb = hb / hb.sum()
        inter = float(np.sum(np.minimum(ha, hb)))
        out["rgb"[ch]] = round(inter, 4)
        total += inter
    out["mean"] = round(total / 3, 4)
    return out


def _box_downsample(img):
    """Halve each axis by 2x2 block means. img is 2-D float."""
    h, w = img.shape
    h2, w2 = (h // 2) * 2, (w // 2) * 2
    return img[:h2, :w2].reshape(h2 // 2, 2, w2 // 2, 2).mean(axis=(1, 3))


def dists_lite(a_rgb, b_rgb, scales=3):
    """Small DISTS-style perceptual score on a plain image pyramid.

    For each scale, local mean (structure) and local spread (texture)
    come from a 5x5 uniform filter on luma. Structure and texture
    similarities use the DISTS form, 2xy+c over x^2+y^2+c, and the
    scales are weighted 0.5, 0.3, 0.2 from fine to coarse. Returns a
    0..1 score where 1 is identical. This is NOT the official DISTS:
    it has no VGG features, because the venv has no VGG weights.
    """
    a = luma_of(a_rgb)
    b = luma_of(b_rgb)
    weights = [0.5, 0.3, 0.2][:scales]
    weights = [w / sum(weights) for w in weights]
    score = 0.0
    for k, wt in enumerate(weights):
        if k > 0:
            a = _box_downsample(a)
            b = _box_downsample(b)
        mu_a = ndimage.uniform_filter(a, size=5, mode="nearest")
        mu_b = ndimage.uniform_filter(b, size=5, mode="nearest")
        sig_a = np.sqrt(np.maximum(
            ndimage.uniform_filter(a * a, size=5, mode="nearest") - mu_a * mu_a, 0))
        sig_b = np.sqrt(np.maximum(
            ndimage.uniform_filter(b * b, size=5, mode="nearest") - mu_b * mu_b, 0))
        c1, c2 = 0.01 ** 2 * 255 ** 2, 0.03 ** 2 * 255 ** 2
        struct = (2 * mu_a * mu_b + c1) / (mu_a * mu_a + mu_b * mu_b + c1)
        text = (2 * sig_a * sig_b + c2) / (sig_a * sig_a + sig_b * sig_b + c2)
        score += wt * float(np.mean(0.5 * (struct + text)))
    return round(score, 4)


def contour_points(mask, max_points=400):
    """Outline points of a boolean mask, downsampled to at most max_points."""
    if mask is None or not mask.any():
        return np.zeros((0, 2), dtype=np.float64)
    contours = _measure.find_contours(mask.astype(np.float64), 0.5)
    if not contours:
        return np.zeros((0, 2), dtype=np.float64)
    pts = max(contours, key=len)
    if len(pts) > max_points:
        idx = np.linspace(0, len(pts) - 1, max_points).astype(int)
        pts = pts[idx]
    return np.asarray(pts, dtype=np.float64)


def chamfer_hausdorff(mask_a, mask_b):
    """Contour distance between two masks: Chamfer both ways and Hausdorff.

    Chamfer a->b is the mean distance-transform value of mask b at the
    contour points of mask a. Hausdorff is the largest smallest
    distance between the two point sets, via KD trees.
    """
    pa = contour_points(mask_a)
    pb = contour_points(mask_b)
    if len(pa) == 0 or len(pb) == 0:
        return {"chamfer_a_to_b_px": None, "chamfer_b_to_a_px": None,
                "chamfer_mean_px": None, "hausdorff_px": None}
    dt_b = ndimage.distance_transform_edt(~mask_b)
    dt_a = ndimage.distance_transform_edt(~mask_a)
    ys_a = np.clip(np.round(pa[:, 0]).astype(int), 0, mask_b.shape[0] - 1)
    xs_a = np.clip(np.round(pa[:, 1]).astype(int), 0, mask_b.shape[1] - 1)
    ys_b = np.clip(np.round(pb[:, 0]).astype(int), 0, mask_a.shape[0] - 1)
    xs_b = np.clip(np.round(pb[:, 1]).astype(int), 0, mask_a.shape[1] - 1)
    c_ab = float(np.mean(dt_b[ys_a, xs_a]))
    c_ba = float(np.mean(dt_a[ys_b, xs_b]))
    tree_a = cKDTree(pa)
    tree_b = cKDTree(pb)
    d_ab, _ = tree_b.query(pa, k=1)
    d_ba, _ = tree_a.query(pb, k=1)
    haus = float(max(np.max(d_ab), np.max(d_ba)))
    return {"chamfer_a_to_b_px": round(c_ab, 2),
            "chamfer_b_to_a_px": round(c_ba, 2),
            "chamfer_mean_px": round((c_ab + c_ba) / 2, 2),
            "hausdorff_px": round(haus, 2)}


def components(mask, min_n=50, top=6):
    """Largest connected components of a mask, largest first.

    Each entry has pixel count, bbox [x0, y0, x1, y1], and centroid.
    """
    if mask is None or not mask.any():
        return []
    lab = _measure.label(mask, connectivity=1)
    if lab.max() == 0:
        return []
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    order = np.argsort(counts)[::-1]
    out = []
    for k in order[:top]:
        if counts[k] < min_n:
            break
        ys, xs = np.where(lab == k)
        out.append({"n": int(counts[k]),
                    "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                    "centroid": [round(float(xs.mean()), 1), round(float(ys.mean()), 1)]})
    return out


def match_components(ref_comps, ours_comps, max_shift_px=120):
    """Match ours components to ref components by nearest centroid.

    Returns a list of {ref, ours, centroid_shift_px, area_ratio},
    with ours None when no component sits near the ref one.
    """
    out = []
    used = set()
    for rc in ref_comps:
        best, best_d = None, None
        for j, oc in enumerate(ours_comps):
            if j in used:
                continue
            d = float(np.hypot(rc["centroid"][0] - oc["centroid"][0],
                               rc["centroid"][1] - oc["centroid"][1]))
            if best_d is None or d < best_d:
                best, best_d = j, d
        if best is not None and best_d <= max_shift_px:
            used.add(best)
            oc = ours_comps[best]
            out.append({"ref": rc, "ours": oc,
                        "centroid_shift_px": round(best_d, 1),
                        "area_ratio": round(oc["n"] / rc["n"], 4) if rc["n"] else None})
        else:
            out.append({"ref": rc, "ours": None,
                        "centroid_shift_px": None, "area_ratio": None})
    return out


def name_neighbour(comp, sudan_centroid):
    """Name a neighbouring landmass by where it sits vs Sudan.

    North of Sudan is Egypt, west is Libya, east across the Red Sea
    is Saudi. This is geometry, not a frame number: it works wherever
    Sudan sits in the frame.
    """
    dx = comp["centroid"][0] - sudan_centroid[0]
    dy = comp["centroid"][1] - sudan_centroid[1]
    if abs(dx) >= abs(dy):
        return "saudi_east" if dx > 0 else "libya_west"
    return "egypt_north" if dy < 0 else "south"


def radial_profile(luma, cx, cy, radii=(5, 10, 15, 20, 30, 45, 60)):
    """Mean luma in rings around a point: the halo falloff curve.

    Returns {radius: mean luma} plus the falloff slope, luma at the
    smallest ring minus luma at the largest ring.
    """
    h, w = luma.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - cx, yy - cy)
    out = {}
    prev = 0.0
    for rad in radii:
        ring = (r > prev) & (r <= rad)
        out[str(rad)] = round(float(np.mean(luma[ring])), 2) if ring.any() else None
        prev = rad
    vals = [v for v in out.values() if v is not None]
    out["falloff"] = round(vals[0] - vals[-1], 2) if len(vals) >= 2 else None
    return out


def type_metrics(luma, ink_mask):
    """Type beyond the box: letter spacing, stroke weight, anti-aliasing.

    ink_mask is the bright glyph mask inside one label box. Letters
    are its connected components. Spacing is the median gap between
    neighbouring letter boxes. Stroke weight is twice the median
    distance-transform value inside the ink. Anti-aliasing is the
    share of ink edge pixels whose luma sits between 40 and 200,
    neither core nor background.
    """
    if ink_mask is None or not ink_mask.any():
        return {"present": False, "letters": 0, "median_gap_px": None,
                "median_stroke_px": None, "aa_fraction": None, "ink_px": 0}
    lab = _measure.label(ink_mask, connectivity=2)
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    keep = [k for k in range(1, len(counts)) if counts[k] >= 3]
    boxes = []
    for k in keep:
        ys, xs = np.where(lab == k)
        boxes.append((int(xs.min()), int(xs.max()) + 1))
    boxes.sort()
    gaps = [boxes[i + 1][0] - boxes[i][1] for i in range(len(boxes) - 1)]
    gaps = [g for g in gaps if g >= 0]
    dt = ndimage.distance_transform_edt(ink_mask)
    stroke = round(float(2 * np.median(dt[ink_mask])), 2) if ink_mask.any() else None
    edge = ink_mask & ~ndimage.binary_erosion(ink_mask)
    edge_luma = luma[edge] if edge.any() else np.array([])
    aa = None
    if edge_luma.size:
        aa = round(float(np.mean((edge_luma > 40) & (edge_luma < 200))), 4)
    return {"present": True, "letters": len(boxes),
            "median_gap_px": round(float(np.median(gaps)), 2) if gaps else None,
            "median_stroke_px": stroke, "aa_fraction": aa,
            "ink_px": int(ink_mask.sum())}


def badge_parts(luma, badge_bbox):
    """Badge interior as parts, not one blob.

    Inside the badge bbox, dark pixels are the rifle, bright pixels
    are the RSF text. Returns each part's count and centroid.
    """
    if badge_bbox is None:
        return {"present": False, "dark_rifle_px": 0, "bright_text_px": 0,
                "dark_centroid": None, "bright_centroid": None}
    x0, y0, x1, y1 = [int(v) for v in badge_bbox]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(luma.shape[1], x1), min(luma.shape[0], y1)
    patch = luma[y0:y1, x0:x1]
    if patch.size == 0:
        return {"present": False, "dark_rifle_px": 0, "bright_text_px": 0,
                "dark_centroid": None, "bright_centroid": None}

    def _part(mask):
        if not mask.any():
            return 0, None
        ys, xs = np.where(mask)
        return int(mask.sum()), [round(float(xs.mean()) + x0, 1),
                                 round(float(ys.mean()) + y0, 1)]

    dark_n, dark_c = _part(patch < 80)
    bright_n, bright_c = _part(patch > 200)
    return {"present": True, "dark_rifle_px": dark_n, "bright_text_px": bright_n,
            "dark_centroid": dark_c, "bright_centroid": bright_c}


def zorder_in_overlap(badge_mask, ink_mask):
    """Z-order at an overlap: which element wins the shared bbox.

    The two masks never share a pixel (a pixel is one colour), so the
    overlap is the intersection of their bboxes. The winner is the
    element with more of its own pixels inside that shared box.
    """
    be = mask_extent(badge_mask)
    ie = mask_extent(ink_mask)
    if be is None or ie is None:
        return {"overlap_px": 0, "badge_px": 0, "ink_px": 0, "winner": None}
    bx0, by0, bx1, by1 = be["bbox"]
    ix0, iy0, ix1, iy1 = ie["bbox"]
    x0, y0 = max(bx0, ix0), max(by0, iy0)
    x1, y1 = min(bx1, ix1), min(by1, iy1)
    if x1 <= x0 or y1 <= y0:
        return {"overlap_px": 0, "badge_px": 0, "ink_px": 0, "winner": None}
    badge_px = int(badge_mask[y0:y1, x0:x1].sum())
    ink_px = int(ink_mask[y0:y1, x0:x1].sum())
    winner = "badge" if badge_px > ink_px else ("ink" if ink_px > badge_px else "tie")
    return {"overlap_px": (x1 - x0) * (y1 - y0), "badge_px": badge_px,
            "ink_px": ink_px, "winner": winner}


def shadow_drop(luma, ink_mask):
    """Shadow test: a soft dark fringe beside bright text.

    Compares mean luma in the 3 px ring just outside the ink against
    a wider background band 3 to 12 px out. A positive drop means a
    dark fringe sits beside the text.
    """
    if ink_mask is None or not ink_mask.any():
        return None
    near = ndimage.binary_dilation(ink_mask, iterations=3)
    far = ndimage.binary_dilation(ink_mask, iterations=12)
    ring = near & ~ink_mask
    band = far & ~near
    if not ring.any() or not band.any():
        return None
    return round(float(np.mean(luma[band]) - np.mean(luma[ring])), 2)


def first_crossing(series, threshold, confirm=1):
    """First frame index where a series crosses a threshold and stays.

    confirm is how many following frames must also clear it. Returns
    None when it never crosses.
    """
    s = np.asarray(series, dtype=np.float64)
    for i in range(len(s)):
        if s[i] >= threshold and np.all(s[i:i + confirm + 1] >= threshold):
            return int(i)
    return None


def fade_span(series, lo_frac=0.1, hi_frac=0.9):
    """Fade curve span: frames from 10% to 90% of the series plateau.

    The plateau is the max over the window. Returns
    {start_frame, end_frame, duration_frames} in window-relative
    frames, or None when the series never reaches 90%.
    """
    s = np.asarray(series, dtype=np.float64)
    if s.size < 2:
        return None
    top = float(np.max(s))
    if top <= 0:
        return None
    lo, hi = lo_frac * top, hi_frac * top
    above_lo = np.where(s >= lo)[0]
    above_hi = np.where(s >= hi)[0]
    if len(above_lo) == 0 or len(above_hi) == 0:
        return None
    return {"start_frame": int(above_lo[0]), "end_frame": int(above_hi[0]),
            "duration_frames": int(above_hi[0] - above_lo[0])}


def linear_slope(series):
    """Slope per frame of a least-squares line through a series."""
    y = np.asarray(series, dtype=np.float64)
    if y.size < 2:
        return 0.0
    x = np.arange(y.size, dtype=np.float64)
    return round(float(np.polyfit(x, y, 1)[0]), 4)
