"""Step B: measure v4 vs real for paired seconds 1, 4, 5, 7.

SSIM/PSNR via src/checker/metrics.py (same functions as the checker).
LPIPS via lpips alex, inputs scaled to [-1, 1], same as checker stages S6.
Delta E via src/checker/color.py ciede2000 on 21x21 medians.
Contrast: WCAG ratio from relative luminance; glyph = median of pixels
at/above 90th-percentile luma inside the label bbox, background = median of
pixels at/below 50th-percentile luma inside the same bbox.

Sample points are 1920x1080 coords. Real points come from the trace
(mapped from screenshot px); v4 points were picked by viewing the v4 frames.
Prints one JSON object to stdout.
"""
import json
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, "/home/hatch/workspace/headless-motion-engine/src")
from checker import metrics, color  # noqa: E402

WORK = "/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence/work"
EVID = "/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence"


def load(path):
    return np.array(Image.open(path).convert("RGB"))


def median21(frame, cx, cy):
    x0, y0 = max(0, cx - 10), max(0, cy - 10)
    patch = frame[y0:cy + 11, x0:cx + 11].reshape(-1, 3)
    med = np.median(patch, axis=0)
    return med.astype(float)


def hex_of(rgb):
    r, g, b = (int(round(v)) for v in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"


def delta_e(a_rgb, b_rgb):
    la = color.rgb_to_lab(np.array(a_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    lb = color.rgb_to_lab(np.array(b_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    return color.ciede2000(la, lb)


def rel_lum(rgb):
    v = np.array(rgb, dtype=np.float64) / 255.0
    v = np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    return float(0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2])


def contrast_ratio(fg, bg):
    l1, l2 = rel_lum(fg), rel_lum(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def label_contrast(frame, bbox):
    x0, y0, x1, y1 = bbox
    region = frame[y0:y1, x0:x1].reshape(-1, 3).astype(np.float64)
    luma = region @ np.array([0.2126, 0.7152, 0.0722])
    hi = np.percentile(luma, 90)
    lo = np.percentile(luma, 50)
    glyph = np.median(region[luma >= hi], axis=0)
    bg = np.median(region[luma <= lo], axis=0)
    return glyph, bg, contrast_ratio(glyph, bg)


# ---- sample points (x, y) in 1920x1080 ----
REAL_POINTS = {
    1: {"sudan": [(980, 640), (1050, 720)],
        "land": [(750, 675), (1300, 620)],
        "water": [(1300, 620)],
        "rsf": None},
    4: {"sudan": [(969, 600), (1100, 650)],
        "land": [(500, 520), (500, 700)],
        "water": [(1350, 350)],
        "rsf": [(945, 552), (968, 597)]},
    5: {"sudan": [(976, 620), (1100, 650)],
        "land": [(480, 530), (480, 700)],
        "water": [(1380, 350)],
        "rsf": [(799, 666), (830, 700)]},
    7: {"sudan": [(970, 578), (770, 578), (1208, 578), (970, 344), (970, 772), (989, 552)],
        "land": [(645, 513), (1521, 383)],
        "water": [(1333, 383)],
        "rsf": [(945, 552), (693, 732)]},
}
V4_POINTS = {
    1: {"sudan": [(1100, 600), (1400, 800)],
        "land": [(300, 500), (200, 900)],
        "water": [(1500, 250)],
        "rsf": None},
    4: {"sudan": [(1100, 600), (1400, 800)],
        "land": [(300, 500), (300, 900)],
        "water": [(1800, 200)],
        "rsf": [(968, 597)]},  # where the badge should be; v4 has no badge here
    5: {"sudan": [(1400, 200), (1300, 600)],
        "land": [(300, 500), (1700, 1000)],
        "water": [(1880, 300)],
        "rsf": [(799, 666)]},  # where the badge should be; v4 has no badge here
    7: {"sudan": [(1500, 150), (1300, 600)],
        "land": [(300, 400), (1700, 1000)],
        "water": [(1880, 500)],
        "rsf": [(693, 732)]},  # where the badge should be; v4 has a navy tag, not the orange square
}
V4_FILES = {1: f"{EVID}/v4-f24.png", 4: f"{WORK}/v4-4s.png",
            5: f"{EVID}/v4-f120.png", 7: f"{WORK}/v4-7s.png"}

pairs = {}
for sec in (1, 4, 5, 7):
    real = load(f"{WORK}/real-{sec}s.png")
    v4 = load(V4_FILES[sec])
    assert real.shape == v4.shape == (1080, 1920, 3), (sec, real.shape, v4.shape)
    ssim = metrics.ssim_frame(metrics.luma(real), metrics.luma(v4))
    psnr = metrics.psnr_frame(real, v4)
    areas = {}
    for area in ("sudan", "land", "water", "rsf"):
        rp = REAL_POINTS[sec][area]
        vp = V4_POINTS[sec][area]
        if rp is None or vp is None:
            areas[area] = {"present": False,
                           "note": "absent in both frames" if rp is None else "absent in real"}
            continue
        r_meds = [median21(real, x, y) for x, y in rp]
        v_meds = [median21(v4, x, y) for x, y in vp]
        r_med = np.median(np.array(r_meds), axis=0)
        v_med = np.median(np.array(v_meds), axis=0)
        areas[area] = {
            "present": True,
            "real_hex": hex_of(r_med),
            "v4_hex": hex_of(v_med),
            "real_point_hexes": [hex_of(m) for m in r_meds],
            "v4_point_hexes": [hex_of(m) for m in v_meds],
            "delta_e_ciede2000": round(delta_e(r_med, v_med), 2),
        }
    pairs[sec] = {"ssim": round(ssim, 4), "psnr": round(psnr, 2), "areas": areas}

# ---- LPIPS, alex, same call as checker S6 ----
import torch  # noqa: E402
import lpips as lpips_lib  # noqa: E402

loss_fn = lpips_lib.LPIPS(net="alex")
for sec in (1, 4, 5, 7):
    real = load(f"{WORK}/real-{sec}s.png")
    v4 = load(V4_FILES[sec])
    a = torch.from_numpy(real.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    b = torch.from_numpy(v4.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    with torch.no_grad():
        pairs[sec]["lpips"] = round(float(loss_fn(a, b).item()), 4)
    print(f"lpips {sec}s done: {pairs[sec]['lpips']}", file=sys.stderr)

# ---- contrast at 0:07 ----
real7 = load(f"{WORK}/real-7s.png")
v4_7 = load(V4_FILES[7])
contrast = {}
for side, frame, sudan_box, elf_box in (
        ("real", real7, (894, 512, 1074, 544), (787, 625, 918, 652)),
        ("v4", v4_7, (1155, 285, 1335, 365), (780, 255, 1075, 330))):
    sg, sb, sr = label_contrast(frame, sudan_box)
    eg, eb, er = label_contrast(frame, elf_box)
    contrast[side] = {
        "sudan": {"glyph_hex": hex_of(sg), "background_hex": hex_of(sb),
                  "ratio": round(sr, 2), "meets_7_to_1": bool(sr >= 7)},
        "el_fasher": {"glyph_hex": hex_of(eg), "background_hex": hex_of(eb),
                      "ratio": round(er, 2), "meets_7_to_1": bool(er >= 7)},
    }

print(json.dumps({"pairs": {str(k): v for k, v in pairs.items()},
                  "contrast_7s": contrast}, indent=1))
