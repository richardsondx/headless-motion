#!/usr/bin/env python3
"""CSRT test: track the Seg4 RSF badge and measure deviation vs the trace.

Reference video is 1920x1038 at 23.976 fps. Trace positions are in 1920x1080
space (the video area was stretched ~4% vertically). Convert CSRT centres
(video coords) to 1080 space with y * 1080/1038 before comparing.
"""
import json
import math
import sys

import cv2

VIDEO = "/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence/refs/seg4-ref-0-8s.mp4"
OUT = "/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence/work/csrt-badge-test.json"

# Trace badge centres and sizes in 1920x1080 space (from seg4-trace.json).
TRACE_CENTRE = {4: (968, 597), 5: (799, 666), 6: (699, 727), 7: (693, 732)}
TRACE_SIZE = {4: (130, 135), 5: (143, 148), 6: (158, 166), 7: (160, 166)}

FPS = 23.976
Y_SCALE = 1080.0 / 1038.0  # video y -> 1080 y
Y_SCALE_INV = 1038.0 / 1080.0  # 1080 y -> video y


def frame_at(second):
    return int(round(second * FPS))


def main():
    cap = cv2.VideoCapture(VIDEO)
    if not cap.isOpened():
        print("cannot open video", VIDEO)
        return 2
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print("frames:", total, "fps:", cap.get(cv2.CAP_PROP_FPS))

    start_frame = frame_at(4)
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    ok, frame = cap.read()
    if not ok:
        print("cannot read frame", start_frame)
        return 2
    h, w = frame.shape[:2]
    print("frame size:", w, "x", h)

    # Init bbox in video coords from the 4s trace entry.
    cx1080, cy1080 = TRACE_CENTRE[4]
    bw, bh1080 = TRACE_SIZE[4]
    cx = cx1080
    cy = cy1080 * Y_SCALE_INV
    bh = bh1080 * Y_SCALE_INV
    bbox = (cx - bw / 2.0, cy - bh / 2.0, float(bw), float(bh))
    print("init bbox (video coords):", [round(v, 1) for v in bbox])

    tracker = cv2.TrackerCSRT_create()
    tracker.init(frame, tuple(int(v) for v in bbox))

    results = {}
    check_seconds = [5, 6, 7]
    target_frames = {frame_at(s): s for s in check_seconds}
    current = start_frame
    while current < frame_at(7):
        ok, frame = cap.read()
        if not ok:
            break
        current += 1
        ok, box = tracker.update(frame)
        if not ok:
            results["tracker_lost_at_frame"] = current
            print("tracker lost at frame", current)
            break
        if current in target_frames:
            s = target_frames[current]
            x, y, bw2, bh2 = box
            cx_v = x + bw2 / 2.0
            cy_v = y + bh2 / 2.0
            # Convert centre to 1920x1080 space.
            cx1080_t = cx_v
            cy1080_t = cy_v * Y_SCALE
            tx, ty = TRACE_CENTRE[s]
            dx = cx1080_t - tx
            dy = cy1080_t - ty
            dev = math.hypot(dx, dy)
            results[str(s)] = {
                "frame": current,
                "csrt_centre_1080": [round(cx1080_t, 1), round(cy1080_t, 1)],
                "csrt_size_video": [round(bw2, 1), round(bh2, 1)],
                "trace_centre_1080": [tx, ty],
                "dx": round(dx, 1),
                "dy": round(dy, 1),
                "deviation_px": round(dev, 2),
            }
            print(f"at {s}s frame {current}: csrt=({cx1080_t:.1f},{cy1080_t:.1f}) "
                  f"trace=({tx},{ty}) dev={dev:.2f}px")

    cap.release()
    verdict = "PASS" if all(
        results.get(str(s), {}).get("deviation_px", 999) <= 5.0
        for s in check_seconds if str(s) in results
    ) and len(results) >= len(check_seconds) else "FAIL"
    out = {
        "video": VIDEO,
        "tracker": "CSRT",
        "init_second": 4,
        "init_bbox_video": [round(v, 1) for v in bbox],
        "results": results,
        "verdict_5px": verdict,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print("verdict (<=5px at 5s, 6s, 7s):", verdict)
    print("wrote", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
