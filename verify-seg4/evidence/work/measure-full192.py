"""Full 192-frame check: v5 render vs the real Seg4 video, 0:00-0:08.

The real video is now on disk (refs/seg4-full-1080p.mp4, 1920x1038 at
23.976 fps). Frames were extracted with ffmpeg: the reference scaled to
1920x1080 (same stretch as the stills prep, so numbers stay comparable to
the 4-still check), v5 at native 1920x1080. 192 frames each.

Per frame: SSIM (luma) and PSNR (RGB) via src/checker/metrics.py.
LPIPS (alex, as in checker S6) every 8th frame, 24 frames, because LPIPS
over all 192 is slow. Delta E at the measure-v5.py POINTS for seconds
1, 4, 5, 7 only, for continuity with the stills check.

Run with the engine venv python. Writes work/full-192/full192-report.json.
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
DIR = WORK / "full-192"
N = 192


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

rows = []
for i in range(N):
    ref = load(DIR / f"ref-{i:04d}.png")
    v5 = load(DIR / f"v5-{i:04d}.png")
    assert ref.shape == v5.shape == (1080, 1920, 3), (i, ref.shape, v5.shape)
    ssim = metrics.ssim_frame(metrics.luma(ref), metrics.luma(v5))
    psnr = metrics.psnr_frame(ref, v5)
    rows.append({"frame": i, "second": round(i / 24, 3),
                 "ssim": round(ssim, 4), "psnr_db": round(psnr, 2)})
    if i % 48 == 0:
        print(f"frame {i} done", file=sys.stderr)

ssims = [r["ssim"] for r in rows]
psnrs = [r["psnr_db"] for r in rows]
below_90 = [r["frame"] for r in rows if r["ssim"] < 0.90]
below_85 = [r["frame"] for r in rows if r["ssim"] < 0.85]
worst = sorted(rows, key=lambda r: r["ssim"])[:5]

# LPIPS every 8th frame.
import torch  # noqa: E402
import lpips as lpips_lib  # noqa: E402

with contextlib.redirect_stdout(sys.stderr):
    loss_fn = lpips_lib.LPIPS(net="alex")
lpips_scores = {}
for i in range(0, N, 8):
    ref = load(DIR / f"ref-{i:04d}.png")
    v5 = load(DIR / f"v5-{i:04d}.png")
    a = torch.from_numpy(ref.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    b = torch.from_numpy(v5.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    with torch.no_grad():
        lpips_scores[i] = round(float(loss_fn(a, b).item()), 4)
    print(f"lpips frame {i} done: {lpips_scores[i]}", file=sys.stderr)

# Delta E at the stills seconds, for continuity.
de_rows = {}
for sec, areas in POINTS.items():
    f = sec * 24
    ref = load(DIR / f"ref-{f:04d}.png")
    v5 = load(DIR / f"v5-{f:04d}.png")
    de_rows[sec] = {}
    for area, rp in areas.items():
        if rp is None:
            de_rows[sec][area] = {"present": False}
            continue
        r_med = np.median([median21(ref, x, y) for x, y in rp], axis=0)
        v_med = np.median([median21(v5, x, y) for x, y in rp], axis=0)
        de = round(delta_e(r_med, v_med), 2)
        de_rows[sec][area] = {"present": True, "real_hex": hex_of(r_med),
                              "v5_hex": hex_of(v_med), "delta_e": de,
                              "pass": bool(de < 3)}
worst_de = max((a["delta_e"], sec, k) for sec, d in de_rows.items()
               for k, a in d.items() if a.get("present"))

lpips_mean = round(sum(lpips_scores.values()) / len(lpips_scores), 4)
report = {
    "title": "v5 vs real Seg4, full 192 frames (0:00-0:08)",
    "date": "2026-11-08",
    "method": "Reference is the captured video (1920x1038 at 23.976 fps), "
              "frames scaled to 1920x1080, same stretch as the stills prep. "
              "v5 is the 192-frame render at 24 fps. SSIM/PSNR per frame via "
              "src/checker/metrics.py; LPIPS alex every 8th frame (24 frames); "
              "Delta E CIEDE2000 on 21x21 medians at the measure-v5.py points "
              "for seconds 1, 4, 5, 7.",
    "frames": N,
    "means": {"ssim": round(sum(ssims) / N, 4),
              "psnr_db": round(sum(psnrs) / N, 2),
              "lpips_every_8th": lpips_mean},
    "per_frame_floor": {"below_0.90": len(below_90), "below_0.85": len(below_85),
                        "below_0.90_frames": below_90[:20]},
    "worst_5_frames": [{"frame": r["frame"], "second": r["second"],
                        "ssim": r["ssim"], "psnr_db": r["psnr_db"]} for r in worst],
    "lpips_by_frame": {str(k): v for k, v in lpips_scores.items()},
    "delta_e_seconds": de_rows,
    "worst_delta_e": {"value": worst_de[0], "second": worst_de[1], "area": worst_de[2]},
    "verdict": ("PASS" if (sum(ssims) / N >= 0.96 and sum(psnrs) / N >= 35
                           and lpips_mean <= 0.08 and worst_de[0] < 3
                           and not below_90) else "FAIL"),
    "limits": [
        "Reference is 23.976 fps, v5 is 24 fps. Drift over 8s is under 0.2 frames, negligible.",
        "Reference frames are stretched about 4% vertically by the resize to 1920x1080, same as the stills prep. The control ceiling (0.9708 clean) includes this resize.",
        "LPIPS is every 8th frame, not all 192.",
        "Seconds 8-10 are phone footage, not the map, so they are outside the clone. The 192-frame check covers the map only.",
        "This is not the full checker (S0-S8): it runs the same metric functions over 192 frames but does not run S2 events, S4 motion, S7 gates, or the human gate.",
    ],
}
(DIR / "full192-report.json").write_text(json.dumps(report, indent=1))
print(json.dumps({k: report[k] for k in
                  ("means", "per_frame_floor", "worst_5_frames",
                   "worst_delta_e", "verdict")}, indent=1))
