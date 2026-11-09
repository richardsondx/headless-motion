"""Recalibrate the yt arm of the control experiment at a YouTube-realistic
bitrate.

The first yt arm used x264 crf 28, which is harsher than YouTube (0.95 Mbps
against YouTube's roughly 4.5 to 8 Mbps for 1080p). This script re-encodes
the v5 video at crf 21, screenshots it at 1/4/5/7s through the same player
path, and measures it against the clean v5 frames with the same method as
measure-control.py. It prints the yt21 means and appends them to
control-ceiling.json under arms.yt21. It does not touch the recorded crf 28
numbers.

Run with the engine venv python (for LPIPS).
"""
import contextlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, "/home/hatch/workspace/headless-motion-engine/src")
from checker import metrics, color  # noqa: E402

ROOT = Path("/home/hatch/workspace/headless-motion-engine")
WORK = ROOT / "verify-seg4/evidence/work"
SHOTS = WORK / "control-shots"
FRAMES = SHOTS / "frames"
FRAMES.mkdir(parents=True, exist_ok=True)

VIDEO = ROOT / "out/seg4-final-v5/run-a/video.mp4"
YT21 = WORK / "control-v5-yt21.mp4"
PAGE = WORK / "control-player-yt21.html"
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


# 1. Encode at crf 21.
subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(VIDEO),
                "-c:v", "libx264", "-crf", "21", "-preset", "medium",
                "-pix_fmt", "yuv420p", "-an", str(YT21)], check=True)
mbps = YT21.stat().st_size * 8 / 8 / 1e6
print(f"yt21 file: {YT21.stat().st_size} bytes, {mbps:.2f} Mbps", flush=True)

# 2. Player page with 4 shots pointing at the yt21 video.
shots_html = ""
for sec in (1, 4, 5, 7):
    shots_html += (f'  <div class="shot" id="yt21-{sec}s">'
                   f'<video src="control-v5-yt21.mp4#t={sec}" muted preload="auto">'
                   f'</video></div>\n')
PAGE.write_text(f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Control player yt21</title>
<style>
  html, body {{ margin: 0; padding: 0; background: #000; width: 100%; height: 100%; overflow: hidden; }}
  .shot {{ display: none; position: absolute; left: 9.64%; top: 3.674%; width: 79.885%; aspect-ratio: 1533 / 831; }}
  .shot:target {{ display: block; }}
  video {{ width: 100%; height: 100%; object-fit: fill; background: #000; display: block; }}
</style></head><body>
{shots_html}</body></html>
""")

# 3. Screenshot the 4 shots with Playwright.
from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1919, "height": 1497})
    for sec in (1, 4, 5, 7):
        shot = f"yt21-{sec}s"
        page.goto(PAGE.as_uri() + "#" + shot, wait_until="load")
        page.wait_for_timeout(1500)
        try:
            page.wait_for_function(
                """([shot, target]) => {
                    const v = document.getElementById(shot).querySelector('video');
                    return v && v.readyState >= 2 && Math.abs(v.currentTime - target) < 0.15;
                }""", arg=[shot, sec], timeout=15000)
        except Exception:
            print(f"{shot}: seek wait timed out", flush=True)
        page.wait_for_timeout(500)
        path = SHOTS / f"control-{shot}.png"
        page.screenshot(path=str(path), full_page=False)
        print(f"{shot}: bytes={path.stat().st_size}", flush=True)
    browser.close()

# 4. Crop to frames and measure against the clean v5 frames.
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
