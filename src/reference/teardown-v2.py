"""Unit A reference teardown — Ozempic 0:00-1:15 (Kurzgesagt).

TEARDOWN-V2 (Unit D fix cycle 2, 2026-11-08): identical to teardown.py
except TRACE_PARAMS below. The tournament params (colour_precision 6,
layer_difference 16, filter_speckle 4) quantize colour so hard that
full-res traces cap at PSNR ~20 dB and SSIM ~0.92 on detailed frames,
and 3/3 palette colour samples miss by up to 19 Delta E. Measured on
Ozempic Gate 1 worst frames (clone 180/200/206): fine-geo preset
(colour_precision 8, layer_difference 8, filter_speckle 0,
corner_threshold 30, length_threshold 2.0) gives SSIM 0.993-0.994,
PSNR 39.4-39.7 dB, Delta E 1.41 at the failing sample. The old preset
is kept in trace history below for comparison; the default is fine-geo.
The original teardown.py is untouched; this file supersedes it.
Evidence: units/D/evidence/d-vtracer-variants.py output, 2026-11-08.

Builds reference-profile.json from the measured reference video only.
No value is guessed: every palette hex, geometry ratio, timing and
trajectory value carries its source (frame number, coordinates, or
measured derivation). Anything unmeasurable is marked UNMEASURED.

Method (all light, chunked, one frame at a time, no full-video load):
  Pass 1  stream at 480x270: per-frame luma-diff energy, same formula as
          checker/events.py frame_diff_energy (mean abs luma diff inside
          the rect; here the full frame). Cuts = energy peaks over an
          adaptive threshold. Events = local energy maxima.
  Pass 2  palette + geometry from sampled frames at 960x540 (k-means,
          cv2), each hex with source frame + sample coords at 1920x1080.
  Pass 3  warp-interval test per shot (Farneback backward flow + remap,
          checker SSIM) at 480x270: SSIM at +1/+5/+10/+20/+40 frames.
  Pass 4  VTracer spline colour traces per keyframe at 960x540
          (fine-geo preset, Unit D fix cycle 2 — the tournament params
          capped traces at ~20 dB PSNR), rasterised with sharp,
          SSIM/PSNR measured.
  Pass 5  trajectories: stream at 480x270, per palette-colour mask
          centroid + area fraction per frame (60 fps).

FPS conversion (recorded BEFORE any clone frame is built, frozen here):
  reference 60 fps (4,500 frames in 75 s) vs engine 24 fps (1,800 frames).
  Clone frame f at time t = f/24 matches reference frame floor(t*60)
  = floor(f*2.5). Gates apply at the comparison fps recorded in the
  profile. The ffmpeg equivalent is -vf fps=24 (same floor rule).

Run with the engine .venv python and PYTHONPATH including
exp1-vtracer/lib (vtracer), code-map-explainer venv site-packages (cv2)
and engine src (checker metrics/events):
  PYTHONPATH=.../exp1-vtracer/lib:.../code-map-explainer/.venv/lib/python3.12/site-packages:.../headless-motion-engine/src \
    .../headless-motion-engine/.venv/bin/python src/reference/teardown.py \
    --start-s 0 --end-s 10 --out-dir .../units/A --pilot
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import time

REF = "/home/hatch/workspace/handover-motion-top3/refs/ozempic-0-75s/ozempic-full-1080p60.mp4"
ENGINE = "/home/hatch/workspace/headless-motion-engine"
EXP = "/home/hatch/workspace/handover-motion-style-copy/experiments"
TRACE_PARAMS = dict(colormode="color", mode="spline",
                    filter_speckle=0, color_precision=8, layer_difference=8,
                    corner_threshold=30, length_threshold=2.0,
                    splice_threshold=45, path_precision=3)
# Previous default (tournament / Unit A), kept for comparison only.
# Measured on Ozempic Gate 1: SSIM 0.918-0.985, PSNR 18.7-22.9 dB,
# Delta E up to 19. It cannot pass the pred-v1 PSNR 35 dB bar.
TRACE_PARAMS_BASE_V1 = dict(colormode="color", mode="spline",
                    filter_speckle=4, color_precision=6, layer_difference=16,
                    corner_threshold=60, length_threshold=4.0,
                    splice_threshold=45, path_precision=3)
# Intermediate preset, also measured: SSIM 0.989-0.991, PSNR 37.1-37.8 dB.
TRACE_PARAMS_FINE_COLOUR = dict(colormode="color", mode="spline",
                    filter_speckle=2, color_precision=8, layer_difference=8,
                    corner_threshold=60, length_threshold=4.0,
                    splice_threshold=45, path_precision=3)
W_FULL, H_FULL = 1920, 1080
REF_FPS = 60.0
ENG_FPS = 24.0


def log(msg):
    print(msg, flush=True)


def ffprobe_video(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,codec_name",
         "-show_entries", "format=duration,size",
         "-of", "json", path], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    num, den = (float(x) for x in s["r_frame_rate"].split("/"))
    return {"width": int(s["width"]), "height": int(s["height"]),
            "r_frame_rate": s["r_frame_rate"], "avg_frame_rate": s["avg_frame_rate"],
            "fps": num / den, "codec": s["codec_name"],
            "duration_s": float(j["format"]["duration"]),
            "size_bytes": int(j["format"]["size"])}


def extract_frame_rgb(path, frame60, w, h):
    """One frame at 60-fps index frame60, scaled to w x h, RGB numpy."""
    import numpy as np
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path,
         "-vf", "select='eq(n\\,%d)',scale=%d:%d,format=rgb24" % (frame60, w, h),
         "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True)
    if r.returncode != 0 or len(r.stdout) != w * h * 3:
        raise RuntimeError("extract frame %d failed rc=%d bytes=%d err=%s"
                           % (frame60, r.returncode, len(r.stdout),
                              r.stderr.decode()[:200]))
    return np.frombuffer(r.stdout, dtype=np.uint8).reshape(h, w, 3).copy()


def stream_frames(path, start_s, end_s, w, h, max_frames=None):
    """Yield (frame60_index, rgb array) streaming at w x h. One frame at a time.

    Frame-accurate: uses select='gte(n,START)' + -vsync 0, the same
    construction as checker/decode.py decode_frames. Do NOT use -ss
    before -i: measured 2026-11-08, -ss 2.0 yields global frame 119 as
    its first frame (labels +1), which shifted every pilot energy/cut/
    trace frame by one. Verified: stream label == select(n) pixel-exact
    (mean abs diff 0.0) after this fix.
    """
    import numpy as np
    dur = end_s - start_s
    if max_frames is None:
        max_frames = int(round(dur * REF_FPS))
    start_frame = int(round(start_s * REF_FPS))
    cmd = ["ffmpeg", "-v", "error", "-i", path,
           "-vf", "select='gte(n\\,%d)',scale=%d:%d,format=rgb24" % (start_frame, w, h),
           "-vsync", "0", "-frames:v", str(max_frames),
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    fb = w * h * 3
    n = 0
    try:
        while n < max_frames:
            buf = proc.stdout.read(fb)
            if len(buf) < fb:
                break
            yield start_frame + n, np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3).copy()
            n += 1
    finally:
        proc.stdout.close()
        proc.wait()


def luma(rgb):
    import numpy as np
    return rgb.astype(np.float32) @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def find_peaks(energies, min_dist=12, min_energy=8.0):
    """Local maxima of per-frame energy. energies: list of (frame, e)."""
    peaks = []
    for i in range(1, len(energies) - 1):
        f, e = energies[i]
        if e >= energies[i - 1][1] and e >= energies[i + 1][1] and e >= min_energy:
            if peaks and f - peaks[-1]["frame_60"] < min_dist:
                if e > peaks[-1]["energy"]:
                    peaks[-1] = {"frame_60": f, "energy": round(float(e), 3)}
                continue
            peaks.append({"frame_60": int(f), "energy": round(float(e), 3)})
    return peaks


def pass1_energy(start_s, end_s):
    """Pass 1: streaming energy + cuts at 480x270."""
    import numpy as np
    t0 = time.time()
    energies = []
    prev_luma = None
    frames_seen = 0
    mean_rgb_sum = None
    for f, rgb in stream_frames(REF, start_s, end_s, 480, 270):
        cur = luma(rgb)
        if prev_luma is not None:
            e = float(np.mean(np.abs(cur - prev_luma)))
            energies.append((f, e))
        prev_luma = cur
        frames_seen += 1
    # Adaptive cut threshold: median + 8 * MAD, floor 10, cap 40.
    vals = np.array([e for _, e in energies], dtype=np.float64)
    med = float(np.median(vals))
    mad = float(np.median(np.abs(vals - med))) or 1.0
    thresh = min(40.0, max(10.0, med + 8 * mad))
    cuts = [f for f, e in energies if e >= thresh]
    # Merge cuts closer than 12 frames (0.2 s), keep the strongest.
    merged = []
    for f in cuts:
        e = dict(energies)[f]
        if merged and f - merged[-1][0] < 12:
            if e > merged[-1][1]:
                merged[-1] = (f, e)
            continue
        merged.append((f, e))
    peaks = find_peaks(energies, min_dist=12, min_energy=8.0)
    return {"energies": [(int(f), round(float(e), 3)) for f, e in energies],
            "frames_seen": frames_seen, "wall_s": round(time.time() - t0, 1),
            "median_energy": round(med, 3), "mad": round(mad, 3),
            "cut_threshold": round(thresh, 3),
            "cuts": [{"frame_60": int(f), "energy": round(float(e), 3)} for f, e in merged],
            "events": peaks}


def build_shots(start_frame, end_frame, cuts):
    bounds = [start_frame] + [c["frame_60"] for c in cuts] + [end_frame]
    shots = []
    for i in range(len(bounds) - 1):
        s, e = bounds[i], bounds[i + 1]
        if e - s < 6:
            continue
        shots.append({"id": "shot-%02d" % (i + 1), "start_frame_60": int(s),
                      "end_frame_60": int(e), "start_s": round(s / REF_FPS, 3),
                      "end_s": round(e / REF_FPS, 3),
                      "duration_s": round((e - s) / REF_FPS, 3),
                      "frames_60": int(e - s)})
    return shots


def pass2_palette(shots, start_frame, end_frame):
    """Palette + geometry from sampled frames at 960x540 (k-means, cv2)."""
    import cv2
    import numpy as np
    t0 = time.time()
    # Sample frames: each shot start+6, midpoint, end-6 (deduped, in range).
    sample_frames = []
    for sh in shots:
        for f in (sh["start_frame_60"] + 6,
                  (sh["start_frame_60"] + sh["end_frame_60"]) // 2,
                  sh["end_frame_60"] - 6):
            if start_frame <= f < end_frame and f not in sample_frames:
                sample_frames.append(f)
    if not sample_frames:
        sample_frames = [(start_frame + end_frame) // 2]
    pooled = []
    per_frame = {}
    for f in sample_frames:
        rgb = extract_frame_rgb(REF, f, 960, 540)
        per_frame[f] = rgb
        pooled.append(rgb[::4, ::4].reshape(-1, 3))
    data = np.vstack(pooled).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 1.0)
    k = 8
    _, labels, centers = cv2.kmeans(data, k, None, criteria, 3,
                                    cv2.KMEANS_PP_CENTERS)
    labels = labels.flatten()
    counts = np.bincount(labels, minlength=k)
    order = np.argsort(-counts)
    palette = []
    for rank, ci in enumerate(order):
        centre = centers[ci]
        hexv = "#%02X%02X%02X" % tuple(int(round(c)) for c in centre)
        share = float(counts[ci]) / float(len(labels)) * 100.0
        # Source frame + coords: pixel closest to centre in the sampled
        # frame where this colour is most present.
        best = None
        for f, rgb in per_frame.items():
            small = rgb[::2, ::2].astype(np.float32)
            d = np.sqrt(np.sum((small - centre) ** 2, axis=-1))
            idx = int(np.argmin(d))
            y2, x2 = divmod(idx, d.shape[1])
            if best is None or float(d[y2, x2]) < best[0]:
                best = (float(d[y2, x2]), f, x2 * 2, y2 * 2)
        _, sf, sx, sy = best
        palette.append({"hex": hexv, "rgb": [int(round(c)) for c in centre],
                        "share_pct_pooled_samples": round(share, 2),
                        "source_frame_60": int(sf),
                        "source_frame_24": int(sf // 2.5) if False else int((sf / REF_FPS) * ENG_FPS),
                        "sample_x_1920": int(sx * 2), "sample_y_1080": int(sy * 2),
                        "sample_x_ratio": round(sx * 2 / W_FULL, 4),
                        "sample_y_ratio": round(sy * 2 / H_FULL, 4),
                        "rank": rank + 1})
    # Geometry: largest connected component of each palette colour mask
    # on its source frame at 960x540.
    geometry = []
    for p in palette:
        rgb = per_frame[p["source_frame_60"]]
        centre = np.array(p["rgb"], dtype=np.float32)
        d = np.sqrt(np.sum((rgb.astype(np.float32) - centre) ** 2, axis=-1))
        mask = (d < 30).astype(np.uint8)
        n, lab, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
        if n <= 1:
            geometry.append({"hex": p["hex"], "source_frame_60": p["source_frame_60"],
                             "area_ratio": 0.0, "bbox_ratio": None,
                             "centroid_ratio": None, "note": "no component over threshold"})
            continue
        j = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        x, y, w, h, area = (int(v) for v in stats[j])
        cx, cy = cent[j]
        geometry.append({"hex": p["hex"], "source_frame_60": p["source_frame_60"],
                         "area_ratio": round(float(area) / (960 * 540), 4),
                         "bbox_ratio": {"x": round(x / 960, 4), "y": round(y / 540, 4),
                                        "w": round(w / 960, 4), "h": round(h / 540, 4)},
                         "centroid_ratio": {"x": round(float(cx) / 960, 4),
                                            "y": round(float(cy) / 540, 4)}})
    return {"palette": palette, "geometry": geometry,
            "sample_frames_60": [int(f) for f in sample_frames],
            "wall_s": round(time.time() - t0, 1)}


def warp_ssim(key_rgb, tgt_rgb):
    """Farneback backward warp of keyframe to target; checker SSIM/PSNR."""
    import cv2
    import numpy as np
    from checker import metrics as M
    ga = cv2.cvtColor(key_rgb, cv2.COLOR_RGB2GRAY)
    gb = cv2.cvtColor(tgt_rgb, cv2.COLOR_RGB2GRAY)
    flow = cv2.calcOpticalFlowFarneback(gb, ga, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    h, w = ga.shape
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32),
                         np.arange(h, dtype=np.float32))
    warped = cv2.remap(key_rgb, xs + flow[..., 0], ys + flow[..., 1],
                       cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    ssim = M.ssim_frame(M.luma(tgt_rgb), M.luma(warped))
    psnr = M.psnr_frame(tgt_rgb, warped)
    return round(float(ssim), 4), round(float(psnr), 2)


def pass3_warp(shots, start_frame, end_frame):
    """Warp-interval test per shot at 480x270."""
    t0 = time.time()
    out = []
    for sh in shots:
        mid = (sh["start_frame_60"] + sh["end_frame_60"]) // 2
        if mid + 40 >= sh["end_frame_60"]:
            mid = sh["start_frame_60"] + 6
        try:
            key = extract_frame_rgb(REF, mid, 480, 270)
        except Exception as e:
            out.append({"shot_id": sh["id"], "keyframe_60": int(mid),
                        "error": "keyframe extract failed: %s" % e})
            continue
        rows = []
        max_ok = 0
        for dist in (1, 5, 10, 20, 40):
            tf = mid + dist
            if tf >= sh["end_frame_60"] or tf >= end_frame:
                rows.append({"distance_frames_60": dist, "target_frame_60": int(tf),
                             "ssim": None, "psnr": None, "note": "outside shot/window"})
                continue
            tgt = extract_frame_rgb(REF, tf, 480, 270)
            ssim, psnr = warp_ssim(key, tgt)
            rows.append({"distance_frames_60": dist, "target_frame_60": int(tf),
                         "ssim": ssim, "psnr": psnr})
            if ssim is not None and ssim >= 0.90:
                max_ok = dist
        out.append({"shot_id": sh["id"], "keyframe_60": int(mid),
                    "warp": rows, "max_interval_frames_60_ssim_ge_0.90": max_ok,
                    "max_interval_s": round(max_ok / REF_FPS, 3)})
    return {"per_shot": out, "wall_s": round(time.time() - t0, 1)}


def rasterize_svg(svg_bytes):
    r = subprocess.run(["node", os.path.join(EXP, "rasterize_stdin.js")],
                       input=svg_bytes, capture_output=True, cwd=ENGINE)
    if r.returncode != 0:
        raise RuntimeError("sharp failed: %s" % r.stderr.decode()[:300])
    from PIL import Image
    import numpy as np
    return np.array(Image.open(io.BytesIO(r.stdout)).convert("RGB"))


def svg_stats(svg_text):
    paths = len(re.findall(r"<path", svg_text))
    d_attrs = re.findall(r'd="([^"]+)"', svg_text)
    coords = sum(len(re.findall(r"-?\d+\.?\d*", d)) for d in d_attrs)
    return {"paths": paths, "coordinate_numbers": coords, "svg_bytes": len(svg_text)}


def pass4_traces(keyframes, out_dir):
    """VTracer traces per keyframe at 960x540. Returns list of trace records."""
    import io as _io
    import vtracer
    from PIL import Image
    from checker import metrics as M
    t0 = time.time()
    traces_dir = os.path.join(out_dir, "traces")
    os.makedirs(traces_dir, exist_ok=True)
    records = []
    for kf in keyframes:
        f = kf["frame_60"]
        t1 = time.time()
        try:
            rgb = extract_frame_rgb(REF, f, 960, 540)
            buf = _io.BytesIO()
            Image.fromarray(rgb).save(buf, format="PNG")
            svg = vtracer.convert_raw_image_to_svg(buf.getvalue(), img_format="png",
                                                   **TRACE_PARAMS)
            svg_text = svg.decode() if isinstance(svg, bytes) else svg
            name = "keyframe-%04d.svg" % f
            with open(os.path.join(traces_dir, name), "w") as fh:
                fh.write(svg_text)
            stats = svg_stats(svg_text)
            traced = rasterize_svg(svg_text.encode())
            ssim = M.ssim_frame(M.luma(rgb), M.luma(traced))
            psnr = M.psnr_frame(rgb, traced)
            records.append({"frame_60": int(f), "frame_24": int((f / REF_FPS) * ENG_FPS),
                            "time_s": round(f / REF_FPS, 3), "shot_id": kf.get("shot_id"),
                            "reason": kf.get("reason"),
                            "trace_file": "traces/" + name, "trace_scale": "960x540",
                            "trace_seconds": round(time.time() - t1, 1),
                            "svg_bytes": stats["svg_bytes"], "paths": stats["paths"],
                            "trace_ssim_960": round(float(ssim), 4),
                            "trace_psnr_960_db": round(float(psnr), 2)})
            log("trace f%d: %.1fs SSIM %.4f PSNR %.2f paths %d"
                % (f, time.time() - t1, ssim, psnr, stats["paths"]))
        except Exception as e:
            records.append({"frame_60": int(f), "frame_24": int((f / REF_FPS) * ENG_FPS),
                            "time_s": round(f / REF_FPS, 3), "shot_id": kf.get("shot_id"),
                            "reason": kf.get("reason"), "trace_file": None,
                            "error": "VTracer failed: %s" % e})
            log("trace f%d FAILED: %s" % (f, e))
    return {"records": records, "wall_s": round(time.time() - t0, 1)}


def pass5_trajectories(palette, start_s, end_s, start_frame, shots=None):
    """Per-target centroid trajectory per frame (60 fps), 480x270 masks."""
    import numpy as np
    t0 = time.time()
    cut_frames = set()
    if shots:
        for sh in shots[1:]:
            cut_frames.add(sh["start_frame_60"])
    centres = [np.array(p["rgb"], dtype=np.float32) for p in palette]
    hexes = [p["hex"] for p in palette]
    # Compact series: per target, lists of frame, x_ratio, y_ratio, area_frac.
    series = {h: {"frames": [], "x_ratio": [], "y_ratio": [], "area_frac": []}
              for h in hexes}
    frames_seen = 0
    for f, rgb in stream_frames(REF, start_s, end_s, 480, 270):
        arr = rgb.astype(np.float32)
        for centre, h in zip(centres, hexes):
            d = np.sqrt(np.sum((arr - centre) ** 2, axis=-1))
            mask = d < 30
            area = int(mask.sum())
            if area < 20:
                series[h]["frames"].append(int(f))
                series[h]["x_ratio"].append(None)
                series[h]["y_ratio"].append(None)
                series[h]["area_frac"].append(0.0)
                continue
            ys, xs = np.nonzero(mask)
            series[h]["frames"].append(int(f))
            series[h]["x_ratio"].append(round(float(xs.mean()) / 480, 4))
            series[h]["y_ratio"].append(round(float(ys.mean()) / 270, 4))
            series[h]["area_frac"].append(round(float(area) / (480 * 270), 4))
        frames_seen += 1
    # Derived velocity / peak / hold per target (1920x1080 px, 60 fps).
    derived = []
    for p in palette:
        h = p["hex"]
        s = series[h]
        xs = [None if v is None else v * W_FULL for v in s["x_ratio"]]
        ys = [None if v is None else v * H_FULL for v in s["y_ratio"]]
        vels = []
        for i in range(1, len(xs)):
            # Across a cut the centroid jump is an appearance change, not
            # motion: velocity is 0 there, never a peak.
            if s["frames"][i] in cut_frames:
                vels.append(0.0)
            elif xs[i] is None or xs[i - 1] is None:
                vels.append(0.0)
            else:
                vels.append(float(np.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])) * REF_FPS)
        peak_v = max(vels) if vels else 0.0
        peak_i = int(np.argmax(vels)) + 1 if vels else 0
        # Holds: runs of velocity < 2 px/s lasting >= 30 frames (0.5 s).
        holds = []
        run_start = None
        for i, v in enumerate(vels):
            if v < 2.0 and run_start is None:
                run_start = i
            if (v >= 2.0 or i == len(vels) - 1) and run_start is not None:
                run_end = i - 1 if v >= 2.0 else i
                if run_end - run_start + 1 >= 30:
                    holds.append({"start_frame_60": int(s["frames"][run_start]),
                                  "end_frame_60": int(s["frames"][run_end]),
                                  "duration_s": round((run_end - run_start + 1) / REF_FPS, 3)})
                run_start = None
        derived.append({"hex": h, "target_id": "target-%s" % h.lstrip("#"),
                        "peak_velocity_px_per_s": round(float(peak_v), 1),
                        "peak_velocity_frame_60": int(s["frames"][peak_i]) if vels else None,
                        "peak_velocity_frame_24": (int((s["frames"][peak_i] / REF_FPS) * ENG_FPS)
                                                   if vels else None),
                        "mean_velocity_px_per_s": round(float(np.mean(vels)), 1) if vels else 0.0,
                        "frames_present": int(sum(1 for a in s["area_frac"] if a > 0)),
                        "holds_over_0.5s": holds})
    return {"series": series, "derived": derived, "frames_seen": frames_seen,
            "wall_s": round(time.time() - t0, 1)}


def choose_keyframes(shots, warp, events, start_frame, end_frame, max_traces):
    """Shot starts + warp-interval spaced frames + event peaks, capped."""
    interval_by_shot = {}
    for w in warp["per_shot"]:
        iv = w.get("max_interval_frames_60_ssim_ge_0.90", 0) or 0
        if iv == 0:
            # Flow fails even 1 frame apart: this shot needs every frame exact.
            interval_by_shot[w["shot_id"]] = 1
        else:
            # Tested only to 40 frames; 40 means at least 40, use 40 (conservative).
            interval_by_shot[w["shot_id"]] = max(1, min(120, iv))
    kfs = []
    seen = set()

    def add(f, shot_id, reason):
        f = int(f)
        if f < start_frame or f >= end_frame or f in seen:
            return
        seen.add(f)
        kfs.append({"frame_60": f, "shot_id": shot_id, "reason": reason})

    for sh in shots:
        add(sh["start_frame_60"] + 2, sh["id"], "shot start")
        iv = interval_by_shot.get(sh["id"], 60)
        f = sh["start_frame_60"] + 2 + iv
        while f < sh["end_frame_60"] - 2:
            add(f, sh["id"], "warp interval %d frames" % iv)
            f += iv
        add((sh["start_frame_60"] + sh["end_frame_60"]) // 2, sh["id"], "shot midpoint")
    for ev in events:
        # Event peak frame belongs to the shot containing it.
        sid = None
        for sh in shots:
            if sh["start_frame_60"] <= ev["frame_60"] < sh["end_frame_60"]:
                sid = sh["id"]
                break
        add(ev["frame_60"], sid, "event peak")
    kfs.sort(key=lambda k: k["frame_60"])
    capped = kfs[:max_traces]
    return capped, len(kfs), interval_by_shot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-s", type=float, default=0.0)
    ap.add_argument("--end-s", type=float, default=75.0)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--max-traces", type=int, default=300)
    ap.add_argument("--skip-traces", action="store_true")
    ap.add_argument("--pilot", action="store_true")
    args = ap.parse_args()
    t_start = time.time()
    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.join(out_dir, "evidence"), exist_ok=True)
    start_frame = int(round(args.start_s * REF_FPS))
    end_frame = int(round(args.end_s * REF_FPS))
    window_frames_60 = end_frame - start_frame
    window_frames_24 = int(round((args.end_s - args.start_s) * ENG_FPS))

    probe = ffprobe_video(REF)
    log("ffprobe: %dx%d fps %.1f codec %s duration %.3f s size %d"
        % (probe["width"], probe["height"], probe["fps"], probe["codec"],
           probe["duration_s"], probe["size_bytes"]))
    assert probe["width"] == W_FULL and probe["height"] == H_FULL
    assert abs(probe["fps"] - REF_FPS) < 0.01, "fps is not 60: %s" % probe["fps"]

    p1 = pass1_energy(args.start_s, args.end_s)
    log("pass1 energy: %d frames, median %.3f, cut thresh %.3f, cuts %d, events %d, %.1fs"
        % (p1["frames_seen"], p1["median_energy"], p1["cut_threshold"],
           len(p1["cuts"]), len(p1["events"]), p1["wall_s"]))
    shots = build_shots(start_frame, end_frame, p1["cuts"])
    log("shots: %d" % len(shots))
    for sh in shots:
        log("  %s %.2f-%.2fs (%d frames)" % (sh["id"], sh["start_s"], sh["end_s"], sh["frames_60"]))

    p2 = pass2_palette(shots, start_frame, end_frame)
    log("pass2 palette: %s (%.1fs)"
        % ([p["hex"] for p in p2["palette"]], p2["wall_s"]))

    p3 = pass3_warp(shots, start_frame, end_frame)
    for w in p3["per_shot"]:
        log("warp %s key %d max_interval %s frames: %s"
            % (w["shot_id"], w.get("keyframe_60"),
               w.get("max_interval_frames_60_ssim_ge_0.90"),
               [(r["distance_frames_60"], r.get("ssim")) for r in w.get("warp", [])]))

    kfs, n_candidates, intervals = choose_keyframes(
        shots, p3, p1["events"], start_frame, end_frame, args.max_traces)
    log("keyframes: %d candidates, %d traced (cap %d), intervals %s"
        % (n_candidates, len(kfs), args.max_traces, intervals))

    if args.skip_traces:
        p4 = {"records": [], "wall_s": 0.0, "skipped": True}
    else:
        p4 = pass4_traces(kfs, out_dir)

    p5 = pass5_trajectories(p2["palette"], args.start_s, args.end_s, start_frame, shots)
    log("pass5 trajectories: %d frames, %.1fs" % (p5["frames_seen"], p5["wall_s"]))

    # FPS conversion record (frozen method, written before any clone frame).
    fps_conversion = {
        "reference_fps_measured": REF_FPS,
        "reference_frames_in_window": window_frames_60,
        "engine_fps": ENG_FPS,
        "engine_frames_in_window": window_frames_24,
        "method": "timestamp-based frame matching, no silent resampling",
        "rule": "clone frame f at time t=f/24 matches reference frame floor(t*60) = floor(f*2.5)",
        "ffmpeg_equivalent": "ffmpeg -i <ref> -vf fps=24 <out>  (same floor rule)",
        "example_pairings_clone24_to_ref60": [
            {"clone_frame_24": f, "time_s": round(f / ENG_FPS, 4),
             "reference_frame_60": int((f / ENG_FPS) * REF_FPS)}
            for f in (0, 1, 2, 3, 4, 5, 24, 48, 100)],
        "gates_apply_at_fps": ENG_FPS,
        "note": "Checker S2 peaks below are at 60 fps; the 24-fps peak frame is "
                "floor(peak_60/2.5) by this rule, recorded per event.",
    }
    events_out = []
    for ev in p1["events"]:
        f60 = ev["frame_60"]
        events_out.append({"id": "event-%04d" % f60, "peak_frame_60": f60,
                           "peak_frame_24": int((f60 / REF_FPS) * ENG_FPS),
                           "time_s": round(f60 / REF_FPS, 3),
                           "energy": ev["energy"],
                           "rect": [0, 0, 480, 270],
                           "rect_note": "full-frame rect at 480x270 analysis scale; "
                                        "energy is checker events.py mean abs luma diff",
                           "class": "TIMING"})
    cuts_out = []
    for c in p1["cuts"]:
        cuts_out.append({"frame_60": c["frame_60"],
                         "frame_24": int((c["frame_60"] / REF_FPS) * ENG_FPS),
                         "time_s": round(c["frame_60"] / REF_FPS, 3),
                         "energy": c["energy"], "type": "hard cut (energy peak)"})

    profile = {
        "tool": "src/reference/teardown-v2.py (Unit D fix cycle 2)",
        "predicate": "pred-v1",
        "source": {"file": REF, "width": probe["width"], "height": probe["height"],
                   "fps_measured": probe["fps"], "r_frame_rate": probe["r_frame_rate"],
                   "avg_frame_rate": probe["avg_frame_rate"], "codec": probe["codec"],
                   "duration_s_full_file": probe["duration_s"],
                   "size_bytes": probe["size_bytes"],
                   "window_start_s": args.start_s, "window_end_s": args.end_s,
                   "window_frames_60fps": window_frames_60,
                   "window_frames_24fps": window_frames_24},
        "fps_conversion": fps_conversion,
        "energy": {"analysis_scale": "480x270", "method": "checker events.py "
                   "mean abs luma diff, full-frame rect, streaming one frame at a time",
                   "median_energy": p1["median_energy"], "mad": p1["mad"],
                   "cut_threshold": p1["cut_threshold"],
                   "frames_seen": p1["frames_seen"]},
        "shots": shots,
        "cuts": cuts_out,
        "events": events_out,
        "palette": p2["palette"],
        "geometry": p2["geometry"],
        "palette_sample_frames_60": p2["sample_frames_60"],
        "warp_intervals": p3["per_shot"],
        "keyframes": p4["records"],
        "keyframe_candidates": n_candidates,
        "keyframe_interval_by_shot_frames_60": intervals,
        "trajectories": p5["series"],
        "trajectory_derived": p5["derived"],
        "unmeasured": [
            {"field": "font family/weight of on-screen text",
             "reason": "no font-identification tool in the $0 toolchain; not guessed"},
            {"field": "on-screen text content (script/words)",
             "reason": "deliberately not transcribed: grammar only, never content/logos/characters copied"},
            {"field": "per-frame LPIPS of traces",
             "reason": "torch/LPIPS load risks the memory gate; SSIM/PSNR only, light pass"},
            {"field": "text enter/exit timing per label",
             "reason": "no OCR/text-cluster measurement run in this unit; no label rects measured"},
            {"field": "camera move per shot (pan/zoom amounts in px)",
             "reason": "not measured: global flow shift was not computed per shot; "
                       "shot list records duration and cut type only"},
        ],
        "run": {"wall_time_s": round(time.time() - t_start, 1),
                "pass_wall_s": {"pass1_energy": p1["wall_s"], "pass2_palette": p2["wall_s"],
                                "pass3_warp": p3["wall_s"], "pass4_traces": p4["wall_s"],
                                "pass5_trajectories": p5["wall_s"]},
                "pilot": args.pilot, "max_traces": args.max_traces,
                "free_memory_note": "light passes only, one frame at a time; "
                                    "no full-resolution checker run"},
    }
    out_path = os.path.join(out_dir, "reference-profile.json")
    with open(out_path, "w") as fh:
        json.dump(profile, fh, indent=2)
    log("wrote %s (%.1fs total, %d keyframe traces)"
        % (out_path, time.time() - t_start, len(p4["records"])))


if __name__ == "__main__":
    main()
