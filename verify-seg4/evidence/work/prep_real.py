"""Step A: prep paired frames for v4-vs-real measurement.

Real side: crop player rect (185,55,1717,885) from each picked browser
screenshot, resize to 1920x1080 (Lanczos). This stretches 1.845:1 to 16:9,
about 4% vertical; recorded as a limit in the report.
V4 side: stills are used as-is; frames 96/168 come from ffmpeg (separate call).
"""
from PIL import Image
import os

SNAP = "/home/hatch/workspace/.hatch-browser/snapshots/browser-task:d5ac3948-baa1-5449-be87-04f0d2cff1cc"
WORK = "/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence/work"
PLAYER = (185, 55, 1717, 885)

REAL = {
    1: "20261107T223659.250490710Z/look.3.png",
    4: "20261107T223727.863904210Z/look.3.png",
    5: "20261107T223847.358401254Z/look.3.png",
    7: "20261107T223332.051888320Z/look.3.png",
}

os.makedirs(WORK, exist_ok=True)
for sec, rel in REAL.items():
    src = os.path.join(SNAP, rel)
    im = Image.open(src).crop(PLAYER).resize((1920, 1080), Image.LANCZOS)
    out = os.path.join(WORK, f"real-{sec}s.png")
    im.save(out)
    print("wrote", out, im.size, os.path.getsize(out) // 1024, "KB")
