// hme gradient: measure the vertical colour gradient of one frame.
//
// One command, one frame, one JSON report in the insight format.
// The frame is split into horizontal bands (default 10). Each band
// reports its per-channel mean and median RGB. The slope is a
// least-squares fit of the band medians against band centre y, per
// channel, plus the top-band minus bottom-band drop. The falloff
// curve is the band medians in order, top to bottom. A step is the
// largest jump between two adjacent band medians.
//
// Why medians are the headline: a subject in the frame (a woman, an
// ant, a planet) pulls the band mean away from the sky colour, while
// the median stays on the sky as long as the subject covers less than
// half the band width. On real frame 360 the band 3 and 4 means jump
// by up to 35 levels from a passing shape while the medians fall
// smoothly. Means are reported beside the medians so the difference
// is visible, never hidden.
//
// Method: Node spawns the engine venv Python with a small driver on
// stdin, the same pattern colour.mjs uses. The driver loads the PNG
// with PIL and numpy, crops the region, and prints exactly one JSON
// object to stdout. Progress goes to stderr. The slope, the drop,
// the step, and the verdict are computed in JavaScript from the band
// medians.
//
// Verdict rule (set from the proof numbers, stated in the report):
// FAIL when the sky is flat (the largest variation outside the
// single largest step, across channels, is under 10 levels) or when
// an abrupt step is found (any adjacent-band median jump over 20
// levels in any channel). PASS when the gradient is present and
// smooth. Real frame 360 varies 48 in R and 67 in G outside its
// largest step, with a largest adjacent jump of 11, so it passes
// with room. Batch 1 S1 varies 0 outside its step and steps 91 in
// R, 148 in G, 168 in B into the dark band, so it fails on both
// counts. The thresholds sit in the wide gap between those two
// measured cases: 10 between 0 and 48, 20 between 11 and 91.
//
// Mapping of facts into the insight corrections shape:
// - Flat-sky correction: ours is the top band centre point, real is
//   the bottom band centre point, px is the pixel count of each
//   band. shift_px is the vertical span between the two band
//   centres in px. The drops per channel are in the fix text and in
//   numbers.
// - Step correction: ours is the band centre just above the step,
//   real is the band centre just below it, px is the pixel count of
//   each band. shift_px is the distance between the two band
//   centres in px. The jump per channel and the y where it happens
//   are in the fix text and in numbers.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const VENV_PYTHON = resolve(REPO_ROOT, ".venv", "bin", "python");

export const DEFAULT_BANDS = 10;
export const DEFAULT_FPS = 60;
export const FLAT_DROP_MAX = 10;
export const STEP_JUMP_MIN = 20;

export const USAGE = [
  "hme gradient: Measure the vertical colour gradient of one frame: slope top to bottom per channel plus a falloff curve.",
  "",
  "Usage: hme gradient <frame.png> [--region <x,y,w,h>] [--bands <n>] [--at-s <n>] [--fps <n>] [--out <report.json>]",
  "",
  "Arguments:",
  "  <frame.png>  One frame image (PNG).",
  "",
  "Options:",
  "  --region <x,y,w,h>  Pixel rect to measure, in full-frame coords. Default: the whole frame. Use it to measure only the sky and keep a subject or a dark band out of the slope.",
  "  --bands <n>  How many horizontal bands to split the region into. Default 10.",
  "  --at-s <n>  Time in seconds of the frame. When absent, it is derived from the frame name: frame-360.png means frame 360 at --fps, real-7s.png means 7 s.",
  "  --fps <n>  Frames per second for a frame-N name. Default 60.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Proof: on real frame 360 of the 30 s cut the tool must read top median near RGB (132, 172, 254), bottom median near (75, 94, 241), green drop near 78, red near 57. On a batch 1 frame it must read a flat sky (drop near 0) and name the abrupt step into the dark band (34, 9, 81).",
  "Verdict: PASS when the gradient is present and smooth (largest variation outside the single largest step at least 10 levels, no adjacent-band jump over 20 levels). FAIL when the sky is flat or a step is found. Thresholds are set from the proof numbers, not from a spec.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

function roundTo(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function roundRgb(rgb) {
  return rgb.map((v) => roundTo(v, 1));
}

// Seconds from a frame file name. frame-360.png means frame 360 at
// fps (default 60, the short-clone rate). A name like real-7s.png
// also works.
export function parseAtS(filePath, fps = DEFAULT_FPS) {
  const base = basename(filePath);
  const byFrame = base.match(/frame-(\d+)\.png$/);
  if (byFrame) return roundTo(Number(byFrame[1]) / fps, 3);
  const bySeconds = base.match(/(\d+(?:\.\d+)?)s\./);
  if (bySeconds) return Number(bySeconds[1]);
  return null;
}

export function parseRegion(text) {
  const parts = text.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  const [x, y, w, h] = parts;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
}

// The Python driver. It loads the PNG, crops the region, splits it
// into bands along y, and prints exactly one JSON object to stdout.
// Progress goes to stderr.
const DRIVER = `
import json
import sys
import numpy as np
from PIL import Image

FRAME = sys.argv[1]
REGION = sys.argv[2]
BANDS = int(sys.argv[3])

im = np.array(Image.open(FRAME).convert("RGB")).astype(np.float64)
h, w, _ = im.shape
if REGION == "full":
    rx, ry, rw, rh = 0, 0, w, h
else:
    rx, ry, rw, rh = (int(v) for v in REGION.split(","))
    if rx + rw > w or ry + rh > h:
        raise RuntimeError(f"region {rx},{ry},{rw},{rh} is outside the {w}x{h} frame")
crop = im[ry:ry + rh, rx:rx + rw]
bands = []
for i in range(BANDS):
    y0 = i * rh // BANDS
    y1 = (i + 1) * rh // BANDS
    band = crop[y0:y1]
    flat = band.reshape(-1, 3)
    bands.append({
        "index": i,
        "y0": ry + y0,
        "y1": ry + y1,
        "centre_y": round(ry + (y0 + y1) / 2, 1),
        "pixels": int(flat.shape[0]),
        "mean": [round(float(v), 1) for v in flat.mean(axis=0)],
        "median": [round(float(v), 1) for v in np.median(flat, axis=0)],
    })

print(json.dumps({
    "shape": [h, w, 3],
    "region": {"x": rx, "y": ry, "w": rw, "h": rh},
    "bands": bands,
}))
`;

function runDriver(framePath, regionText, bands) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", framePath, regionText, String(bands)], {
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
        rejectPromise(new Error(`gradient measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`gradient measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Least-squares fit of y against x. Returns slope per x unit,
// intercept, and r squared.
export function linearFit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = sxx === 0 || syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

export function measureGradient(measured) {
  const bands = measured.bands;
  const centres = bands.map((b) => b.centre_y);
  const channels = ["r", "g", "b"];
  const slope = {};
  const drop = {};
  for (let ch = 0; ch < 3; ch++) {
    const values = bands.map((b) => b.median[ch]);
    const fit = linearFit(centres, values);
    slope[channels[ch]] = {
      per_100px: roundTo(fit.slope * 100, 2),
      per_px: roundTo(fit.slope, 4),
      r2: roundTo(fit.r2, 3),
    };
    drop[channels[ch]] = roundTo(bands[0].median[ch] - bands[bands.length - 1].median[ch], 1);
  }
  const maxDrop = Math.max(...Object.values(drop).map((v) => Math.abs(v)));
  const top = bands[0].median;
  const bottom = bands[bands.length - 1].median;
  let step = null;
  for (let i = 0; i < bands.length - 1; i++) {
    const jump = {
      r: roundTo(bands[i + 1].median[0] - bands[i].median[0], 1),
      g: roundTo(bands[i + 1].median[1] - bands[i].median[1], 1),
      b: roundTo(bands[i + 1].median[2] - bands[i].median[2], 1),
    };
    const biggest = Math.max(...Object.values(jump).map((v) => Math.abs(v)));
    if (!step || biggest > step.biggest) {
      step = {
        between_bands: [i, i + 1],
        y: roundTo((bands[i].centre_y + bands[i + 1].centre_y) / 2, 1),
        above_median: roundRgb(bands[i].median),
        below_median: roundRgb(bands[i + 1].median),
        jump,
        biggest: roundTo(biggest, 1),
      };
    }
  }
  // Variation outside the single largest step: a hard edge inflates
  // the raw top-to-bottom drop, so a flat sky above a step would
  // read as a gradient. The measure is the sum of the absolute
  // jumps between adjacent bands, leaving out the largest-step
  // boundary, worst channel. S1 sums to 0 outside its step; frame
  // 360 sums to 48 in R and 67 in G outside its largest step. The
  // flat bar applies to this number, not to the raw drop.
  const variationOutsideStep = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < bands.length - 1; i++) {
    if (i === step.between_bands[0]) continue;
    for (let ch = 0; ch < 3; ch++) {
      variationOutsideStep[channels[ch]] += Math.abs(bands[i + 1].median[ch] - bands[i].median[ch]);
    }
  }
  for (const ch of channels) variationOutsideStep[ch] = roundTo(variationOutsideStep[ch], 1);
  const maxVariationOutsideStep = Math.max(...Object.values(variationOutsideStep));
  return {
    top_median: roundRgb(top),
    bottom_median: roundRgb(bottom),
    slope_per_100px: {
      r: slope.r.per_100px,
      g: slope.g.per_100px,
      b: slope.b.per_100px,
    },
    slope_r2: { r: slope.r.r2, g: slope.g.r2, b: slope.b.r2 },
    drop_top_to_bottom: drop,
    max_drop: roundTo(maxDrop, 1),
    variation_outside_step: variationOutsideStep,
    max_variation_outside_step: roundTo(maxVariationOutsideStep, 1),
    largest_step: step,
    falloff_curve: bands.map((b) => ({
      band: b.index,
      y0: b.y0,
      y1: b.y1,
      centre_y: b.centre_y,
      median: roundRgb(b.median),
      mean: roundRgb(b.mean),
    })),
  };
}

export function buildCorrections(gradient, measured, { atS, frame }) {
  const corrections = [];
  const region = measured.region;
  const cx = roundTo(region.x + region.w / 2, 1);
  const bands = measured.bands;
  const topBand = bands[0];
  const bottomBand = bands[bands.length - 1];
  if (gradient.max_variation_outside_step < FLAT_DROP_MAX) {
    corrections.push({
      element: "sky",
      kind: "gradient",
      at_s: atS,
      ours: { x: cx, y: topBand.centre_y, px: topBand.pixels },
      real: { x: cx, y: bottomBand.centre_y, px: bottomBand.pixels },
      shift_px: { dx: 0, dy: roundTo(bottomBand.centre_y - topBand.centre_y, 1) },
      fix: `Sky is flat, not a gradient. Top band median is RGB (${gradient.top_median.join(", ")}) and bottom band median is RGB (${gradient.bottom_median.join(", ")}), and the variation outside the single largest step is R ${gradient.variation_outside_step.r}, G ${gradient.variation_outside_step.g}, B ${gradient.variation_outside_step.b}, so the largest is ${gradient.max_variation_outside_step} levels, under the flat bar of ${FLAT_DROP_MAX}. A real sky falls: frame 360 varies 48 in R and 67 in G outside its largest step. Rebuild the sky as a smooth gradient from the top colour to the bottom colour over the full height, not one flat fill. shift_px here is the vertical span between the top and bottom band centres, not a move.`,
      source: `hme gradient, ${basename(frame)}`,
    });
  }
  const step = gradient.largest_step;
  if (step && step.biggest > STEP_JUMP_MIN) {
    const aboveBand = bands[step.between_bands[0]];
    const belowBand = bands[step.between_bands[1]];
    corrections.push({
      element: "sky",
      kind: "gradient",
      at_s: atS,
      ours: { x: cx, y: aboveBand.centre_y, px: aboveBand.pixels },
      real: { x: cx, y: belowBand.centre_y, px: belowBand.pixels },
      shift_px: { dx: 0, dy: roundTo(belowBand.centre_y - aboveBand.centre_y, 1) },
      fix: `Abrupt step, not a gradient. Between bands ${step.between_bands[0]} and ${step.between_bands[1]}, near y=${step.y}, the median jumps R ${step.jump.r}, G ${step.jump.g}, B ${step.jump.b} (largest ${step.biggest} levels), over the ${STEP_JUMP_MIN} level step bar. Above the step the median is RGB (${step.above_median.join(", ")}), below it RGB (${step.below_median.join(", ")}). A real sky moves at most 11 levels between bands (frame 360). Replace the hard edge with a smooth falloff across the full height. shift_px here is the distance between the two band centres, not a move.`,
      source: `hme gradient, ${basename(frame)}`,
    });
  }
  return corrections;
}

export function buildInsightReport(measured, gradient, { frame, atS, atSFrom, bands, regionText, outPath }) {
  const corrections = buildCorrections(gradient, measured, { atS, frame });
  const status = corrections.length === 0 ? "PASS" : "FAIL";
  const failedBar = status === "PASS"
    ? null
    : "Gradient present and smooth (largest variation outside the single largest step at least 10 levels, no adjacent-band jump over 20 levels)";
  const detail = status === "PASS"
    ? `Gradient is present and smooth. Top median RGB (${gradient.top_median.join(", ")}), bottom median RGB (${gradient.bottom_median.join(", ")}), largest variation outside the step ${gradient.max_variation_outside_step} levels, largest adjacent-band jump ${gradient.largest_step.biggest} levels.`
    : `Gradient fails: ${corrections.length} correction${corrections.length === 1 ? " is" : "s are"} named. Largest variation outside the step is ${gradient.max_variation_outside_step} levels, largest adjacent-band jump is ${gradient.largest_step.biggest} levels.`;
  const meaning = `Top band median is RGB (${gradient.top_median.join(", ")}) and bottom band median is RGB (${gradient.bottom_median.join(", ")}). Slope per 100 px is R ${gradient.slope_per_100px.r}, G ${gradient.slope_per_100px.g}, B ${gradient.slope_per_100px.b} (least-squares fit of band medians, r2 R ${gradient.slope_r2.r}, G ${gradient.slope_r2.g}, B ${gradient.slope_r2.b}). Top-to-bottom drop is R ${gradient.drop_top_to_bottom.r}, G ${gradient.drop_top_to_bottom.g}, B ${gradient.drop_top_to_bottom.b}. The largest step between two adjacent bands is ${gradient.largest_step.biggest} levels near y=${gradient.largest_step.y}. Medians are the headline because a subject in the frame pulls band means away from the sky colour while the median stays on the sky; means are reported beside the medians in the falloff curve.`;
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      at_s: atS,
      at_s_source: atSFrom,
      frame,
      frame_shape: measured.shape,
      region: measured.region,
      bands,
      method: "Frame split into horizontal bands along y. Each band reports per-channel mean and median RGB over the region. Slope is a least-squares fit of the band medians against band centre y, per channel. Drop is top band median minus bottom band median. Step is the largest jump between two adjacent band medians. Medians are the headline; means are reported beside them. Python driver loads the PNG with PIL and numpy in the engine venv; slope, drop, step, and verdict are computed in JavaScript.",
      gradient,
    },
    corrections,
    context: {
      thresholds: {
        flat_drop_max: FLAT_DROP_MAX,
        flat_rule: "Largest variation outside the single largest step, across channels, under 10 levels means the sky is flat. The step is taken out because a hard edge inflates the raw drop. Variation is the sum of the absolute jumps between adjacent bands, leaving out the largest-step boundary.",
        step_jump_min: STEP_JUMP_MIN,
        step_rule: "Any adjacent-band median jump over 20 levels in any channel means an abrupt step, not a gradient.",
        verdict_rule: "FAIL when the sky is flat or a step is found, PASS when the gradient is present and smooth.",
        proof_basis: "Real frame 360 varies 48 in R and 67 in G outside its largest step, with a largest adjacent jump of 11, so it passes with room. Batch 1 S1 varies 0 outside its step and steps 91 in R, 148 in G, 168 in B into the dark band, so it fails on both counts. The bars sit in the wide gap between those two measured cases: 10 between 0 and 48, 20 between 11 and 91.",
      },
      control_ceiling: null,
      meaning,
    },
    next: "hme gradient <batch-2-frame.png> --out out/gradient.json",
    limits: [
      "One frame is one moment. It cannot see motion, fades, or timing.",
      "The median stays on the sky only while the subject covers less than half the band width. A subject wider than half the frame pulls the median too; use --region to cut it out.",
      "The tool measures the gradient that is there. It does not say which colours the gradient should have; compare the numbers against the real frame.",
      "Bands are horizontal slices of the region. A diagonal gradient reads as a weaker vertical slope.",
    ],
  };
}

// Run `hme gradient <frame.png> [--region <x,y,w,h>] [--bands <n>] [--at-s <n>] [--fps <n>] [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runGradient(argv) {
  const positionals = [];
  let regionText = "full";
  let bands = DEFAULT_BANDS;
  let atS = null;
  let fps = DEFAULT_FPS;
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--region") {
      if (i + 1 >= argv.length) {
        console.error("hme gradient: --region needs x,y,w,h");
        console.error(USAGE);
        return 2;
      }
      regionText = argv[++i];
      if (!parseRegion(regionText)) {
        console.error(`hme gradient: bad --region "${regionText}", want x,y,w,h with w and h at least 1`);
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--bands") {
      if (i + 1 >= argv.length) {
        console.error("hme gradient: --bands needs a number");
        console.error(USAGE);
        return 2;
      }
      bands = Number(argv[++i]);
      if (!Number.isInteger(bands) || bands < 2 || bands > 64) {
        console.error("hme gradient: --bands needs a whole number from 2 to 64");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--at-s") {
      if (i + 1 >= argv.length) {
        console.error("hme gradient: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
      atS = Number(argv[++i]);
      if (!Number.isFinite(atS)) {
        console.error("hme gradient: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--fps") {
      if (i + 1 >= argv.length) {
        console.error("hme gradient: --fps needs a number");
        console.error(USAGE);
        return 2;
      }
      fps = Number(argv[++i]);
      if (!Number.isFinite(fps) || fps <= 0) {
        console.error("hme gradient: --fps needs a positive number");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme gradient: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme gradient: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme gradient: needs one frame, <frame.png>");
    console.error(USAGE);
    return 2;
  }
  const [frameArg] = positionals;
  const framePath = resolve(frameArg);
  if (!existsSync(framePath)) {
    console.error(`hme gradient: no such file: ${frameArg}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme gradient: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  let atSFrom;
  if (atS === null) {
    atS = parseAtS(frameArg, fps);
    if (atS === null) {
      console.error("hme gradient: cannot tell the seconds from the frame name; pass --at-s <n>");
      console.error(USAGE);
      return 2;
    }
    atSFrom = `derived from the frame name at ${fps} fps`;
  } else {
    atSFrom = "--at-s flag";
  }
  try {
    const measured = await runDriver(framePath, regionText, bands);
    const gradient = measureGradient(measured);
    const report = buildInsightReport(measured, gradient, {
      frame: frameArg, atS, atSFrom, bands, regionText, outPath,
    });
    return writeInsightReport(report, outPath);
  } catch (err) {
    console.error(`hme gradient: ${err.message}`);
    return 2;
  }
}
