"""V5 perceptual checker gates (law 7).

Every gate measures rendered pixels only, never layer values. Pixel
classes follow the spec exactly (see src/draw/check-pixels.py):
orange fill, cream fill, dark outline, pink nose. Silhouette masks
are cat pixels (orange | cream | dark).

Gates and bars (blueprint law 7, package P1-P12):
  seam_leak_count == 0      enclosed background holes in the audit silhouette
  foot_slip_px <= 0.1       planted foot vs its world pin, figure px
  front_symmetry_iou >= 0.94  yaw-0 flip IoU over legs, paws, ears (not the
                              whole figure: the tail is one-sided by design)
  silhouette_separability: solid-black silhouette IoU between distinct
                              beats < 0.78
  c0_corner_audit == 0      Bezier join tangent gaps >= 8 deg across torso
                              and limb-root paths

CLI: python -m checker.v5_gates --plan plan.json --out report.json
Plan: {"scale": 0.8, "silhouette": "pass1-audit.png",
       "poses": {"front": "front.png", ...},
       "pins": {"front": {"left": [x, y], "right": [x, y]}},
       "symmetry": {"pose": "front", "centre_x": 160,
                    "regions": [[x0, y0, x1, y1], ...]},
       "separability": [["front", "profile"], ...],
       "c0_paths": ["M ... C ... Z", ...]}
"""
import argparse
import json
import math
import re
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

# Bars, from the package predicate. Never relax them here.
BAR_SEAM_LEAK = 0
BAR_FOOT_SLIP_PX = 0.1
BAR_FRONT_SYMMETRY_IOU = 0.94
BAR_SEPARABILITY_IOU = 0.78
BAR_C0_CORNERS = 0
BAR_C0_DEG = 8.0


def load_rgb(path):
    return np.array(Image.open(path).convert("RGB"))


def classes(arr):
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    orange = (r >= 221) & (r <= 255) & (g >= 121) & (g <= 174) & (b >= 31) & (b <= 94)
    cream = (
        (r >= 236) & (r <= 255) & (g >= 216) & (g <= 247) & (b >= 161) & (b <= 219)
        & ((r - g) >= 9) & ((r - g) <= 31) & ((g - b) >= 16) & ((g - b) <= 59)
    )
    dark = (r < 110) & (g < 110) & (b < 170)
    cat = orange | cream | dark
    return {"orange": orange, "cream": cream, "dark": dark, "cat": cat}


def silhouette_mask(arr):
    """Solid-black silhouette mask: dark pixels in an audit render."""
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    return (r < 128) & (g < 128) & (b < 128)


def _components(mask):
    """4-connected components of a boolean mask, as lists of (y, x)."""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    comps = []
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or seen[y, x]:
                continue
            queue = deque([(y, x)])
            seen[y, x] = True
            px = []
            while queue:
                cy, cx = queue.popleft()
                px.append((cy, cx))
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((ny, nx))
            comps.append(px)
    return comps


def seam_leak_count(silhouette_png):
    """Enclosed background holes inside the audit silhouette.

    Flood-fill the background from the image border over
    non-silhouette pixels. Any non-silhouette pixel the flood cannot
    reach is enclosed: a seam leak. Counts connected components, so
    one hole is one leak whatever its size.
    """
    arr = load_rgb(silhouette_png)
    sil = silhouette_mask(arr)
    h, w = sil.shape
    outside = np.zeros_like(sil, dtype=bool)
    queue = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not sil[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if not sil[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((y, x))
    while queue:
        cy, cx = queue.popleft()
        for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
            if 0 <= ny < h and 0 <= nx < w and not sil[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                queue.append((ny, nx))
    enclosed = (~sil) & (~outside)
    # Ignore specks under 4 px: antialiasing fringe, not a seam.
    comps = [c for c in _components(enclosed) if len(c) >= 4]
    return {"seam_leak_count": len(comps), "leak_sizes_px": sorted((len(c) for c in comps), reverse=True)}


def foot_slip_px(pose_png, pin_rendered_x, foot_box, scale=1.0, expected_offset_fig=0.0,
                 side_sign=1, turnout_deg=12, foot_half_width_fig=28.5):
    """Planted-foot slip in figure px.

    pin_rendered_x is the world pin's x in RENDERED px (the caller
    converts from figure px with its own canvas mapping: rendered x
    is not figure x times scale, the figure origin is offset in the
    frame). foot_box is the rendered px box [x0, y0, x1, y1] holding
    the foot, with y1 = sole canvas y + 5. The foot's SOLE is
    measured from the FILL (orange/cream), never the dark outline:
    the Pass-1 keyline extends 9 px below the sole, so the dark
    pixels' lowest row is the stroke, not the foot, and it reads
    2-3 px off. For each row of the foot's height, the fill run
    containing the pin is taken, its midpoint corrected for the V6
    turnout shear ((6 - fig_y) * tan(turnout) * side_sign, 0 at the
    sole, 4.7 px at the instep), and the MEDIAN over rows is the
    slip: the median is robust to the other foot or the tail
    intruding into the box on a few rows. expected_offset_fig is
    the morph's known offset of the sole midpoint from the ankle
    pin (toe forward, heel tucked: (toeExtension - heelTuck) / 2,
    0 at front, 1 px at full profile, facing direction +x).
    """
    import math
    arr = load_rgb(pose_png)
    c = classes(arr)
    fill = c["orange"] | c["cream"]
    x0, y0, x1, y1 = [int(v) for v in foot_box]
    sub = fill[y0:y1, x0:x1]
    shear_k = math.tan(math.radians(turnout_deg)) * side_sign
    slips = []
    # Foot rows only: below the ankle (fig y -7) to the sole (fig y
    # +6). Above the ankle the leg tube overlaps the foot and the
    # run's midpoint is the leg's, not the foot's (the first build
    # used the whole foot height and read -12 px on the leg rows).
    top_row = max(y0, int(y1 - 5 - 13 * scale))
    for y in range(top_row, y1 - 4):
        row = sub[y - y0, :]
        xs = np.where(row)[0]
        if len(xs) == 0:
            continue
        # Runs in this row; take the run containing the pin x.
        runs = []
        start = xs[0]
        prev = xs[0]
        for v in xs[1:]:
            if v > prev + 1:
                runs.append((start, prev))
                start = v
            prev = v
        runs.append((start, prev))
        pin_local = pin_rendered_x - x0
        containing = [r for r in runs if r[0] <= pin_local <= r[1]]
        if containing:
            a, b = containing[0]
        else:
            a, b = min(runs, key=lambda r: min(abs(r[0] - pin_local), abs(r[1] - pin_local)))
        # Centre of the foot in this row. Normally the run IS the
        # foot and its midpoint is the centre. In profile the two
        # feet overlap and merge into one wide run, so the midpoint
        # is between the feet, not on either foot: then the foot's
        # OUTER edge is clean and the centre is one half-width in
        # from it (left foot from the left edge, right from the
        # right). A run wider than the foot plus 4 px is merged.
        half_w_canvas = foot_half_width_fig * scale
        if (b - a + 1) > 2 * half_w_canvas + 4:
            mid_canvas = x0 + (a + half_w_canvas if side_sign < 0 else b - half_w_canvas)
        else:
            mid_canvas = x0 + (a + b) / 2
        fig_y = 6 + (y - (y1 - 5)) / scale
        shift_fig = (6 - fig_y) * shear_k
        slips.append((mid_canvas - pin_rendered_x) / scale - shift_fig - expected_offset_fig)
    if not slips:
        return {"foot_slip_px": None, "error": "no fill pixels in foot rows"}
    slips.sort()
    med = slips[len(slips) // 2]
    return {
        "foot_slip_px": round(float(abs(med)), 3),
        "signed_median_fig": round(float(med), 3),
        "rows_used": len(slips),
        "row_slips": [round(float(s), 2) for s in slips],
        "pin_rendered_x": round(pin_rendered_x, 2),
    }


def _iou(a, b):
    inter = int((a & b).sum())
    union = int((a | b).sum())
    return inter / union if union else 1.0


def front_symmetry_iou(pose_png, centre_x, regions):
    """Horizontal-flip IoU over the given regions (legs, paws, ears).

    centre_x is the rendered-px flip axis. Each region is
    [x0, y0, x1, y1] in rendered px. The mask inside the regions is
    flipped about centre_x and compared with itself: IoU 1.0 is
    perfectly symmetric. The tail is excluded by design: it sweeps
    to one side in every pose.
    """
    arr = load_rgb(pose_png)
    mask = classes(arr)["cat"]
    h, w = mask.shape
    flipped = mask[:, ::-1]
    # Flip about centre_x, not about the image centre: shift the
    # flipped image so its axis lands on centre_x.
    shift = int(round(2 * centre_x - (w - 1)))
    aligned = np.zeros_like(mask)
    if shift >= 0:
        aligned[:, shift:] = flipped[:, : w - shift]
    else:
        aligned[:, : w + shift] = flipped[:, -shift:]
    region_mask = np.zeros_like(mask)
    for x0, y0, x1, y1 in regions:
        region_mask[y0:y1, x0:x1] = True
    a = mask & region_mask
    b = aligned & region_mask
    return {"front_symmetry_iou": round(_iou(a, b), 4)}


def silhouette_iou(png_a, png_b):
    """IoU of two solid-black silhouettes, aligned by bbox centre."""
    ma = silhouette_mask(load_rgb(png_a))
    mb = silhouette_mask(load_rgb(png_b))

    def bbox(m):
        ys, xs = np.where(m)
        if len(xs) == 0:
            return None
        return xs.min(), ys.min(), xs.max(), ys.max()

    ba, bb = bbox(ma), bbox(mb)
    if ba is None or bb is None:
        return {"silhouette_iou": None, "error": "empty silhouette"}
    # Translate mb so its bbox centre lands on ma's.
    ca = ((ba[0] + ba[2]) / 2, (ba[1] + ba[3]) / 2)
    cb = ((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)
    dy = int(round(ca[1] - cb[1]))
    dx = int(round(ca[0] - cb[0]))
    shifted = np.zeros_like(mb)
    h, w = mb.shape
    y0a, y1a = max(0, dy), min(h, h + dy)
    y0b, y1b = max(0, -dy), min(h, h - dy)
    x0a, x1a = max(0, dx), min(w, w + dx)
    x0b, x1b = max(0, -dx), min(w, w - dx)
    shifted[y0a:y1a, x0a:x1a] = mb[y0b:y1b, x0b:x1b]
    return {"silhouette_iou": round(_iou(ma, shifted), 4)}


_C_RE = re.compile(r"C\s+(-?[\d.]+),(-?[\d.]+)\s+(-?[\d.]+),(-?[\d.]+)\s+(-?[\d.]+),(-?[\d.]+)")
_M_RE = re.compile(r"M\s+(-?[\d.]+),(-?[\d.]+)")


def c0_corner_audit(d_list):
    """Count Bezier joins with tangent discontinuity >= 8 deg.

    d_list is the torso and limb-root path data strings. Each cubic
    segment's end tangent (end - 2nd control) is compared with the
    next segment's start tangent (1st control - start). A gap at or
    above 8 deg is a C0 corner. Closed paths wrap the last segment
    onto the first.
    """
    corners = []
    for di, d in enumerate(d_list):
        m = _M_RE.search(d)
        if not m:
            continue
        start = (float(m.group(1)), float(m.group(2)))
        segs = [[float(v) for v in g] for g in _C_RE.findall(d)]
        if not segs:
            continue
        pts = [start]
        for s in segs:
            pts.append((s[4], s[5]))

        def angle_between(a, b):
            dd = abs(math.atan2(a[1], a[0]) - math.atan2(b[1], b[0]))
            if dd > math.pi:
                dd = 2 * math.pi - dd
            return math.degrees(dd)

        for i, s in enumerate(segs):
            nxt = segs[(i + 1) % len(segs)]
            end_tan = (s[4] - s[2], s[5] - s[3])
            start_tan = (nxt[0] - s[4], nxt[1] - s[5])
            if math.hypot(*end_tan) < 1e-9 or math.hypot(*start_tan) < 1e-9:
                continue
            gap = angle_between(end_tan, start_tan)
            if gap >= BAR_C0_DEG:
                corners.append({"path": di, "segment": i, "gap_deg": round(gap, 2)})
    return {"c0_corner_count": len(corners), "corners": corners}


def run_gates(plan):
    """Run every gate in a plan dict. Returns a report dict."""
    scale = plan.get("scale", 1.0)
    report = {"gates": {}, "verdict": "PASS"}
    if "silhouette" in plan:
        r = seam_leak_count(plan["silhouette"])
        r["pass"] = r["seam_leak_count"] == BAR_SEAM_LEAK
        report["gates"]["seam_leak_count"] = r
    if "foot" in plan:
        f = plan["foot"]
        r = foot_slip_px(f["png"], f["pin"], f["box"], scale)
        r["pass"] = r.get("foot_slip_px") is not None and r["foot_slip_px"] <= BAR_FOOT_SLIP_PX
        report["gates"]["foot_slip_px"] = r
    if "symmetry" in plan:
        s = plan["symmetry"]
        r = front_symmetry_iou(s["png"], s["centre_x"], s["regions"])
        r["pass"] = r["front_symmetry_iou"] >= BAR_FRONT_SYMMETRY_IOU
        report["gates"]["front_symmetry_iou"] = r
    if "separability" in plan:
        pairs = {}
        worst = 0.0
        for a, b in plan["separability"]:
            r = silhouette_iou(plan["poses"][a], plan["poses"][b])
            pairs[f"{a} vs {b}"] = r
            if r.get("silhouette_iou") is not None:
                worst = max(worst, r["silhouette_iou"])
        report["gates"]["silhouette_separability"] = {
            "pairs": pairs,
            "worst_iou": worst,
            "pass": worst < BAR_SEPARABILITY_IOU,
        }
    if "c0_paths" in plan:
        r = c0_corner_audit(plan["c0_paths"])
        r["pass"] = r["c0_corner_count"] == BAR_C0_CORNERS
        report["gates"]["c0_corner_audit"] = r
    for g in report["gates"].values():
        if not g.get("pass", True):
            report["verdict"] = "FAIL"
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    plan = json.loads(Path(args.plan).read_text())
    report = run_gates(plan)
    Path(args.out).write_text(json.dumps(report, indent=2) + "\n")
    print(f"verdict: {report['verdict']}")
    for name, g in report["gates"].items():
        print(f"  {name}: {g.get('pass')} {json.dumps({k: v for k, v in g.items() if k != 'pass'})[:200]}")
    return 0 if report["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
