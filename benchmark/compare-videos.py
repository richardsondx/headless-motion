#!/usr/bin/env python3
# Compare two videos frame by frame (SSIM on luma + PSNR), at 854x480 for
# speed. Usage: compare-videos.py <old.mp4> <new.mp4> <out.json>
# Used for the old-path vs new-path (layer cache + dedup) quality check.
# The videos must have the same frame count; frames are paired by index.
import sys, os, json, subprocess, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from checker.metrics import ssim_frame, psnr_frame, luma
import imageio.v2 as imageio
import numpy as np

def frames(video, outdir, scale="854:480"):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                    "-vf", f"scale={scale}", os.path.join(outdir, "f-%04d.png")],
                   check=True)
    return sorted(os.path.join(outdir, f) for f in os.listdir(outdir) if f.startswith("f-"))

def main():
    old, new, out = sys.argv[1], sys.argv[2], sys.argv[3]
    with tempfile.TemporaryDirectory() as td:
        a_dir, b_dir = os.path.join(td, "a"), os.path.join(td, "b")
        os.makedirs(a_dir); os.makedirs(b_dir)
        a = frames(old, a_dir); b = frames(new, b_dir)
        assert len(a) == len(b), f"frame counts differ: {len(a)} vs {len(b)}"
        ss, ps = [], []
        for fa, fb in zip(a, b):
            ia = imageio.imread(fa).astype(np.float64)
            ib = imageio.imread(fb).astype(np.float64)
            ss.append(ssim_frame(luma(ia), luma(ib)))
            ps.append(psnr_frame(ia, ib))
        result = {
            "old": old, "new": new, "frames": len(a),
            "ssim_mean": round(sum(ss) / len(ss), 5),
            "ssim_min": round(min(ss), 5),
            "ssim_below_0.99": sum(1 for s in ss if s < 0.99),
            "psnr_mean_db": round(sum(ps) / len(ps), 2),
            "psnr_min_db": round(min(ps), 2),
            "per_frame_ssim": [round(s, 5) for s in ss],
            "per_frame_psnr_db": [round(p, 2) for p in ps],
        }
        with open(out, "w") as f:
            json.dump(result, f, indent=1)
            f.write("\n")
        print(f"frames={len(a)} ssim_mean={result['ssim_mean']} ssim_min={result['ssim_min']} "
              f"below_0.99={result['ssim_below_0.99']} psnr_mean={result['psnr_mean_db']} psnr_min={result['psnr_min_db']}")

if __name__ == "__main__":
    main()
