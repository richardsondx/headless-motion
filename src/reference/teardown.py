"""Unit A reference teardown — Ozempic 0:00-1:15 (Kurzgesagt).

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
          (tournament params), rasterised with sharp, SSIM/PSNR measured.
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
                    filter_speckle=4, color_precision=6, layer_difference=16,
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


# ---------------------------------------------------------------------------
# Progressive resolve (Unit A, stage2-coarse-fine-2026-11-08-01).
#
# General, video-agnostic, numpy-only (no cv2), streaming one frame at a
# time at 480x270. Measures whether a video resolves coarse-to-fine
# (mosaic dabs shrinking) or only sharpens (blur-back), and records
# camera_ease "none" for a static frame. No ease is fitted here and the
# ease picker (src/scene/pick-ease.mjs) is never invoked by this code.
#
# Per sampled frame (default every 3rd frame):
#   lap_var     variance of the 3x3 Laplacian of luma — detail sharpness.
#               A true mosaic has sharp dab edges (high lap_var) from the
#               first coarse pass; a blur-back has almost none until the
#               end (low lap_var at mid frames).
#   hf_ratio    mean(lap^2) / (var(luma) + 1) — high-frequency energy
#               ratio, supporting metric for lap_var.
#   detail_size horizontal block-preservation size in px: for candidate
#               widths bw, replace each bw-wide vertical strip by its
#               row-wise mean and measure mean abs error to the original.
#               The estimate is the largest bw whose error stays under
#               1.0 grey level. A mosaic with block width B is preserved
#               (error ~0) for bw that divide B; a blurred frame is
#               preserved by small bw only. Candidates:
#               [80, 40, 20, 12, 10, 8, 6, 5, 4, 3, 2, 1].
#               LIMIT (measured 2026-11-08 on the working pair): the
#               estimator recovers coarse steps exactly (80/40/12) but
#               cannot separate 7/4/2/1 px on a mostly-flat still — the
#               error is averaged over flat regions, so fine segments
#               read 2-4 px and are not monotonic sample by sample.
#               The ladder therefore records successive minima of the
#               per-sample estimate (the decreasing envelope); every
#               per-sample value is kept in per_frame_samples so the
#               envelope can be checked. Do not read the ladder as
#               ground-truth brush sizes.
# Passes: a new pass starts when the estimate drops to a new minimum
#   that the next sample confirms (next sample estimate <= new minimum,
#   or it is the last sample). Blank samples (lap_var < 1.0) are the
#   start state, not a pass. Pass names are assigned by order after the
#   Ananth study (Block-in / Form and color / Refinement / Fine
#   details); boundaries are sample-resolution (+/- sample_every
#   frames), not per-frame.
# detail_structure: "present" iff the median lap_var over mid-third
#   frames is >= LAP_VAR_THRESHOLD (100.0). Threshold set from the
#   measured working pair (see units/A/check-log.md): true mid median
#   ~747, fake mid median ~9.4; 100 sits ~10x above the fake max (21.7)
#   and ~7x below the true min (711). hf_ratio threshold 0.02 is a
#   supporting check (true mid 0.122-0.145, fake mid 0.0008-0.0040).
# Camera: phase correlation between consecutive samples in the same
#   segment (lap_var ratio within [0.5, 2]; transition pairs excluded,
#   because a pass change moves the correlation peak). No camera move
#   iff the median shift is <= 1 px at the 120x68 correlation scale
#   (~4 px at 480x270). camera_ease is then "none".
# ---------------------------------------------------------------------------
PROGRESSIVE_RESOLVE_CANDIDATE_WIDTHS = [80, 40, 20, 12, 10, 8, 6, 5, 4, 3, 2, 1]
PROGRESSIVE_RESOLVE_BLOCK_ERROR_THRESHOLD = 1.0
PROGRESSIVE_RESOLVE_LAP_VAR_THRESHOLD = 100.0
PROGRESSIVE_RESOLVE_HF_RATIO_THRESHOLD = 0.02
PROGRESSIVE_RESOLVE_PASS_NAMES = ["Block-in", "Form and color",
                                  "Refinement", "Fine details"]


def stream_frames_generic(path, start_s, end_s, w, h, fps):
    """Yield (frame_index, rgb array) streaming at w x h, one frame at a time.

    Generic version of stream_frames(): the video path and fps are
    parameters instead of the Ozempic REF / REF_FPS globals.
    """
    import numpy as np
    dur = end_s - start_s
    max_frames = int(round(dur * fps))
    start_frame = int(round(start_s * fps))
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


def _laplacian(gray):
    import numpy as np
    g = gray.astype(np.float32)
    lap = (np.roll(g, 1, 0) + np.roll(g, -1, 0) + np.roll(g, 1, 1)
           + np.roll(g, -1, 1) - 4 * g)
    return lap[2:-2, 2:-2]


def frame_detail_metrics(gray):
    """lap_var, hf_ratio and detail-size estimate for one luma frame."""
    import numpy as np
    lap = _laplacian(gray)
    lap_var = float(lap.var())
    hf_ratio = float((lap * lap).mean()) / (float(gray.var()) + 1.0)
    detail_size = None
    block_errors = {}
    if float(gray.var()) >= 1e-6:
        h, w = gray.shape
        for bw in PROGRESSIVE_RESOLVE_CANDIDATE_WIDTHS:
            ww = (w // bw) * bw
            g = gray[:, :ww]
            m = g.reshape(h, ww // bw, bw).mean(axis=2)
            up = np.repeat(m, bw, axis=1)
            block_errors[bw] = round(float(np.mean(np.abs(up - g))), 3)
        good = [b for b in PROGRESSIVE_RESOLVE_CANDIDATE_WIDTHS
                if block_errors[b] < PROGRESSIVE_RESOLVE_BLOCK_ERROR_THRESHOLD]
        detail_size = int(max(good)) if good else 1
    return {"lap_var": round(lap_var, 2), "hf_ratio": round(hf_ratio, 4),
            "detail_size_px": detail_size, "block_errors": block_errors}


def _phase_shift(a_gray, b_gray):
    """Global translation between two luma frames, in px at 120x68 scale.

    Downscale 4x by block mean, blur 3x, FFT phase correlation.
    Returns (dx, dy); (0, 0) means no shift detected.
    """
    import numpy as np

    def down(g):
        g = g.astype(np.float32)
        h, w = g.shape
        g = g[:h // 4 * 4, :w // 4 * 4].reshape(h // 4, 4, w // 4, 4).mean(axis=(1, 3))
        for _ in range(3):
            g = (np.roll(g, 1, 0) + np.roll(g, -1, 0) + np.roll(g, 1, 1)
                 + np.roll(g, -1, 1) + 4 * g) / 8.0
        return g

    A, B = down(a_gray), down(b_gray)
    FA, FB = np.fft.rfft2(A), np.fft.rfft2(B)
    R = FA * np.conj(FB)
    R /= (np.abs(R) + 1e-9)
    cc = np.fft.irfft2(R, s=A.shape)
    y, x = np.unravel_index(np.argmax(cc), cc.shape)
    dy = int(y if y <= A.shape[0] // 2 else y - A.shape[0])
    dx = int(x if x <= A.shape[1] // 2 else x - A.shape[1])
    return dx, dy


def measure_progressive_resolve(path, start_s=0.0, end_s=None, sample_every=3,
                                analysis_w=480, analysis_h=270):
    """Measure a coarse-to-fine progressive resolve in any video.

    Returns the progressive_resolve profile object (JSON-able). Streams
    one frame at a time; only every sample_every-th frame is measured.
    """
    import numpy as np
    t0 = time.time()
    probe = ffprobe_video(path)
    fps = probe["fps"]
    if end_s is None:
        end_s = probe["duration_s"]
    n_frames = int(round((end_s - start_s) * fps))
    samples = []
    shifts = []          # (frame, dx, dy) for same-segment consecutive samples
    prev_gray = None
    prev_sample = None
    frames_seen = 0
    for f, rgb in stream_frames_generic(path, start_s, end_s,
                                        analysis_w, analysis_h, fps):
        frames_seen += 1
        if (f - int(round(start_s * fps))) % sample_every != 0:
            continue
        gray = luma(rgb)
        m = frame_detail_metrics(gray)
        sample = {"frame": int(f), "time_s": round(f / fps, 3),
                  "lap_var": m["lap_var"], "hf_ratio": m["hf_ratio"],
                  "detail_size_px": m["detail_size_px"],
                  "block_errors": m["block_errors"]}
        samples.append(sample)
        if prev_gray is not None and prev_sample is not None:
            # Same-segment pairs only: a pass change moves the phase
            # correlation peak, so transition pairs are excluded. Same
            # segment = same detail-size estimate and lap_var ratio
            # within [0.5, 2].
            ratio = (sample["lap_var"] / prev_sample["lap_var"]
                     if prev_sample["lap_var"] > 0 else 0.0)
            if (sample["detail_size_px"] == prev_sample["detail_size_px"]
                    and 0.5 <= ratio <= 2.0):
                dx, dy = _phase_shift(prev_gray, gray)
                shifts.append({"frame": int(f), "dx_px_120scale": dx,
                               "dy_px_120scale": dy})
        prev_gray = gray
        prev_sample = sample
    if len(samples) < 3:
        return {"method": "progressive_resolve v1 (Unit A)",
                "source": {"file": path, "fps": fps,
                           "frames_in_window": n_frames,
                           "frames_seen": frames_seen},
                "passes": [], "ladder": [], "detail_structure": "unknown",
                "camera_ease": "none",
                "note": "too few samples (%d) to measure a resolve" % len(samples),
                "per_frame_samples": samples,
                "wall_s": round(time.time() - t0, 1)}
    # Passes: decreasing envelope of the detail-size estimate, skipping
    # blank samples (lap_var < 1.0). A new minimum must be confirmed by
    # the next sample (estimate <= new minimum) or be the last sample.
    measured = [s for s in samples if s["lap_var"] >= 1.0]
    passes = []
    running_min = None
    for i, s in enumerate(measured):
        d = s["detail_size_px"]
        if d is None:
            continue
        if running_min is None or d < running_min:
            nxt = measured[i + 1] if i + 1 < len(measured) else None
            if nxt is None or (nxt["detail_size_px"] is not None
                               and nxt["detail_size_px"] <= d):
                running_min = d
                passes.append({"detail_size_px": int(d),
                               "source_frame": int(s["frame"]),
                               "start_frame": int(s["frame"]),
                               "start_s": s["time_s"],
                               "lap_var_at_source": s["lap_var"],
                               "hf_ratio_at_source": s["hf_ratio"]})
    for j, p in enumerate(passes):
        p["end_frame"] = (passes[j + 1]["start_frame"] - 1
                          if j + 1 < len(passes) else int(samples[-1]["frame"]))
        p["end_s"] = round(p["end_frame"] / fps, 3)
        p["name"] = (PROGRESSIVE_RESOLVE_PASS_NAMES[j]
                     if j < len(PROGRESSIVE_RESOLVE_PASS_NAMES) - 1
                     else PROGRESSIVE_RESOLVE_PASS_NAMES[-1])
        # Order fields for readability.
        passes[j] = {"name": p["name"], "start_frame": p["start_frame"],
                     "end_frame": p["end_frame"], "start_s": p["start_s"],
                     "end_s": p["end_s"], "detail_size_px": p["detail_size_px"],
                     "source_frame": p["source_frame"],
                     "lap_var_at_source": p["lap_var_at_source"],
                     "hf_ratio_at_source": p["hf_ratio_at_source"]}
    ladder = [{"detail_size_px": p["detail_size_px"],
               "source_frame": p["source_frame"],
               "pass": p["name"]} for p in passes]
    ladder_monotonic = all(ladder[i]["detail_size_px"] > ladder[i + 1]["detail_size_px"]
                           for i in range(len(ladder) - 1))
    # Mid-third frames: detail structure present iff median lap_var >= threshold.
    lo = n_frames // 3
    hi = 2 * n_frames // 3
    mid = [s for s in samples if lo <= s["frame"] < hi]
    mid_lap = sorted(s["lap_var"] for s in mid)
    mid_median = float(np.median(mid_lap)) if mid_lap else 0.0
    detail_structure = ("present" if mid_median >= PROGRESSIVE_RESOLVE_LAP_VAR_THRESHOLD
                        else "absent")
    mid_flags = [{"frame": s["frame"], "lap_var": s["lap_var"],
                  "detail_structure": ("present" if s["lap_var"] >= PROGRESSIVE_RESOLVE_LAP_VAR_THRESHOLD
                                       else "absent")} for s in mid]
    # Camera: median same-segment phase shift.
    if shifts:
        med_dx = float(np.median([s["dx_px_120scale"] for s in shifts]))
        med_dy = float(np.median([s["dy_px_120scale"] for s in shifts]))
        max_abs = max(max(abs(s["dx_px_120scale"]), abs(s["dy_px_120scale"]))
                      for s in shifts)
    else:
        med_dx = med_dy = 0.0
        max_abs = 0
    camera_move = not (abs(med_dx) <= 1 and abs(med_dy) <= 1)
    # States.
    def state(s, description):
        return {"frame": s["frame"], "time_s": s["time_s"],
                "lap_var": s["lap_var"], "hf_ratio": s["hf_ratio"],
                "detail_size_px": s["detail_size_px"], "description": description}
    mid_sample = min(samples, key=lambda s: abs(s["frame"] - n_frames // 2))
    result = {
        "method": "progressive_resolve v1 (Unit A): per-frame Laplacian "
                  "variance + high-frequency ratio + horizontal "
                  "block-preservation detail size, streaming one frame at "
                  "a time at 480x270, numpy only",
        "source": {"file": path, "fps": fps, "width": probe["width"],
                   "height": probe["height"],
                   "frames_in_window": n_frames, "frames_seen": frames_seen,
                   "analysis_scale": "%dx%d" % (analysis_w, analysis_h),
                   "sample_every_frames": sample_every,
                   "pass_boundary_resolution_frames": sample_every},
        "thresholds": {
            "lap_var_threshold": PROGRESSIVE_RESOLVE_LAP_VAR_THRESHOLD,
            "hf_ratio_threshold": PROGRESSIVE_RESOLVE_HF_RATIO_THRESHOLD,
            "block_error_threshold_grey_levels": PROGRESSIVE_RESOLVE_BLOCK_ERROR_THRESHOLD,
            "block_error_candidates_px": list(PROGRESSIVE_RESOLVE_CANDIDATE_WIDTHS),
            "threshold_source": "set from the measured Unit A working pair "
                                "(true mid-median lap_var ~747, fake mid-median "
                                "~9.4; 100 sits ~10x above the fake mid max 21.7 "
                                "and ~7x below the true mid min 711); recorded "
                                "here, NOT in predicate.json (pred-v1 frozen)"},
        "passes": passes,
        "ladder": ladder,
        "ladder_monotonic_decreasing": ladder_monotonic,
        "ladder_note": "ladder steps are successive minima (decreasing "
                       "envelope) of the per-sample detail-size estimate; "
                       "fine-scale estimates are noisy on mostly-flat "
                       "frames, so a later sample reading higher than the "
                       "running minimum does not create a step. All "
                       "per-sample values are in per_frame_samples.",
        "start_state": state(samples[0], "first frame: blank off-white canvas "
                             "when lap_var is 0.0, else the coarsest state"),
        "intermediate_state": state(
            mid_sample, "middle frame: mosaic state at mid resolve; "
            "detail_structure here is the mid-frame flag, not the verdict"),
        "end_state": state(samples[-1], "last frame: fully resolved state"),
        "detail_structure": detail_structure,
        "camera_ease": "none" if not camera_move else "UNMEASURED-move-detected",
        "detail_structure_mid_frames": {
            "frames": "%d-%d (middle third)" % (lo, hi),
            "median_lap_var": round(mid_median, 2),
            "median_hf_ratio": round(float(np.median([s["hf_ratio"] for s in mid])), 4)
                               if mid else 0.0,
            "per_frame": mid_flags},
        "camera": {
            "camera_move_detected": camera_move,
            "camera_ease": "none",
            "ease_fitted": False,
            "picker_invoked": False,
            "picker_note": "no ease is fitted and src/scene/pick-ease.mjs "
                           "is not invoked for a static-frame timelapse; "
                           "camera_ease 'none' is a measurement (median "
                           "same-segment phase shift), not a default",
            "method": "phase correlation between consecutive same-segment "
                      "samples (same detail-size estimate and lap_var ratio "
                      "within [0.5, 2]); transition pairs excluded; shift in "
                      "px at 120x68 scale (~4 px at 480x270); no move iff "
                      "median |dx|,|dy| <= 1",
            "median_shift_px_120scale": {"dx": med_dx, "dy": med_dy},
            "max_shift_px_120scale_same_segment": int(max_abs),
            "same_segment_pairs": len(shifts),
            "shifts": shifts},
        "per_frame_samples": samples,
        "wall_s": round(time.time() - t0, 1),
    }
    return result


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
    ap.add_argument("--progressive-resolve", metavar="VIDEO",
                    help="measure only the progressive_resolve field for "
                         "VIDEO and write reference-profile-progressive-"
                         "resolve.json; the Ozempic teardown below is skipped")
    ap.add_argument("--sample-every", type=int, default=3)
    args = ap.parse_args()
    if args.progressive_resolve:
        out_dir = args.out_dir
        os.makedirs(out_dir, exist_ok=True)
        pr = measure_progressive_resolve(args.progressive_resolve,
                                         start_s=args.start_s,
                                         end_s=(args.end_s if args.end_s != 75.0 else None),
                                         sample_every=args.sample_every)
        out_path = os.path.join(out_dir, "reference-profile-progressive-resolve.json")
        with open(out_path, "w") as fh:
            json.dump({"progressive_resolve": pr}, fh, indent=2)
        log("wrote %s: %d passes, ladder %s, detail_structure %s, "
            "camera_ease %s (%.1fs)"
            % (out_path, len(pr["passes"]),
               [l["detail_size_px"] for l in pr["ladder"]],
               pr["detail_structure"], pr["camera_ease"], pr["wall_s"]))
        return
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
        "tool": "src/reference/teardown.py (Unit A)",
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
