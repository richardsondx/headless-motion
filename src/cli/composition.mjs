// hme composition: measure the subject box of one frame and report
// its share of the frame, its margins, its place against the
// rule-of-thirds lines, and its eye placement, as one JSON report
// in the insight format.
//
// One command, one frame, one JSON report. The subject is the
// largest non-background connected component. The background is
// found in two ways, and the tool says which one it used:
// - Smooth sky: when the 10 horizontal band medians fall smoothly
//   (largest adjacent-band jump at most 20 levels in any channel,
//   the same step bar the gradient tool uses), the background at
//   row y is the straight line from the top band median to the
//   bottom band median. This keeps the sky as background even on
//   rows where the subject covers most of the row, where a
//   per-row median would flip onto the subject itself.
// - Stepped sky: when a band median jumps more than 20 levels
//   (a flat sky over a dark band, as in batch 1), the background
//   at row y is that row median. A single straight line would
//   misread the flat sky and the dark band both.
// A pixel counts as subject when its Euclidean RGB distance from
// its row background is over the threshold (default 40). The
// largest component comes from dimensions.components, reused from
// src/checker, never reimplemented here.
//
// Proof, stated honestly. On batch 1 S1 the tool reads 45.3
// percent wide and 68.3 percent tall, within 0.3 points of the
// stated 45 and 68. On real frame 360 the tool reads 93.9 percent
// wide and 13.3 percent tall, against the stated 70 and 36: the
// stated frame 360 box does not reproduce from the pixels. The
// winged figure spans nearly the full width (wings outstretched)
// and is short (head to feet 170 px of 1280). No tolerance bridges
// a 23 point gap on both shares, so --expect 70,36 fails on frame
// 360 with exit 1. That is a wrong Stage 1 fact, not a tool miss:
// the number is stable across thresholds 30 to 60 and across both
// background models (per-row median reads 100.0 percent wide, same
// 13.3 percent tall). See units/K/tool-report.md.
//
// Verdict rule: PASS when a subject component is found and, when
// --expect is given, both shares sit within --tolerance points of
// the expected shares. FAIL when no subject is found or when an
// expected share is missed. The default tolerance is 5 points:
// S1 reproduces to 0.3 points and the frame 360 height is stable
// to 0.0 points across methods, so 5 is generous to the stated
// numbers on the failing dimension.
//
// Mapping of facts into the insight corrections shape:
// - No-subject correction: ours and real are the frame centre with
//   px 0, because no centroid exists. shift_px is zero.
// - Expect-miss correction: ours is the measured box centroid with
//   the measured pixel count, real is the centre of an expected
//   box of the expected shares placed at the measured centroid
//   with the expected pixel count, shift_px is the expected minus
//   measured box width and height in px. The gaps per share are in
//   the fix text and in numbers.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = resolve(REPO_ROOT, "src");
const VENV_PYTHON = resolve(REPO_ROOT, ".venv", "bin", "python");

export const DEFAULT_THRESHOLD = 40;
export const DEFAULT_TOLERANCE = 5;
export const DEFAULT_FPS = 60;
export const STEP_JUMP_MAX = 20;
export const MIN_COMPONENT_PX = 50;

export const USAGE = [
  "hme composition: Measure the subject box of one frame: box share, margins, thirds position, and eye placement.",
  "",
  "Usage: hme composition <frame.png> [--threshold <n>] [--at-s <n>] [--fps <n>] [--expect <w_pct,h_pct>] [--tolerance <n>] [--out <report.json>]",
  "",
  "Arguments:",
  "  <frame.png>  One frame image (PNG).",
  "",
  "Options:",
  "  --threshold <n>  RGB distance from the row background that counts as subject. Default 40.",
  "  --at-s <n>  Time in seconds of the frame. When absent, it is derived from the frame name: frame-360.png means frame 360 at --fps, real-7s.png means 7 s.",
  "  --fps <n>  Frames per second for a frame-N name. Default 60.",
  "  --expect <w_pct,h_pct>  Expected box shares in percent, for example 70,36. When given, the verdict is PASS only when both measured shares sit within --tolerance points of these.",
  "  --tolerance <n>  Allowed gap in percentage points between a measured share and its expected share. Default 5.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Proof: on batch 1 S1 the tool reads 45.3 percent wide, 68.3 percent tall, within 0.3 points of the stated 45 and 68. On real frame 360 the tool reads 93.9 percent wide, 13.3 percent tall, against the stated 70 and 36, so --expect 70,36 fails on frame 360. The stated frame 360 box does not reproduce from the pixels; see units/K/tool-report.md.",
  "Verdict: PASS when a subject component is found and, when --expect is given, both shares sit within --tolerance points of the expected shares. FAIL when no subject is found or an expected share is missed.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

function roundTo(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function roundFrac(value) {
  return roundTo(value, 3);
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

export function parseExpect(text) {
  const parts = text.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 2 || parts.some((p) => !Number.isFinite(p) || p <= 0 || p > 100)) return null;
  return { width_pct: parts[0], height_pct: parts[1] };
}

// The Python driver. It loads the PNG, picks the background model
// from the band medians, segments the subject, and prints exactly
// one JSON object to stdout. Progress goes to stderr. Connected
// components come from checker.dimensions, reused, not rewritten.
const DRIVER = `
import json
import sys
sys.path.insert(0, sys.argv[3])
import numpy as np
from PIL import Image
from scipy import ndimage
from checker import dimensions

FRAME = sys.argv[1]
THRESHOLD = float(sys.argv[2])

im = np.array(Image.open(FRAME).convert("RGB")).astype(np.float64)
h, w, _ = im.shape
bands = []
for i in range(10):
    y0 = i * h // 10
    y1 = (i + 1) * h // 10
    bands.append(np.median(im[y0:y1].reshape(-1, 3), axis=0))
jumps = [float(np.max(np.abs(bands[i + 1] - bands[i]))) for i in range(9)]
largest_step = max(jumps) if jumps else 0.0
if largest_step <= 20:
    branch = "linear-sky"
    ys = np.arange(h)
    top, bottom = bands[0], bands[-1]
    bg = np.stack([top[c] + (bottom[c] - top[c]) * ys / (h - 1) for c in range(3)], axis=1)[:, None, :]
else:
    branch = "per-row-median"
    bg = np.median(im, axis=1, keepdims=True)
dist = np.sqrt(((im - bg) ** 2).sum(axis=2))
mask = dist > THRESHOLD
comps = dimensions.components(mask, min_n=50, top=6)
subject_pixels = int(mask.sum())

# Head top: the topmost pixel of the largest component inside the
# central third of its own x range. Wings or raised arms crossing
# that band read as the head top; the report states this limit.
head_top_y = None
head_top_x = None
if comps:
    lab, _ = ndimage.label(mask)
    b0 = comps[0]["bbox"]
    target = None
    for k in range(1, int(lab.max()) + 1):
        yy, xx = np.where(lab == k)
        if len(xx) == 0:
            continue
        if int(xx.min()) == b0[0] and int(yy.min()) == b0[1] and int(xx.max()) + 1 == b0[2] and int(yy.max()) + 1 == b0[3]:
            target = k
            break
    if target is not None:
        yy, xx = np.where(lab == target)
        third_w = (b0[2] - b0[0]) / 3
        lo = b0[0] + third_w
        hi = b0[2] - third_w
        keep = (xx >= lo) & (xx < hi)
        if keep.any():
            head_top_y = int(yy[keep].min())
            head_top_x = int(xx[keep][yy[keep].argmin()])

print(json.dumps({
    "shape": [h, w, 3],
    "background": {
        "branch": branch,
        "largest_band_step": round(largest_step, 1),
        "step_bar": 20,
        "threshold": THRESHOLD,
        "top_band_median": [round(float(v), 1) for v in bands[0]],
        "bottom_band_median": [round(float(v), 1) for v in bands[-1]],
    },
    "subject_pixels": subject_pixels,
    "subject_frac": round(subject_pixels / (h * w), 4),
    "components": comps,
    "head_top": {"x": head_top_x, "y": head_top_y},
}))
`;

// The thirds a value sits in: 0, 1, or 2 for the three bands split
// at 1/3 and 2/3.
function thirdBand(frac) {
  if (frac < 1 / 3) return 0;
  if (frac < 2 / 3) return 1;
  return 2;
}

function nearestThirdsLine(frac) {
  const lines = [1 / 3, 2 / 3];
  let best = lines[0];
  for (const line of lines) {
    if (Math.abs(frac - line) < Math.abs(frac - best)) best = line;
  }
  return { line: roundFrac(best), distance: roundFrac(Math.abs(frac - best)) };
}

export function measureComposition(measured) {
  const [h, w] = measured.shape;
  const comps = measured.components;
  if (!comps || comps.length === 0) return null;
  const top = comps[0];
  const [x0, y0, x1, y1] = top.bbox;
  const boxW = x1 - x0;
  const boxH = y1 - y0;
  const [cx, cy] = top.centroid;
  const widthPct = roundTo((boxW / w) * 100, 1);
  const heightPct = roundTo((boxH / h) * 100, 1);
  const cxFrac = roundFrac(cx / w);
  const cyFrac = roundFrac(cy / h);
  const headTop = measured.head_top || { x: null, y: null };
  return {
    frame: { width: w, height: h },
    background: measured.background,
    subject_pixels: measured.subject_pixels,
    subject_frac: measured.subject_frac,
    components: comps.map((c) => {
      const [ax0, ay0, ax1, ay1] = c.bbox;
      return {
        pixels: c.n,
        box: { x0: ax0, y0: ay0, x1: ax1, y1: ay1, width: ax1 - ax0, height: ay1 - ay0 },
        width_pct: roundTo(((ax1 - ax0) / w) * 100, 1),
        height_pct: roundTo(((ay1 - ay0) / h) * 100, 1),
        centroid: { x: c.centroid[0], y: c.centroid[1], x_frac: roundFrac(c.centroid[0] / w), y_frac: roundFrac(c.centroid[1] / h) },
      };
    }),
    box: { x0, y0, x1, y1, width: boxW, height: boxH },
    share: { width_pct: widthPct, height_pct: heightPct },
    margins: {
      left_px: x0,
      right_px: w - x1,
      top_px: y0,
      bottom_px: h - y1,
      left_frac: roundFrac(x0 / w),
      right_frac: roundFrac((w - x1) / w),
      top_frac: roundFrac(y0 / h),
      bottom_frac: roundFrac((h - y1) / h),
    },
    thirds: {
      centroid_cell: { column: thirdBand(cxFrac), row: thirdBand(cyFrac) },
      centroid_cell_name: ["left", "centre", "right"][thirdBand(cxFrac)] + "-" + ["top", "middle", "bottom"][thirdBand(cyFrac)],
      nearest_vertical_line: nearestThirdsLine(cxFrac),
      nearest_horizontal_line: nearestThirdsLine(cyFrac),
      box_columns: [thirdBand(x0 / w), thirdBand((x1 - 1) / w)],
      box_rows: [thirdBand(y0 / h), thirdBand((y1 - 1) / h)],
    },
    eye: {
      focal: { x: cx, y: cy, x_frac: cxFrac, y_frac: cyFrac },
      focal_note: "Focal point is the subject centroid: the point the eye lands on for a symmetric subject. It is the headline eye placement.",
      head_top: { x: headTop.x, y: headTop.y, y_frac: headTop.y === null ? null : roundFrac(headTop.y / h) },
      head_top_note: "Head top is the topmost pixel of the subject inside the central third of its own x range. Wings or raised arms crossing that band read as the head top, not the skull.",
      box_top_frac: roundFrac(y0 / h),
    },
  };
}

export function checkExpect(composition, expect, tolerance) {
  if (!composition) return null;
  const gapW = roundTo(composition.share.width_pct - expect.width_pct, 1);
  const gapH = roundTo(composition.share.height_pct - expect.height_pct, 1);
  return {
    expected: expect,
    tolerance_pct_points: tolerance,
    measured: { ...composition.share },
    gap: { width_pct_points: gapW, height_pct_points: gapH },
    width_pass: Math.abs(gapW) <= tolerance,
    height_pass: Math.abs(gapH) <= tolerance,
    pass: Math.abs(gapW) <= tolerance && Math.abs(gapH) <= tolerance,
  };
}

export function buildCorrections(composition, proof, { atS, frame, expect }) {
  const corrections = [];
  if (!composition) {
    corrections.push({
      element: "subject",
      kind: "composition",
      at_s: atS,
      ours: { x: 0, y: 0, px: 0 },
      real: { x: 0, y: 0, px: 0 },
      shift_px: { dx: 0, dy: 0 },
      fix: "No subject component was found: no connected group of pixels over the distance threshold. The frame may be plain background, or the threshold may be too high for a pale subject. Lower --threshold and re-run. Ours and real are the frame centre with px 0, because no centroid exists there.",
      source: `hme composition, ${basename(frame)}`,
    });
    return corrections;
  }
  if (proof && !proof.pass) {
    const [h, w] = [composition.frame.height, composition.frame.width];
    const expW = Math.round((expect.width_pct / 100) * w);
    const expH = Math.round((expect.height_pct / 100) * h);
    const expPx = Math.round((expect.width_pct / 100) * (expect.height_pct / 100) * w * h);
    const cx = composition.eye.focal.x;
    const cy = composition.eye.focal.y;
    const failed = [];
    if (!proof.width_pass) failed.push(`width ${composition.share.width_pct} percent against expected ${expect.width_pct}, gap ${proof.gap.width_pct_points} points`);
    if (!proof.height_pass) failed.push(`height ${composition.share.height_pct} percent against expected ${expect.height_pct}, gap ${proof.gap.height_pct_points} points`);
    corrections.push({
      element: "subject",
      kind: "composition",
      at_s: atS,
      ours: { x: cx, y: cy, px: composition.subject_pixels },
      real: { x: cx, y: cy, px: expPx },
      shift_px: { dx: expW - composition.box.width, dy: expH - composition.box.height },
      fix: `Subject box does not match the expected shares. Measured ${failed.join("; ")}, tolerance ${proof.tolerance_pct_points} points. Expected box would be ${expW} by ${expH} px at this frame size. shift_px here is the expected minus measured box width and height in px, not a move. Check the expected numbers against the pixels before changing the tool: on frame 360 the stated 70 by 36 does not match the winged figure, which spans 93.9 percent wide and 13.3 percent tall.`,
      source: `hme composition, ${basename(frame)}`,
    });
  }
  return corrections;
}

export function buildInsightReport(measured, composition, proof, { frame, atS, atSFrom, threshold, expect, tolerance, outPath }) {
  const corrections = buildCorrections(composition, proof, { atS, frame, expect });
  const status = corrections.length === 0 ? "PASS" : "FAIL";
  const failedBar = status === "PASS"
    ? null
    : !composition
      ? "Subject found"
      : "Subject found and both box shares within tolerance of the expected shares";
  const detail = !composition
    ? "No subject component was found in the frame."
    : proof
      ? proof.pass
        ? `Subject box is ${composition.share.width_pct} percent wide and ${composition.share.height_pct} percent tall, within ${tolerance} points of the expected ${expect.width_pct} by ${expect.height_pct}.`
        : `Subject box is ${composition.share.width_pct} percent wide and ${composition.share.height_pct} percent tall, against the expected ${expect.width_pct} by ${expect.height_pct}: width gap ${proof.gap.width_pct_points} points, height gap ${proof.gap.height_pct_points} points, tolerance ${tolerance}.`
      : `Subject box is ${composition.share.width_pct} percent wide and ${composition.share.height_pct} percent tall. No expected shares were given, so the verdict is measurement only.`;
  const meaning = composition
    ? `Subject box is ${composition.box.width} by ${composition.box.height} px in a ${composition.frame.width} by ${composition.frame.height} frame: ${composition.share.width_pct} percent wide, ${composition.share.height_pct} percent tall. Margins are left ${composition.margins.left_frac}, right ${composition.margins.right_frac}, top ${composition.margins.top_frac}, bottom ${composition.margins.bottom_frac} of the frame. The focal point (subject centroid) sits at (${composition.eye.focal.x_frac}, ${composition.eye.focal.y_frac}) of the frame, in the ${composition.thirds.centroid_cell_name} cell, nearest the vertical thirds line at ${composition.thirds.nearest_vertical_line.line} (distance ${composition.thirds.nearest_vertical_line.distance}) and the horizontal thirds line at ${composition.thirds.nearest_horizontal_line.line} (distance ${composition.thirds.nearest_horizontal_line.distance}). Head top is at ${composition.eye.head_top.y_frac} of frame height. Background model is ${composition.background.branch} (largest band step ${composition.background.largest_band_step} levels, bar ${composition.background.step_bar}).`
    : "No subject component was found, so no box, margins, thirds, or eye numbers exist.";
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      at_s: atS,
      at_s_source: atSFrom,
      frame,
      method: "Background first: 10 horizontal band medians. Largest adjacent-band jump at most 20 levels means a smooth sky, so the background at row y is the straight line from the top band median to the bottom band median. A larger jump means a stepped sky, so the background at row y is that row median. A pixel counts as subject when its Euclidean RGB distance from its row background is over --threshold (default 40). The subject is the largest connected component from dimensions.components (src/checker), reused. Margins are the box edges to the frame edges. Thirds lines sit at 1/3 and 2/3 of width and height. Eye placement is the subject centroid (focal point) plus the head top, the topmost subject pixel inside the central third of the box x range.",
      threshold,
      composition,
      proof,
    },
    corrections,
    context: {
      thresholds: {
        distance_threshold: threshold,
        step_jump_max: STEP_JUMP_MAX,
        step_rule: "Largest adjacent-band median jump at most 20 levels means a smooth sky (linear background); over 20 means a stepped sky (per-row median background). The bar is the gradient tool step bar, set from frame 360 at 11 and batch 1 S1 at 168.",
        tolerance_pct_points: tolerance,
        expect_rule: "When --expect is given, both measured shares must sit within --tolerance points of the expected shares. Default tolerance 5 points: S1 reproduces to 0.3 points and the frame 360 height is stable to 0.0 points across methods, so 5 is generous on the failing dimension.",
        proof_basis: "Batch 1 S1 measures 45.3 percent wide, 68.3 percent tall, against the stated 45 and 68. Real frame 360 measures 93.9 percent wide, 13.3 percent tall, against the stated 70 and 36. The frame 360 gaps are 23.9 and 22.7 points, far outside any tolerance the S1 exactness justifies.",
      },
      control_ceiling: null,
      meaning,
    },
    next: "hme composition <batch-2-frame.png> --expect <w,h> --out out/composition.json",
    limits: [
      "One frame is one moment. It cannot see motion, fades, or timing.",
      "The subject is the largest connected component. When a subject is split by a background-coloured gap, as the batch 1 ant is into two side components, the largest piece understates the whole; the components list shows the pieces.",
      "The head top is the topmost subject pixel in the central third of the box. Wings or raised arms crossing that band read as the head top, not the skull.",
      "The background models assume the background is a smooth vertical gradient or a per-row flat colour. A busy background with no dominant row colour defeats both.",
      "A pale subject close to the sky colour (distance under the threshold) is missed. Lower --threshold and re-run when the subject is pale.",
      "The tool measures the box that is there. It does not say which box the subject should have; compare the numbers against the real frame.",
    ],
  };
}

function runDriver(framePath, threshold) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", framePath, String(threshold), SRC_DIR], {
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
        rejectPromise(new Error(`composition measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`composition measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Run `hme composition <frame.png> [--threshold <n>] [--at-s <n>] [--fps <n>] [--expect <w_pct,h_pct>] [--tolerance <n>] [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runComposition(argv) {
  const positionals = [];
  let threshold = DEFAULT_THRESHOLD;
  let atS = null;
  let fps = DEFAULT_FPS;
  let expect = null;
  let tolerance = DEFAULT_TOLERANCE;
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threshold") {
      if (i + 1 >= argv.length) {
        console.error("hme composition: --threshold needs a number");
        console.error(USAGE);
        return 2;
      }
      threshold = Number(argv[++i]);
      if (!Number.isFinite(threshold) || threshold <= 0) {
        console.error("hme composition: --threshold needs a positive number");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--at-s") {
      if (i + 1 >= argv.length) {
        console.error("hme composition: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
      atS = Number(argv[++i]);
      if (!Number.isFinite(atS)) {
        console.error("hme composition: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--fps") {
      if (i + 1 >= argv.length) {
        console.error("hme composition: --fps needs a number");
        console.error(USAGE);
        return 2;
      }
      fps = Number(argv[++i]);
      if (!Number.isFinite(fps) || fps <= 0) {
        console.error("hme composition: --fps needs a positive number");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--expect") {
      if (i + 1 >= argv.length) {
        console.error("hme composition: --expect needs w_pct,h_pct");
        console.error(USAGE);
        return 2;
      }
      expect = parseExpect(argv[++i]);
      if (!expect) {
        console.error("hme composition: bad --expect, want w_pct,h_pct with each from 0 to 100, for example 70,36");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--tolerance") {
      if (i + 1 >= argv.length) {
        console.error("hme composition: --tolerance needs a number");
        console.error(USAGE);
        return 2;
      }
      tolerance = Number(argv[++i]);
      if (!Number.isFinite(tolerance) || tolerance < 0) {
        console.error("hme composition: --tolerance needs a number of 0 or more");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme composition: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme composition: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme composition: needs one frame, <frame.png>");
    console.error(USAGE);
    return 2;
  }
  const [frameArg] = positionals;
  const framePath = resolve(frameArg);
  if (!existsSync(framePath)) {
    console.error(`hme composition: no such file: ${frameArg}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme composition: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  let atSFrom;
  if (atS === null) {
    atS = parseAtS(frameArg, fps);
    if (atS === null) {
      console.error("hme composition: cannot tell the seconds from the frame name; pass --at-s <n>");
      console.error(USAGE);
      return 2;
    }
    atSFrom = `derived from the frame name at ${fps} fps`;
  } else {
    atSFrom = "--at-s flag";
  }
  try {
    const measured = await runDriver(framePath, threshold);
    const composition = measureComposition(measured);
    const proof = expect ? checkExpect(composition, expect, tolerance) : null;
    const report = buildInsightReport(measured, composition, proof, {
      frame: frameArg, atS, atSFrom, threshold, expect, tolerance, outPath,
    });
    return writeInsightReport(report, outPath);
  } catch (err) {
    console.error(`hme composition: ${err.message}`);
    return 2;
  }
}
