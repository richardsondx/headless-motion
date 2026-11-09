// hme trace: measure a video and write its reference profile.
//
// Generalizes src/reference/teardown.py (the Ozempic 5-pass teardown,
// hardcoded to 60 fps and one video) to any video and any fps. The
// passes themselves are reused where they already take parameters:
// teardown.py is imported as a module with its REF / REF_FPS /
// W_FULL / H_FULL globals set from ffprobe, and left untouched, so
// the Ozempic teardown still reproduces exactly. Two passes are
// re-implemented here with general sampling instead of the Ozempic
// choices: the palette pass samples one frame per second (capped at
// 30) with k=10, because the shot-based k=8 palette misses small
// accent colours (the RSF orange is 0.4% of pooled pixels), and the
// trajectory pass is extended with the zoom curve and label tracking.
//
// Passes, matching teardown.py:
// - Pass 1 streaming energy and cuts, same formula as
//   checker/events.py frame_diff_energy, adaptive threshold
//   median + 8*MAD, floor 10, cap 40.
// - Pass 2 palette and geometry from sampled frames (k-means, cv2).
// - Pass 3 warp-interval test per shot (Farneback backward flow +
//   remap, checker SSIM).
// - Pass 4 VTracer traces per keyframe (optional; --skip-traces
//   skips it, and it is the slow part).
// - Pass 5 trajectories: per palette-colour mask centroid + area
//   fraction per frame, at the video's native fps.
// Plus, from the measurement-gap audit (Gap 2):
// - Zoom curve: the subject colour's largest-component bbox width
//   per frame (strict per-channel box, each channel within 6 of the
//   subject colour, the same strict box the hand trace used) and
//   its velocity, the first difference of the 5-frame moving
//   average width, times fps.
// - Badge trajectory: per-frame centroid and bbox of the
//   radius-30 mask around the badge colour.
// - Label tracking: bright-component text clusters (luma over 160)
//   on frames every 0.5 s, bbox refined with checker text.py Otsu
//   ink boxes, tracked across samples by nearest centre. Text
//   identity is UNMEASURED: there is no OCR in the toolchain, so
//   clusters are reported by position, never named after a text.
// Plus, from Unit A (stage2-coarse-fine-2026-11-08-01):
// - progressive_resolve: teardown.py measure_progressive_resolve,
//   the coarse-to-fine ladder (passes, detail-size steps with source
//   frames, start/intermediate/end states, detail_structure present
//   or absent at mid frames, camera_ease "none" for a static frame).
//   No ease is fitted and the picker is not invoked for it.
//
// Nothing here is hardcoded to a video, a segment, or a frame
// count: the video, window, subject colour, badge colour, and
// labels all come from the arguments, and the fps is read from
// ffprobe. Positions are reported in the video's native pixels
// and, for cross-video comparison, in 1920x1080 space (ratios
// times 1920 / 1080). Times are seconds and frame numbers at the
// video's native fps.
//
// The measurement is Python (teardown passes, cv2, checker), so
// this module spawns the engine venv Python with a small driver
// on stdin, the same shape as src/cli/compare.mjs. The driver
// writes reference-profile.json; this module only parses args,
// finds the cv2 site-packages, and reports the result.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const REF_DIR = join(SRC_DIR, "reference");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

export const DEFAULT_SUBJECT_COLOUR = "#143C34";
export const DEFAULT_BADGE_COLOUR = "#CC4726";
export const SUBJECT_TOLERANCE = 6;
export const LABEL_LUMA_THRESHOLD = 160;
export const LABEL_SAMPLE_EVERY_S = 0.5;
export const PALETTE_CLUSTERS = 10;

export const USAGE = [
  "hme trace: Measure a video and write its reference profile: cuts, palette, per-colour paths, zoom curve, label tracks, and the progressive_resolve field.",
  "",
  "Usage: hme trace video.mp4 --start-s <n> --end-s <n> --out <dir> [--skip-traces] [--subject-colour <hex>] [--badge-colour <hex>] [--labels <text,...>]",
  "",
  "Arguments:",
  "  video.mp4  Path to the video to measure.",
  "",
  "Options:",
  "  --start-s <n>  Start time in seconds. Required.",
  "  --end-s <n>  End time in seconds. Required.",
  "  --out <dir>  Directory for reference-profile.json, or a .json file path. Without it, the profile goes to stdout.",
  "  --skip-traces  Skip the VTracer pass (Pass 4), the slow part. The profile records the skip.",
  "  --subject-colour <hex>  Colour the zoom curve follows, for example #143C34. Default #143C34.",
  "  --badge-colour <hex>  Colour the badge trajectory follows, for example #CC4726. Default #CC4726.",
  "  --labels <text,...>  Label texts to record, for example SUDAN,EL FASHER. Text identity is not OCR-verified; the profile reports the bright-text clusters found and records the requested texts.",
  "",
  "Exit codes: 0 ok, 1 measurement failed, 2 usage error.",
].join("\n") + "\n";

// Parse "#RRGGBB" to [r, g, b], or null. Pure function, tested.
export function parseHex(hex) {
  if (typeof hex !== "string") return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const v = m[1];
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

// Parse trace argv. Returns the options plus error (null on success).
// Pure function, tested without any video.
export function parseTraceArgs(argv) {
  const out = {
    video: null,
    startS: null,
    endS: null,
    out: null,
    skipTraces: false,
    subjectColour: DEFAULT_SUBJECT_COLOUR,
    badgeColour: DEFAULT_BADGE_COLOUR,
    labels: [],
    error: null,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start-s" || a === "--end-s" || a === "--out"
      || a === "--subject-colour" || a === "--badge-colour" || a === "--labels") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        out.error = `option "${a}" needs a value`;
        return out;
      }
      i++;
      if (a === "--start-s") out.startS = Number(v);
      else if (a === "--end-s") out.endS = Number(v);
      else if (a === "--out") out.out = v;
      else if (a === "--subject-colour") out.subjectColour = v.toUpperCase();
      else if (a === "--badge-colour") out.badgeColour = v.toUpperCase();
      else if (a === "--labels") out.labels = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--skip-traces") {
      out.skipTraces = true;
    } else if (a.startsWith("--")) {
      out.error = `unknown option "${a}"`;
      return out;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length === 0) {
    out.error = "needs a video: hme trace video.mp4 --start-s <n> --end-s <n> --out <dir>";
    return out;
  }
  if (positionals.length > 1) {
    out.error = `takes one video, got ${positionals.length}`;
    return out;
  }
  out.video = positionals[0];
  if (out.startS === null) {
    out.error = "--start-s <n> is required";
    return out;
  }
  if (out.endS === null) {
    out.error = "--end-s <n> is required";
    return out;
  }
  if (!Number.isFinite(out.startS) || !Number.isFinite(out.endS)) {
    out.error = "--start-s and --end-s must be numbers";
    return out;
  }
  if (out.startS < 0 || out.endS <= out.startS) {
    out.error = "--end-s must be greater than --start-s, and --start-s must not be negative";
    return out;
  }
  if (!parseHex(out.subjectColour)) {
    out.error = `--subject-colour must be a hex colour like #143C34, got "${out.subjectColour}"`;
    return out;
  }
  if (!parseHex(out.badgeColour)) {
    out.error = `--badge-colour must be a hex colour like #CC4726, got "${out.badgeColour}"`;
    return out;
  }
  return out;
}

// Resolve --out to a profile file path, or null for stdout mode.
// A .json path is used as-is; anything else is a directory that
// gets reference-profile.json inside it. Pure function, tested.
export function resolveProfilePath(out) {
  if (out === null || out === undefined) return null;
  if (out.endsWith(".json")) return out;
  return join(out, "reference-profile.json");
}

// Find the site-packages dir that holds cv2. cv2 lives in the
// code-map-explainer venv, not the engine venv, the same place
// teardown.py's header points at. HME_CV2_SITE_PACKAGES overrides
// the search. Returns null when nothing is found.
export function findCv2SitePackages() {
  if (process.env.HME_CV2_SITE_PACKAGES
    && existsSync(join(process.env.HME_CV2_SITE_PACKAGES, "cv2"))) {
    return process.env.HME_CV2_SITE_PACKAGES;
  }
  const workspace = resolve(REPO_ROOT, "..");
  const lib = join(workspace, "code-map-explainer", ".venv", "lib");
  if (!existsSync(lib)) return null;
  for (const py of readdirSync(lib).sort()) {
    const sp = join(lib, py, "site-packages");
    if (existsSync(join(sp, "cv2"))) return sp;
  }
  return null;
}

// Find the experiments dir that holds the VTracer rasterizer.
// Returns null when it is absent; traces then record an error
// per keyframe instead of failing the whole run.
export function findExpDir() {
  const workspace = resolve(REPO_ROOT, "..");
  const exp = join(workspace, "handover-motion-style-copy", "experiments");
  return existsSync(join(exp, "rasterize_stdin.js")) ? exp : null;
}

function runDriver(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", (err) => rejectPromise(new Error(`could not start ${VENV_PYTHON}: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        rejectPromise(new Error(`trace measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`trace measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Run `hme trace <video> --start-s <n> --end-s <n> [--out <dir|file>] ...`.
// Returns the process exit code: 0 ok, 1 measurement failed, 2 usage.
export async function runTrace(argv) {
  const parsed = parseTraceArgs(argv);
  if (parsed.error) {
    console.error(`hme trace: ${parsed.error}`);
    return 2;
  }
  if (!existsSync(parsed.video)) {
    console.error(`hme trace: no such file: ${parsed.video}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme trace: engine python not found: ${VENV_PYTHON}`);
    return 2;
  }
  const cv2dir = findCv2SitePackages();
  if (!cv2dir) {
    console.error("hme trace: cv2 site-packages not found (expected the code-map-explainer venv); set HME_CV2_SITE_PACKAGES");
    return 2;
  }
  const expDir = findExpDir();
  let tmpDir = null;
  let profilePath = resolveProfilePath(parsed.out);
  if (profilePath === null) {
    tmpDir = mkdtempSync(join(tmpdir(), "hme-trace-"));
    profilePath = join(tmpDir, "reference-profile.json");
  } else {
    mkdirSync(dirname(resolve(profilePath)), { recursive: true });
  }
  const driverArgs = [
    resolve(parsed.video),
    String(parsed.startS),
    String(parsed.endS),
    profilePath,
    SRC_DIR,
    REF_DIR,
    cv2dir,
    expDir ?? "-",
    parsed.subjectColour,
    parsed.badgeColour,
    parsed.labels.join(","),
    parsed.skipTraces ? "1" : "0",
  ];
  let summary;
  try {
    summary = await runDriver(driverArgs);
  } catch (err) {
    console.error(`hme trace: ${err.message}`);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    return 1;
  }
  if (!existsSync(profilePath)) {
    console.error(`hme trace: driver finished but no profile was written at ${profilePath}`);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    return 1;
  }
  if (tmpDir) {
    process.stdout.write(readFileSync(profilePath, "utf8"));
    rmSync(tmpDir, { recursive: true, force: true });
    return 0;
  }
  process.stderr.write(
    `wrote ${profilePath} (${summary.frames} frames at ${summary.fps} fps, `
    + `cuts at ${summary.cuts_s.length ? summary.cuts_s.join(", ") + "s" : "none"}, `
    + `palette ${summary.palette.join(" ")})\n`,
  );
  return 0;
}

// The Python driver. It probes the video, runs teardown.py's passes
// with the video's own fps and size, runs the generalized palette
// pass, the zoom / subject / badge pass, and the label pass, then
// writes reference-profile.json. It prints exactly one JSON object
// to stdout (a short summary); progress goes to stderr.
const DRIVER = `
import json
import os
import sys
import time

VIDEO = sys.argv[1]
START_S = float(sys.argv[2])
END_S = float(sys.argv[3])
OUT_PATH = sys.argv[4]
SRC_DIR = sys.argv[5]
REF_DIR = sys.argv[6]
CV2_DIR = sys.argv[7]
EXP_DIR = sys.argv[8]
SUBJECT_HEX = sys.argv[9]
BADGE_HEX = sys.argv[10]
LABELS_CSV = sys.argv[11]
SKIP_TRACES = sys.argv[12] == "1"
LABELS = [s for s in LABELS_CSV.split(",") if s] if LABELS_CSV else []

for p in (CV2_DIR, SRC_DIR, REF_DIR, EXP_DIR):
    if p and p != "-":
        sys.path.insert(0, p)

import numpy as np
import teardown as T
from checker import text as textmod


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def hex_of(rgb):
    return "#%02X%02X%02X" % tuple(int(round(v)) for v in rgb)


def r3(x):
    return round(float(x), 3)


def r1(x):
    return round(float(x), 1)


def pass2_palette_general(shots, start_s, end_s, start_frame, end_frame, fps, W, H):
    """Palette + geometry from sampled frames at 960x540 (k-means, cv2).

    Same method as teardown.py pass2, with two general changes: sample
    one frame per whole second of the window (plus each shot midpoint,
    capped at 30 frames) instead of three frames per shot, and k=10
    instead of k=8. The shot-based k=8 palette misses small accent
    colours: on the Seg4 reference the RSF orange is 0.4% of pooled
    pixels and never becomes a centre, while per-second k=10 finds
    it within 5 RGB of the hand-measured hex.
    """
    import cv2
    t0 = time.time()
    sample_frames = []
    t = int(np.ceil(start_s - 1e-9))
    while t < end_s:
        sample_frames.append(int(round(t * fps)))
        t += 1
    for sh in shots:
        mid = (sh["start_frame_60"] + sh["end_frame_60"]) // 2
        if mid not in sample_frames:
            sample_frames.append(mid)
    sample_frames = sorted(set(f for f in sample_frames if start_frame <= f < end_frame))
    if not sample_frames:
        sample_frames = [(start_frame + end_frame) // 2]
    if len(sample_frames) > 30:
        idx = np.linspace(0, len(sample_frames) - 1, 30).round().astype(int)
        sample_frames = sorted(set(int(sample_frames[i]) for i in idx))
    pooled = []
    per_frame = {}
    for f in sample_frames:
        rgb = T.extract_frame_rgb(T.REF, f, 960, 540)
        per_frame[f] = rgb
        pooled.append(rgb[::4, ::4].reshape(-1, 3))
    data = np.vstack(pooled).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 1.0)
    k = 10
    _, labels, centers = cv2.kmeans(data, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.flatten()
    counts = np.bincount(labels, minlength=k)
    order = np.argsort(-counts)
    palette = []
    for rank, ci in enumerate(order):
        centre = centers[ci]
        hexv = hex_of(centre)
        share = float(counts[ci]) / float(len(labels)) * 100.0
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
                        "source_frame": int(sf), "time_s": r3(sf / fps),
                        "sample_x": int(round(sx * W / 960)),
                        "sample_y": int(round(sy * H / 540)),
                        "sample_x_ratio": round(sx / 960, 4),
                        "sample_y_ratio": round(sy / 540, 4),
                        "rank": rank + 1})
    geometry = []
    for p in palette:
        rgb = per_frame[p["source_frame"]]
        centre = np.array(p["rgb"], dtype=np.float32)
        d = np.sqrt(np.sum((rgb.astype(np.float32) - centre) ** 2, axis=-1))
        mask = (d < 30).astype(np.uint8)
        n, lab, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
        if n <= 1:
            geometry.append({"hex": p["hex"], "source_frame": p["source_frame"],
                             "area_ratio": 0.0, "bbox_ratio": None,
                             "centroid_ratio": None, "note": "no component over threshold"})
            continue
        j = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        x, y, w, h, area = (int(v) for v in stats[j])
        cx, cy = cent[j]
        geometry.append({"hex": p["hex"], "source_frame": p["source_frame"],
                         "area_ratio": round(float(area) / (960 * 540), 4),
                         "bbox_ratio": {"x": round(x / 960, 4), "y": round(y / 540, 4),
                                        "w": round(w / 960, 4), "h": round(h / 540, 4)},
                         "centroid_ratio": {"x": round(float(cx) / 960, 4),
                                            "y": round(float(cy) / 540, 4)}})
    return {"palette": palette, "geometry": geometry,
            "sample_frames": [int(f) for f in sample_frames],
            "wall_s": r1(time.time() - t0)}


def pass_extra(subject_rgb, badge_rgb, start_s, end_s, fps, W, H):
    """Zoom curve + explicit subject and badge trajectories, one stream.

    Streams at 960x540, one frame at a time. Per frame: the subject
    colour's strict per-channel box (each channel within 6 of the
    subject colour) largest component gives the zoom width; the
    radius-30 masks around the subject and badge colours give their
    centroids; the badge mask's largest component gives its bbox.
    Widths are mapped to 1920x1080 (analysis x2) and to native
    pixels. Velocity is the first difference of the 5-frame moving
    average width, times fps; the raw first difference is kept too.
    """
    import cv2
    t0 = time.time()
    subj = np.array(subject_rgb, dtype=np.int16)
    badge = np.array(badge_rgb, dtype=np.float32)
    subj_f = np.array(subject_rgb, dtype=np.float32)
    frames = []
    times = []
    widths1920 = []
    widths_native = []
    zcx = []
    zcy = []
    zarea = []
    s_x = []
    s_y = []
    s_a = []
    b_x = []
    b_y = []
    b_a = []
    b_bbox = []
    for f, rgb in T.stream_frames(T.REF, start_s, end_s, 960, 540):
        frames.append(int(f))
        times.append(r3(f / fps))
        strict = (np.abs(rgb.astype(np.int16) - subj) <= 6).all(axis=-1)
        m = strict.astype(np.uint8)
        n, lab, stats, cent = cv2.connectedComponentsWithStats(m, 8)
        if n <= 1 or int(stats[1:, cv2.CC_STAT_AREA].max()) < 5:
            widths1920.append(0)
            widths_native.append(0)
            zcx.append(None)
            zcy.append(None)
            zarea.append(0.0)
        else:
            j = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            x, y, w, h, area = (int(v) for v in stats[j])
            cx, cy = cent[j]
            widths1920.append(int(round(w * 1920 / 960)))
            widths_native.append(int(round(w * W / 960)))
            zcx.append(round(float(cx) * 1920 / 960, 1))
            zcy.append(round(float(cy) * 1080 / 540, 1))
            zarea.append(round(float(area) / (960 * 540), 4))
        arr = rgb.astype(np.float32)
        for centre, xs, ys, aas in ((subj_f, s_x, s_y, s_a), (badge, b_x, b_y, b_a)):
            d = np.sqrt(np.sum((arr - centre) ** 2, axis=-1))
            mask = d < 30
            area = int(mask.sum())
            if area < 20:
                xs.append(None)
                ys.append(None)
                aas.append(0.0)
            else:
                ys2, xs2 = np.nonzero(mask)
                xs.append(round(float(xs2.mean()) / 960, 4))
                ys.append(round(float(ys2.mean()) / 540, 4))
                aas.append(round(float(area) / (960 * 540), 4))
        d = np.sqrt(np.sum((arr - badge) ** 2, axis=-1))
        m = (d < 30).astype(np.uint8)
        n, lab, stats, cent = cv2.connectedComponentsWithStats(m, 8)
        if n <= 1:
            b_bbox.append(None)
        else:
            j = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            x, y, w, h, area = (int(v) for v in stats[j])
            b_bbox.append([int(x * 2), int(y * 2), int((x + w) * 2), int((y + h) * 2)])
    sm = []
    for i in range(len(widths1920)):
        lo = max(0, i - 2)
        hi = min(len(widths1920), i + 3)
        sm.append(sum(widths1920[lo:hi]) / (hi - lo))
    vel = [0.0]
    vel_raw = [0.0]
    for i in range(1, len(widths1920)):
        # Across an appearance or disappearance the width jump is a
        # visibility change, not motion: velocity is 0 there, never a peak.
        if widths1920[i] == 0 or widths1920[i - 1] == 0:
            vel.append(0.0)
            vel_raw.append(0.0)
        else:
            vel.append(r1((sm[i] - sm[i - 1]) * fps))
            vel_raw.append(r1((widths1920[i] - widths1920[i - 1]) * fps))
    per_second = {}
    for i, t in enumerate(times):
        sec = str(int(t))
        slot = per_second.setdefault(sec, {"widths": [], "frames": 0})
        slot["frames"] += 1
        if widths1920[i] > 0:
            slot["widths"].append(widths1920[i])
    per_second = {k: {"mean_width_px_1920x1080": round(sum(v["widths"]) / len(v["widths"]), 1) if v["widths"] else 0.0,
                      "frames_present": len(v["widths"]), "frames_total": v["frames"]}
                  for k, v in sorted(per_second.items())}
    zoom = {"subject_hex": SUBJECT_HEX, "subject_rgb": subject_rgb,
            "tolerance_per_channel": 6,
            "method": "largest connected component of the strict per-channel box (each channel within 6 of the subject colour) at 960x540, width mapped to 1920x1080; velocity is the first difference of the 5-frame moving-average width, times fps",
            "analysis_scale": "960x540", "frames": frames, "time_s": times,
            "width_px_1920x1080": widths1920, "width_px_native": widths_native,
            "velocity_px_per_s": vel, "velocity_raw_px_per_s": vel_raw,
            "centroid_x_1920x1080": zcx, "centroid_y_1920x1080": zcy,
            "area_frac": zarea,
            "per_second_mean_width_px_1920x1080": per_second,
            "peak_velocity_px_per_s": max(vel) if vel else 0.0,
            "frames_seen": len(frames), "wall_s": r1(time.time() - t0)}

    def series(xs, ys, aas):
        return {"frames": frames, "time_s": times,
                "x_ratio": xs, "y_ratio": ys, "area_frac": aas,
                "x_1920x1080": [None if v is None else round(v * 1920, 1) for v in xs],
                "y_1920x1080": [None if v is None else round(v * 1080, 1) for v in ys]}

    subj_tr = series(s_x, s_y, s_a)
    subj_tr.update({"hex": SUBJECT_HEX,
                    "method": "per-frame centroid of the radius-30 mask around the subject colour at 960x540"})
    badge_tr = series(b_x, b_y, b_a)
    badge_tr.update({"hex": BADGE_HEX,
                     "method": "per-frame centroid of the radius-30 mask around the badge colour at 960x540",
                     "bbox_1920x1080": b_bbox})
    return {"zoom_curve": zoom, "subject_trajectory": subj_tr,
            "badge_trajectory": badge_tr, "wall_s": r1(time.time() - t0)}


def pass_labels(start_s, end_s, fps):
    """Label tracks from bright-text clusters on sampled frames.

    Every 0.5 s a frame is extracted at 960x540; bright components
    (luma over 160, area at least 30 px) are merged within 24 px
    into word-sized clusters, each bbox refined with checker
    text.py's Otsu ink box, and clusters are tracked across
    samples by nearest centre within 120 px in 1920x1080 space.
    """
    import cv2
    t0 = time.time()
    step = max(1, int(round(fps * 0.5)))
    start_frame = int(round(start_s * fps))
    end_frame = int(round(end_s * fps))
    tracks = []
    f = start_frame
    while f < end_frame:
        rgb = T.extract_frame_rgb(T.REF, f, 960, 540)
        lum = T.luma(rgb)
        mask = (lum > 160).astype(np.uint8)
        n, lab, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
        boxes = []
        for j in range(1, n):
            x, y, w, h, area = (int(v) for v in stats[j])
            if area >= 30:
                boxes.append([x, y, x + w - 1, y + h - 1, area])
        changed = True
        while changed:
            changed = False
            for i in range(len(boxes)):
                for k in range(i + 1, len(boxes)):
                    a, b = boxes[i], boxes[k]
                    gapx = max(b[0] - a[2], a[0] - b[2])
                    gapy = max(b[1] - a[3], a[1] - b[3])
                    if gapx <= 24 and gapy <= 24:
                        boxes[i] = [min(a[0], b[0]), min(a[1], b[1]),
                                    max(a[2], b[2]), max(a[3], b[3]), a[4] + b[4]]
                        del boxes[k]
                        changed = True
                        break
                if changed:
                    break
        used = set()
        for x0, y0, x1, y1, area in boxes:
            rx0, ry0 = max(0, x0 - 4), max(0, y0 - 4)
            rw = min(960, x1 + 5) - rx0
            rh = min(540, y1 + 5) - ry0
            try:
                ink = textmod.ink_box(lum, [rx0, ry0, rw, rh])
            except Exception:
                ink = None
            if ink is not None:
                bx0, by0, bx1, by1 = ink
            else:
                bx0, by0, bx1, by1 = x0, y0, x1, y1
            cx = (bx0 + bx1) / 2 * 2
            cy = (by0 + by1) / 2 * 2
            bbox = [int(bx0 * 2), int(by0 * 2), int((bx1 + 1) * 2), int((by1 + 1) * 2)]
            sample = {"frame": int(f), "time_s": r3(f / fps),
                      "centre_1920x1080": [round(cx, 1), round(cy, 1)],
                      "bbox_1920x1080": bbox, "area_px_960": int(area)}
            best = None
            bestd = 150.0
            for ti, tr in enumerate(tracks):
                if ti in used:
                    continue
                last = tr["samples"][-1]
                d = ((last["centre_1920x1080"][0] - cx) ** 2
                     + (last["centre_1920x1080"][1] - cy) ** 2) ** 0.5
                if d < bestd:
                    bestd = d
                    best = ti
            if best is None:
                tracks.append({"id": "label-%02d" % (len(tracks) + 1), "samples": [sample]})
                used.add(len(tracks) - 1)
            else:
                tracks[best]["samples"].append(sample)
                used.add(best)
        f += step
    clusters = []
    for tr in tracks:
        s = tr["samples"]
        clusters.append({"id": tr["id"], "first_seen_s": s[0]["time_s"],
                         "last_seen_s": s[-1]["time_s"],
                         "samples_present": len(s), "samples": s})
    return {"method": "bright-component clusters (luma over 160) at 960x540 on frames every 0.5 s, merged within 24 px, bbox refined with checker text.py Otsu ink box, tracked across samples by nearest centre within 150 px in 1920x1080 space (map-fixed labels move with the zoom, up to about 100 px per 0.5 s sample)",
            "sampled_every_s": 0.5, "threshold_luma": 160,
            "requested_texts": LABELS,
            "text_identity": "UNMEASURED: no OCR in the toolchain, so a cluster is not named after a text. Requested texts are recorded, not matched to clusters.",
            "clusters": clusters, "wall_s": r1(time.time() - t0)}


def main():
    t_start = time.time()
    out_dir = os.path.dirname(os.path.abspath(OUT_PATH))
    os.makedirs(out_dir, exist_ok=True)
    probe = T.ffprobe_video(VIDEO)
    fps = probe["fps"]
    W = probe["width"]
    H = probe["height"]
    T.REF = VIDEO
    T.REF_FPS = fps
    T.W_FULL = W
    T.H_FULL = H
    if EXP_DIR and EXP_DIR != "-" and os.path.exists(os.path.join(EXP_DIR, "rasterize_stdin.js")):
        T.EXP = EXP_DIR
    start_frame = int(round(START_S * fps))
    end_frame = int(round(END_S * fps))
    log("ffprobe: %dx%d fps %.3f codec %s duration %.3f s size %d"
        % (W, H, fps, probe["codec"], probe["duration_s"], probe["size_bytes"]))

    p1 = T.pass1_energy(START_S, END_S)
    log("pass1 energy: %d frames, median %.3f, cut thresh %.3f, cuts %d, events %d, %.1fs"
        % (p1["frames_seen"], p1["median_energy"], p1["cut_threshold"],
           len(p1["cuts"]), len(p1["events"]), p1["wall_s"]))
    shots_raw = T.build_shots(start_frame, end_frame, p1["cuts"])
    log("shots: %d" % len(shots_raw))

    p2 = pass2_palette_general(shots_raw, START_S, END_S, start_frame, end_frame, fps, W, H)
    log("pass2 palette: %s (%.1fs)" % ([p["hex"] for p in p2["palette"]], p2["wall_s"]))

    p3 = T.pass3_warp(shots_raw, start_frame, end_frame)
    for w in p3["per_shot"]:
        log("warp %s key %d max_interval %s frames"
            % (w["shot_id"], w.get("keyframe_60"),
               w.get("max_interval_frames_60_ssim_ge_0.90")))

    kfs, n_candidates, intervals = T.choose_keyframes(
        shots_raw, p3, p1["events"], start_frame, end_frame, 300)
    log("keyframes: %d candidates (cap 300)" % n_candidates)

    if SKIP_TRACES:
        p4 = {"records": [], "wall_s": 0.0, "skipped": True}
    else:
        try:
            p4 = T.pass4_traces(kfs, out_dir)
        except Exception as e:
            p4 = {"records": [], "wall_s": 0.0, "skipped": False,
                  "error": "VTracer pass failed: %s" % e}
            log("pass4 traces FAILED: %s" % e)

    p5 = T.pass5_trajectories(p2["palette"], START_S, END_S, start_frame, shots_raw)
    log("pass5 trajectories: %d frames, %.1fs" % (p5["frames_seen"], p5["wall_s"]))

    px = pass_extra(hex_rgb(SUBJECT_HEX), hex_rgb(BADGE_HEX), START_S, END_S, fps, W, H)
    log("zoom/badge: %d frames, %.1fs" % (px["zoom_curve"]["frames_seen"], px["wall_s"]))

    pl = pass_labels(START_S, END_S, fps)
    log("labels: %d clusters, %.1fs" % (len(pl["clusters"]), pl["wall_s"]))

    pr = T.measure_progressive_resolve(VIDEO, START_S, END_S)
    log("progressive_resolve: %d passes, ladder %s, detail_structure %s, camera_ease %s, %.1fs"
        % (len(pr["passes"]), [l["detail_size_px"] for l in pr["ladder"]],
           pr["detail_structure"], pr["camera_ease"], pr["wall_s"]))

    cuts_out = [{"frame": int(c["frame_60"]), "time_s": r3(c["frame_60"] / fps),
                 "energy": c["energy"], "type": "hard cut (energy peak)"}
                for c in p1["cuts"]]
    events_out = [{"id": "event-%04d" % ev["frame_60"],
                   "peak_frame": int(ev["frame_60"]),
                   "time_s": r3(ev["frame_60"] / fps), "energy": ev["energy"],
                   "rect": [0, 0, 480, 270],
                   "rect_note": "full-frame rect at 480x270 analysis scale; energy is checker events.py mean abs luma diff",
                   "class": "TIMING"} for ev in p1["events"]]
    shots_out = [{"id": sh["id"], "start_frame": sh["start_frame_60"],
                  "end_frame": sh["end_frame_60"], "start_s": sh["start_s"],
                  "end_s": sh["end_s"], "duration_s": sh["duration_s"],
                  "frames": sh["frames_60"]} for sh in shots_raw]
    warp_out = []
    for w in p3["per_shot"]:
        warp_out.append({"shot_id": w["shot_id"], "keyframe": w.get("keyframe_60"),
                         "keyframe_time_s": (r3(w["keyframe_60"] / fps)
                                             if w.get("keyframe_60") is not None else None),
                         "warp": [{"distance_frames": r["distance_frames_60"],
                                   "target_frame": r["target_frame_60"],
                                   "target_time_s": r3(r["target_frame_60"] / fps),
                                   "ssim": r.get("ssim"), "psnr": r.get("psnr"),
                                   "note": r.get("note")} for r in w.get("warp", [])],
                         "max_interval_frames_ssim_ge_0.90":
                             w.get("max_interval_frames_60_ssim_ge_0.90"),
                         "max_interval_s": w.get("max_interval_s")})
    kf_out = []
    for r in p4["records"]:
        d = dict(r)
        d["frame"] = d.pop("frame_60")
        d["time_s"] = r3(d["frame"] / fps)
        d.pop("frame_24", None)
        kf_out.append(d)
    traj = {}
    for h, s in p5["series"].items():
        traj[h] = {"frames": s["frames"],
                   "time_s": [r3(f / fps) for f in s["frames"]],
                   "x_ratio": s["x_ratio"], "y_ratio": s["y_ratio"],
                   "area_frac": s["area_frac"]}
    derived = []
    for dv in p5["derived"]:
        pf = dv["peak_velocity_frame_60"]
        derived.append({"hex": dv["hex"], "target_id": dv["target_id"],
                        "peak_velocity_px_per_s": dv["peak_velocity_px_per_s"],
                        "peak_velocity_frame": pf,
                        "peak_velocity_time_s": r3(pf / fps) if pf is not None else None,
                        "mean_velocity_px_per_s": dv["mean_velocity_px_per_s"],
                        "frames_present": dv["frames_present"],
                        "holds_over_0.5s": [
                            {"start_frame": hh["start_frame_60"],
                             "end_frame": hh["end_frame_60"],
                             "duration_s": hh["duration_s"]}
                            for hh in dv["holds_over_0.5s"]]})

    profile = {
        "tool": "src/cli/trace.mjs (driver) + src/reference/teardown.py passes 1, 3, 4, 5",
        "command": "hme trace",
        "source": {"file": VIDEO, "width": W, "height": H,
                   "fps_measured": fps, "r_frame_rate": probe["r_frame_rate"],
                   "avg_frame_rate": probe["avg_frame_rate"], "codec": probe["codec"],
                   "duration_s_full_file": probe["duration_s"],
                   "size_bytes": probe["size_bytes"],
                   "window_start_s": START_S, "window_end_s": END_S,
                   "window_frames": end_frame - start_frame},
        "fps_conversion": {
            "reference_fps_measured": fps,
            "reference_frames_in_window": end_frame - start_frame,
            "method": "native fps, no resampling",
            "rule": "profile frame numbers are native video frames at the measured fps; frame f is at time t=f/fps",
            "gates_apply_at_fps": fps},
        "energy": {"analysis_scale": "480x270",
                   "method": "checker events.py mean abs luma diff, full-frame rect, streaming one frame at a time",
                   "median_energy": p1["median_energy"], "mad": p1["mad"],
                   "cut_threshold": p1["cut_threshold"],
                   "frames_seen": p1["frames_seen"]},
        "shots": shots_out,
        "cuts": cuts_out,
        "events": events_out,
        "palette": p2["palette"],
        "geometry": p2["geometry"],
        "palette_sample_frames": p2["sample_frames"],
        "warp_intervals": warp_out,
        "keyframes": kf_out,
        "keyframe_candidates": n_candidates,
        "keyframe_interval_by_shot_frames": intervals,
        "trajectories": traj,
        "trajectory_derived": derived,
        "zoom_curve": px["zoom_curve"],
        "subject_trajectory": px["subject_trajectory"],
        "badge_trajectory": px["badge_trajectory"],
        "labels": pl,
        "progressive_resolve": pr,
        "unmeasured": [
            {"field": "font family/weight of on-screen text",
             "reason": "no font-identification tool in the $0 toolchain; not guessed"},
            {"field": "on-screen text content (script/words)",
             "reason": "no OCR in the toolchain; label clusters are reported by position only, never named after a text"},
            {"field": "per-frame LPIPS of traces",
             "reason": "torch/LPIPS load risks the memory gate; SSIM/PSNR only, light pass"},
            {"field": "camera pan per shot (px)",
             "reason": "not measured: global flow shift was not computed per shot; the zoom curve measures subject width only"},
        ],
        "run": {"wall_time_s": r1(time.time() - t_start),
                "pass_wall_s": {"pass1_energy": p1["wall_s"],
                                "pass2_palette": p2["wall_s"],
                                "pass3_warp": p3["wall_s"],
                                "pass4_traces": p4["wall_s"],
                                "pass5_trajectories": p5["wall_s"],
                                "pass_extra_zoom_badge": px["wall_s"],
                                "pass_labels": pl["wall_s"],
                                "progressive_resolve": pr["wall_s"]},
                "skip_traces": SKIP_TRACES,
                "traces_skipped": bool(p4.get("skipped")),
                "trace_error": p4.get("error"),
                "subject_colour": SUBJECT_HEX,
                "badge_colour": BADGE_HEX,
                "labels_requested": LABELS,
                "free_memory_note": "light passes only, one frame at a time; no full-resolution checker run"},
    }
    with open(OUT_PATH, "w") as fh:
        json.dump(profile, fh, indent=2)
    log("wrote %s (%.1fs total, %d keyframe traces)"
        % (OUT_PATH, time.time() - t_start, len(p4["records"])))
    print(json.dumps({"profile": OUT_PATH, "frames": end_frame - start_frame,
                      "fps": round(fps, 3),
                      "cuts_s": [c["time_s"] for c in cuts_out],
                      "palette": [p["hex"] for p in p2["palette"]],
                      "shots": len(shots_out),
                      "wall_s": r1(time.time() - t_start)}))


if __name__ == "__main__":
    main()
`;
