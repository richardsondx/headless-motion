#!/usr/bin/env python3
"""Motion smoothness for a rendered clip, from the video file alone.

Usage:
    python3 benchmark/motion-smoothness.py benchmark/runs/map-sample-final/video.mp4 [...]

Decodes frames at 320x180 gray, then reports, per clip:
  - mean and median frame-to-frame mean absolute difference (0-255 scale)
  - max single-frame change and the frame where it happens
  - jumps: frames where the change is over 3x the median and over 2.0
    (a jump at a scene cut is expected; a jump mid-beat is a defect)
  - diff-of-diff sign flips (noisy on near-static frames; read with the
    jump list, not alone)

This is a smoothness check, not a quality check. It says nothing about
whether the motion matches the reference. That is the checker's job
(S4 motion error, S5 easing) in src/checker/.
"""
import io
import subprocess
import sys

import numpy as np
from PIL import Image


def analyse(path):
    cmd = ["ffmpeg", "-v", "error", "-i", path,
           "-vf", "scale=320:180,format=gray",
           "-f", "image2pipe", "-vcodec", "png", "-"]
    out = subprocess.run(cmd, capture_output=True, timeout=300).stdout
    sig = b"\x89PNG\r\n\x1a\n"
    frames = [np.asarray(Image.open(io.BytesIO(sig + p)), dtype=np.float32)
              for p in out.split(sig)[1:]]
    diffs = np.array([float(np.mean(np.abs(b - a)))
                      for a, b in zip(frames, frames[1:])])
    med = float(np.median(diffs))
    jumps = [int(i) for i, v in enumerate(diffs) if v > 3 * med and v > 2.0]
    dd = np.diff(diffs)
    flips = int(np.sum(np.sign(dd[1:]) != np.sign(dd[:-1])))
    print(f"{path}: frames={len(frames)} mean_diff={diffs.mean():.3f} "
          f"median={med:.3f} max={diffs.max():.3f} at_frame={int(diffs.argmax())} "
          f"jumps={jumps} sign_flips={flips}/{len(dd) - 1}")


for p in sys.argv[1:]:
    analyse(p)
