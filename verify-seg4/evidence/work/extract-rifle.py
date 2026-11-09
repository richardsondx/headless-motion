"""Extract the rifle icon from the real Seg4 RSF badge as a transparent PNG.

Method (from study/2026-11-08-pixel-to-vector-reverse-engineering.md):
mask badge pixels by distance from badge orange, keep the largest connected
shape, exclude the text zone (bottom of the badge, y > 130 in badge coords).
Pixel copy only, no tracing: the rifle is ~2,660 px in a 149x111 box with
551 distinct colours, so a trace would discard shading and invent an outline.

Source frame: verify-seg4/evidence/work/real-7s.png (1920x1080).
Badge box in that frame: [613, 649, 773, 815] (160x166).
Output: a 160x166 RGBA PNG, rifle pixels at their badge-local positions,
everything else transparent, so the scene node can reuse the badge box and
the badge transform tracks exactly.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent.parent.parent
SRC = ROOT / "verify-seg4" / "evidence" / "work" / "real-7s.png"
DST = ROOT / "verify-seg4" / "evidence" / "work" / "rifle.png"

BADGE_X0, BADGE_Y0 = 613, 649
BADGE_W, BADGE_H = 160, 166
ORANGE = np.array([204.0, 71.0, 39.0])  # #CC4726, measured badge median
DIST_T = 50.0
LUMA_MAX = 150.0
TEXT_ZONE_Y = 130  # exclude y > 130 in badge coords (RSF text sits there)


def main():
    im = np.asarray(Image.open(SRC).convert("RGB")).astype(float)
    badge = im[BADGE_Y0:BADGE_Y0 + BADGE_H, BADGE_X0:BADGE_X0 + BADGE_W]
    dist = np.sqrt(((badge - ORANGE) ** 2).sum(axis=2))
    luma = 0.2126 * badge[:, :, 0] + 0.7152 * badge[:, :, 1] + 0.0722 * badge[:, :, 2]
    mask = (dist > DIST_T) & (luma < LUMA_MAX)
    mask[TEXT_ZONE_Y + 1:, :] = False
    lab, n = ndimage.label(mask)
    sizes = ndimage.sum_labels(mask, lab, range(1, n + 1))
    rifle_id = int(np.argmax(sizes)) + 1
    rifle = lab == rifle_id
    ys, xs = np.where(rifle)
    print(f"components: {n}, mask total: {int(mask.sum())}")
    print(f"rifle: {int(rifle.sum())} px, bbox x {xs.min()}-{xs.max()} y {ys.min()}-{ys.max()} "
          f"(badge coords, {xs.max() - xs.min() + 1}x{ys.max() - ys.min() + 1})")
    rejected = sorted(((int(sizes[i]), i + 1) for i in range(n) if i + 1 != rifle_id),
                      reverse=True)[:3]
    for size, cid in rejected:
        rys, rxs = np.where(lab == cid)
        print(f"rejected comp {cid}: {size} px, bbox x {rxs.min()}-{rxs.max()} "
              f"y {rys.min()}-{rys.max()}")
    rgba = np.zeros((BADGE_H, BADGE_W, 4), dtype=np.uint8)
    rgba[:, :, :3] = badge.astype(np.uint8)
    rgba[:, :, 3] = np.where(rifle, 255, 0)
    Image.fromarray(rgba, "RGBA").save(DST)
    print(f"wrote {DST} ({DST.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
