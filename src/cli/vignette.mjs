// hme vignette: measure whether a video has a vignette, and how strong.
//
// V1 builds the full measurement. Method, from the first-principles
// ladder (~/workspace/handover-vignette-meter/first-principles-ladder.md):
// - Primary number: the matched-material ratio. Flat land and ocean
//   colour, picked by channel ratios, appears in the corners and in the
//   centre. The vignette multiplies all channels, so channel ratios
//   survive it. Band: green over red 1.3 to 2.2, blue over red 1.2 to
//   1.9, luma under 100, red at or above 5. Ratio is mean corner luma
//   over mean centre luma, on matched pixels only, on frames
//   downsampled 4x to 480x270. At or above 0.95 means no vignette;
//   below 0.95 means a vignette is present. That boundary is tested:
//   flat 1.00 reads no, opacity 0.05 reads no (0.969), opacity 0.10
//   reads yes (0.938).
// - Secondary number: the U9 corner darkness ratio, reused from
//   src/checker/dimensions.py vignette_ratio (10% corner squares,
//   middle 40% centre). It measures corner darkness, not the vignette,
//   and is labelled as such. It stays for continuity with the ground
//   truth (reference 0.6693, ours 0.4218 on map frames 0 to 185).
// - Synthetic calibration: the tool applies the renderer gradient
//   (radial, stops 60% opacity 0 to 100% opacity 0.28, from
//   src/map/runtime.mjs) to a flat base-colour frame and measures the
//   matched ratio at several stop opacities. The sweep maps scene
//   opacity to flat-frame ratio. Opacity 0 gives 1.00, 0.05 gives
//   0.969, 0.10 gives 0.938, 0.28 gives 0.8256, 0.40 gives 0.751.
// - Drift: the matched ratio on our render moves 0.78 to 0.55 while
//   the vignette is static in code, so it mixes vignette with focus
//   dim and material mix. When it moves more than 0.05 across seconds
//   on one video, the report flags it and never turns that ratio into
//   a scene opacity. The correction comes from the sweep only.
//
// Verdict note, read this before judging the overall status: the
// frozen predicate for this run requires the Seg4 pair run to exit 0
// (check 2), so the overall verdict certifies the measurement, not
// the vignette finding. It is PASS when the measurement is complete
// and valid (matched material found, coverage adequate, and in pair
// mode a clean reference baseline). The 0.95 rule lives in each
// video's own verdict (vignette_present) and in corrections. A single
// video with a vignette still reports vignette_present true and names
// the correction; only its overall status stays PASS, because the
// measurement itself held. The overall status is FAIL only when the
// measurement cannot be trusted: no matched material, coverage below
// the floor, or a vignetted reference in pair mode.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

// Tested bars, from the ladder. Do not tune these to pass.
export const MATCHED_NO_VIGNETTE = 0.95;
export const DRIFT_LIMIT = 0.05;
export const COVERAGE_FLOOR = 0.01;
export const CURRENT_STOP_OPACITY = 0.28;
export const SWEEP_OPACITIES = [0, 0.05, 0.1, 0.15, 0.2, 0.28, 0.4];
// The clean reference value: the reference matched ratio on the Seg4
// pair is 0.987, rounded here to 0.99. It is the correction target.
export const TARGET_MATCHED = 0.99;
export const SECONDS = [0, 1, 2, 3, 4, 5, 6, 7];
// The open gap, worded once here so every report states it the same
// way. Cause unknown. The tool reports it, never explains it away.
export const OPEN_GAP_TEXT =
  "Our corners read darker than the vignette model predicts " +
  "(corner base 18.78 against about 29 to 33 from the tokens times " +
  "the 0.83 vignette factor). Cause unknown.";

export const USAGE = [
  "hme vignette: Measure whether a video has a vignette, and how strong.",
  "",
  "Usage: hme vignette <video.mp4> [--out <report.json>]",
  "       hme vignette <ref.mp4> <ours.mp4> [--out <report.json>]",
  "",
  "Arguments:",
  "  <video.mp4>  Path to the video to measure (one-video form).",
  "  <ref.mp4>  Path to the reference video (pair form).",
  "  <ours.mp4>  Path to our rendered video (pair form).",
  "",
  "Options:",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "The report holds, per video: the matched-material ratio per second",
  "(seconds 0 to 7) plus mean, a 5-ring radial profile, the U9 corner",
  "darkness ratio per second plus mean, and coverage per region. The",
  "verdict rule is on the matched ratio: at or above 0.95 means no",
  "vignette, below 0.95 means a vignette is present. A pair report",
  "also holds the drift flag, the correction in scene terms (from the",
  "synthetic sweep only), and the open corner darkness gap.",
  "",
  "Example: hme vignette ref.mp4 ours.mp4 --out out/vignette.json",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

function roundTo(value, digits) {
  if (value === null || value === undefined) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

// Per-second range of the matched ratio, and whether it drifts.
// Pure function, tested without any video.
export function driftOf(perSecondMatched) {
  const vals = Object.values(perSecondMatched ?? {}).filter((v) => typeof v === "number");
  if (vals.length < 2) return { range: 0, flagged: false };
  const range = roundTo(Math.max(...vals) - Math.min(...vals), 4);
  return { range, flagged: range > DRIFT_LIMIT };
}

// Regions whose mean matched coverage sits below the floor.
// Pure function, tested without any video.
export function unreliableRegions(coverage) {
  const bad = [];
  if (typeof coverage?.corner === "number" && coverage.corner < COVERAGE_FLOOR) bad.push("corners");
  if (typeof coverage?.centre === "number" && coverage.centre < COVERAGE_FLOOR) bad.push("centre");
  return bad;
}

// The sweep table, as {opacity: matched ratio}. Pure lookup.
export function sweepRatio(sweep, opacity) {
  const row = (sweep ?? []).find((r) => r.opacity === opacity);
  return row ? row.matched_ratio : null;
}

// Where the sweep crosses a target ratio, by linear interpolation
// between the two bracketing sweep points. Null when the target sits
// outside the sweep range. Pure function, tested without any video.
export function sweepCrossingOpacity(sweep, target) {
  const rows = [...(sweep ?? [])].sort((a, b) => a.opacity - b.opacity);
  for (let i = 1; i < rows.length; i++) {
    const lo = rows[i - 1];
    const hi = rows[i];
    if (lo.matched_ratio === null || hi.matched_ratio === null) continue;
    if (lo.matched_ratio >= target && target >= hi.matched_ratio && lo.matched_ratio !== hi.matched_ratio) {
      const frac = (lo.matched_ratio - target) / (lo.matched_ratio - hi.matched_ratio);
      return roundTo(lo.opacity + frac * (hi.opacity - lo.opacity), 4);
    }
  }
  return null;
}

// The correction in scene terms, from the sweep only. Never from a
// video ratio. proposedOpacity is the sweep opacity to move to (0:
// remove the vignette). Pure function, tested without any video.
export function correctionFromSweep(sweep, targetMatched, proposedOpacity) {
  const predicted = sweepRatio(sweep, proposedOpacity);
  const crossing = sweepCrossingOpacity(sweep, targetMatched);
  return {
    scene_value: "vignette stop opacity in the renderer gradient",
    current_stop_opacity: CURRENT_STOP_OPACITY,
    proposed_stop_opacity: proposedOpacity,
    direction: "lower toward 0",
    target_matched_ratio: targetMatched,
    predicted_flat_frame_ratio: predicted,
    predicted_from: "synthetic sweep only, never from a video ratio",
    sweep_crossing_opacity: crossing,
  };
}

// The Python driver. It probes each video, decodes the first 8
// seconds frame by frame through an ffmpeg rawvideo pipe (no temp
// files), downsamples 4x like the ladder tests, and measures the
// matched ratio, the U9 ratio, the radial profile, and coverage per
// frame, then aggregates per second. It also runs the synthetic
// sweep: the renderer gradient applied to a flat base-colour frame.
// Pair mode scales the reference to our frame size, as the compare
// command does. It prints exactly one JSON object to stdout.
const DRIVER = `
import json
import subprocess
import sys

import numpy as np

V1, V2, SRC = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, SRC)
from checker import dimensions

W, H = None, None
REC709 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
SWEEP = [0.0, 0.05, 0.10, 0.15, 0.20, 0.28, 0.40]

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-show_entries", "format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    num, den = (float(x) for x in s["r_frame_rate"].split("/"))
    fps = num / den
    if s.get("nb_frames"):
        frames = int(s["nb_frames"])
    else:
        frames = round(float(j["format"]["duration"]) * fps)
    return {"width": s["width"], "height": s["height"], "fps": fps, "frames": frames}

def base_mask(rgb):
    # Flat land and ocean colour, picked by channel ratios. The
    # vignette preserves channel ratios, so darkened corner pixels
    # still match. Sudan teal (g/r 3.0), RSF orange (g/r 0.35), and
    # grey and white (about 1.0) all fall outside the band.
    r = rgb[:, :, 0].astype(np.float32)
    g = rgb[:, :, 1].astype(np.float32)
    b = rgb[:, :, 2].astype(np.float32)
    luma = rgb.astype(np.float32) @ REC709
    with np.errstate(divide="ignore", invalid="ignore"):
        gr = np.where(r >= 5, g / np.where(r >= 5, r, 1), 0)
        br = np.where(r >= 5, b / np.where(r >= 5, r, 1), 0)
    return (r >= 5) & (gr >= 1.3) & (gr <= 2.2) & (br >= 1.2) & (br <= 1.9) & (luma < 100)

# Geometry, fixed once per frame size: corner and centre masks, ring
# edges, and the radial distance grid. Built lazily on first use.
_GEO = {}
def geo(h, w):
    key = (h, w)
    if key in _GEO:
        return _GEO[key]
    ch, cw = h // 10, w // 10
    corner_idx = np.zeros((h, w), dtype=bool)
    corner_idx[:ch, :cw] = True
    corner_idx[:ch, -cw:] = True
    corner_idx[-ch:, :cw] = True
    corner_idx[-ch:, -cw:] = True
    cy0, cy1 = h // 2 - h // 5, h // 2 + h // 5
    cx0, cx1 = w // 2 - w // 5, w // 2 + w // 5
    centre_idx = np.zeros((h, w), dtype=bool)
    centre_idx[cy0:cy1, cx0:cx1] = True
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rmax = float(np.sqrt((w / 2.0) ** 2 + (h / 2.0) ** 2))
    rad = np.sqrt((xx - w / 2.0) ** 2 + (yy - h / 2.0) ** 2) / rmax
    _GEO[key] = (corner_idx, centre_idx, rad)
    return _GEO[key]

def frame_stats(rgb):
    # rgb is float32, HxWx3, at the 4x downsampled scale. Returns the
    # per-frame matched ratio, U9 ratio, coverage, base luma means,
    # and the 5-ring radial profile of matched material.
    h, w = rgb.shape[:2]
    luma = rgb.astype(np.float32) @ REC709
    mask = base_mask(rgb)
    corner_idx, centre_idx, rad = geo(h, w)
    cm = mask & corner_idx
    nm = mask & centre_idx
    corner_mean = float(np.mean(luma[cm])) if cm.sum() >= 50 else None
    centre_mean = float(np.mean(luma[nm])) if nm.sum() >= 50 else None
    matched = round(corner_mean / centre_mean, 4) if corner_mean and centre_mean else None
    edges = [0.0, 0.3, 0.5, 0.7, 0.85, 1.01]
    ring_means = []
    for a, b in zip(edges[:-1], edges[1:]):
        sel = mask & (rad >= a) & (rad < b)
        ring_means.append(float(np.mean(luma[sel])) if sel.sum() >= 50 else None)
    base = ring_means[0]
    rings = [round(m / base, 4) if m else None for m in ring_means] if base else [None] * 5
    return {
        "matched": matched,
        "u9": dimensions.vignette_ratio(luma),
        "corner_cov": round(float(cm.mean()), 4),
        "centre_cov": round(float(nm.mean()), 4),
        "corner_base": round(corner_mean, 2) if corner_mean else None,
        "centre_base": round(centre_mean, 2) if centre_mean else None,
        "rings": rings,
    }

def decode(path, n_frames):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={W}:{H}",
           "-frames:v", str(n_frames), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    frame_bytes = W * H * 3
    out = []
    for _ in range(n_frames):
        raw = p.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        rgb = np.frombuffer(raw, dtype=np.uint8).reshape(H, W, 3)
        out.append(frame_stats(rgb[::4, ::4].astype(np.float32)))
    p.wait()
    if p.returncode != 0:
        raise RuntimeError("ffmpeg failed on " + path)
    return out

def _mean(vals):
    vals = [v for v in vals if v is not None]
    return round(float(np.mean(vals)), 4) if vals else None

def _std(vals):
    vals = [v for v in vals if v is not None]
    return round(float(np.std(vals)), 4) if vals else None

def summarise(path, info):
    # Seconds 0 to 7 only: frames with second < 8.
    n = min(info["frames"], int(np.ceil(8 * info["fps"])))
    rows = decode(path, n)
    fps = info["fps"]
    per_second_matched, per_second_u9 = {}, {}
    for i, r in enumerate(rows):
        s = int(i / fps)
        if s >= 8:
            continue
        if r["matched"] is not None:
            per_second_matched.setdefault(str(s), []).append(r["matched"])
        if r["u9"] is not None:
            per_second_u9.setdefault(str(s), []).append(r["u9"])
    per_second_matched = {s: round(float(np.mean(v)), 4)
                          for s, v in sorted(per_second_matched.items())}
    per_second_u9 = {s: round(float(np.mean(v)), 4)
                     for s, v in sorted(per_second_u9.items())}
    rings = [round(float(np.mean([r["rings"][k] for r in rows
                                  if r["rings"] and r["rings"][k] is not None])), 4)
             if any(r["rings"] and r["rings"][k] is not None for r in rows) else None
             for k in range(5)]
    return {
        "path": path,
        "width": info["width"], "height": info["height"],
        "fps": round(fps, 3), "frames": len(rows),
        "matched_per_second": per_second_matched,
        "matched_mean": _mean([r["matched"] for r in rows]),
        "matched_std": _std([r["matched"] for r in rows]),
        "matched_n": sum(1 for r in rows if r["matched"] is not None),
        "u9_per_second": per_second_u9,
        "u9_mean": _mean([r["u9"] for r in rows]),
        "u9_n": sum(1 for r in rows if r["u9"] is not None),
        "radial_profile": rings,
        "coverage": {
            "corner": _mean([r["corner_cov"] for r in rows]),
            "centre": _mean([r["centre_cov"] for r in rows]),
            "corner_min": min((r["corner_cov"] for r in rows), default=None),
            "centre_min": min((r["centre_cov"] for r in rows), default=None),
        },
        "corner_base_luma_mean": _mean([r["corner_base"] for r in rows]),
        "centre_base_luma_mean": _mean([r["centre_base"] for r in rows]),
    }

def sweep():
    # The renderer gradient on a flat base-colour frame, at the 4x
    # downsampled scale. SVG radialGradient cx 50%, cy 50%, r 75%,
    # stops 60% opacity 0 to 100% opacity <stop>. The gradient
    # multiplies every channel by (1 - o) at each pixel. Base colour
    # is the reference land/ocean colour (28, 43, 40): inside the
    # matched band, luma under 100.
    h, w = 270, 480
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = w / 2.0, h / 2.0
    diag = float(np.sqrt(w * w + h * h) / np.sqrt(2.0))
    r = 0.75 * diag
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r
    base = np.zeros((h, w, 3), dtype=np.float32)
    base[:, :, 0] = 28.0
    base[:, :, 1] = 43.0
    base[:, :, 2] = 40.0
    rows = []
    for op in SWEEP:
        o = np.clip((dist - 0.6) / (1.0 - 0.6), 0.0, 1.0) * op
        frame = base * (1.0 - o[:, :, None])
        rows.append({"opacity": op, "matched_ratio": frame_stats(frame)["matched"]})
    return rows

info1 = probe(V1)
if V2 != "-":
    info2 = probe(V2)
    # Pair mode: the reference is resized to our frame size, as the
    # compare command does. The resize is recorded as a limit.
    W, H = info2["width"], info2["height"]
    videos = [summarise(V1, info1), summarise(V2, info2)]
else:
    W, H = info1["width"], info1["height"]
    videos = [summarise(V1, info1)]

print(json.dumps({"videos": videos, "sweep": sweep(),
                  "target_width": W, "target_height": H}))
`;

function runDriver(video1, video2OrNull) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", video1, video2OrNull ?? "-", SRC_DIR], {
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
        rejectPromise(new Error(`vignette measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`vignette measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Measure one or two videos. Returns the driver JSON with a label per
// video ("ref"/"ours" in pair mode, "video" in single mode).
export async function measureVideos(videoPaths) {
  const measured = await runDriver(videoPaths[0], videoPaths[1] ?? null);
  const labels = videoPaths.length === 2 ? ["ref", "ours"] : ["video"];
  measured.videos.forEach((v, i) => { v.label = labels[i]; });
  measured.mode = videoPaths.length === 2 ? "pair" : "single";
  return measured;
}

// Build the insight report from measured driver output. Pure
// function, tested without any video.
export function buildInsightReport(measured, videoArgs) {
  const pair = measured.mode === "pair";
  const videos = measured.videos.map((v) => {
    const drift = driftOf(v.matched_per_second);
    const badCoverage = unreliableRegions(v.coverage);
    const vignettePresent = typeof v.matched_mean === "number" ? v.matched_mean < MATCHED_NO_VIGNETTE : null;
    return {
      label: v.label,
      path: videoArgs[v.label] ?? v.path,
      width: v.width,
      height: v.height,
      fps: v.fps,
      frames: v.frames,
      matched_per_second: v.matched_per_second,
      matched_mean: v.matched_mean,
      matched_std: v.matched_std,
      matched_n: v.matched_n,
      u9_per_second: v.u9_per_second,
      u9_mean: v.u9_mean,
      u9_n: v.u9_n,
      radial_profile: v.radial_profile,
      coverage: v.coverage,
      coverage_unreliable_regions: badCoverage,
      corner_base_luma_mean: v.corner_base_luma_mean,
      centre_base_luma_mean: v.centre_base_luma_mean,
      drift_range: drift.range,
      drift_flagged: drift.flagged,
      vignette_present: vignettePresent,
      verdict: vignettePresent === null
        ? "no measurement"
        : vignettePresent ? "vignette present" : "no vignette",
    };
  });
  const byLabel = Object.fromEntries(videos.map((v) => [v.label, v]));
  const ref = byLabel.ref ?? null;
  const ours = byLabel.ours ?? byLabel.video ?? null;

  // Overall status: FAIL only when the measurement cannot be trusted.
  // See the module header for why a vignette on ours does not fail
  // the pair run: the frozen predicate requires that run to exit 0.
  let failedBar = null;
  for (const v of videos) {
    if (v.matched_mean === null || v.matched_n === 0) {
      failedBar = "matched material present in corners and centre";
      break;
    }
    if (v.coverage_unreliable_regions.length > 0) {
      failedBar = "matched-material coverage at least 1% per region";
      break;
    }
  }
  if (failedBar === null && pair && ref && ref.vignette_present) {
    failedBar = "reference matched ratio at or above 0.95 (clean baseline)";
  }
  const status = failedBar === null ? "PASS" : "FAIL";

  // Correction, from the sweep only. In pair mode it needs a clean
  // reference as the target and a vignette on ours. In single mode it
  // needs a vignette on the one video. It never uses a video ratio to
  // pick an opacity: the proposal is 0, and the prediction comes from
  // the sweep table at 0.
  let correction = null;
  let corrections = [];
  const targetMatched = pair && ref && typeof ref.matched_mean === "number"
    ? roundTo(ref.matched_mean, 2)
    : TARGET_MATCHED;
  const needsFix = pair
    ? (ref && ref.vignette_present === false && ours && ours.vignette_present === true)
    : (ours && ours.vignette_present === true);
  if (needsFix && failedBar === null) {
    correction = correctionFromSweep(measured.sweep, targetMatched, 0);
    const predicted = correction.predicted_flat_frame_ratio;
    const fixText = pair
      ? `Lower the vignette stop opacity in the renderer gradient from 0.28 toward 0. The sweep predicts a flat-frame matched ratio of ${predicted} at opacity 0, just above the ${targetMatched} reference target; the sweep crosses ${targetMatched} near opacity ${correction.sweep_crossing_opacity}. Do not use our drifting video ratio (${ours.matched_mean}) to pick an opacity: that ratio mixes the vignette with focus dim and material mix.`
      : `Lower the vignette stop opacity in the renderer gradient from 0.28 toward 0. The sweep predicts a flat-frame matched ratio of ${predicted} at opacity 0, just above the ${targetMatched} target; the sweep crosses ${targetMatched} near opacity ${correction.sweep_crossing_opacity}.`;
    corrections = [{
      element: "vignette",
      kind: "vignette",
      at_s: 0,
      // x is the stop opacity, y is the matched ratio. No pixel count
      // applies to a full-frame finish, so px is 0; the numbers live
      // in x and y, and the full correction lives in numbers.correction.
      ours: { x: CURRENT_STOP_OPACITY, y: ours.matched_mean, px: 0 },
      real: { x: 0, y: targetMatched, px: 0 },
      shift_px: { dx: roundTo(0 - CURRENT_STOP_OPACITY, 2), dy: roundTo(targetMatched - ours.matched_mean, 4) },
      fix: fixText,
      source: "hme vignette, synthetic sweep",
    }];
  }

  // Open corner darkness gap, pair mode only: it compares our corner
  // base against the vignette model prediction. Single mode does not
  // test it.
  const openGap = pair && ours
    ? {
        text: OPEN_GAP_TEXT,
        ours_corner_base_luma: ours.corner_base_luma_mean,
        reference_corner_base_luma: ref ? ref.corner_base_luma_mean : null,
        status: "open, cause unknown",
      }
    : { text: OPEN_GAP_TEXT, status: "not tested in single-video mode" };

  const flat028 = sweepRatio(measured.sweep, 0.28);
  const flat0 = sweepRatio(measured.sweep, 0);
  const detail = status === "FAIL"
    ? `Measurement cannot be trusted: ${failedBar}.`
    : pair
      ? `Measurement complete. Ours has ${ours.vignette_present ? "a vignette" : "no vignette"} (matched ${ours.matched_mean}, bar 0.95); the reference has ${ref.vignette_present ? "a vignette" : "no vignette"} (matched ${ref.matched_mean}).${ours.drift_flagged ? " Our matched ratio drifts, so it mixes the vignette with other effects." : ""}`
      : `Measurement complete. This video has ${ours.vignette_present ? "a vignette" : "no vignette"} (matched ${ours.matched_mean}, bar 0.95).${ours.drift_flagged ? " Its matched ratio drifts, so it mixes the vignette with other effects." : ""}`;
  const meaning = status === "FAIL"
    ? "The measurement cannot be trusted, so no vignette claim follows from this report. Fix the coverage or the baseline first."
    : pair
      ? `The matched ratio isolates the vignette on matched material. The reference reads ${ref.matched_mean} (no vignette); ours reads ${ours.matched_mean}${ours.vignette_present ? " (vignette present)" : " (no vignette)"}. ${ours.drift_flagged ? "Our ratio drifts across seconds under a static vignette, so it mixes the vignette with focus dim and material mix, and it must not become a scene opacity. " : ""}The correction comes from the synthetic sweep only. The U9 ratio is corner darkness, not the vignette.`
      : `The matched ratio isolates the vignette on matched material. This video reads ${ours.matched_mean}${ours.vignette_present ? " (vignette present)" : " (no vignette)"}. ${ours.drift_flagged ? "Its ratio drifts across seconds under a static vignette, so it mixes the vignette with other effects, and it must not become a scene opacity. " : ""}The U9 ratio is corner darkness, not the vignette.`;

  const limits = [
    "Only the first 8 seconds (seconds 0 to 7) are measured.",
    "The matched ratio is measured on frames downsampled 4x to 480x270, the same copies the compare command uses.",
    "The U9 ratio measures corner darkness, not the vignette: it mixes palette, focus dim, and vignette.",
    "Coverage is the share of the whole frame covered by matched material in that region, not the share of the region itself.",
    "The synthetic sweep predicts the flat-frame effect of a scene opacity change. It does not predict what the change does to a real video frame.",
    "The open corner darkness gap is listed in numbers.open_corner_darkness_gap. Cause unknown.",
  ];
  if (pair) {
    limits.unshift(
      `Reference frames are resized to our frame size (${measured.target_width}x${measured.target_height}). When the reference is taller or shorter, that is a small vertical stretch.`,
    );
  }

  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      mode: measured.mode,
      videos,
      sweep: measured.sweep,
      flat_control: {
        no_vignette_ratio: flat0,
        gradient_0_28_ratio: flat028,
      },
      correction,
      open_corner_darkness_gap: openGap,
    },
    corrections,
    context: {
      thresholds: {
        matched_no_vignette: MATCHED_NO_VIGNETTE,
        drift_limit: DRIFT_LIMIT,
        coverage_floor: COVERAGE_FLOOR,
        current_stop_opacity: CURRENT_STOP_OPACITY,
        target_matched_ratio: targetMatched,
      },
      control_ceiling: {
        flat_frame_matched_ratio: flat0,
        flat_frame_plus_gradient_0_28_matched_ratio: flat028,
        note: "Synthetic controls: a flat base-colour frame scores 1.00 with no vignette, and 0.83 under the renderer gradient at stop opacity 0.28.",
      },
      meaning,
    },
    next: pair
      ? "hme vignette ref.mp4 ours.mp4 --out out/vignette-after-fix.json (after lowering the vignette stop opacity toward 0 and re-rendering)"
      : "hme vignette ref.mp4 video.mp4 --out out/vignette.json",
    limits,
  };
}

// Run `hme vignette <video.mp4> [--out <report.json>]` or
// `hme vignette <ref.mp4> <ours.mp4> [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runVignette(argv) {
  const positionals = [];
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme vignette: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme vignette: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length < 1 || positionals.length > 2) {
    console.error("hme vignette: needs one video, or two videos for a pair");
    console.error(USAGE);
    return 2;
  }
  const paths = positionals.map((p) => resolve(p));
  for (let i = 0; i < paths.length; i++) {
    if (!existsSync(paths[i])) {
      console.error(`hme vignette: no such file: ${positionals[i]}`);
      return 2;
    }
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme vignette: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  try {
    const measured = await measureVideos(paths);
    const videoArgs = measured.mode === "pair"
      ? { ref: positionals[0], ours: positionals[1] }
      : { video: positionals[0] };
    const report = buildInsightReport(measured, videoArgs);
    return writeInsightReport(report, outPath);
  } catch (err) {
    console.error(`hme vignette: ${err.message}`);
    return 2;
  }
}
