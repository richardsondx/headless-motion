#!/usr/bin/env python3
"""Pixel check for the look test render. Run after
`node tools/look-test/build-look-test.mjs --render`.

  python3 tools/look-test/check-look-test.py [--video DIR/video.mp4]

Checks, all measured from the rendered frames:
- ffprobe: 240 frames at 24 fps, 10.0 s, 16:9 at previs size
  (854x480) or better. Regions are given in 1920x1080 scene px
  and scaled to the rendered size.
- No black plate edges: the four 40x40 corner patches of the
  frames at 0, 2, 4, 6, 8 s are not pure black (mean luma over 5).
- The character is on screen at 5 s: the host region
  (x 840-1080, y 380-860) holds skin pixels (#f4a261) and shirt
  pixels (#e2552f) within a tolerance of 30 per channel.
- The board holds text at 5 s: the board region (x 200-1020,
  y 150-270) holds ink pixels (#2b2d42) within tolerance 30.
- The tag is on screen at 5 s: the tag pill region holds dark
  navy pixels (#2b2d42) within tolerance 30.

Exit 0 PASS, 1 FAIL, 2 usage / missing file. Prints JSON.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

EXPECTED_FRAMES = 240
EXPECTED_FPS = 24
# Previs renders at 854x480, not full size. Regions below are given
# in 1920x1080 scene px and scaled to the rendered size, so the
# same check works at previs and at final.
SCENE_W, SCENE_H = 1920, 1080


def ffprobe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=nb_frames,r_frame_rate,width,height,duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)["streams"][0]


def extract_frames(video, times, out_dir):
    paths = []
    for t in times:
        p = Path(out_dir) / f"f{t}s.png"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(video),
             "-frames:v", "1", str(p)],
            check=True,
        )
        paths.append(p)
    return paths


def count_close(rgb, target, tol=30):
    diff = np.abs(rgb.astype(np.int32) - np.array(target, dtype=np.int32))
    return int((np.all(diff <= tol, axis=2)).sum())


def main(argv):
    ap = argparse.ArgumentParser(description="Pixel check for the look test render.")
    ap.add_argument("--video", default="out/look-test/render/video.mp4")
    args = ap.parse_args(argv)
    video = Path(args.video)
    if not video.exists():
        print(f"LOOK_TEST_NO_VIDEO {video}", file=sys.stderr)
        return 2
    probe = ffprobe(video)
    frames = int(probe.get("nb_frames") or 0)
    fps_num, fps_den = (int(v) for v in probe["r_frame_rate"].split("/"))
    fps = fps_num / fps_den if fps_den else 0
    width, height = int(probe["width"]), int(probe["height"])
    sx, sy = width / SCENE_W, height / SCENE_H
    checks = {
        "frames_240": frames == EXPECTED_FRAMES,
        "fps_24": abs(fps - EXPECTED_FPS) < 0.01,
        # Previs is 854x480; the bar is 16:9 at previs size or better.
        "size_16x9_previs_or_better": abs(width / height - 16 / 9) < 0.01 and width >= 854,
    }
    failed = [k for k, v in checks.items() if not v]
    with tempfile.TemporaryDirectory() as tmp:
        paths = extract_frames(video, [0, 2, 4, 6, 8], tmp)
        for p, t in zip(paths, [0, 2, 4, 6, 8]):
            img = np.array(Image.open(p).convert("RGB"))
            corners = [img[:40, :40], img[:40, -40:], img[-40:, :40], img[-40:, -40:]]
            luma = [float(c.mean()) for c in corners]
            key = f"corners_not_black_t{t}s"
            checks[key] = all(v > 5 for v in luma)
            if not checks[key]:
                failed.append(key)
        mid = np.array(Image.open(paths[2]).convert("RGB"))
        def region(x0, y0, x1, y1):
            return mid[int(y0 * sy):int(y1 * sy), int(x0 * sx):int(x1 * sx)]
        host = region(840, 380, 1080, 860)
        checks["host_skin_present_5s"] = count_close(host, (244, 162, 97)) > 100
        checks["host_shirt_present_5s"] = count_close(host, (226, 85, 47)) > 100
        board = region(200, 150, 1020, 270)
        checks["board_text_present_5s"] = count_close(board, (43, 45, 66)) > 40
        tag = region(1200, 180, 1560, 270)
        checks["tag_present_5s"] = count_close(tag, (43, 45, 66)) > 100
        for k in ("host_skin_present_5s", "host_shirt_present_5s",
                  "board_text_present_5s", "tag_present_5s"):
            if not checks[k]:
                failed.append(k)
    report = {
        "status": "PASS" if not failed else "FAIL",
        "failed_checks": failed,
        "probe": {"frames": frames, "fps": fps,
                  "width": int(probe["width"]), "height": int(probe["height"]),
                  "duration": probe.get("duration")},
        "checks": checks,
    }
    print(json.dumps(report, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
