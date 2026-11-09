"""Measure the yt21 arm against the clean v5 frames and append it to
control-ceiling.json. Same method as measure-control.py.
Run with the engine venv python: .venv/bin/python measure-yt21.py
"""
import contextlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, "/home/hatch/workspace/headless-motion-engine/src")
from checker import metrics, color  # noqa: E402

WORK = Path("/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence/work")
SHOTS = WORK / "control-shots"
FRAMES = SHOTS / "frames"
CROP = (185, 55, 185 + 1533, 55 + 831)

POINTS = {
    1: {"sudan": [(980, 640), (1050, 720)],
        "land": [(750, 675), (1300, 620)],
        "water": [(1300, 620)], "rsf": None},
    4: {"sudan": [(969, 600), (1100, 650)],
        "land": [(500, 520), (500, 700)],
        "water": [(1350, 350)], "rsf": [(945, 552), (968, 597)]},
    5: {"sudan": [(976, 620), (1100, 650)],
        "land": [(480, 530), (480, 700)],
        "water": [(1380, 350)], "rsf": [(799, 666), (830, 700)]},
    7: {"sudan": [(970, 578), (770, 578), (1208, 578), (970, 344), (970, 772), (989, 552)],
        "land": [(645, 513), (1521, 383)],
        "water": [(1333, 383)], "rsf": [(945, 552), (693, 732)]},
}


def load(path):
    return np.array(Image.open(path).convert("RGB"))


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


pairs = {}
for sec in (1, 4, 5, 7):
    src = Image.open(SHOTS / f"control-yt21-{sec}s.png").convert("RGB")
    assert src.size == (1919, 1497), src.size
    frame = src.crop(CROP).resize((1920, 1080), Image.LANCZOS)
    frame.save(FRAMES / f"control-yt21-{sec}s.png")
    ctrl = np.array(frame)
    clean = load(WORK / f"v5-{sec}s.png")
    ssim = metrics.ssim_frame(metrics.luma(clean), metrics.luma(ctrl))
    psnr = metrics.psnr_frame(clean, ctrl)
    areas = {}
    for area in ("sudan", "land", "water", "rsf"):
        rp = POINTS[sec][area]
        if rp is None:
            areas[area] = {"present": False}
            continue
        c_med = np.median([median21(clean, x, y) for x, y in rp], axis=0)
        s_med = np.median([median21(ctrl, x, y) for x, y in rp], axis=0)
        de = round(delta_e(c_med, s_med), 2)
        areas[area] = {"present": True, "clean_hex": hex_of(c_med),
                       "control_hex": hex_of(s_med), "delta_e": de,
                       "pass": bool(de < 3)}
    worst = max((a["delta_e"] for a in areas.values() if a.get("present")), default=None)
    pairs[sec] = {"ssim": round(ssim, 4), "psnr_db": round(psnr, 2),
                  "areas": areas, "worst_delta_e": worst}

import torch  # noqa: E402
import lpips as lpips_lib  # noqa: E402

with contextlib.redirect_stdout(sys.stderr):
    loss_fn = lpips_lib.LPIPS(net="alex")
for sec in (1, 4, 5, 7):
    clean = load(WORK / f"v5-{sec}s.png")
    ctrl = load(FRAMES / f"control-yt21-{sec}s.png")
    a = torch.from_numpy(clean.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    b = torch.from_numpy(ctrl.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    with torch.no_grad():
        pairs[sec]["lpips"] = round(float(loss_fn(a, b).item()), 4)
    print(f"lpips yt21 {sec}s: {pairs[sec]['lpips']}", file=sys.stderr)

mbps = (WORK / "control-v5-yt21.mp4").stat().st_size * 8 / 8 / 1e6
means = {"ssim": round(sum(p["ssim"] for p in pairs.values()) / 4, 4),
         "psnr_db": round(sum(p["psnr_db"] for p in pairs.values()) / 4, 2),
         "lpips": round(sum(p["lpips"] for p in pairs.values()) / 4, 4)}
worst = max((p["worst_delta_e"], s) for s, p in pairs.items()
            if p["worst_delta_e"] is not None)
arm = {"pairs": {str(k): v for k, v in pairs.items()},
       "means_4_pairs": means,
       "worst_delta_e": {"value": worst[0], "second": worst[1]},
       "bitrate_mbps": round(mbps, 2),
       "passes_pred_v1_seg4": bool(means["ssim"] >= 0.96 and means["psnr_db"] >= 35
                                   and means["lpips"] <= 0.08 and worst[0] < 3)}
ceiling_path = WORK / "control-ceiling.json"
data = json.loads(ceiling_path.read_text())
data["arms"]["yt21"] = arm
ceiling_path.write_text(json.dumps(data, indent=1))
print(json.dumps({"arm": "yt21", "means_4_pairs": means,
                  "worst_delta_e": {"value": worst[0], "second": worst[1]},
                  "passes_pred_v1_seg4": arm["passes_pred_v1_seg4"]}, indent=1))
