// hme frame-style: measure a reference video frame by frame and
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
// Method: ffmpeg extracts the window at the video native fps,
// scaled to 480 px wide so one frame at a time stays cheap in
// memory. A Python driver (engine venv, PIL and numpy only, no
// cv2) loads the frames in order and reports, per frame, the mean
// absolute grayscale difference against the frame before it, plus
// the first frame top and bottom band medians. JavaScript turns
// those rows into pace numbers: changed fraction, mean change per
// frame and per second, longest static run, and a per-second
// motion curve. The prompt is built from those numbers only.
//
// A changed frame is one whose mean absolute difference from the
// frame before it is over 0.5 levels. Encoded-video noise sits
// under 0.5, so a frame over that bar moved for real. The bar is
// in the report thresholds, not hidden.
//
// Verdict rule: PASS when the window yields at least 2 frames, so
// a change can be measured at all. FAIL when it yields fewer.
// This command measures pace; it does not judge whether the pace
// is good, so a still window passes with a changed fraction of 0.
import { spawn, spawnSync } from "node:child_process";
import {
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
export const MEASURE_WIDTH = 480;

export const USAGE = [
  "hme frame-style: Measure a reference video frame by frame over a window and write a plain-language style prompt from the measured pace numbers.",
  "",
  "Usage: hme frame-style <video.mp4> --start-s <n> --end-s <n> --out <prompt.md> [--report <report.json>] [--csv <per-frame.csv>]",
  "",
  "Arguments:",
  "  <video.mp4>  Path to the reference video.",
  "",
  "Options:",
  "  --start-s <n>  Start time in seconds. Required.",
  "  --end-s <n>  End time in seconds. Required, and after --start-s.",
  "  --out <file>  Write the style prompt here. Required.",
  "  --report <file>  Write the JSON insight report here. Without it, the report goes to stdout.",
  "  --csv <file>  Write one row per frame (frame, time, mean_abs_diff, changed). Without it, no CSV is written.",
  "  --fps <n>  Frames per second to extract at. Default: the video native fps from ffprobe.",
  "",
  "Proof: on the 24-frame Headless Motion descent clip (24 fps, 1.0 s, 480p) the tool must read 24 frames, a changed fraction of 0.3478, and a longest static run of 15 frames. The prompt must name the window, the frame count, the changed fraction, and the mean change per second.",
  "Verdict: PASS when the window yields at least 2 frames. FAIL when it yields fewer than 2 frames.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// The Python driver. It loads the extracted PNGs in sorted order,
// one at a time, and prints exactly one JSON object to stdout.
// Progress goes to stderr. PIL and numpy only, no cv2.
const DRIVER = `
import json
import os
import sys
import numpy as np
from PIL import Image

frames_dir = sys.argv[1]
names = sorted(n for n in os.listdir(frames_dir) if n.endswith(".png"))
if not names:
    print(json.dumps({"frames": 0, "rows": [], "first_frame": None}))
    sys.exit(0)
rows = []
prev = None
first_top = None
first_bottom = None
for i, name in enumerate(names):
    arr = np.array(Image.open(os.path.join(frames_dir, name)).convert("L")).astype(np.float64)
    if i == 0:
        rgb = np.array(Image.open(os.path.join(frames_dir, name)).convert("RGB")).astype(np.float64)
        h = rgb.shape[0]
        top = rgb[: max(1, h // 10)]
        bottom = rgb[-max(1, h // 10):]
        first_top = [round(float(v), 1) for v in np.median(top.reshape(-1, 3), axis=0)]
        first_bottom = [round(float(v), 1) for v in np.median(bottom.reshape(-1, 3), axis=0)]
        rows.append({"frame": i, "mean_abs_diff": 0.0, "changed": False, "mean_luma": round(float(arr.mean()), 2)})
    else:
        diff = float(np.abs(arr - prev).mean())
        rows.append({"frame": i, "mean_abs_diff": round(diff, 3), "changed": diff > ${CHANGED_MEAN_ABS_DIFF}, "mean_luma": round(float(arr.mean()), 2)})
    prev = arr

print(json.dumps({
    "frames": len(names),
    "width": int(arr.shape[1]),
    "height": int(arr.shape[0]),
    "rows": rows,
    "first_frame": {"top_median_rgb": first_top, "bottom_median_rgb": first_bottom},
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
  const perSecond = [];
  const seconds = total ? Math.ceil(total / fps) : 0;
  for (let s = 0; s < seconds; s++) {
    const slice = rows.slice(Math.floor(s * fps), Math.floor((s + 1) * fps));
    const sliceDiffs = slice.filter((r) => r.frame > 0).map((r) => r.mean_abs_diff);
    perSecond.push({
      second: roundTo(startS + s, 3),
      frames: slice.length,
      mean_abs_diff: sliceDiffs.length ? roundTo(sliceDiffs.reduce((a, b) => a + b, 0) / sliceDiffs.length, 3) : 0,
      changed: slice.filter((r) => r.changed).length,
    });
  }
  return {
    frames: total,
    fps: roundTo(fps, 3),
    changed_frames: changedRows.length,
    changed_fraction: total > 1 ? roundTo(changedRows.length / (total - 1), 4) : 0,
    mean_change_per_frame: roundTo(meanChange, 3),
    mean_change_per_second: roundTo(meanChange * fps, 3),
    longest_static_run_frames: longestRun,
    longest_static_run_s: roundTo(longestRun / fps, 3),
    per_second: perSecond,
  };
}

// Build the plain-language prompt from the measured numbers only.
// Short sentences, active voice, one thought per sentence. Every
// claim names the number and the window behind it.
export function buildPrompt(pace, measured, { video, startS, endS }) {
  const first = measured.first_frame || {};
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
    "## Motion per second",
    "",
  ];
  for (const s of pace.per_second) {
    lines.push(`Second ${s.second} moves ${s.mean_abs_diff} levels per frame across ${s.frames} frames, with ${s.changed} changed frames.`);
  }
  if (first.top_median_rgb && first.bottom_median_rgb) {
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
    `Frames were measured at ${MEASURE_WIDTH} px wide, so small details under that scale are not in these numbers.`,
  );
  return lines.join("\n") + "\n";
}

export function buildInsightReport(pace, measured, { video, startS, endS, outPath, csvPath }) {
  const ok = pace.frames >= 2;
  const status = ok ? "PASS" : "FAIL";
  const failedBar = ok ? null : "At least 2 frames in the window";
  const detail = ok
    ? `Measured ${pace.frames} frames from ${startS} s to ${endS} s at ${pace.fps} fps. Changed fraction ${pace.changed_fraction}, mean change ${pace.mean_change_per_frame} levels per frame, longest static run ${pace.longest_static_run_frames} frames.`
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
      changed_fraction: pace.changed_fraction,
      changed_frames: pace.changed_frames,
      mean_change_per_frame: pace.mean_change_per_frame,
      mean_change_per_second: pace.mean_change_per_second,
      longest_static_run_frames: pace.longest_static_run_frames,
      longest_static_run_s: pace.longest_static_run_s,
      per_second: pace.per_second,
      first_frame: measured.first_frame,
      prompt_path: outPath,
      csv_path: csvPath,
      method: "ffmpeg extracts every frame in the window at native fps, scaled to 480 px wide. A Python driver (PIL and numpy, engine venv) loads frames one at a time and reports mean absolute grayscale difference against the frame before it. A frame counts as changed when that difference is over 0.5 levels. JavaScript turns the rows into changed fraction, mean change per frame and per second, longest static run, and a per-second motion curve. The prompt is built from those numbers only.",
    },
    corrections: [],
    context: {
      thresholds: {
        changed_mean_abs_diff: CHANGED_MEAN_ABS_DIFF,
        changed_rule: "A frame counts as changed when its mean absolute grayscale difference against the frame before it is over 0.5 levels. Encoded-video noise sits under 0.5, so a frame over that bar moved for real.",
        min_frames: 2,
        verdict_rule: "PASS when the window yields at least 2 frames, FAIL when it yields fewer. This command measures pace; it does not judge whether the pace is good, so a still window passes with a changed fraction of 0.",
      },
      control_ceiling: null,
      meaning: `Over ${pace.frames} frames the video changes on ${pace.changed_frames} steps, a changed fraction of ${pace.changed_fraction}. Mean change is ${pace.mean_change_per_frame} levels per frame, ${pace.mean_change_per_second} levels per second. The longest static run is ${pace.longest_static_run_frames} frames (${pace.longest_static_run_s} s). The per-second curve names the motion in each second of the window.`,
    },
    next: "hme trace <video.mp4> --start-s <n> --end-s <n> --out <dir>",
    limits: [
      "The numbers describe this window only. They do not describe the full video.",
      "Frames are measured at 480 px wide. Small details under that scale are not in these numbers.",
      "Mean absolute difference sees any pixel move, so a camera move reads as motion even when the subject holds still.",
      "This command measures pace and background medians only. It does not measure palette, cuts, trajectories, or easing; hme trace measures those.",
    ],
  };
}

// Run `hme frame-style <video.mp4> --start-s <n> --end-s <n> --out <prompt.md> [--report <report.json>] [--csv <file.csv>] [--fps <n>]`.
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
    } else if (a.startsWith("--")) {
      console.error(`hme frame-style: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme frame-style: needs one video, <video.mp4>");
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
      const pace = { frames: 0, fps, changed_frames: 0, changed_fraction: 0, mean_change_per_frame: 0, mean_change_per_second: 0, longest_static_run_frames: 0, longest_static_run_s: 0, per_second: [] };
      const report = buildInsightReport(pace, { source_width: probe.width, source_height: probe.height, first_frame: null }, { video: videoArg, startS, endS, outPath, csvPath });
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
      const csvLines = ["frame,time_s,mean_abs_diff,changed,mean_luma"];
      measured.rows.forEach((r, i) => {
        csvLines.push(`${r.frame},${roundTo(startS + i / fps, 4)},${r.mean_abs_diff},${r.changed},${r.mean_luma}`);
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
