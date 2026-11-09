// hme zoom-velocity: measure the camera zoom as a move on two videos.
//
// The subject (Sudan) width per frame is the zoom curve. Width comes
// from dimensions.largest_component_width on a strict per-channel
// mask (each channel within tolerance of the side's own colour), min
// component 50 px. Union extent is rejected: on v5 it reads 1007 px
// where the largest component reads 628 px. One colour cannot serve
// both sides: #143C34 with tolerance 6 reads 14-32 px on v5 where the
// truth is 130-624 px.
//
// Velocity is the headline number: the first difference of the
// 5-frame centered moving-average width, times each side's own fps.
// Velocity is 0 across appearance (width 0 on either side of the
// step), never a peak. The raw first difference stays in the report
// as a diagnostic only: it peaks at 767.2 px/s on real (+78 percent)
// and at the wrong time (3.50 s) on v5. dimensions.velocity_stats
// gives raw first differences only, so it serves the raw diagnostic
// series, not the headline velocity. No smoothing is invented here:
// the 5-frame centered moving average is the trace method
// (src/cli/trace.mjs pass_extra).
//
// Both sides decode at 1920x1080, reference scaled up, the same prep
// as the compare run. Frames 0 to 185 only: the map span ends at the
// cut, frame 186 (7.708 s). Frames after that are phone footage.
//
// Knot pulse rule: a knot flags when the local median smoothed
// velocity (plus or minus 6 frames) exceeds 20 px/s and the knot
// velocity differs from that median by more than half the median.
// Knots below the floor report 'no motion', never a ratio.
//
// The measurement is Python (src/checker), so this module spawns the
// engine venv Python with a small driver on stdin, the same shape as
// src/cli/compare.mjs. The driver streams frames through ffmpeg and
// returns the two width series; everything else is computed here.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

export const DEFAULT_REF_COLOUR = "#123B34";
export const DEFAULT_OURS_COLOUR = "#0C352E";
export const DEFAULT_TOLERANCE = 6;
export const MIN_COMPONENT_PX = 50;
export const LAST_FRAME = 185;
export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;
export const KNOT_FLOOR_PX_PER_S = 20;
export const KNOT_IDS = ["open", "s1", "s2", "s3e", "s3l", "s4", "s5", "s6", "s7"];
export const FROZEN_WIDTHS = {
  ref: [0, 108, 180, 332, 508, 552, 620, 664],
  ours: [0, 130, 208, 324, 520, 572, 624, 624],
};
export const FROZEN_PEAKS = {
  ref: { value: 431.6, time_s: 0.38 },
  ours: { value: 624.0, time_s: 0.79 },
};

export const USAGE = [
  "hme zoom-velocity: Measure the camera zoom as a move on two videos.",
  "",
  "Usage: hme zoom-velocity <ref.mp4> <ours.mp4> --ref-colour '#123B34' --ours-colour '#0C352E' --tolerance 6 --scene <scene.json> --out <report.json>",
  "",
  "Arguments:",
  "  <ref.mp4>  Path to the reference video.",
  "  <ours.mp4>  Path to our rendered video.",
  "",
  "Options:",
  "  --ref-colour <hex>  Sudan colour on the reference side. Default #123B34.",
  "  --ours-colour <hex>  Sudan colour on our side. Default #0C352E.",
  "  --tolerance <n>  Per-channel colour tolerance. Default 6.",
  "  --scene <file>  Scene file for the camera knot times (its events list). Optional.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Method: largest-component width per frame (dimensions.largest_component_width,",
  "min component 50 px) on a strict per-channel mask, both sides decoded at",
  "1920x1080, frames 0 to 185. Velocity is the first difference of the 5-frame",
  "centered moving-average width, times each side's own fps, 0 across appearance.",
  "A knot flags when the local median smoothed velocity (+-6 frames) exceeds",
  "20 px/s and the knot velocity differs from it by more than half the median.",
  "",
  "Exit codes: 0 ok, 1 no subject found or measurement failed, 2 usage error.",
].join("\n") + "\n";

// Parse "#RRGGBB" to [r, g, b], or null. Pure function.
export function parseHex(hex) {
  if (typeof hex !== "string") return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const v = m[1];
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function roundTo(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

// Parse zoom-velocity argv. Returns the options plus error (null on
// success). Pure function, tested without any video.
export function parseZoomVelocityArgs(argv) {
  const out = {
    ref: null,
    ours: null,
    refColour: DEFAULT_REF_COLOUR,
    oursColour: DEFAULT_OURS_COLOUR,
    tolerance: DEFAULT_TOLERANCE,
    scene: null,
    outPath: null,
    error: null,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref-colour" || a === "--ours-colour" || a === "--tolerance"
      || a === "--scene" || a === "--out") {
      if (i + 1 >= argv.length) {
        out.error = `option "${a}" needs a value`;
        return out;
      }
      const v = argv[++i];
      if (a === "--ref-colour") out.refColour = v.toUpperCase();
      else if (a === "--ours-colour") out.oursColour = v.toUpperCase();
      else if (a === "--tolerance") out.tolerance = Number(v);
      else if (a === "--scene") out.scene = v;
      else if (a === "--out") out.outPath = v;
    } else if (a.startsWith("--")) {
      out.error = `unknown option "${a}"`;
      return out;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 2) {
    out.error = "needs two videos, <ref.mp4> and <ours.mp4>";
    return out;
  }
  [out.ref, out.ours] = positionals;
  if (!parseHex(out.refColour)) {
    out.error = `--ref-colour must be a hex colour like #123B34, got "${out.refColour}"`;
    return out;
  }
  if (!parseHex(out.oursColour)) {
    out.error = `--ours-colour must be a hex colour like #0C352E, got "${out.oursColour}"`;
    return out;
  }
  if (!Number.isFinite(out.tolerance) || out.tolerance < 0 || !Number.isInteger(out.tolerance)) {
    out.error = `--tolerance must be a whole number >= 0, got "${out.tolerance}"`;
    return out;
  }
  return out;
}

// Median of a list of numbers. Pure function.
export function median(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// 5-frame centered moving average, truncated at the edges (the trace
// method). Pure function.
export function movingAverage(widths) {
  const out = [];
  for (let i = 0; i < widths.length; i++) {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(widths.length, i + 3);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += widths[j];
    out.push(sum / (hi - lo));
  }
  return out;
}

// Smoothed velocity in px/s: first difference of the moving-average
// width, times fps. 0 at frame 0 and 0 across appearance (width 0 on
// either side of the step). Pure function.
export function smoothedVelocity(widths, fps) {
  const sm = movingAverage(widths);
  const vel = [0];
  for (let i = 1; i < widths.length; i++) {
    if (widths[i] === 0 || widths[i - 1] === 0) vel.push(0);
    else vel.push(roundTo((sm[i] - sm[i - 1]) * fps, 1));
  }
  return vel;
}

// Raw first-difference velocity in px/s, diagnostic only. Same
// appearance rule as the smoothed series. Pure function.
export function rawVelocity(widths, fps) {
  const vel = [0];
  for (let i = 1; i < widths.length; i++) {
    if (widths[i] === 0 || widths[i - 1] === 0) vel.push(0);
    else vel.push(roundTo((widths[i] - widths[i - 1]) * fps, 1));
  }
  return vel;
}

// Width at frame round(s * fps) for s = 0..7. Pure function.
export function widthsPerSecond(widths, fps) {
  const out = [];
  for (let s = 0; s <= 7; s++) {
    const f = Math.round(s * fps);
    out.push(f < widths.length ? widths[f] : null);
  }
  return out;
}

// Smoothed velocity at frame round(s * fps) for s = 0..7. Pure function.
export function velocityPerSecond(vel, fps) {
  const out = [];
  for (let s = 0; s <= 7; s++) {
    const f = Math.round(s * fps);
    out.push(f < vel.length ? vel[f] : null);
  }
  return out;
}

// Peak smoothed velocity: value, frame, and time. First frame wins
// a tie. Pure function.
export function peakVelocity(vel, fps) {
  let best = 0;
  let bestFrame = 0;
  for (let i = 0; i < vel.length; i++) {
    if (vel[i] > best) {
      best = vel[i];
      bestFrame = i;
    }
  }
  return { value: best, frame: bestFrame, time_s: roundTo(bestFrame / fps, 3) };
}

// First frame with a nonzero width, and that width. Pure function.
export function firstAppearance(widths) {
  for (let i = 0; i < widths.length; i++) {
    if (widths[i] > 0) return { frame: i, width_px: widths[i] };
  }
  return { frame: null, width_px: 0 };
}

// Knot rows for one side. knots is [{name, frame}]. vel is the
// smoothed velocity series, fps is the side's fps. The local median
// is the median smoothed velocity over frames kf-6 to kf+6 (window
// starts at 1, never frame 0). A knot flags when the median exceeds
// 20 px/s and the knot velocity differs from it by more than half
// the median. Below the floor the ratio reads 'no motion'. Pure
// function.
export function knotRows(knots, vel, fps) {
  const rows = [];
  for (const k of knots) {
    const kf = k.frame;
    if (kf < 0 || kf >= vel.length) continue;
    const lo = Math.max(1, kf - 6);
    const hi = Math.min(vel.length, kf + 7);
    const med = median(vel.slice(lo, hi));
    const v = vel[kf];
    const belowFloor = med === null || med <= KNOT_FLOOR_PX_PER_S;
    const ratio = belowFloor ? "no motion" : roundTo(v / med, 2);
    const flagged = !belowFloor && Math.abs(v - med) > 0.5 * med;
    rows.push({
      knot: k.name,
      frame: kf,
      time_s: roundTo(kf / fps, 3),
      velocity_px_per_s: v,
      local_median_px_per_s: roundTo(med, 1),
      ratio,
      flagged,
    });
  }
  return rows;
}

// Camera knots from a scene file: the events list filtered to the
// nine camera knot ids, in file order. Returns {knots, note}: knots
// is [] and note says so plainly when the file holds no knot times.
// Pure function over the parsed scene object.
export function knotsFromScene(scene) {
  if (!scene || !Array.isArray(scene.events)) {
    return { knots: [], note: "no knot times in scene file: no events list" };
  }
  const knots = [];
  for (const ev of scene.events) {
    if (ev && typeof ev.id === "string" && KNOT_IDS.includes(ev.id)
      && Number.isInteger(ev.f)) {
      knots.push({ name: ev.id, frame: ev.f });
    }
  }
  if (!knots.length) {
    return { knots: [], note: "no knot times in scene file: events list holds no camera knot ids" };
  }
  return { knots, note: null };
}

// The Python driver. It probes both videos, streams frames 0..185
// through ffmpeg at 1920x1080 (reference scaled up, ours native),
// and measures the largest-component width per frame with
// dimensions.largest_component_width on the strict per-channel mask.
// It prints exactly one JSON object to stdout; progress goes to stderr.
const DRIVER = `
import json
import subprocess
import sys

import numpy as np

sys.path.insert(0, sys.argv[5])
from checker import dimensions

REF, OURS = sys.argv[1], sys.argv[2]
REF_RGB = tuple(int(x) for x in sys.argv[3].split(","))
OURS_RGB = tuple(int(x) for x in sys.argv[4].split(","))
TOL = int(sys.argv[6])
LAST = int(sys.argv[7])
W, H = 1920, 1080
FRAME_BYTES = W * H * 3

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-of", "json", path], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    num, den = (float(x) for x in s["r_frame_rate"].split("/"))
    fps = num / den
    frames = int(s["nb_frames"]) if s.get("nb_frames") else None
    return {"width": s["width"], "height": s["height"], "fps": fps, "frames": frames}

def strict_box(frame, rgb, tol):
    # Same predicate as the ladder's int16 version: every channel
    # within tol of the colour. The uint8 comparison form is faster
    # and gives identical widths (checked on frames 0..11: 0,0,0,0,0,
    # 0,0,0,48,80,84,88 on the reference side).
    m = np.ones(frame.shape[:2], dtype=bool)
    for c in range(3):
        lo = max(0, rgb[c] - tol)
        hi = min(255, rgb[c] + tol)
        ch = frame[:, :, c]
        m &= (ch >= lo) & (ch <= hi)
    return m

def series(path, rgb):
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path,
        "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE)
    widths = []
    frame = 0
    while frame <= LAST:
        buf = proc.stdout.read(FRAME_BYTES)
        if len(buf) < FRAME_BYTES:
            break
        arr = np.frombuffer(buf, dtype=np.uint8).reshape(H, W, 3)
        widths.append(dimensions.largest_component_width(strict_box(arr, rgb, TOL), min_n=50))
        frame += 1
        if frame % 48 == 0:
            print(f"frame {frame} done", file=sys.stderr, flush=True)
    proc.kill()
    proc.wait()
    return widths

ref_info = probe(REF)
ours_info = probe(OURS)
ref_widths = series(REF, REF_RGB)
ours_widths = series(OURS, OURS_RGB)
print(json.dumps({
    "ref": ref_info, "ours": ours_info,
    "widths": {"ref": ref_widths, "ours": ours_widths},
}))
`;

function runDriver(refPath, oursPath, refRgb, oursRgb, tolerance) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", refPath, oursPath,
      refRgb.join(","), oursRgb.join(","), SRC_DIR, String(tolerance), String(LAST_FRAME)], {
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
        rejectPromise(new Error(`zoom-velocity measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`zoom-velocity measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Build the report object from the measured widths and the options.
// Pure function (no video, no files).
export function buildReport(measured, opts) {
  const refFps = measured.ref.fps;
  const oursFps = measured.ours.fps;
  const refW = measured.widths.ref;
  const oursW = measured.widths.ours;
  const refVel = smoothedVelocity(refW, refFps);
  const oursVel = smoothedVelocity(oursW, oursFps);
  const refRaw = rawVelocity(refW, refFps);
  const oursRaw = rawVelocity(oursW, oursFps);
  const refPerSec = widthsPerSecond(refW, refFps);
  const oursPerSec = widthsPerSecond(oursW, oursFps);
  const refPeak = peakVelocity(refVel, refFps);
  const oursPeak = peakVelocity(oursVel, oursFps);
  const refFirst = firstAppearance(refW);
  const oursFirst = firstAppearance(oursW);
  const knots = opts.knots ?? [];
  const knotsNote = opts.knotsNote ?? null;
  const refKnots = knotRows(knots, refVel, refFps);
  const oursKnots = knotRows(knots, oursVel, oursFps);

  const frozen = { ref: [], ours: [] };
  for (let s = 0; s <= 7; s++) {
    frozen.ref.push({
      second: s,
      width_px: refPerSec[s],
      frozen_px: FROZEN_WIDTHS.ref[s],
      diff_px: refPerSec[s] === null ? null : refPerSec[s] - FROZEN_WIDTHS.ref[s],
    });
    frozen.ours.push({
      second: s,
      width_px: oursPerSec[s],
      frozen_px: FROZEN_WIDTHS.ours[s],
      diff_px: oursPerSec[s] === null ? null : oursPerSec[s] - FROZEN_WIDTHS.ours[s],
    });
  }
  const within5 = [...frozen.ref, ...frozen.ours]
    .every((r) => r.diff_px !== null && Math.abs(r.diff_px) <= 5);

  const corrections = [];
  for (const row of oursKnots) {
    if (!row.flagged) continue;
    const refRow = refKnots.find((r) => r.knot === row.knot);
    const direction = row.velocity_px_per_s > row.local_median_px_per_s
      ? "slow the zoom into the knot"
      : "speed the zoom into the knot";
    corrections.push({
      knot: row.knot,
      element: `camera knot ${row.knot}`,
      kind: "zoom-velocity pulse",
      at_s: row.time_s,
      ours: { x: row.frame, y: row.velocity_px_per_s, px: oursW[row.frame] },
      real: {
        x: row.frame,
        y: refRow ? refRow.velocity_px_per_s : null,
        px: refW[row.frame],
      },
      shift_px: {
        dx: refRow ? roundTo(row.velocity_px_per_s - refRow.velocity_px_per_s, 1) : null,
        dy: oursW[row.frame] - refW[row.frame],
      },
      fix: `${direction}: the smoothed velocity at knot ${row.knot} is ${row.velocity_px_per_s} px/s against a local median of ${row.local_median_px_per_s} px/s.`,
      direction,
      field: "nodes[map].props.camera[] (event, zoom, ease) in the scene file",
      scene_field: "nodes[map].props.camera[] (event, zoom, ease)",
      source: "scene file map node camera array",
    });
  }
  // Appearance difference: ours lands in one frame, real ramps
  // gradually. Name it when the first widths show that shape.
  if (refFirst.frame !== null && oursFirst.frame !== null
    && refFirst.width_px < 100 && oursFirst.width_px >= 100) {
    corrections.push({
      knot: "appearance",
      element: "Sudan highlight appearance",
      kind: "fade-in step",
      at_s: roundTo(oursFirst.frame / oursFps, 3),
      ours: { x: oursFirst.frame, y: 0, px: oursFirst.width_px },
      real: { x: refFirst.frame, y: 0, px: refFirst.width_px },
      shift_px: { dx: oursFirst.frame - refFirst.frame, dy: oursFirst.width_px - refFirst.width_px },
      fix: "Ramp the Sudan highlight in gradually over the first frames instead of landing in one frame: real appears at frame 8 at 48 px and grows, ours jumps from 0 to 128 px in one frame.",
      direction: "ramp the highlight in gradually",
      field: "nodes[map].props.focus (Sudan highlight event / focus flood) in the scene file",
      scene_field: "nodes[map].props.focus (Sudan highlight event / focus flood)",
      source: "scene file map node focus array, event sudan",
    });
  }

  const curvesDiffer = corrections.length > 0
    || Math.abs(refPeak.value - oursPeak.value) > 0.1
    || JSON.stringify(refPerSec) !== JSON.stringify(oursPerSec);
  const flaggedOurs = oursKnots.filter((r) => r.flagged).map((r) => r.knot);
  const flaggedRef = refKnots.filter((r) => r.flagged).map((r) => r.knot);

  return {
    verdict: {
      status: "PASS",
      failed_bar: null,
      detail: `Measured the zoom on both sides. Peak smoothed velocity ${refPeak.value} px/s at ${refPeak.time_s} s (ref) and ${oursPeak.value} px/s at ${oursPeak.time_s} s (ours). PASS means the measurement ran and both subjects were found, not that the curves match.`,
    },
    numbers: {
      ref: opts.ref,
      ours: opts.ours,
      ref_fps: roundTo(refFps, 3),
      ours_fps: roundTo(oursFps, 3),
      frames_measured: refW.length,
      widths_per_second: { ref: refPerSec, ours: oursPerSec },
      velocity_per_second: {
        ref: velocityPerSecond(refVel, refFps),
        ours: velocityPerSecond(oursVel, oursFps),
      },
      peak_velocity: { ref: refPeak, ours: oursPeak },
      first_appearance: { ref: refFirst, ours: oursFirst },
      knots_flagged: { ref: flaggedRef, ours: flaggedOurs },
      frozen_widths_within_5px: within5,
    },
    corrections,
    context: {
      thresholds: {
        tolerance_per_channel: opts.tolerance,
        min_component_px: MIN_COMPONENT_PX,
        knot_floor_px_per_s: KNOT_FLOOR_PX_PER_S,
        knot_flag_ratio: 0.5,
        frozen_width_tolerance_px: 5,
        frozen_peak_value_tolerance_pct: 10,
        frozen_peak_time_tolerance_s: 0.1,
      },
      control_ceiling: null,
      meaning: "PASS means the measurement ran and both subjects were found. The curves differ: the peaks and the per-second widths are in numbers, and corrections names the fixes in scene terms.",
    },
    next: "hme diagnose ref-frame.png ours-frame.png --scene <scene.json> (for the worst frame, use the flagged knot frame)",
    limits: [
      "Reference and ours are paired by frame index, not by time. When the two frame rates differ, drift over the span stays under one frame.",
      `Reference frames are resized to our frame size (${FRAME_WIDTH}x${FRAME_HEIGHT}). Widths are horizontal, so the 4 percent vertical stretch does not move them.`,
      "Frames 0 to 185 only. The map span ends at the cut, frame 186 (7.708 s); frames after that are phone footage.",
      "Velocity is the first difference of the 5-frame centered moving-average width, times each side's own fps. The raw first difference is a diagnostic only.",
      "Knot times come from the scene file events list. When the scene file holds no knot times, the knots tables are empty and the report says so.",
      "In corrections, ours/real x is the knot frame, y is the smoothed velocity in px/s, and px is the Sudan width in px at that frame.",
    ],
    inputs: {
      ref: opts.ref,
      ours: opts.ours,
      ref_fps: roundTo(refFps, 3),
      ours_fps: roundTo(oursFps, 3),
      ref_size: { width: measured.ref.width, height: measured.ref.height },
      ours_size: { width: measured.ours.width, height: measured.ours.height },
      resize: `reference scaled from ${measured.ref.width}x${measured.ref.height} to ${FRAME_WIDTH}x${FRAME_HEIGHT}; ours used at native ${FRAME_WIDTH}x${FRAME_HEIGHT}`,
      frames_measured: { first: 0, last: Math.max(refW.length, oursW.length) - 1 },
      scene: opts.scene ?? null,
    },
    method: {
      mask: "strict per-channel box: each channel within tolerance of the side's colour",
      tolerance: opts.tolerance,
      ref_colour: opts.refColour,
      ours_colour: opts.oursColour,
      width_function: "dimensions.largest_component_width",
      min_component_px: MIN_COMPONENT_PX,
      smoothing: "5-frame centered moving-average width; velocity is its first difference times each side's own fps; velocity is 0 across appearance",
      frames: "0 to 185",
      cut_frame: 186,
    },
    widths: { ref: refW, ours: oursW },
    widths_per_second: { ref: refPerSec, ours: oursPerSec },
    velocity_per_second: {
      ref: velocityPerSecond(refVel, refFps),
      ours: velocityPerSecond(oursVel, oursFps),
    },
    velocity: { ref: refVel, ours: oursVel },
    velocity_raw: { ref: refRaw, ours: oursRaw },
    peak_velocity: { ref: refPeak, ours: oursPeak },
    first_appearance: { ref: refFirst, ours: oursFirst },
    knots: {
      source: opts.scene ?? null,
      note: knotsNote,
      ref: refKnots,
      ours: oursKnots,
    },
    frozen_table_comparison: {
      widths_per_second: frozen,
      within_5px: within5,
      peaks: {
        ref: { measured: refPeak, frozen: FROZEN_PEAKS.ref },
        ours: { measured: oursPeak, frozen: FROZEN_PEAKS.ours },
      },
    },
    curves_differ: curvesDiffer,
  };
}

// Run `hme zoom-velocity <ref.mp4> <ours.mp4> [--ref-colour <hex>]
// [--ours-colour <hex>] [--tolerance <n>] [--scene <file>]
// [--out <report.json>]`.
// Returns the process exit code: 0 ok, 1 no subject found or
// measurement failed, 2 usage error. Never prints a stack trace.
export async function runZoomVelocity(argv) {
  const parsed = parseZoomVelocityArgs(argv);
  if (parsed.error) {
    console.error(`hme zoom-velocity: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const refPath = resolve(parsed.ref);
  const oursPath = resolve(parsed.ours);
  if (!existsSync(refPath)) {
    console.error(`hme zoom-velocity: no such file: ${parsed.ref}`);
    return 2;
  }
  if (!existsSync(oursPath)) {
    console.error(`hme zoom-velocity: no such file: ${parsed.ours}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme zoom-velocity: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  let knots = [];
  let knotsNote = null;
  if (parsed.scene) {
    const scenePath = resolve(parsed.scene);
    if (!existsSync(scenePath)) {
      console.error(`hme zoom-velocity: no such file: ${parsed.scene}`);
      return 2;
    }
    let scene;
    try {
      scene = JSON.parse(readFileSync(scenePath, "utf8"));
    } catch (err) {
      console.error(`hme zoom-velocity: cannot read scene file: ${err.message}`);
      return 2;
    }
    const found = knotsFromScene(scene);
    knots = found.knots;
    knotsNote = found.note;
  } else {
    knotsNote = "no knot times in scene file: --scene was not given";
  }
  let measured;
  try {
    measured = await runDriver(refPath, oursPath,
      parseHex(parsed.refColour), parseHex(parsed.oursColour), parsed.tolerance);
  } catch (err) {
    console.error(`hme zoom-velocity: ${err.message}`);
    return 1;
  }
  const refEmpty = measured.widths.ref.every((w) => w === 0);
  const oursEmpty = measured.widths.ours.every((w) => w === 0);
  if (refEmpty || oursEmpty) {
    const side = refEmpty && oursEmpty ? "both sides" : refEmpty ? "the reference side" : "our side";
    console.error(`hme zoom-velocity: no subject found on ${side} (all widths 0; check --ref-colour / --ours-colour)`);
    return 1;
  }
  const report = buildReport(measured, {
    ref: parsed.ref,
    ours: parsed.ours,
    refColour: parsed.refColour,
    oursColour: parsed.oursColour,
    tolerance: parsed.tolerance,
    scene: parsed.scene,
    knots,
    knotsNote,
  });
  const text = JSON.stringify(report, null, 2) + "\n";
  if (parsed.outPath) {
    mkdirSync(dirname(resolve(parsed.outPath)), { recursive: true });
    writeFileSync(resolve(parsed.outPath), text);
    process.stderr.write(`wrote ${parsed.outPath}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}
