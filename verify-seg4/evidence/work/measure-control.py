"""Control experiment: what would a perfect clone score?

Compares the clean v5 frames against screenshots of our own v5 video taken
through the same player path as the reference frames (1919x1497 window,
video area 1533x831 at x185 y55, cropped and resized to 1920x1080).

Two arms:
  clean: screenshot of the clean v5 video. Measures the screenshot + resize
         penalty only.
  yt:    screenshot of a YouTube-like re-encode (x264 crf 28). Measures
         screenshot + resize + compression penalty.

Method mirrors measure-v5.py exactly: SSIM/PSNR via src/checker/metrics.py,
LPIPS alex as in checker S6, Delta E CIEDE2000 on 21x21 medians at the same
POINTS. Run with the engine venv python.

Note: the control screenshots carry no captions, player chrome, watermark or
cursor, so this ceiling is an UPPER bound. The true ceiling against the real
reference frames is lower, because those frames carry all of that.
"""
import contextlib
import json
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, "/home/hatch/workspace/headless-motion-engine/src")
from checker import metrics, color  # noqa: E402

WORK = "/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence/work"
SHOTS = WORK + "/control-shots"
FRAMES = SHOTS + "/frames"

# Crop box of the video area inside a 1919x1497 screenshot, same as the
# reference prep: x185 y55, 1533x831, resized to 1920x1080.
CROP = (185, 55, 185 + 1533, 55 + 831)


def load(path):
    return np.array(Image.open(path).convert("RGB"))


def control_frame(arm, sec):
    src = Image.open(f"{SHOTS}/control-{arm}-{sec}s.png").convert("RGB")
    assert src.size == (1919, 1497), (arm, sec, src.size)
    frame = src.crop(CROP).resize((1920, 1080), Image.LANCZOS)
    out = f"{FRAMES}/control-{arm}-{sec}s.png"
    frame.save(out)
    return np.array(frame)


def median21(frame, cx, cy):
    x0, y0 = max(0, cx - 10), max(0, cy - 10)
    patch = frame[y0:cy + 11, x0:cx + 11].reshape(-1, 3)
    return np.median(patch, axis=0).astype(float)


def hex_of(rgb):
    r, g, b = (int(round(v)) for v in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"


def delta_e(a_rgb, b_rgb):
    la = color.rgb_to_lab(np.array(a_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    lb = color.rgb_to_lab(np.array(b_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    return color.ciede2000(la, lb)


# Same sample points as measure-v5.py (trace points, same on both sides).
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

import os
os.makedirs(FRAMES, exist_ok=True)

results = {}
for arm in ("clean", "yt"):
    pairs = {}
    for sec in (1, 4, 5, 7):
        clean = load(f"{WORK}/v5-{sec}s.png")
        ctrl = control_frame(arm, sec)
        assert clean.shape == ctrl.shape == (1080, 1920, 3), (arm, sec, ctrl.shape)
        ssim = metrics.ssim_frame(metrics.luma(clean), metrics.luma(ctrl))
        psnr = metrics.psnr_frame(clean, ctrl)
        areas = {}
        for area in ("sudan", "land", "water", "rsf"):
            rp = POINTS[sec][area]
            if rp is None:
                areas[area] = {"present": False}
                continue
            c_meds = [median21(clean, x, y) for x, y in rp]
            s_meds = [median21(ctrl, x, y) for x, y in rp]
            c_med = np.median(np.array(c_meds), axis=0)
            s_med = np.median(np.array(s_meds), axis=0)
            de = round(delta_e(c_med, s_med), 2)
            areas[area] = {"present": True, "clean_hex": hex_of(c_med),
                           "control_hex": hex_of(s_med), "delta_e": de,
                           "pass": bool(de < 3)}
        worst = max((a["delta_e"] for a in areas.values() if a.get("present")), default=None)
        pairs[sec] = {"ssim": round(ssim, 4), "psnr_db": round(psnr, 2),
                      "areas": areas, "worst_delta_e": worst}
    results[arm] = pairs

# LPIPS, alex, same call as checker S6. Banner goes to stderr.
import torch  # noqa: E402
import lpips as lpips_lib  # noqa: E402

with contextlib.redirect_stdout(sys.stderr):
    loss_fn = lpips_lib.LPIPS(net="alex")
for arm in ("clean", "yt"):
    for sec in (1, 4, 5, 7):
        clean = load(f"{WORK}/v5-{sec}s.png")
        ctrl = load(f"{FRAMES}/control-{arm}-{sec}s.png")
        a = torch.from_numpy(clean.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
        b = torch.from_numpy(ctrl.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
        with torch.no_grad():
            results[arm][sec]["lpips"] = round(float(loss_fn(a, b).item()), 4)
        print(f"lpips {arm} {sec}s done: {results[arm][sec]['lpips']}", file=sys.stderr)

out = {"title": "Control experiment: ceiling for a perfect clone vs screenshot references",
       "date": "2026-11-08",
       "method": "Clean v5 frames vs screenshots of our own v5 video through the "
                 "same player path as the reference frames (1919x1497 window, "
                 "video area cropped 185,55,1533x831, resized to 1920x1080). "
                 "SSIM/PSNR via src/checker/metrics.py, LPIPS alex as in checker S6, "
                 "Delta E CIEDE2000 on 21x21 medians at the measure-v5.py points.",
       "arms": {}}
for arm in ("clean", "yt"):
    pairs = results[arm]
    means = {"ssim": round(sum(p["ssim"] for p in pairs.values()) / 4, 4),
             "psnr_db": round(sum(p["psnr_db"] for p in pairs.values()) / 4, 2),
             "lpips": round(sum(p["lpips"] for p in pairs.values()) / 4, 4)}
    worst = max((p["worst_delta_e"], s) for s, p in pairs.items()
                if p["worst_delta_e"] is not None)
    out["arms"][arm] = {"pairs": {str(k): v for k, v in pairs.items()},
                        "means_4_pairs": means,
                        "worst_delta_e": {"value": worst[0], "second": worst[1]},
                        "passes_pred_v1_seg4": bool(
                            means["ssim"] >= 0.96 and means["psnr_db"] >= 35
                            and means["lpips"] <= 0.08 and worst[0] < 3)}
out["limits"] = [
    "Control screenshots carry no captions, player chrome, watermark or cursor, "
    "so this ceiling is an UPPER bound. The true ceiling against the real "
    "reference frames is lower.",
    "The clean arm isolates the screenshot + resize penalty. The yt arm adds "
    "YouTube-like compression (x264 crf 28). Neither arm reproduces YouTube's "
    "exact encoder, so the yt arm is an approximation of the compression part.",
    "4 paired seconds only, same as the v5 check.",
]
print(json.dumps(out, indent=1))
with open(f"{WORK}/control-ceiling.json", "w") as f:
    json.dump(out, f, indent=1)
