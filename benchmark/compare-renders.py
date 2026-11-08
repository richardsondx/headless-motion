#!/usr/bin/env python3
"""Compare two renders of the same scene frame by frame (SSIM/PSNR).

Usage:
    python3 benchmark/compare-renders.py <dir-a> <dir-b> [--frames 0,60,120,180,239]

Both dirs must contain frames/*.png (kept with --keep-frames) or
frame-hashes.json. Prints mean SSIM/PSNR over the sampled frames: the
visual cost of a profile change (e.g. final 1.5/medium vs final-max 2/slow).
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from skimage.metrics import peak_signal_noise_ratio as psnr
from skimage.metrics import structural_similarity as ssim


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--frames", default="0,60,120,180,239")
    args = ap.parse_args()
    da, db = Path(args.a), Path(args.b)
    rows = []
    for f in [int(x) for x in args.frames.split(",")]:
        pa, pb = da / "frames" / f"{f:06d}.png", db / "frames" / f"{f:06d}.png"
        if not pa.exists() or not pb.exists():
            print(f"frame {f}: missing in one dir, skipped")
            continue
        ia = Image.open(pa).convert("L")
        ib = Image.open(pb).convert("L")
        if ia.size != ib.size:
            # Kept frames are captured at supersample resolution, so final
            # (1.5x) and final-max (2x) frames differ in pixels. Resize the
            # larger down to the smaller before comparing.
            if ia.size[0] * ia.size[1] > ib.size[0] * ib.size[1]:
                ia = ia.resize(ib.size, Image.LANCZOS)
            else:
                ib = ib.resize(ia.size, Image.LANCZOS)
        ga = np.asarray(ia, dtype=np.float64)
        gb = np.asarray(ib, dtype=np.float64)
        s = ssim(ga, gb, data_range=255)
        p = psnr(ga, gb, data_range=255)
        rows.append((f, s, p))
        print(f"frame {f}: SSIM {s:.4f} PSNR {p:.2f} dB")
    if rows:
        ms = sum(r[1] for r in rows) / len(rows)
        mp = sum(r[2] for r in rows) / len(rows)
        print(f"mean over {len(rows)} frames: SSIM {ms:.4f} PSNR {mp:.2f} dB")


if __name__ == "__main__":
    main()
