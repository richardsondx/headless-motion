"""Fix-up: re-measure the three suspect samples with corrected points.

1. Real 4s Sudan: the first point (969,600) sat on the RSF badge (orange).
   Use (850,700) and (1100,650), both inside Sudan, clear of badge and label.
2. Real 7s RSF: the first point (945,552) was Sudan teal, not the badge.
   Use (720,700) and (693,732), both inside the badge.
3. Real SUDAN contrast background: the bbox method returned #3A4E4B, lighter
   than Sudan teal. Check a clean 21x21 Sudan patch above the label and
   recompute the ratio with the direct background.
"""
import json
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, "/home/hatch/workspace/headless-motion-engine/src")
from checker import color  # noqa: E402

WORK = "/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence/work"
EVID = "/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence"


def load(path):
    return np.array(Image.open(path).convert("RGB"))


def median21(frame, cx, cy):
    patch = frame[cy - 10:cy + 11, cx - 10:cx + 11].reshape(-1, 3)
    return np.median(patch, axis=0).astype(float)


def hex_of(rgb):
    r, g, b = (int(round(v)) for v in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"


def delta_e(a_rgb, b_rgb):
    la = color.rgb_to_lab(np.array(a_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    lb = color.rgb_to_lab(np.array(b_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    return round(color.ciede2000(la, lb), 2)


def rel_lum(rgb):
    v = np.array(rgb, dtype=np.float64) / 255.0
    v = np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    return float(0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2])


def ratio(fg, bg):
    l1, l2 = rel_lum(fg), rel_lum(bg)
    return round((max(l1, l2) + 0.05) / (min(l1, l2) + 0.05), 2)


real4 = load(f"{WORK}/real-4s.png")
v4_4 = load(f"{WORK}/v4-4s.png")
r_sudan4 = np.median([median21(real4, 850, 700), median21(real4, 1100, 650)], axis=0)
v_sudan4 = np.median([median21(v4_4, 1100, 600), median21(v4_4, 1400, 800)], axis=0)

real7 = load(f"{WORK}/real-7s.png")
v4_7 = load(f"{WORK}/v4-7s.png")
r_rsf7 = np.median([median21(real7, 720, 700), median21(real7, 693, 732)], axis=0)
v_rsf7 = median21(v4_7, 693, 732)  # coral flood where the badge should be

# SUDAN contrast background, direct patch above the label
bg_patch = median21(real7, 984, 480)
# glyph: median of bright pixels in the SUDAN bbox
box = real7[512:544, 894:1074].reshape(-1, 3).astype(np.float64)
luma = box @ np.array([0.2126, 0.7152, 0.0722])
glyph = np.median(box[luma >= np.percentile(luma, 90)], axis=0)
# EL FASHER background, direct patch above its label
bg_elf = median21(real7, 850, 600)
box_e = real7[625:652, 787:918].reshape(-1, 3).astype(np.float64)
luma_e = box_e @ np.array([0.2126, 0.7152, 0.0722])
glyph_e = np.median(box_e[luma_e >= np.percentile(luma_e, 90)], axis=0)

print(json.dumps({
    "sudan_4s": {"real_hex": hex_of(r_sudan4), "v4_hex": hex_of(v_sudan4),
                 "delta_e": delta_e(r_sudan4, v_sudan4)},
    "rsf_7s": {"real_hex": hex_of(r_rsf7), "v4_hex": hex_of(v_rsf7),
               "delta_e": delta_e(r_rsf7, v_rsf7),
               "note": "v4 value is the coral flood at the badge position; v4 has no orange badge"},
    "sudan_contrast_real_7s_direct_bg": {
        "glyph_hex": hex_of(glyph), "background_hex": hex_of(bg_patch),
        "ratio": ratio(glyph, bg_patch)},
    "el_fasher_contrast_real_7s_direct_bg": {
        "glyph_hex": hex_of(glyph_e), "background_hex": hex_of(bg_elf),
        "ratio": ratio(glyph_e, bg_elf)},
}, indent=1))
