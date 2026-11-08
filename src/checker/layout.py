"""Layer-separated layout check for flat motion-graphics frames.

Compares one real still against one render still at the same second,
layer by layer, in RATIOS (not pixels) so the numbers hold across
aspect ratios and camera zooms. Vectorized numpy + skimage only.
No models, no downloads, no per-pixel Python loops.

Layers are split by flat-colour segmentation: each layer has one
near-flat colour, so connected pixels of that colour are one element.
Reference colours come from verify-seg4/evidence/seg4-trace.json
(21x21 medians, no value guessed).

Real frames here are 1.845:1 (cropped from a 1919x1497 screenshot,
player rect x 185-1717, y 55-885) and were resized to 1920x1080,
which stretches about 4% vertically. Y positions in 1920x1080 space
therefore carry about +/-15 px uncertainty (0.0139 as a ratio),
inside the 0.02 tolerances used by the runner.
"""
import numpy as np
from skimage import measure as _measure

# --- reference palette, from the Seg4 trace (measured, not guessed) ---
PALETTE = {
    "sudan": (20, 60, 52),       # #143C34 Sudan teal
    "base": (28, 43, 40),        # #1C2B28 non-subject land (ocean reads the same)
    "rsf": (204, 71, 38),        # #CC4726 RSF badge orange
    "october": (171, 173, 172),  # #ABADAC October 2025 grey
}
# RGB euclidean tolerance around each reference colour.
TOL = {"sudan": 15, "base": 15, "rsf": 12, "october": 15}

WHITE_LUMA_MIN = 200   # bright text layer (glyph cores)
LABEL_LUMA_MIN = 180   # label matching (glyph edges are dimmer than cores)
LABEL_MIN_N = 50       # ignore specks (grain, the 11 px El Fasher dot) in labels
CAPTION_CUT_Y = 950    # real frames: YouTube caption/control bar below this line
DOT_LUMA_MIN = 170     # El Fasher dot core (peak luminance 198, halo 87)
DOT_MIN_N = 20
DOT_BOX = 60           # search box half-size around the expected dot centre

# A "Sudan" wider than 40% of the frame is the whole map, not Sudan:
# the real Sudan never exceeds 651/1920 = 0.339.
MERGE_WIDTH_RATIO_MAX = 0.40

# RSF badge discriminator. The real badge is a compact solid square
# (fill about 0.43, aspect about 0.95, interior). The coral flood in v4
# is wide, flat and touches the frame edge (fill about 0.05-0.13).
RSF_MIN_N = 100
RSF_FILL_MIN = 0.25
RSF_ASPECT = (0.7, 1.4)

_REC709 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# --- aspect mapping (recorded, from the trace) ---
REAL_ASPECT = 1533 / 831    # 1.845:1, the displayed video rect
RENDER_ASPECT = 1920 / 1080  # 16:9
PLAYER_RECT = (185, 55, 1717, 885)  # screenshot px of the video area


def map_real_to_1080(x, y):
    """Map a screenshot pixel into 1920x1080 video space (trace formula)."""
    return (x - 185) * 1.2524, (y - 55) * 1.2996


def aspect_mapping():
    """The aspect mapping used, recorded in every output."""
    return {
        "real_aspect": round(REAL_ASPECT, 3),
        "render_aspect": round(RENDER_ASPECT, 3),
        "player_rect_screenshot_px": list(PLAYER_RECT),
        "mapping": "x1080 = (x - 185) * 1.2524; y1080 = (y - 55) * 1.2996",
        "note": ("Real frames were cropped to the player rect and resized to "
                 "1920x1080, about 4% vertical stretch. Y positions carry "
                 "about +/-15 px uncertainty (0.0139 as a ratio)."),
    }


def _hex(rgb):
    r, g, b = (int(round(v)) for v in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"


def _rgb_mask32(frame32, rgb, tol):
    """Boolean mask from a precomputed int32 frame (one conversion per frame)."""
    d2 = np.sum((frame32 - np.array(rgb, dtype=np.int32)) ** 2, axis=2)
    return d2 <= tol * tol


def rgb_mask(frame, rgb, tol):
    """Boolean mask of pixels within tol (RGB euclidean) of rgb. Vectorized."""
    return _rgb_mask32(frame.astype(np.int32), rgb, tol)


def _regions(mask, min_n=1):
    """Connected components of a boolean mask, largest first.

    Small labels are zeroed before regionprops runs, so a grainy mask
    with thousands of 1-px specks costs the same as a clean one.
    Returns a list of dicts: n, bbox [x0, y0, x1, y1], centroid [x, y].
    """
    lab = _measure.label(mask, connectivity=1)
    if lab.max() == 0:
        return []
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    keep = np.where(counts >= min_n)[0]
    if len(keep) == 0:
        return []
    if len(keep) < len(counts) - 1:
        lab = np.where(np.isin(lab, keep), lab, 0)
    out = []
    for props in _measure.regionprops(lab):
        if props.area < min_n:
            continue
        y0, x0, y1, x1 = props.bbox
        cy, cx = props.centroid
        out.append({"n": int(props.area), "bbox": [int(x0), int(y0), int(x1), int(y1)],
                    "centroid": [float(cx), float(cy)]})
    out.sort(key=lambda r: -r["n"])
    return out


def _largest_region(mask):
    """Largest connected component, via bincount only (no regionprops)."""
    lab = _measure.label(mask, connectivity=1)
    if lab.max() == 0:
        return None
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    k = int(np.argmax(counts))
    ys, xs = np.where(lab == k)
    return {"n": int(counts[k]),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "centroid": [float(xs.mean()), float(ys.mean())]}


def _mask_extent(mask):
    """Union bbox + centroid of every set pixel, one scan, no labelling."""
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return {"n": int(len(xs)),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "centroid": [float(xs.mean()), float(ys.mean())]}


def _geom(bbox, centroid, n, width, height):
    """Ratios for one element: centroid, bbox, area, four border gaps."""
    x0, y0, x1, y1 = bbox
    return {
        "centroid": [round(float(centroid[0]), 1), round(float(centroid[1]), 1)],
        "centroid_ratio": [round(centroid[0] / width, 4), round(centroid[1] / height, 4)],
        "bbox": [int(x0), int(y0), int(x1), int(y1)],
        "bbox_ratio": [round(x0 / width, 4), round(y0 / height, 4),
                       round((x1 - x0) / width, 4), round((y1 - y0) / height, 4)],
        "area_ratio": round(n / (width * height), 4),
        "border_ratio": {"left": round(x0 / width, 4), "right": round((width - x1) / width, 4),
                         "top": round(y0 / height, 4), "bottom": round((height - y1) / height, 4)},
    }


def _absent(reason):
    return {"present": False, "median_hex": None, "pixels": 0, "centroid": None,
            "centroid_ratio": None, "bbox": None, "bbox_ratio": None,
            "area_ratio": 0.0, "border_ratio": None, "flags": [reason]}


def _median_hex(frame, mask):
    px = frame[mask]
    if px.shape[0] == 0:
        return None
    if px.shape[0] > 20000:
        px = px[::4]  # flat colour: a 5k sample gives the same median
    return _hex(np.median(px.astype(np.float64), axis=0))


def _union_geom(regions, width, height):
    """Union bbox + area-weighted centroid of a region list (no full scan)."""
    x0 = min(r["bbox"][0] for r in regions)
    y0 = min(r["bbox"][1] for r in regions)
    x1 = max(r["bbox"][2] for r in regions)
    y1 = max(r["bbox"][3] for r in regions)
    n = sum(r["n"] for r in regions)
    cx = sum(r["centroid"][0] * r["n"] for r in regions) / n
    cy = sum(r["centroid"][1] * r["n"] for r in regions) / n
    return _geom([x0, y0, x1, y1], [cx, cy], n, width, height)


def _scale_regions(regions, stride):
    """Scale strided-coord regions back to full-frame coords."""
    if stride == 1:
        return regions
    out = []
    for r in regions:
        x0, y0, x1, y1 = r["bbox"]
        out.append({"n": r["n"] * stride * stride,
                    "bbox": [x0 * stride, y0 * stride, x1 * stride, y1 * stride],
                    "centroid": [r["centroid"][0] * stride, r["centroid"][1] * stride]})
    return out


def segment_frame(frame, stride=2):
    """Split one 1920x1080 RGB frame into layers. Returns {layer: geometry}.

    Masks run on a stride-2 subsample (960x540) with 4-connectivity:
    stride 4 merges v4's teal regions across 1-2 px dark borders into one
    frame-wide component, and 8-connectivity bridges them diagonally.
    Stride 2 keeps every measured bbox within 2 px (0.001 as a ratio),
    inside the 0.02 tolerances. Full-res masks cost about 2 s each;
    strided masks cost about 0.5 s.
    """
    height, width = frame.shape[:2]
    small = frame[::stride, ::stride]
    frame32 = small.astype(np.int32)
    out = {}

    # Sudan: largest connected teal component.
    sudan_mask = _rgb_mask32(frame32, PALETTE["sudan"], TOL["sudan"])
    big = _largest_region(sudan_mask)
    if big:
        r = _scale_regions([big], stride)[0]
        g = _geom(r["bbox"], r["centroid"], r["n"], width, height)
        g["present"] = True
        g["median_hex"] = _median_hex(small, sudan_mask)
        g["pixels"] = r["n"]
        g["flags"] = []
        if g["bbox_ratio"][2] > MERGE_WIDTH_RATIO_MAX:
            g["flags"].append("MERGED_WITH_BASE")
        out["sudan"] = g
    else:
        out["sudan"] = _absent("ABSENT")

    # Base (non-subject land + ocean): frame-filling, union of all mask pixels.
    base_mask = _rgb_mask32(frame32, PALETTE["base"], TOL["base"])
    ext = _mask_extent(base_mask)
    if ext:
        r = _scale_regions([ext], stride)[0]
        g = _geom(r["bbox"], r["centroid"], r["n"], width, height)
        g["present"] = True
        g["median_hex"] = _median_hex(small, base_mask)
        g["pixels"] = r["n"]
        g["flags"] = ["FRAME_FILLING"]
        out["base"] = g
    else:
        out["base"] = _absent("ABSENT")

    # RSF badge: orange components that look like a badge, not flood.
    rsf_mask = _rgb_mask32(frame32, PALETTE["rsf"], TOL["rsf"])
    cands = [r for r in _scale_regions(
        _regions(rsf_mask, min_n=max(1, RSF_MIN_N // (stride * stride))), stride)
        if r["n"] >= RSF_MIN_N
             and r["bbox"][0] > 0 and r["bbox"][1] > 0
             and r["bbox"][2] < width and r["bbox"][3] < height]
    audit = {"candidates": len(cands)}
    if cands:
        x0 = min(r["bbox"][0] for r in cands)
        y0 = min(r["bbox"][1] for r in cands)
        x1 = max(r["bbox"][2] for r in cands)
        y1 = max(r["bbox"][3] for r in cands)
        n_all = sum(r["n"] for r in cands)
        fill = n_all / max((x1 - x0) * (y1 - y0), 1)
        aspect = (x1 - x0) / max(y1 - y0, 1)
        audit.update({"fill": round(fill, 3), "aspect": round(aspect, 3),
                      "union_bbox": [x0, y0, x1, y1]})
        if fill >= RSF_FILL_MIN and RSF_ASPECT[0] <= aspect <= RSF_ASPECT[1]:
            cx = float(np.mean([r["centroid"][0] for r in cands]))
            cy = float(np.mean([r["centroid"][1] for r in cands]))
            g = _geom([x0, y0, x1, y1], [cx, cy], n_all, width, height)
            g["present"] = True
            g["median_hex"] = _median_hex(small, rsf_mask)
            g["pixels"] = n_all
            g["flags"] = []
            g["discriminator"] = audit
            out["rsf"] = g
        else:
            bad = _absent("REJECTED_BY_DISCRIMINATOR")
            bad["discriminator"] = audit
            out["rsf"] = bad
    else:
        bad = _absent("ABSENT")
        bad["discriminator"] = audit
        out["rsf"] = bad

    # White text: bright pixels above the caption cut. Union + components.
    luma = small.astype(np.float32) @ _REC709
    white_mask = luma >= WHITE_LUMA_MIN
    white_mask[CAPTION_CUT_Y // stride:, :] = False
    out["white_text"] = _text_layer(small, white_mask, width, height, stride)

    # October 2025 title: grey mask, union of all matching pixels.
    oct_mask = _rgb_mask32(frame32, PALETTE["october"], TOL["october"])
    out["october"] = _text_layer(small, oct_mask, width, height, stride)
    return out


def _text_layer(small, mask, width, height, stride):
    # Only components of at least LABEL_MIN_N full-res pixels count:
    # grain specks must not stretch the union bbox.
    regions = _scale_regions(
        _regions(mask, min_n=max(1, LABEL_MIN_N // (stride * stride))), stride)
    if not regions:
        return _absent("ABSENT")
    g = _union_geom(regions, width, height)
    g["present"] = True
    g["median_hex"] = _median_hex(small, mask)
    g["pixels"] = sum(r["n"] for r in regions)
    g["flags"] = []
    g["components"] = [r for r in regions if r["n"] >= LABEL_MIN_N]
    return g


def text_clusters(components, x_gap=150, y_band=20):
    """Group white-text components into label clusters by proximity.

    Components sorted by x. Each component joins the best-matching
    existing cluster (smallest vertical distance, then smallest x gap);
    a new cluster starts only when no cluster is within x_gap px
    horizontally and y_band px vertically. Comparing against every
    cluster matters: a stray element between two labels in x-order
    must not split the earlier label. The gaps are wide on purpose:
    the space inside "EL FASHER" is 121 px, while the two v4 chip
    labels sit 36 px apart vertically, so y is what splits them, not x.
    """
    comps = sorted(components, key=lambda c: c["bbox"][0])
    clusters = []
    for c in comps:
        best = None
        for cl in clusters:
            gap = c["bbox"][0] - cl["bbox"][2]
            dy = abs(c["centroid"][1] - cl["centroid"][1])
            if gap <= x_gap and dy <= y_band:
                score = (dy, gap)
                if best is None or score < best[0]:
                    best = (score, cl)
        if best is None:
            clusters.append({"bbox": list(c["bbox"]), "centroid": list(c["centroid"]),
                             "pixels": c["n"], "members": [c]})
            continue
        cl = best[1]
        cl["members"].append(c)
        cl["bbox"] = [min(cl["bbox"][0], c["bbox"][0]),
                      min(cl["bbox"][1], c["bbox"][1]),
                      max(cl["bbox"][2], c["bbox"][2]),
                      max(cl["bbox"][3], c["bbox"][3])]
        cl["pixels"] += c["n"]
        xs = [m["centroid"][0] for m in cl["members"]]
        ys = [m["centroid"][1] for m in cl["members"]]
        cl["centroid"] = [float(np.mean(xs)), float(np.mean(ys))]
    for cl in clusters:
        cl["n_components"] = len(cl["members"])
    return clusters


def identify_labels(clusters):
    """Name the text clusters. Only clusters of 3+ glyph components
    with a width/height aspect of at least 3 count as labels: horizontal
    text is wide, while map marks (pins, ring highlights) are compact.
    One label cluster is SUDAN. With two, the 5-glyph cluster is SUDAN
    and the wider one is EL FASHER. Ambiguous cases return None for
    that label and a flag, never a guess."""
    cands = [c for c in clusters if c["n_components"] >= 3
             and (c["bbox"][2] - c["bbox"][0]) / max(c["bbox"][3] - c["bbox"][1], 1) >= 3.0]
    if not cands:
        return {"sudan": None, "el_fasher": None, "flags": ["NO_TEXT_CLUSTERS"]}
    if len(cands) == 1:
        return {"sudan": cands[0], "el_fasher": None, "flags": []}
    fives = [c for c in cands if c["n_components"] == 5]
    if len(fives) == 1 and len(cands) == 2:
        other = [c for c in cands if c is not fives[0]][0]
        return {"sudan": fives[0], "el_fasher": other, "flags": []}
    return {"sudan": None, "el_fasher": None,
            "flags": ["AMBIGUOUS_CLUSTERS"],
            "clusters": [{"bbox": c["bbox"], "n_components": c["n_components"]} for c in cands]}


def match_label_near(frame, expected_xy, window_px=150, luma_min=LABEL_LUMA_MIN):
    """Bright components near an expected label centre (trace position).

    Used to validate the real side against the trace. Returns the union
    geometry of matching components, or None.
    """
    luma = frame.astype(np.float32) @ _REC709
    mask = luma >= luma_min
    mask[CAPTION_CUT_Y:, :] = False
    near = [r for r in _regions(mask, min_n=LABEL_MIN_N)
            if abs(r["centroid"][0] - expected_xy[0]) <= window_px
            and abs(r["centroid"][1] - expected_xy[1]) <= window_px]
    if not near:
        return None
    x0 = min(r["bbox"][0] for r in near)
    y0 = min(r["bbox"][1] for r in near)
    x1 = max(r["bbox"][2] for r in near)
    y1 = max(r["bbox"][3] for r in near)
    cx = float(np.mean([r["centroid"][0] for r in near]))
    cy = float(np.mean([r["centroid"][1] for r in near]))
    return {"bbox": [x0, y0, x1, y1], "centroid": [cx, cy],
            "n_components": len(near), "pixels": sum(r["n"] for r in near)}


def find_dot(frame, expected_xy, box=DOT_BOX, luma_min=DOT_LUMA_MIN, min_n=DOT_MIN_N):
    """The El Fasher dot: bright core pixels near the expected centre.

    Picks the bright component NEAREST the expected centre, not the
    centroid of all bright pixels: the EL FASHER "E" glyph sits 4 px
    from the dot and would pull a plain centroid 28 px to the right.
    Returns centroid, pixel count and bbox, or None when absent. The v4
    ring is coral (luma about 115), below the threshold, so it never
    matches.
    """
    x, y = int(expected_xy[0]), int(expected_xy[1])
    x0, y0 = max(0, x - box), max(0, y - box)
    x1, y1 = min(frame.shape[1], x + box), min(frame.shape[0], y + box)
    patch = frame[y0:y1, x0:x1].astype(np.float32) @ _REC709
    comps = _regions(patch >= luma_min, min_n=min_n)
    if not comps:
        return None
    best = min(comps, key=lambda c: (c["centroid"][0] + x0 - x) ** 2
               + (c["centroid"][1] + y0 - y) ** 2)
    return {"centroid": [round(best["centroid"][0] + x0, 1),
                         round(best["centroid"][1] + y0, 1)],
            "pixels": best["n"],
            "bbox": [best["bbox"][0] + x0, best["bbox"][1] + y0,
                     best["bbox"][2] + x0, best["bbox"][3] + y0]}


def pair_gap(a_xy, b_xy, width):
    """Distance between two points as a ratio of frame width."""
    if a_xy is None or b_xy is None:
        return None
    dx = (b_xy[0] - a_xy[0]) / width
    dy = (b_xy[1] - a_xy[1]) / width
    return {"dx_ratio": round(dx, 4), "dy_ratio": round(dy, 4),
            "dist_ratio": round(float(np.hypot(dx, dy)), 4)}


def gap_check(real_value, v4_value, tolerance):
    """One ratio gap against a tolerance. None values mean unmeasurable."""
    if real_value is None or v4_value is None:
        return {"gap": None, "pass": None, "status": "unmeasurable"}
    gap = round(abs(v4_value - real_value), 4)
    return {"gap": gap, "pass": bool(gap <= tolerance),
            "status": "pass" if gap <= tolerance else "fail"}


def stage_rows(ref_frame, render_frame, second, expected, tolerances):
    """Gap rows for one paired second, for the checker's S8 stage.

    expected: {"sudan_width_ratio": float} from the trace. Returns rows
    only; it never fails anything. The S8 stage is informational: the
    verdict is decided by S0-S7 and the human gate, never by S8.
    """
    r = segment_frame(ref_frame)
    v = segment_frame(render_frame)
    rows = []
    pos_tol = tolerances.get("position_ratio", 0.02)
    if r["sudan"]["present"] and v["sudan"]["present"]:
        rows.append({"second": second, "check": "sudan_centroid",
                     "value": ratio_gap(r["sudan"]["centroid_ratio"],
                                        v["sudan"]["centroid_ratio"]),
                     "threshold": pos_tol,
                     "v4_flags": v["sudan"].get("flags", [])})
        rows.append({"second": second, "check": "sudan_width",
                     "value": round(abs(r["sudan"]["bbox_ratio"][2]
                                        - v["sudan"]["bbox_ratio"][2]), 4),
                     "threshold": pos_tol,
                     "v4_flags": v["sudan"].get("flags", [])})
    if "sudan_width_ratio" in expected and v["sudan"]["present"]:
        rows.append({"second": second, "check": "zoom_vs_trace",
                     "value": round(abs(v["sudan"]["bbox_ratio"][2]
                                        - expected["sudan_width_ratio"]), 4),
                     "threshold": tolerances.get("zoom_ratio", 0.02),
                     "v4_flags": v["sudan"].get("flags", [])})
    return rows
