// hme frame-style v2: measure a reference video frame by frame and
// write a plain-language prompt that carries the style in words.
//
// This is the CLI for the frame-style-measure skill
// (skills/frame-style-measure/SKILL.md). The skill watches a
// reference video frame by frame for a set time, measures its pace
// and motion with scripts, then writes a prompt that teaches
// another model how to make that animation. This command is the
// scripted half of that skill: it extracts every frame in the
// window, measures frame-to-frame change, and writes the prompt
// from the measured numbers. Every number in the prompt traces to
// a row in the per-frame CSV.
//
// v1 measured pace only: scalar grayscale frame-to-frame difference
// (MAD > 0.5), longest static run, and two 10%-band RGB medians on
// frame 0. That left three blind spots, fixed here in v2:
//
// 1. Pace-only blindness. v2 also measures palette hierarchy (top 8
//    quantized hexes with shares), flatness (flat-fill ratio), dark
//    outline density, surface grain (Laplacian floor), and a 5-stop
//    vertical background gradient with row-to-row smoothness.
// 2. Corrupted motion metrics. A hard shot cut spikes MAD and
//    distorts easing and velocity curves, and a camera pan reads
//    the same as subject motion. v2 isolates cuts (MAD > 22.0) and
//    splits camera from subject motion (outer 12% border MAD
//    against inner 50% centre MAD), and classifies cadence
//    (on-1s, on-2s, on-3s, hold-and-pop, mixed) from the gaps
//    between changed frames.
// 3. No consistency falsification. v1 passed whenever frames >= 2.
//    v2 keeps that verdict for the reference itself, but the report
//    now carries the bounds a generated frame must meet, and
//    `--gate-image` checks a generated still against those bounds
//    on five bars (palette, flat fill, outline, grain, luminance),
//    with a targeted [FIX-k] patch per failed bar.
//
// Method: ffmpeg extracts the window at the video native fps,
// scaled to 480 px wide so one frame at a time stays cheap in
// memory. A Python driver (engine venv, PIL and numpy only, no
// cv2) loads the frames in order and reports, per frame, the mean
// absolute grayscale difference against the frame before it, the
// border and centre MADs, flat-fill ratio, outline density, grain,
// and mean luma, plus window aggregates for palette and gradient.
// JavaScript turns those rows into pace numbers: changed fraction,
// mean change per frame and per second, longest static run, shot
// cuts, cadence, camera-vs-subject split, and a per-second motion
// curve. The prompt is built from those numbers only.
//
// A changed frame is one whose mean absolute difference from the
// frame before it is over 0.5 levels. Encoded-video noise sits
// under 0.5, so a frame over that bar moved for real. A shot cut
// is one whose difference is over 22.0 levels, a full-scene
// change, not a moving subject. Both bars are in the report
// thresholds, not hidden.
//
// Verdict rule: PASS when the window yields at least 2 frames, so
// a change can be measured at all. FAIL when it yields fewer.
// This command measures pace and style; it does not judge whether
// the pace is good, so a still window passes with a changed
// fraction of 0. The gate mode has its own verdict: PASS when all
// five bars pass, FAIL when any bar fails.
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const VENV_PYTHON = resolve(REPO_ROOT, ".venv", "bin", "python");

export const CHANGED_MEAN_ABS_DIFF = 0.5;
export const SHOT_CUT_MEAN_ABS_DIFF = 22.0;
export const MEASURE_WIDTH = 480;
export const BORDER_FRACTION = 0.12;
export const CENTER_FRACTION = 0.5;
// Gate tolerances, all stated in the gate output, not hidden.
export const GATE_PALETTE_MAX_DISTANCE = 36;
export const GATE_PALETTE_MIN_MATCHES = 6;
export const GATE_FLAT_MAX_DIFF = 0.15;
export const GATE_OUTLINE_RATIO_LOW = 0.25;
export const GATE_OUTLINE_RATIO_HIGH = 4;
export const GATE_GRAIN_FACTOR = 1.5;
export const GATE_GRAIN_SLACK = 0.5;
export const GATE_LUMA_MAX_DIFF = 30;

export const USAGE = [
  "hme frame-style v2: Measure a reference video frame by frame over a window and write a plain-language style prompt from the measured pace and style numbers.",
  "",
  "Usage: hme frame-style video.mp4 --start-s <n> --end-s <n> --out <prompt.md> [--report <report.json>] [--csv <per-frame.csv>] [--fps <n>]",
  "       hme frame-style --gate-image <image.png> --reference <report.json> [--gate-out <gate.json>]",
  "",
  "Arguments:",
  "  video.mp4  Path to the reference video.",
  "",
  "Options:",
  "  --start-s <n>  Start time in seconds. Required.",
  "  --end-s <n>  End time in seconds. Required, and after --start-s.",
  "  --out <file>  Write the style prompt here. Required.",
  "  --report <file>  Write the JSON insight report here. Without it, the report goes to stdout.",
  "  --csv <file>  Write one row per frame (frame, time, mean_abs_diff, changed, shot_cut, border_mad, center_mad, mean_luma, flat_fill_ratio, outline_density, grain). Without it, no CSV is written.",
  "  --fps <n>  Frames per second to extract at. Default: the video native fps from ffprobe.",
  "  --gate-image <file>  Check one generated still against a v2 reference report instead of measuring a video. Needs --reference.",
  "  --reference <file>  A v2 frame-style report JSON to gate against. Needs --gate-image.",
  "  --gate-out <file>  Write the gate JSON here. Without it, the gate goes to stdout.",
  "",
  "Proof: on the 24-frame Headless Motion descent clip (24 fps, 1.0 s, 480p) the tool must read 24 frames, a changed fraction of 0.3478, and a longest static run of 15 frames. The prompt must name the window, the frame count, the changed fraction, and the mean change per second.",
  "Verdict: PASS when the window yields at least 2 frames. FAIL when it yields fewer than 2 frames. Gate mode: PASS when all five bars pass, FAIL when any bar fails.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// The Python driver. It loads the extracted PNGs in sorted order,
// one at a time, and prints exactly one JSON object to stdout.
// Progress goes to stderr. PIL and numpy only, no cv2.
//
// Per frame it reports: mean absolute grayscale difference against
// the frame before it, border MAD (outer 12% frame edge) and centre
// MAD (inner 50% centre), flat-fill ratio (pixels whose x and y
// gradients are both under 8 levels), dark outline density (dark
// pixels under luma 48 that sit on a gradient over 25 levels),
// grain (mean absolute Laplacian), and mean luma. Across the
// window it aggregates the top 8 quantized palette hexes (5 bits
// per channel) and the mean vertical row-colour profile.
const DRIVER = `
import json
import os
import sys
import numpy as np
from PIL import Image

frames_dir = sys.argv[1]
names = sorted(n for n in os.listdir(frames_dir) if n.endswith(".png"))
empty = {"frames": 0, "rows": [], "first_frame": None, "palette": [], "gradient": None, "flat_fill_ratio": None, "outline_density": None, "dark_fraction": None, "grain_mean_abs_laplacian": None, "mean_luma": None}
if not names:
    print(json.dumps(empty))
    sys.exit(0)
first_size = Image.open(os.path.join(frames_dir, names[0])).size
fw, fh = first_size
bh = max(1, int(round(fh * ${BORDER_FRACTION})))
bw = max(1, int(round(fw * ${BORDER_FRACTION})))
ch0 = int(round(fh * (1 - ${CENTER_FRACTION}) / 2))
ch1 = fh - ch0
cw0 = int(round(fw * (1 - ${CENTER_FRACTION}) / 2))
cw1 = fw - cw0
rows = []
prev = None
first_top = None
first_bottom = None
first_stops = None
palette_counts = np.zeros(32768, dtype=np.int64)
row_profile_sum = None
row_profile_n = 0
flat_vals = []
outline_vals = []
dark_vals = []
grain_vals = []
luma_vals = []
total_pixels = 0
for i, name in enumerate(names):
    path = os.path.join(frames_dir, name)
    rgb_u8 = np.array(Image.open(path).convert("RGB"))
    rgb = rgb_u8.astype(np.float64)
    h, w, _ = rgb.shape
    gray = np.array(Image.open(path).convert("L")).astype(np.float64)
    row_med = np.median(rgb, axis=1)
    if row_profile_sum is None:
        row_profile_sum = np.zeros_like(row_med)
    row_profile_sum += row_med
    row_profile_n += 1
    total_pixels += h * w
    codes = ((rgb_u8[:, :, 0].astype(np.int64) >> 3) * 1024 + (rgb_u8[:, :, 1].astype(np.int64) >> 3) * 32 + (rgb_u8[:, :, 2].astype(np.int64) >> 3))
    palette_counts += np.bincount(codes.ravel(), minlength=32768)
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:] = np.abs(np.diff(gray, axis=1))
    gy[1:, :] = np.abs(np.diff(gray, axis=0))
    flat = float((((gx < 8) & (gy < 8)).mean()))
    dark = gray < 48
    outline = float(((dark) & ((gx > 25) | (gy > 25))).mean())
    dark_frac = float(dark.mean())
    lap = -4 * gray[1:-1, 1:-1] + gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:]
    grain = float(np.abs(lap).mean())
    mean_luma = float(gray.mean())
    flat_vals.append(flat)
    outline_vals.append(outline)
    dark_vals.append(dark_frac)
    grain_vals.append(grain)
    luma_vals.append(mean_luma)
    if i == 0:
        top = rgb[: max(1, h // 10)]
        bottom = rgb[-max(1, h // 10):]
        first_top = [round(float(v), 1) for v in np.median(top.reshape(-1, 3), axis=0)]
        first_bottom = [round(float(v), 1) for v in np.median(bottom.reshape(-1, 3), axis=0)]
        first_stops = []
        for f in (0.0, 0.25, 0.5, 0.75, 0.99):
            r = int(round(f * (h - 1)))
            first_stops.append({"y": f, "rgb": [round(float(v), 1) for v in row_med[r]]})
        rows.append({"frame": i, "mean_abs_diff": 0.0, "changed": False, "shot_cut": False, "border_mad": 0.0, "center_mad": 0.0, "mean_luma": round(mean_luma, 2), "flat_fill_ratio": round(flat, 4), "outline_density": round(outline, 4), "grain": round(grain, 3)})
    else:
        diff = np.abs(gray - prev)
        mad = float(diff.mean())
        border = np.concatenate([diff[:bh, :].ravel(), diff[-bh:, :].ravel(), diff[:, :bw].ravel(), diff[:, -bw:].ravel()])
        center = diff[ch0:ch1, cw0:cw1]
        border_mad = float(border.mean())
        center_mad = float(center.mean())
        rows.append({"frame": i, "mean_abs_diff": round(mad, 3), "changed": mad > ${CHANGED_MEAN_ABS_DIFF}, "shot_cut": mad > ${SHOT_CUT_MEAN_ABS_DIFF}, "border_mad": round(border_mad, 3), "center_mad": round(center_mad, 3), "mean_luma": round(mean_luma, 2), "flat_fill_ratio": round(flat, 4), "outline_density": round(outline, 4), "grain": round(grain, 3)})
    prev = gray

mean_profile = row_profile_sum / max(1, row_profile_n)
stops = []
for f in (0.0, 0.25, 0.5, 0.75, 0.99):
    r = int(round(f * (mean_profile.shape[0] - 1)))
    stops.append({"y": f, "rgb": [round(float(v), 1) for v in mean_profile[r]]})
step = np.abs(np.diff(mean_profile, axis=0))
top_idx = np.argsort(-palette_counts)[:8]
palette = []
for code in top_idx:
    count = int(palette_counts[code])
    if count <= 0:
        continue
    r = int(code >> 10) * 8 + 4
    g = int((code >> 5) & 31) * 8 + 4
    b = int(code & 31) * 8 + 4
    palette.append({"hex": "#%02X%02X%02X" % (r, g, b), "share": round(count / max(1, total_pixels), 4)})
print(json.dumps({
    "frames": len(names),
    "width": int(fw),
    "height": int(fh),
    "rows": rows,
    "first_frame": {"top_median_rgb": first_top, "bottom_median_rgb": first_bottom, "gradient_stops": first_stops},
    "palette": palette,
    "gradient": {"stops": stops, "max_row_step": round(float(step.max()), 2) if step.size else 0.0, "mean_row_step": round(float(step.mean()), 2) if step.size else 0.0},
    "flat_fill_ratio": round(float(np.mean(flat_vals)), 4),
    "outline_density": round(float(np.mean(outline_vals)), 4),
    "dark_fraction": round(float(np.mean(dark_vals)), 4),
    "grain_mean_abs_laplacian": round(float(np.mean(grain_vals)), 3),
    "mean_luma": round(float(np.mean(luma_vals)), 2),
}))
`;

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

export function probeVideo(videoPath) {
  const r = run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json",
    videoPath,
  ]);
  if (r.status !== 0) throw new Error(`ffprobe failed: ${(r.stderr || "").trim().slice(-300)}`);
  const data = JSON.parse(r.stdout);
  const stream = (data.streams || [])[0] || {};
  const rate = stream.r_frame_rate || stream.avg_frame_rate || "24/1";
  const [num, den] = rate.split("/").map(Number);
  const fps = den ? num / den : 24;
  return {
    width: stream.width || null,
    height: stream.height || null,
    fps,
    duration: data.format ? Number(data.format.duration) : null,
  };
}

function runDriver(framesDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", framesDir], { stdio: ["pipe", "pipe", "pipe"] });
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
        rejectPromise(new Error(`frame-style measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`frame-style measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

function roundTo(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function classifyCadence(pace) {
  if (pace.changed_frames === 0) return "static";
  if (pace.changed_fraction >= 0.85) return "on-1s";
  if (pace.median_gap_between_changes === 2) return "on-2s";
  if (pace.median_gap_between_changes === 3) return "on-3s";
  if (pace.longest_static_run_frames >= 8 && pace.changed_fraction < 0.5) return "hold-and-pop";
  return "mixed";
}

export function measurePace(measured, fps, startS) {
  const rows = measured.rows || [];
  const total = rows.length;
  const changedRows = rows.filter((r) => r.changed);
  const diffs = rows.slice(1).map((r) => r.mean_abs_diff);
  const meanChange = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
  let longestRun = 0;
  let run = 0;
  for (const r of rows) {
    if (r.changed) run = 0;
    else {
      run += 1;
      longestRun = Math.max(longestRun, run);
    }
  }
  // Shot cuts are full-scene changes, not subject motion. They are
  // listed apart so they never pollute the easing or velocity read.
  const shotCuts = rows
    .filter((r) => r.shot_cut)
    .map((r) => ({ frame: r.frame, time_s: roundTo(startS + r.frame / fps, 4), mean_abs_diff: r.mean_abs_diff }));
  // Cadence comes from the gaps between changed frames, not from
  // the changed fraction alone. A gap of 2 means a change every
  // other frame (on-2s); a gap of 3 means every third frame.
  const changedFrames = changedRows.map((r) => r.frame);
  const gaps = [];
  for (let i = 1; i < changedFrames.length; i++) gaps.push(changedFrames[i] - changedFrames[i - 1]);
  const medianGap = gaps.length ? median(gaps) : null;
  // Camera against subject: the outer 12% border moves when the
  // camera moves; the inner 50% centre moves when the subject
  // moves. A frame counts for one side only when that side moves
  // at least twice as much as the other and clears the 0.5 bar.
  let cameraFrames = 0;
  let subjectFrames = 0;
  let bothFrames = 0;
  let neitherFrames = 0;
  const borderMads = [];
  const centerMads = [];
  for (const r of rows.slice(1)) {
    const border = r.border_mad || 0;
    const center = r.center_mad || 0;
    borderMads.push(border);
    centerMads.push(center);
    if (border > 0.5 && border > 2 * center) cameraFrames += 1;
    else if (center > 0.5 && center > 2 * border) subjectFrames += 1;
    else if (border > 0.5 && center > 0.5) bothFrames += 1;
    else neitherFrames += 1;
  }
  const medianBorder = roundTo(median(borderMads), 3);
  const medianCenter = roundTo(median(centerMads), 3);
  const perSecond = [];
  const seconds = total ? Math.ceil(total / fps) : 0;
  for (let s = 0; s < seconds; s++) {
    const slice = rows.slice(Math.floor(s * fps), Math.floor((s + 1) * fps));
    const sliceDiffs = slice.filter((r) => r.frame > 0).map((r) => r.mean_abs_diff);
    const sliceBorder = slice.filter((r) => r.frame > 0).map((r) => r.border_mad || 0);
    const sliceCenter = slice.filter((r) => r.frame > 0).map((r) => r.center_mad || 0);
    const meanOf = (xs) => (xs.length ? roundTo(xs.reduce((a, b) => a + b, 0) / xs.length, 3) : 0);
    perSecond.push({
      second: roundTo(startS + s, 3),
      frames: slice.length,
      mean_abs_diff: meanOf(sliceDiffs),
      changed: slice.filter((r) => r.changed).length,
      shot_cuts: slice.filter((r) => r.shot_cut).length,
      border_mad: meanOf(sliceBorder),
      center_mad: meanOf(sliceCenter),
    });
  }
  const pace = {
    frames: total,
    fps: roundTo(fps, 3),
    changed_frames: changedRows.length,
    changed_fraction: total > 1 ? roundTo(changedRows.length / (total - 1), 4) : 0,
    mean_change_per_frame: roundTo(meanChange, 3),
    mean_change_per_second: roundTo(meanChange * fps, 3),
    longest_static_run_frames: longestRun,
    longest_static_run_s: roundTo(longestRun / fps, 3),
    shot_cuts: shotCuts,
    shot_cut_count: shotCuts.length,
    median_gap_between_changes: medianGap,
    per_second: perSecond,
    camera_vs_subject: {
      camera_frames: cameraFrames,
      subject_frames: subjectFrames,
      both_frames: bothFrames,
      neither_frames: neitherFrames,
      median_border_mad: medianBorder,
      median_center_mad: medianCenter,
      border_center_ratio: medianCenter ? roundTo(medianBorder / medianCenter, 3) : null,
    },
  };
  pace.cadence = classifyCadence(pace);
  return pace;
}

function hexDistance(a, b) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return Math.sqrt(pa.reduce((sum, v, i) => sum + (v - pb[i]) ** 2, 0));
}

// Build the plain-language prompt from the measured numbers only.
// Short sentences, active voice, one thought per sentence. Every
// claim names the number and the window behind it.
export function buildPrompt(pace, measured, { video, startS, endS }) {
  const first = measured.first_frame || {};
  const gradient = measured.gradient || null;
  const palette = measured.palette || [];
  const camera = pace.camera_vs_subject || {};
  const lines = [
    `# Frame style prompt (measured, ${basename(video)})`,
    "",
    `Measure this window before you draw. The window runs from ${startS} s to ${endS} s.`,
    `The window holds ${pace.frames} frames at ${pace.fps} fps. The source frame is ${measured.source_width}x${measured.source_height}.`,
    "",
    "## Pace",
    "",
    `${pace.changed_frames} of ${pace.frames - 1} frame steps change, so the changed fraction is ${pace.changed_fraction}.`,
    `Mean change is ${pace.mean_change_per_frame} levels per frame and ${pace.mean_change_per_second} levels per second.`,
    `The longest static run is ${pace.longest_static_run_frames} frames, or ${pace.longest_static_run_s} s.`,
    pace.changed_fraction >= 0.9
      ? "Move something on nearly every frame, because the reference tweens every frame."
      : pace.changed_fraction >= 0.5
        ? "Move something on most frames, because the reference changes on most frames."
        : "Hold still for long stretches, because the reference holds still for most frames.",
    "",
    "## Shots and cadence",
    "",
    `The window holds ${pace.shot_cut_count} shot cuts${pace.shot_cut_count ? ` at ${pace.shot_cuts.map((c) => `${c.time_s} s`).join(", ")}` : ""}.`,
    `Cadence is ${pace.cadence}${pace.median_gap_between_changes === null ? "" : `, with a median gap of ${pace.median_gap_between_changes} frames between changed frames`}.`,
    pace.cadence === "on-1s"
      ? "Change the drawing on every frame."
      : pace.cadence === "on-2s"
        ? "Hold each drawing for two frames, then change it."
        : pace.cadence === "on-3s"
          ? "Hold each drawing for three frames, then change it."
          : pace.cadence === "hold-and-pop"
            ? "Hold still, then move in short bursts."
            : "Mix holds and movement, because the reference does not hold one cadence.",
    "Treat each shot cut as a fresh scene. Do not tween across a cut.",
    "",
    "## Camera or subject",
    "",
    `Border motion is ${camera.median_border_mad} levels per frame and centre motion is ${camera.median_center_mad} levels per frame.`,
    `${camera.camera_frames} steps are camera-led and ${camera.subject_frames} steps are subject-led, with ${camera.both_frames} steps moving on both.`,
    (camera.camera_frames || 0) > 2 * (camera.subject_frames || 0) && (camera.camera_frames || 0) > 0
      ? "Move the camera, because the border moves while the subject holds."
      : (camera.subject_frames || 0) > 2 * (camera.camera_frames || 0) && (camera.subject_frames || 0) > 0
        ? "Move the subject and hold the camera, because the centre moves while the border holds."
        : "Move camera and subject together only where both measured numbers move.",
    "",
    "## Palette",
    "",
  ];
  if (palette.length) {
    lines.push(`Use only these ${palette.length} colours, in this order: ${palette.map((p) => `${p.hex} (${Math.round(p.share * 100)}%)`).join(", ")}.`);
    lines.push("No colour outside this list belongs in the frame.");
  } else {
    lines.push("No palette was measured for this window.");
  }
  lines.push("", "## Flatness, outline, and grain", "");
  lines.push(`Fill shapes with solid colour. The flat-fill ratio is ${measured.flat_fill_ratio}.`);
  lines.push(`Dark outline density is ${measured.outline_density}. Use dark outlines at that density, no heavier.`);
  lines.push(`Surface grain is ${measured.grain_mean_abs_laplacian}. Keep the surface that smooth.`);
  lines.push(`Mean brightness is ${measured.mean_luma}. Hold the whole image near that brightness.`);
  lines.push("", "## Motion per second", "");
  for (const s of pace.per_second) {
    lines.push(`Second ${s.second} moves ${s.mean_abs_diff} levels per frame across ${s.frames} frames, with ${s.changed} changed frames and ${s.shot_cuts} cuts.`);
  }
  if (gradient && gradient.stops && gradient.stops.length) {
    lines.push(
      "",
      "## Background",
      "",
      "Paint the whole background, edge to edge, as one smooth gradient wash.",
      ...gradient.stops.map((stop) => `At ${Math.round(stop.y * 100)}% down the frame the colour is RGB (${stop.rgb.join(", ")}).`),
      `No single row changes by more than ${gradient.max_row_step} RGB points from the row above it, and the mean row change is ${gradient.mean_row_step} points.`,
    );
  } else if (first.top_median_rgb && first.bottom_median_rgb) {
    lines.push(
      "",
      "## Background",
      "",
      `Paint the first frame background from RGB (${first.top_median_rgb.join(", ")}) at the top to RGB (${first.bottom_median_rgb.join(", ")}) at the bottom.`,
      "Keep the gradient smooth, because the measured top and bottom medians come from the first frame of this window.",
    );
  }
  lines.push(
    "",
    "## Limits",
    "",
    `These numbers describe ${pace.frames} frames only. They do not describe the full video.`,
    `A changed frame means mean absolute difference over ${CHANGED_MEAN_ABS_DIFF} levels against the frame before it.`,
    `A shot cut means mean absolute difference over ${SHOT_CUT_MEAN_ABS_DIFF} levels against the frame before it.`,
    `Frames were measured at ${MEASURE_WIDTH} px wide, so small details under that scale are not in these numbers.`,
  );
  return lines.join("\n") + "\n";
}

export function buildInsightReport(pace, measured, { video, startS, endS, outPath, csvPath }) {
  const ok = pace.frames >= 2;
  const status = ok ? "PASS" : "FAIL";
  const failedBar = ok ? null : "At least 2 frames in the window";
  const detail = ok
    ? `Measured ${pace.frames} frames from ${startS} s to ${endS} s at ${pace.fps} fps. Changed fraction ${pace.changed_fraction}, mean change ${pace.mean_change_per_frame} levels per frame, longest static run ${pace.longest_static_run_frames} frames. ${pace.shot_cut_count} shot cuts, cadence ${pace.cadence}, flat-fill ratio ${measured.flat_fill_ratio}, grain ${measured.grain_mean_abs_laplacian}.`
    : `Window ${startS} s to ${endS} s yielded ${pace.frames} frames, under the 2 frame bar, so no change can be measured.`;
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      video,
      window_s: [startS, endS],
      fps: pace.fps,
      frames: pace.frames,
      source_shape: [measured.source_height, measured.source_width],
      measure_width: MEASURE_WIDTH,
      changed_threshold_mean_abs_diff: CHANGED_MEAN_ABS_DIFF,
      shot_cut_threshold_mean_abs_diff: SHOT_CUT_MEAN_ABS_DIFF,
      changed_fraction: pace.changed_fraction,
      changed_frames: pace.changed_frames,
      mean_change_per_frame: pace.mean_change_per_frame,
      mean_change_per_second: pace.mean_change_per_second,
      longest_static_run_frames: pace.longest_static_run_frames,
      longest_static_run_s: pace.longest_static_run_s,
      shot_cuts: pace.shot_cuts,
      shot_cut_count: pace.shot_cut_count,
      cadence: pace.cadence,
      median_gap_between_changes: pace.median_gap_between_changes,
      camera_vs_subject: pace.camera_vs_subject,
      palette: measured.palette,
      gradient: measured.gradient,
      flat_fill_ratio: measured.flat_fill_ratio,
      outline_density: measured.outline_density,
      dark_fraction: measured.dark_fraction,
      grain_mean_abs_laplacian: measured.grain_mean_abs_laplacian,
      mean_luma: measured.mean_luma,
      per_second: pace.per_second,
      first_frame: measured.first_frame,
      prompt_path: outPath,
      csv_path: csvPath,
      method: "ffmpeg extracts every frame in the window at native fps, scaled to 480 px wide. A Python driver (PIL and numpy, engine venv) loads frames one at a time and reports mean absolute grayscale difference against the frame before it, border MAD (outer 12%) and centre MAD (inner 50%), flat-fill ratio, outline density, grain (mean absolute Laplacian), and mean luma. It aggregates the top 8 quantized palette hexes and the mean 5-stop vertical gradient. A frame counts as changed when that difference is over 0.5 levels; a shot cut when it is over 22.0 levels. JavaScript turns the rows into changed fraction, mean change per frame and per second, longest static run, shot cuts, cadence, camera-vs-subject split, and a per-second motion curve. The prompt is built from those numbers only.",
    },
    corrections: [],
    context: {
      thresholds: {
        changed_mean_abs_diff: CHANGED_MEAN_ABS_DIFF,
        shot_cut_mean_abs_diff: SHOT_CUT_MEAN_ABS_DIFF,
        changed_rule: "A frame counts as changed when its mean absolute grayscale difference against the frame before it is over 0.5 levels. Encoded-video noise sits under 0.5, so a frame over that bar moved for real.",
        shot_cut_rule: "A frame counts as a shot cut when its mean absolute grayscale difference against the frame before it is over 22.0 levels. That is a full-scene change, not a moving subject.",
        cadence_rule: "static means no frame changed. on-1s means a change on nearly every frame (changed fraction at least 0.85). on-2s means a median gap of 2 frames between changed frames. on-3s means a median gap of 3. hold-and-pop means long static runs of at least 8 frames with a changed fraction under 0.5. Anything else is mixed.",
        camera_rule: "A step is camera-led when border MAD is over 0.5 and more than twice centre MAD. It is subject-led when centre MAD is over 0.5 and more than twice border MAD.",
        min_frames: 2,
        verdict_rule: "PASS when the window yields at least 2 frames, FAIL when it yields fewer. This command measures pace and style; it does not judge whether the pace is good, so a still window passes with a changed fraction of 0. The report carries the palette, flatness, outline, grain, and luminance bounds that --gate-image checks a generated still against.",
      },
      control_ceiling: null,
      meaning: `Over ${pace.frames} frames the video changes on ${pace.changed_frames} steps, a changed fraction of ${pace.changed_fraction}. Mean change is ${pace.mean_change_per_frame} levels per frame, ${pace.mean_change_per_second} levels per second. The longest static run is ${pace.longest_static_run_frames} frames (${pace.longest_static_run_s} s). There are ${pace.shot_cut_count} shot cuts and cadence is ${pace.cadence}. The per-second curve names the motion in each second of the window.`,
    },
    next: "hme trace video.mp4 --start-s <n> --end-s <n> --out <dir>",
    limits: [
      "The numbers describe this window only. They do not describe the full video.",
      "Frames are measured at 480 px wide. Small details under that scale are not in these numbers.",
      "Mean absolute difference sees any pixel move, so a camera move reads as motion even when the subject holds still. The border and centre MADs split the two; read them before trusting the headline pace.",
      "The palette is quantized to 5 bits per channel, so near colours merge into one hex. The gradient stops are medians across each row, so a wide figure can pull a stop toward the figure colour.",
      "This command measures pace, palette, flatness, outline, grain, and gradient. It does not measure trajectories or easing; hme trace measures those.",
    ],
  };
}

// --- Pixel falsification gate -------------------------------------------
// Measure one still image with the same driver, then check it
// against a v2 reference report on five bars. Each bar names its
// measured value and its bound, and each failed bar carries one
// targeted [FIX-k] patch for the prompt that made the image.
export async function measureSingleImage(imagePath) {
  const framesDir = mkdtempSync(join(tmpdir(), "hme-frame-style-gate-"));
  try {
    copyFileSync(resolve(imagePath), join(framesDir, "frame-000000.png"));
    return await runDriver(framesDir);
  } finally {
    rmSync(framesDir, { recursive: true, force: true });
  }
}

export function gateImageAgainstReference(measured, reference) {
  const ref = (reference && reference.numbers) || {};
  const missing = ["palette", "flat_fill_ratio", "outline_density", "grain_mean_abs_laplacian", "mean_luma"]
    .filter((k) => ref[k] === undefined || ref[k] === null);
  if (missing.length) {
    throw new Error(`reference report is missing ${missing.join(", ")}; gate needs a v2 frame-style report`);
  }
  const refPalette = ref.palette || [];
  const gatePalette = measured.palette || [];
  const matched = gatePalette.filter((p) => refPalette.some((r) => hexDistance(p.hex, r.hex) <= GATE_PALETTE_MAX_DISTANCE));
  const paletteBar = {
    bar: "Palette Adherence",
    status: matched.length >= GATE_PALETTE_MIN_MATCHES ? "PASS" : "FAIL",
    measured: `${matched.length} of ${gatePalette.length} top colours within ${GATE_PALETTE_MAX_DISTANCE} RGB points of the reference palette`,
    bound: `At least ${GATE_PALETTE_MIN_MATCHES} of ${gatePalette.length} top colours within ${GATE_PALETTE_MAX_DISTANCE} RGB points`,
    detail: `Gate palette: ${gatePalette.map((p) => p.hex).join(", ")}. Reference palette: ${refPalette.map((p) => p.hex).join(", ")}.`,
  };
  const flatDiff = Math.abs((measured.flat_fill_ratio ?? 0) - ref.flat_fill_ratio);
  const flatBar = {
    bar: "Flat Fill Integrity",
    status: flatDiff <= GATE_FLAT_MAX_DIFF ? "PASS" : "FAIL",
    measured: `flat-fill ratio ${measured.flat_fill_ratio}`,
    bound: `Within ${GATE_FLAT_MAX_DIFF} of the reference ${ref.flat_fill_ratio}`,
    detail: `Difference is ${roundTo(flatDiff, 4)}.`,
  };
  const refOutline = ref.outline_density;
  const gateOutline = measured.outline_density ?? 0;
  const outlineOk = (refOutline < 0.005 && gateOutline < 0.005)
    || (refOutline > 0 && gateOutline / refOutline >= GATE_OUTLINE_RATIO_LOW && gateOutline / refOutline <= GATE_OUTLINE_RATIO_HIGH);
  const outlineBar = {
    bar: "Outline Contract",
    status: outlineOk ? "PASS" : "FAIL",
    measured: `outline density ${gateOutline}`,
    bound: `Between ${GATE_OUTLINE_RATIO_LOW}x and ${GATE_OUTLINE_RATIO_HIGH}x the reference ${refOutline}`,
    detail: `Ratio is ${refOutline > 0 ? roundTo(gateOutline / refOutline, 3) : "n/a"}.`,
  };
  const grainBound = ref.grain_mean_abs_laplacian * GATE_GRAIN_FACTOR + GATE_GRAIN_SLACK;
  const grainBar = {
    bar: "Grain Floor",
    status: (measured.grain_mean_abs_laplacian ?? 0) <= grainBound ? "PASS" : "FAIL",
    measured: `grain ${measured.grain_mean_abs_laplacian}`,
    bound: `At or under ${roundTo(grainBound, 3)} (reference ${ref.grain_mean_abs_laplacian} x ${GATE_GRAIN_FACTOR} + ${GATE_GRAIN_SLACK})`,
    detail: "Generated art must not be grainier than the flat reference.",
  };
  const lumaDiff = Math.abs((measured.mean_luma ?? 0) - ref.mean_luma);
  const lumaBar = {
    bar: "Luminance Balance",
    status: lumaDiff <= GATE_LUMA_MAX_DIFF ? "PASS" : "FAIL",
    measured: `mean luma ${measured.mean_luma}`,
    bound: `Within ${GATE_LUMA_MAX_DIFF} of the reference ${ref.mean_luma}`,
    detail: `Difference is ${roundTo(lumaDiff, 2)}.`,
  };
  const bars = [paletteBar, flatBar, outlineBar, grainBar, lumaBar];
  const failed = bars.filter((b) => b.status === "FAIL");
  const fixes = [];
  if (paletteBar.status === "FAIL") {
    fixes.push(`[FIX-1] Use only these colours: ${refPalette.map((p) => p.hex).join(", ")}. Remove every colour outside that list.`);
  }
  if (flatBar.status === "FAIL") {
    fixes.push(`[FIX-2] Fill every shape with one solid colour. The reference flat-fill ratio is ${ref.flat_fill_ratio} and this image is ${measured.flat_fill_ratio}. Remove shading and texture inside shapes.`);
  }
  if (outlineBar.status === "FAIL") {
    fixes.push(`[FIX-3] Set dark outline density to ${ref.outline_density}. This image is ${gateOutline}. ${gateOutline > refOutline ? "Thin or remove dark outlines." : "Add dark outlines at the reference density."}`);
  }
  if (grainBar.status === "FAIL") {
    fixes.push(`[FIX-4] Remove grain and texture. The reference grain floor is ${ref.grain_mean_abs_laplacian} and this image is ${measured.grain_mean_abs_laplacian}. Keep flat fills with hard edges.`);
  }
  if (lumaBar.status === "FAIL") {
    fixes.push(`[FIX-5] Shift overall brightness toward ${ref.mean_luma}. This image is ${measured.mean_luma}. ${(measured.mean_luma ?? 0) > ref.mean_luma ? "Darken the image." : "Brighten the image."}`);
  }
  return {
    verdict: {
      status: failed.length ? "FAIL" : "PASS",
      failed_bars: failed.map((b) => b.bar),
      detail: failed.length
        ? `${failed.length} of 5 bars failed: ${failed.map((b) => b.bar).join(", ")}.`
        : "All 5 bars passed.",
    },
    bars,
    fixes,
  };
}

export async function runGateImage(gateImagePath, referencePath, gateOutPath) {
  if (!existsSync(resolve(gateImagePath))) {
    console.error(`hme frame-style: no such file: ${gateImagePath}`);
    return 2;
  }
  if (!existsSync(resolve(referencePath))) {
    console.error(`hme frame-style: no such file: ${referencePath}`);
    return 2;
  }
  let reference;
  try {
    reference = JSON.parse(readFileSync(resolve(referencePath), "utf8"));
  } catch {
    console.error(`hme frame-style: --reference is not valid JSON: ${referencePath}`);
    return 2;
  }
  let measured;
  try {
    measured = await measureSingleImage(gateImagePath);
  } catch (err) {
    console.error(`hme frame-style: ${err.message}`);
    return 2;
  }
  let gate;
  try {
    gate = gateImageAgainstReference(measured, reference);
  } catch (err) {
    console.error(`hme frame-style: ${err.message}`);
    return 2;
  }
  const output = {
    ...gate,
    image: gateImagePath,
    reference: referencePath,
    measured: {
      palette: measured.palette,
      flat_fill_ratio: measured.flat_fill_ratio,
      outline_density: measured.outline_density,
      grain_mean_abs_laplacian: measured.grain_mean_abs_laplacian,
      mean_luma: measured.mean_luma,
    },
  };
  if (gateOutPath) {
    mkdirSync(dirname(resolve(gateOutPath)), { recursive: true });
    writeFileSync(resolve(gateOutPath), JSON.stringify(output, null, 2) + "\n");
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
  return gate.verdict.status === "PASS" ? 0 : 1;
}

// Run `hme frame-style <video.mp4> --start-s <n> --end-s <n> --out <prompt.md> [--report <report.json>] [--csv <file.csv>] [--fps <n>]`
// or `hme frame-style --gate-image <image.png> --reference <report.json> [--gate-out <gate.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runFrameStyle(argv) {
  const positionals = [];
  let startS = null;
  let endS = null;
  let outPath = null;
  let reportPath = null;
  let csvPath = null;
  let fpsOverride = null;
  let gateImagePath = null;
  let referencePath = null;
  let gateOutPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      if (i + 1 >= argv.length) {
        console.error(`hme frame-style: ${flag} needs a value`);
        console.error(USAGE);
        return null;
      }
      return argv[++i];
    };
    if (a === "--start-s") {
      const v = need(a);
      if (v === null) return 2;
      startS = Number(v);
      if (!Number.isFinite(startS) || startS < 0) { console.error("hme frame-style: --start-s needs a number at or above 0"); console.error(USAGE); return 2; }
    } else if (a === "--end-s") {
      const v = need(a);
      if (v === null) return 2;
      endS = Number(v);
      if (!Number.isFinite(endS)) { console.error("hme frame-style: --end-s needs a number of seconds"); console.error(USAGE); return 2; }
    } else if (a === "--out") {
      outPath = need(a);
      if (outPath === null) return 2;
    } else if (a === "--report") {
      reportPath = need(a);
      if (reportPath === null) return 2;
    } else if (a === "--csv") {
      csvPath = need(a);
      if (csvPath === null) return 2;
    } else if (a === "--fps") {
      const v = need(a);
      if (v === null) return 2;
      fpsOverride = Number(v);
      if (!Number.isFinite(fpsOverride) || fpsOverride <= 0) { console.error("hme frame-style: --fps needs a positive number"); console.error(USAGE); return 2; }
    } else if (a === "--gate-image") {
      gateImagePath = need(a);
      if (gateImagePath === null) return 2;
    } else if (a === "--reference") {
      referencePath = need(a);
      if (referencePath === null) return 2;
    } else if (a === "--gate-out") {
      gateOutPath = need(a);
      if (gateOutPath === null) return 2;
    } else if (a.startsWith("--")) {
      console.error(`hme frame-style: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (gateImagePath || referencePath) {
    if (!gateImagePath || !referencePath) {
      console.error("hme frame-style: --gate-image and --reference go together");
      console.error(USAGE);
      return 2;
    }
    if (positionals.length || startS !== null || endS !== null || outPath) {
      console.error("hme frame-style: gate mode takes no video, window, or --out");
      console.error(USAGE);
      return 2;
    }
    return runGateImage(gateImagePath, referencePath, gateOutPath);
  }
  if (positionals.length !== 1) {
    console.error("hme frame-style: needs one video, video.mp4");
    console.error(USAGE);
    return 2;
  }
  if (startS === null || endS === null) {
    console.error("hme frame-style: --start-s and --end-s are both required");
    console.error(USAGE);
    return 2;
  }
  if (endS <= startS) {
    console.error("hme frame-style: --end-s must be after --start-s");
    console.error(USAGE);
    return 2;
  }
  if (!outPath) {
    console.error("hme frame-style: --out <prompt.md> is required");
    console.error(USAGE);
    return 2;
  }
  const [videoArg] = positionals;
  const videoPath = resolve(videoArg);
  if (!existsSync(videoPath)) {
    console.error(`hme frame-style: no such file: ${videoArg}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme frame-style: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  let probe;
  try {
    probe = probeVideo(videoPath);
  } catch (err) {
    console.error(`hme frame-style: ${err.message}`);
    return 2;
  }
  const fps = fpsOverride || probe.fps;
  const duration = endS - startS;
  const framesDir = mkdtempSync(join(tmpdir(), "hme-frame-style-"));
  try {
    const extract = run("ffmpeg", [
      "-v", "error",
      "-ss", String(startS),
      "-i", videoPath,
      "-t", String(duration),
      "-vf", `fps=${fps},scale=${MEASURE_WIDTH}:-2`,
      join(framesDir, "frame-%06d.png"),
    ]);
    if (extract.status !== 0) {
      console.error(`hme frame-style: ffmpeg failed: ${(extract.stderr || "").trim().slice(-300)}`);
      return 2;
    }
    const names = readdirSync(framesDir).filter((n) => n.endsWith(".png")).sort();
    if (names.length === 0) {
      const pace = { frames: 0, fps, changed_frames: 0, changed_fraction: 0, mean_change_per_frame: 0, mean_change_per_second: 0, longest_static_run_frames: 0, longest_static_run_s: 0, per_second: [], shot_cuts: [], shot_cut_count: 0, median_gap_between_changes: null, cadence: "mixed", camera_vs_subject: { camera_frames: 0, subject_frames: 0, both_frames: 0, neither_frames: 0, median_border_mad: 0, median_center_mad: 0, border_center_ratio: null } };
      const report = buildInsightReport(pace, { source_width: probe.width, source_height: probe.height, first_frame: null, palette: [], gradient: null, flat_fill_ratio: null, outline_density: null, dark_fraction: null, grain_mean_abs_laplacian: null, mean_luma: null }, { video: videoArg, startS, endS, outPath, csvPath });
      return writeInsightReport(report, reportPath);
    }
    const measured = await runDriver(framesDir);
    measured.source_width = probe.width;
    measured.source_height = probe.height;
    const pace = measurePace(measured, fps, startS);
    const prompt = buildPrompt(pace, measured, { video: videoArg, startS, endS });
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(resolve(outPath), prompt);
    if (csvPath) {
      const csvLines = ["frame,time_s,mean_abs_diff,changed,shot_cut,border_mad,center_mad,mean_luma,flat_fill_ratio,outline_density,grain"];
      measured.rows.forEach((r, i) => {
        csvLines.push(`${r.frame},${roundTo(startS + i / fps, 4)},${r.mean_abs_diff},${r.changed},${r.shot_cut},${r.border_mad},${r.center_mad},${r.mean_luma},${r.flat_fill_ratio},${r.outline_density},${r.grain}`);
      });
      mkdirSync(dirname(resolve(csvPath)), { recursive: true });
      writeFileSync(resolve(csvPath), csvLines.join("\n") + "\n");
    }
    const report = buildInsightReport(pace, measured, { video: videoArg, startS, endS, outPath, csvPath });
    return writeInsightReport(report, reportPath);
  } catch (err) {
    console.error(`hme frame-style: ${err.message}`);
    return 2;
  } finally {
    rmSync(framesDir, { recursive: true, force: true });
  }
}
