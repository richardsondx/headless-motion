"""Step B (v5): measure v5 vs real for paired seconds 1, 4, 5, 7.

Same method as measure.py (v4): SSIM/PSNR via src/checker/metrics.py,
LPIPS via lpips alex, Delta E via src/checker/color.py ciede2000 on
21x21 medians. Contrast: WCAG ratio from relative luminance.

Difference from v4: the v5 sample points EQUAL the real trace points on
both sides, because v5 places Sudan, the badge, and the labels at the
traced positions. The v4 run needed different points because v4's layout
was wrong. Contrast boxes at 7s are the real boxes on both sides, because
the v5 SUDAN label matches the real box within 1 px and the EL FASHER
box is the measured bbox used in the scene.

Prints one JSON object to stdout, in the final shape the layout check
consumes (psnr_db, delta_e, means_4_pairs, limits included).
Run with the engine venv python. Frame stills must already exist at
verify-seg4/evidence/work/v5-{1,4,5,7}s.png (see check-v5.sh).
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


# ---- sample points (x, y) in 1920x1080, from the trace ----
# Same coords on both sides: v5 places elements at the traced positions.
POINTS = {
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
V5_FILES = {1: f"{WORK}/v5-1s.png", 4: f"{WORK}/v5-4s.png",
            5: f"{WORK}/v5-5s.png", 7: f"{WORK}/v5-7s.png"}

pairs = {}
for sec in (1, 4, 5, 7):
    real = load(f"{WORK}/real-{sec}s.png")
    v5 = load(V5_FILES[sec])
    assert real.shape == v5.shape == (1080, 1920, 3), (sec, real.shape, v5.shape)
    ssim = metrics.ssim_frame(metrics.luma(real), metrics.luma(v5))
    psnr = metrics.psnr_frame(real, v5)
    areas = {}
    for area in ("sudan", "land", "water", "rsf"):
        rp = POINTS[sec][area]
        if rp is None:
            areas[area] = {"present": False, "note": "absent in both frames"}
            continue
        r_meds = [median21(real, x, y) for x, y in rp]
        v_meds = [median21(v5, x, y) for x, y in rp]
        r_med = np.median(np.array(r_meds), axis=0)
        v_med = np.median(np.array(v_meds), axis=0)
        de = round(delta_e(r_med, v_med), 2)
        areas[area] = {
            "present": True,
            "real_hex": hex_of(r_med),
            "v5_hex": hex_of(v_med),
            "real_point_hexes": [hex_of(m) for m in r_meds],
            "v5_point_hexes": [hex_of(m) for m in v_meds],
            "delta_e": de,
            "pass": bool(de < 3),
        }
    worst = max((a["delta_e"] for a in areas.values() if a.get("present")), default=None)
    pairs[sec] = {
        "real_file": f"verify-seg4/evidence/work/real-{sec}s.png",
        "v5_file": f"verify-seg4/evidence/work/v5-{sec}s.png",
        "ssim": round(ssim, 4),
        "psnr_db": round(psnr, 2),
        "areas": areas,
        "worst_delta_e": worst,
        "verdict": "PASS" if (ssim >= 0.96 and psnr >= 35 and worst is not None and worst < 3)
                   else "FAIL (ssim/psnr/delta-e; lpips pending)",
        "notes": "v5 sample points equal the real trace points on both sides.",
    }

# ---- LPIPS, alex, same call as checker S6 ----
# lpips prints its "Setting up..." banner to stdout when the model is
# created; redirect it to stderr so stdout stays pure JSON (the layout
# check reads this file as JSON, and a banner line breaks the parse).
import contextlib  # noqa: E402
import torch  # noqa: E402
import lpips as lpips_lib  # noqa: E402

with contextlib.redirect_stdout(sys.stderr):
    loss_fn = lpips_lib.LPIPS(net="alex")
for sec in (1, 4, 5, 7):
    real = load(f"{WORK}/real-{sec}s.png")
    v5 = load(V5_FILES[sec])
    a = torch.from_numpy(real.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    b = torch.from_numpy(v5.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    with torch.no_grad():
        pairs[sec]["lpips"] = round(float(loss_fn(a, b).item()), 4)
    p = pairs[sec]
    p["verdict"] = "PASS" if (p["ssim"] >= 0.96 and p["psnr_db"] >= 35
                             and p["lpips"] <= 0.08 and p["worst_delta_e"] is not None
                             and p["worst_delta_e"] < 3) else "FAIL"
    print(f"lpips {sec}s done: {pairs[sec]['lpips']}", file=sys.stderr)

# ---- contrast at 0:07, real boxes on both sides ----
real7 = load(f"{WORK}/real-7s.png")
v5_7 = load(V5_FILES[7])
contrast = {"note": "v5 boxes equal the real boxes: the v5 SUDAN label matches "
                    "the real box within 1 px and the EL FASHER box is the measured "
                    "bbox used in the scene."}
for side, frame in (("real", real7), ("v5", v5_7)):
    sg, sb, sr = label_contrast(frame, (894, 512, 1074, 544))
    eg, eb, er = label_contrast(frame, (787, 625, 918, 652))
    contrast[side] = {
        "sudan": {"glyph_hex": hex_of(sg), "background_hex": hex_of(sb),
                  "ratio": round(sr, 2), "meets_7_to_1": bool(sr >= 7)},
        "el_fasher": {"glyph_hex": hex_of(eg), "background_hex": hex_of(eb),
                      "ratio": round(er, 2), "meets_7_to_1": bool(er >= 7)},
    }

means = {
    "ssim": round(sum(p["ssim"] for p in pairs.values()) / 4, 4),
    "psnr_db": round(sum(p["psnr_db"] for p in pairs.values()) / 4, 2),
    "lpips": round(sum(p["lpips"] for p in pairs.values()) / 4, 4),
}
all_areas = [(a["delta_e"], sec, k) for sec, p in pairs.items()
             for k, a in p["areas"].items() if a.get("present")]
worst_de, worst_sec, worst_area = max(all_areas)
passing = [s for s, p in pairs.items() if p["verdict"] == "PASS"]

print(json.dumps({
    "title": "v5 clone vs real Seg4 opening: SSIM/PSNR/LPIPS/Delta E, 4 paired seconds",
    "date": "2026-11-08",
    "scope": "Paired stills at seconds 1, 4, 5, 7 only. NOT a 240-frame check.",
    "predicate": "pred-v1 seg4, FROZEN: mean SSIM >= 0.96, PSNR >= 35 dB, "
                 "LPIPS <= 0.08, flat colour Delta E < 3. No threshold changed.",
    "method": "Same as the v4 numbers run (measure.py): SSIM/PSNR via "
              "src/checker/metrics.py, LPIPS alex scaled to [-1, 1] as in checker "
              "S6, Delta E CIEDE2000 on 21x21 medians, contrast from WCAG ratios. "
              "V5 sample points equal the real trace points on both sides.",
    "files_used": {
        "real": [f"verify-seg4/evidence/work/real-{s}s.png" for s in (1, 4, 5, 7)],
        "v5": [f"verify-seg4/evidence/work/v5-{s}s.png" for s in (1, 4, 5, 7)],
        "frames": "v5 frames 24/96/120/168 at 24 fps from "
                  "out/seg4-final-v5/run-a/video.mp4",
    },
    "pairs": {str(k): v for k, v in pairs.items()},
    "means_4_pairs": means,
    "worst_delta_e": {"value": worst_de, "second": worst_sec, "area": worst_area},
    "contrast_7s": contrast,
    "overall_verdict": (f"PASS, {len(passing)} of 4 pairs pass pred-v1 Seg4."
                        if len(passing) == 4 else
                        f"FAIL, {len(passing)} of 4 pairs pass pred-v1 Seg4."),
    "what_passes": [f"{s}s" for s in passing],
    "what_fails": [f"{s}s" for s in (1, 4, 5, 7) if s not in passing],
    "limits": [
        "4 paired seconds only; no 240-frame verdict is possible from stills.",
        "Real frames are screenshots of a compressed YouTube stream, not studio frames. They carry a caption bar and player control bar at the bottom, an SP channel watermark at bottom-right, and a mouse cursor in some frames. None of that is video content, and all of it lowers SSIM, PSNR and LPIPS against the clean v5 render.",
        "Real frames were stretched from 1.845:1 to 16:9 (about 4% vertical) by the resize to 1920x1080.",
        "Sub-second timing uncertainty is about +/-0.5s: YouTube timecodes truncate to whole seconds, while v5 frames are exact (frames 24/96/120/168 at 24 fps).",
        "Delta E sample points are the trace points on both sides, because v5 places elements at the traced positions. Land and water are hard to separate in both videos at this compression.",
        "The 1s water sample fell on land; treat that row as indicative only.",
        "The full checker was not run: it needs a reference MP4, which does not exist, and the segment config has ref null. No fake reference video was built.",
    ],
}, indent=1))
