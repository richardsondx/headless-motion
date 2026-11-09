// hme type: measure letterforms in two labels, not just the ink box.
//
// T1 builds the command framework only: argument parsing, help text,
// default frame sets, and the insight report shape. The measurement
// core lands in T2, so a real measurement run stops here with
// "not implemented yet" and exit code 2. That stop is by design, not
// a crash: no stack trace, exit code 2.
//
// Method, from the Stage 1 predicate (stage1-type-meter-2026-11-08-02,
// section 3) and the first-principles ladder:
// - Two labels: the October 2025 title and the EL FASHER label.
// - Frame files in each dir are matched by frame number, so no Seg4
//   file names are hardcoded. In one dir holding both sides the ref
//   side takes ref- files and the ours side takes the other prefix.
// - --trace is required. It supplies the two label boxes
//   (labels.october_2025.bbox_1920x1080 and
//   labels.el_fasher.bbox_1920x1080) and the dot centre
//   (labels.el_fasher_dot.centre_1920x1080).
// - --scene is optional. It supplies scene element ids and sizes so
//   corrections can be named in scene terms.
// - Ink is adaptive in T2: a pixel brighter than its local background
//   median by 40. The fixed 180 numbers are reported too, only for
//   the U9 reproduction check.
// - Per label the report holds per-letter overlap (mean IoU and worst
//   letter), letter spacing (median gap in px and over cap height,
//   plus the full per-pair gap list), stroke weight (px and over cap
//   height), and anti-aliasing (edge transition width in px plus the
//   U9 fraction with its caveat).
// - Verdict rule: PASS means the measurement completed for both
//   labels (counts matched, IoU computed, corrections named). FAIL
//   means a label could not be measured (present False on either side
//   after adaptive ink, or a count mismatch refusing pairing), with
//   failed_bar naming the reason.
// - T2 wires in the measurement core: Node resolves frame files by
//   number (the T1 "paired by sorted index" note cannot work when
//   both dirs are the same path, which is the Seg4 invocation, so
//   files are matched by their frame number, with the ref side
//   preferring "ref-" names and the ours side preferring the other
//   prefix in a mixed dir), then spawns the engine venv Python,
//   which runs checker.type_meter (it calls dimensions.type_metrics
//   for the fixed 180 reproduction and ports the same formulas for
//   the adaptive numbers). The driver prints exactly one JSON object
//   to stdout, progress to stderr, the contour pattern.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = resolve(REPO_ROOT, "src");
const VENV_PYTHON = resolve(REPO_ROOT, ".venv", "bin", "python");

// Fade sampling frames for the October title, both sides. The fade
// is read off adaptive ink on the trace box, so it needs frames
// across the title's life, not just the full ones.
export const FADE_FRAMES = [0, 12, 24, 36, 48, 60, 72];

export const LABELS = ["october", "el-fasher"];

// Default frame sets: the Seg4 proof plan. EL FASHER uses frames 156,
// 168, 180 on both sides. October ref uses frames 12 and 24, October
// ours uses frames 24 and 36, because the title fades out while
// EL FASHER fades in. No single frame serves both labels.
export const DEFAULT_FRAMES = {
  october: { ref: [12, 24], ours: [24, 36] },
  "el-fasher": { ref: [156, 168, 180], ours: [156, 168, 180] },
};

export const USAGE = [
  "hme type: Measure letterforms in two labels: the October 2025 title and the EL FASHER label.",
  "",
  "Usage: hme type <ref-frames-dir> <ours-frames-dir> --trace <trace.json> [--scene <scene.json>] [--frames <label:side:list>] [--out <report.json>]",
  "",
  "Arguments:",
  "  <ref-frames-dir>   Directory of reference frames.",
  "  <ours-frames-dir>  Directory of our rendered frames. Frame files are matched by their frame number (ref-0156.png is frame 156). In one dir holding both sides, the ref side takes ref- files and the ours side takes the other prefix.",
  "",
  "Options:",
  "  --trace <file>  Path to the trace JSON. Required. It supplies the two label boxes and the El Fasher dot centre.",
  "  --scene <file>  Path to the scene file. It supplies scene element ids and sizes for corrections.",
  "  --frames <label:side:list>  Frame set for one label, for example el-fasher:156,168,180 or october:ref:12,24. Repeatable. With two parts the list applies to both sides; with three parts the side is ref or ours.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Defaults (Seg4 proof plan):",
  "  EL FASHER 156, 168, 180 on both sides.",
  "  October ref 12, 24; October ours 24, 36.",
  "",
  "Report fields: verdict (PASS or FAIL, with failed_bar naming the reason), numbers (per-letter overlap, spacing, stroke, and anti-aliasing per label, plus per-pair kerning gaps), corrections (in scene terms), context (thresholds, control ceiling, meaning), next (one command), limits.",
  "",
  "Verdict rule: PASS means the measurement completed for both labels (counts matched, IoU computed, corrections named). FAIL means a label could not be measured (present False on either side after adaptive ink, or a count mismatch refusing pairing).",
  "",
  "Exit codes: 0 PASS, 1 FAIL, 2 usage error or not implemented yet.",
].join("\n") + "\n";

function cloneFrames(frames) {
  return {
    october: { ref: [...frames.october.ref], ours: [...frames.october.ours] },
    "el-fasher": { ref: [...frames["el-fasher"].ref], ours: [...frames["el-fasher"].ours] },
  };
}

function parseFrameList(listText) {
  const parts = listText.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) throw new Error("frame list is empty");
  const frames = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error(`"${part}" is not a frame number`);
    frames.push(Number(part));
  }
  return [...new Set(frames)].sort((a, b) => a - b);
}

// Parse one --frames spec into the frame sets it changes.
// Two parts set both sides: "el-fasher:156,168,180".
// Three parts set one side: "october:ref:12,24" or "october:ours:24,36".
// Returns a new frame-sets object; the input is not changed.
export function parseFramesSpec(spec, frames = DEFAULT_FRAMES) {
  const out = cloneFrames(frames);
  const parts = spec.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`bad --frames spec "${spec}": use label:list or label:side:list`);
  }
  const label = parts[0];
  if (!LABELS.includes(label)) {
    throw new Error(`bad --frames label "${label}": use october or el-fasher`);
  }
  const listText = parts[parts.length - 1];
  const list = parseFrameList(listText);
  if (parts.length === 2) {
    out[label].ref = list;
    out[label].ours = list;
  } else {
    const side = parts[1];
    if (side !== "ref" && side !== "ours") {
      throw new Error(`bad --frames side "${side}": use ref or ours`);
    }
    out[label][side] = list;
  }
  return out;
}

// Apply every --frames spec in order, starting from the defaults.
export function resolveFrames(specs) {
  let frames = cloneFrames(DEFAULT_FRAMES);
  for (const spec of specs) frames = parseFramesSpec(spec, frames);
  return frames;
}

function labelNumbers(label) {
  if (!label) return null;
  if (!label.measured) return { measured: false, reason: label.reason || "label was not measured" };
  // Per-side values come through as {ref, ours} objects when the
  // measurement ran; a flat value passes through unchanged, which
  // keeps the T1 shape fixtures valid.
  const sideOr = (ref, ours, flat) =>
    (ref !== undefined && ours !== undefined ? { ref, ours } : flat);
  const out = {
    measured: true,
    letters_ref: label.lettersRef,
    letters_ours: label.lettersOurs,
    mean_iou: label.meanIou,
    worst_letter: label.worstLetter,
    worst_iou: label.worstIou,
    gap_median_px: sideOr(label.gapMedianPxRef, label.gapMedianPxOurs, label.gapMedianPx),
    gap_over_cap_height: sideOr(label.gapOverCapHeightRef, label.gapOverCapHeightOurs, label.gapOverCapHeight),
    gaps_px: sideOr(label.gapsPxRef, label.gapsPxOurs, label.gapsPx),
    stroke_px: sideOr(label.strokePxRef, label.strokePxOurs, label.strokePx),
    stroke_over_cap_height: sideOr(label.strokeOverCapHeightRef, label.strokeOverCapHeightOurs, label.strokeOverCapHeight),
    stroke_note: label.strokeNote || null,
    aa_transition_px: sideOr(label.aaTransitionPxRef, label.aaTransitionPxOurs, label.aaTransitionPx),
    aa_fraction: sideOr(label.aaFractionRef, label.aaFractionOurs, label.aaFraction),
    cap_height_px: sideOr(label.capHeightPxRef, label.capHeightPxOurs, label.capHeightPx),
    frames_ref: label.framesRef,
    frames_ours: label.framesOurs,
  };
  // T2 extras, only when the measurement supplied them.
  if (label.overlap !== undefined) out.overlap = label.overlap;
  if (label.fade !== undefined) out.fade = label.fade;
  if (label.perFrame !== undefined) out.per_frame = label.perFrame;
  if (label.present !== undefined) out.present = label.present;
  if (label.inkPx !== undefined) out.ink_px = label.inkPx;
  if (label.backgroundMedian !== undefined) out.background_median = label.backgroundMedian;
  if (label.capHeightRatio !== undefined) out.cap_height_ratio = label.capHeightRatio;
  if (label.centroidShiftPx !== undefined) out.centroid_shift_px = label.centroidShiftPx;
  if (label.aaTransitionNote !== undefined) out.aa_transition_note = label.aaTransitionNote;
  if (label.fullestFrame !== undefined) out.fullest_frame = label.fullestFrame;
  return out;
}

// Build the insight report from measured labels. Pure function, so
// T2 fills in the measurement and this shape stays fixed. Each label
// is null when it was not measured, or an object with measured true
// and the numbers, or an object with measured false and a reason.
// corrections defaults to [] and is filled in by T3. reproduction
// is the fixed 180 U9 check, or null when it was not run.
export function buildInsightReport({ refDir, oursDir, tracePath, scenePath, frames, october, elFasher, corrections = [], reproduction = null }) {
  const failures = [];
  for (const [name, label] of [["october", october], ["el-fasher", elFasher]]) {
    if (!label || !label.measured) {
      const reason = label && label.reason ? label.reason : "label was not measured";
      failures.push(`${name} label could not be measured: ${reason}`);
    } else if (label.lettersRef !== label.lettersOurs) {
      failures.push(`${name} letter counts differ: ref ${label.lettersRef}, ours ${label.lettersOurs}, so no pairing`);
    }
  }
  const passed = failures.length === 0;
  const detail = passed
    ? `Both labels measured: October mean IoU ${october.meanIou}, EL FASHER mean IoU ${elFasher.meanIou}.`
    : failures.join(" ");
  return {
    verdict: {
      status: passed ? "PASS" : "FAIL",
      failed_bar: passed ? null : failures[0],
      detail,
    },
    numbers: {
      ref_frames_dir: refDir,
      ours_frames_dir: oursDir,
      trace: tracePath,
      scene: scenePath || null,
      frames: {
        october: { ref: frames.october.ref, ours: frames.october.ours },
        "el-fasher": { ref: frames["el-fasher"].ref, ours: frames["el-fasher"].ours },
      },
      labels: {
        october: labelNumbers(october),
        "el-fasher": labelNumbers(elFasher),
      },
      ...(reproduction !== null ? { reproduction_fixed180: reproduction } : {}),
    },
    corrections,
    context: {
      thresholds: {
        adaptive_ink_delta: 40,
        fixed_threshold_reproduction: 180,
      },
      control_ceiling: null,
      meaning: passed
        ? "Per-letter overlap, spacing, stroke, and anti-aliasing are measured for both labels, so the numbers say how the letterforms differ, not just where the ink box sits."
        : "One label could not be measured, so the report holds counts and reasons instead of a comparison for that label.",
    },
    next: `hme type ${refDir} ${oursDir} --trace ${tracePath}`,
    limits: [
      "EL FASHER stroke under 1 px is not resolvable, so its stroke number is a bound, not a precise width.",
      "The anti-aliasing fraction alone says little; the edge transition width is the comparison.",
      "Frames are per label, not one set: EL FASHER uses 156, 168, 180, October ref uses 12 or 24, October ours uses 24 or 36.",
      "No correction is named from a number whose uncertainty covers it.",
    ],
  };
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Map frame numbers to file paths in one frames dir, for one side.
//
// Files are named <prefix>-NNNN.png, for example ref-0156.png and
// v5-0156.png. The frame number is parsed from the name, so the two
// dirs need not hold the same files in the same order. In a mixed
// dir (both dirs are the same path in the Seg4 invocation) the ref
// side takes the "ref-" files and the ours side takes the other
// prefix; in a single-prefix dir both sides take all files, and
// when the preferred set is empty the side falls back to all files.
// Returns a Map from frame number to absolute path.
export function frameFileMap(dir, side) {
  const names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".png"));
  const byNumber = new Map();
  const prefixes = new Set();
  for (const name of names) {
    const m = name.match(/^(.*?)-(\d+)\.png$/i);
    if (!m) continue;
    prefixes.add(m[1]);
    const num = Number(m[2]);
    if (!byNumber.has(num)) byNumber.set(num, new Map());
    byNumber.get(num).set(m[1], resolve(dir, name));
  }
  const out = new Map();
  for (const [num, perPrefix] of byNumber) {
    let pick = null;
    if (side === "ref" && perPrefix.has("ref")) pick = perPrefix.get("ref");
    else if (side === "ours" && prefixes.has("ref") && perPrefix.size > 1) {
      for (const [prefix, path] of perPrefix) {
        if (prefix !== "ref") { pick = path; break; }
      }
    }
    if (pick === null) {
      pick = perPrefix.values().next().value;
    }
    out.set(num, pick);
  }
  return out;
}

// The Python driver. It reads the config JSON from argv, runs
// checker.type_meter.measure, and prints exactly one JSON object to
// stdout. Progress goes to stderr.
const DRIVER = `
import json
import sys
sys.path.insert(0, sys.argv[2])
from checker import type_meter
config = json.loads(sys.argv[1])
print(json.dumps(type_meter.measure(config)))
`;

function runDriver(config) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", JSON.stringify(config), SRC_DIR], {
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
        rejectPromise(new Error(`type measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`type measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Convert one measured label from checker.type_meter into the shape
// buildInsightReport takes. A label with no fullest frame on a side
// is unmeasured, with the reason naming the side and the ink.
export function labelFromMeasured(measured, frames) {
  if (!measured) return { measured: false, reason: "label was not measured" };
  const ref = measured.ref || {};
  const ours = measured.ours || {};
  if (!ref.measured || !ours.measured) {
    const bad = !ref.measured ? "ref" : "ours";
    const reason = (ref.measured ? ours : ref).reason
      || `present False on the ${bad} side after adaptive ink`;
    return { measured: false, reason };
  }
  const overlap = measured.overlap || { paired: false };
  const paired = overlap.paired === true;
  const strokeNote = "Stroke is twice the median distance transform, so it "
    + "moves in 1 px steps after doubling; an EL FASHER stroke change "
    + "under 1 px is not resolvable.";
  return {
    measured: true,
    lettersRef: measured.letters.ref,
    lettersOurs: measured.letters.ours,
    meanIou: paired ? overlap.mean_iou : null,
    worstLetter: paired ? overlap.worst_letter : null,
    worstIou: paired ? overlap.worst_iou : null,
    gapMedianPxRef: ref.gap_median_px,
    gapMedianPxOurs: ours.gap_median_px,
    gapOverCapHeightRef: ref.gap_over_cap_height,
    gapOverCapHeightOurs: ours.gap_over_cap_height,
    gapsPxRef: ref.gaps_px,
    gapsPxOurs: ours.gaps_px,
    strokePxRef: ref.stroke_px,
    strokePxOurs: ours.stroke_px,
    strokeOverCapHeightRef: ref.stroke_over_cap_height,
    strokeOverCapHeightOurs: ours.stroke_over_cap_height,
    strokeNote,
    aaTransitionPxRef: ref.aa_transition_px,
    aaTransitionPxOurs: ours.aa_transition_px,
    aaFractionRef: ref.aa_fraction,
    aaFractionOurs: ours.aa_fraction,
    capHeightPxRef: ref.cap_height_px,
    capHeightPxOurs: ours.cap_height_px,
    framesRef: frames.ref,
    framesOurs: frames.ours,
    overlap,
    fade: measured.fade || null,
    perFrame: measured.per_frame,
    present: measured.present,
    inkPx: { ref: ref.ink_px, ours: ours.ink_px },
    backgroundMedian: { ref: ref.background_median, ours: ours.background_median },
    capHeightRatio: paired ? overlap.cap_height_ratio : null,
    centroidShiftPx: paired ? overlap.centroid_shift_px : null,
    aaTransitionNote: "Edge transition width is the headline AA number. "
      + "The U9 fraction counts erosion edge pixels with luma 40 to 200, "
      + "so it reads 1.0 when the glyph itself is mid grey, and it counts "
      + "halo pixels under adaptive ink; EL FASHER frame spread is the "
      + "uncertainty.",
    fullestFrame: measured.fullest_frame,
  };
}

// Find the scene text node for a label text, or null. The scene
// carries the element ids and font sizes the corrections name.
export function sceneTextNode(scene, text) {
  if (!scene || !Array.isArray(scene.nodes)) return null;
  for (const node of scene.nodes) {
    if (node && node.type === "text" && node.props && node.props.text === text) {
      return node;
    }
  }
  return null;
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fullestEntry(measured, label, side) {
  const frame = measured.labels[label].fullest_frame[side];
  if (frame === null || frame === undefined) return null;
  return measured.labels[label].per_frame[side].find((e) => e.frame === frame) || null;
}

function labelCentroid(entry) {
  if (!entry || !Array.isArray(entry.centroids) || entry.centroids.length === 0) return null;
  const xs = entry.centroids.map((c) => c[0]);
  const ys = entry.centroids.map((c) => c[1]);
  return {
    x: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10,
    y: Math.round(ys.reduce((a, b) => a + b, 0) / ys.length * 10) / 10,
  };
}

function correctionPoint(entry) {
  const centroid = labelCentroid(entry);
  return {
    x: centroid ? centroid.x : 0,
    y: centroid ? centroid.y : 0,
    px: entry ? entry.ink_px : 0,
  };
}

function shiftBetween(refEntry, oursEntry) {
  const rc = labelCentroid(refEntry);
  const oc = labelCentroid(oursEntry);
  if (!rc || !oc) return { dx: 0, dy: 0 };
  return { dx: Math.round((rc.x - oc.x) * 10) / 10, dy: Math.round((rc.y - oc.y) * 10) / 10 };
}

// Build the scene-term corrections from a measurement and a scene.
// Pure function, so the rules are testable without frames. A
// correction is named only when the number behind it clears its
// uncertainty gate; a number whose uncertainty covers it names
// nothing, and anti-aliasing never names one, because no scene knob
// maps to edge transition width. fontTools is absent from the engine
// venv, so every correction stays in px: no letterSpacing delta
// from font side bearings is promised, and the letterSpacing delta
// below is the gap delta in px, which is what letterSpacing adds.
export function buildCorrections(measured, scene) {
  const corrections = [];
  if (!measured || !measured.labels) return corrections;
  const oct = measured.labels.october;
  const ef = measured.labels["el-fasher"];
  const titleNode = sceneTextNode(scene, "October 2025");
  const fasherNode = sceneTextNode(scene, "EL FASHER");
  const titleId = titleNode ? titleNode.id : "october";
  const fasherId = fasherNode ? fasherNode.id : "el-fasher";
  const titleSpacing = titleNode && titleNode.props && titleNode.props.font
    ? titleNode.props.font.letterSpacing : null;
  const fasherSize = fasherNode && fasherNode.props && fasherNode.props.font
    ? fasherNode.props.font.size : null;

  // October spacing: the median gap differs by far more than the
  // 1 px gap quantisation, on both sides, with 10 pairs each.
  if (oct && oct.ref && oct.ours && oct.ref.measured && oct.ours.measured) {
    const refEntry = fullestEntry(measured, "october", "ref");
    const oursEntry = fullestEntry(measured, "october", "ours");
    const refGap = oct.ref.gap_median_px;
    const oursGap = oct.ours.gap_median_px;
    if (refGap !== null && oursGap !== null && Math.abs(refGap - oursGap) >= 2
        && oct.ref.gaps_px.length >= 3 && oct.ours.gaps_px.length >= 3) {
      const delta = Math.round(refGap - oursGap);
      const from = titleSpacing !== null && titleSpacing !== undefined
        ? ` from ${titleSpacing} to ${titleSpacing + delta}` : "";
      corrections.push({
        element: titleId,
        kind: "text",
        at_s: Math.round(refEntry.frame / 24 * 1000) / 1000,
        ours: correctionPoint(oursEntry),
        real: correctionPoint(refEntry),
        shift_px: shiftBetween(refEntry, oursEntry),
        fix: `Set ${titleId} letterSpacing${from} (increase by ${delta} px) so the median letter gap grows from ${oursGap} px to ${refGap} px. The gap delta is in px; no side-bearing delta is promised.`,
        source: `hme type, October frames ref ${refEntry.frame}, ours ${oursEntry.frame}`,
      });
    }
    // October timing: the title fades out a full sampling step later
    // in ours than in ref.
    if (oct.fade && oct.fade.ref && oct.fade.ours
        && oct.fade.ref.last_visible_frame !== null
        && oct.fade.ours.last_visible_frame !== null
        && Math.abs(oct.fade.ref.last_visible_frame - oct.fade.ours.last_visible_frame) >= 12) {
      const refLast = oct.fade.ref.last_visible_frame;
      const oursLast = oct.fade.ours.last_visible_frame;
      corrections.push({
        element: titleId,
        kind: "timing",
        at_s: Math.round(oursLast / 24 * 1000) / 1000,
        ours: { x: correctionPoint(oursEntry).x, y: correctionPoint(oursEntry).y,
                px: oct.fade.ours.ink_by_frame[String(oursLast)] || 0 },
        real: { x: correctionPoint(refEntry).x, y: correctionPoint(refEntry).y,
                px: oct.fade.ref.ink_by_frame[String(oursLast)] || 0 },
        shift_px: shiftBetween(refEntry, oursEntry),
        fix: `Fade ${titleId} out by frame ${refLast + 12} (it is still visible at frame ${oursLast} in ours while the reference is gone after frame ${refLast}).`,
        source: `hme type, October fade frames ref ${refLast}, ours ${oursLast}`,
      });
    }
    // October stroke: no correction. The stroke difference sits
    // inside the 1 px quantisation band, so no weight or size change
    // is named from it.
  }

  // EL FASHER size and face: the cap height ratio clears 10 percent,
  // and the ref cap is settled (its maximum sits at the last sampled
  // frame over at least 2 frames), so the size is a real difference
  // and not a mid-zoom frame.
  if (ef && ef.ref && ef.ours && ef.ref.measured && ef.ours.measured) {
    const refEntry = fullestEntry(measured, "el-fasher", "ref");
    const oursEntry = fullestEntry(measured, "el-fasher", "ours");
    const capRef = ef.ref.cap_height_px;
    const capOurs = ef.ours.cap_height_px;
    const ratio = capRef && capOurs ? capOurs / capRef : null;
    const refCaps = ef.per_frame.ref.map((e) => e.cap_height_px).filter((v) => v !== null);
    const settled = refCaps.length >= 2
      && refCaps[refCaps.length - 1] === Math.max(...refCaps);
    if (ratio !== null && (ratio < 0.9 || ratio > 1.1) && settled) {
      const newSize = fasherSize !== null && fasherSize !== undefined
        ? Math.round(fasherSize / ratio) : null;
      const sizeText = newSize !== null
        ? ` from ${fasherSize} to ${newSize}` : ` by a factor of ${Math.round(1 / ratio * 100) / 100}`;
      corrections.push({
        element: fasherId,
        kind: "text",
        at_s: Math.round(refEntry.frame / 24 * 1000) / 1000,
        ours: correctionPoint(oursEntry),
        real: correctionPoint(refEntry),
        shift_px: shiftBetween(refEntry, oursEntry),
        fix: `Reduce ${fasherId} font size${sizeText} so the cap height falls from ${capOurs} px to ${capRef} px (ratio ${Math.round(ratio * 100) / 100}).`,
        source: `hme type, EL FASHER frames ref ${refEntry.frame}, ours ${oursEntry.frame}`,
      });
      // Face: at the matched cap height the ours glyphs are narrower
      // than ref by at least 2 px, and the word space is far narrower
      // too, so a size change alone leaves the label too narrow.
      const refWidths = (refEntry.boxes || []).map((b) => b[2] - b[0]);
      const oursWidths = (oursEntry.boxes || []).map((b) => b[2] - b[0]);
      const refMedianWidth = medianOf(refWidths);
      const oursMedianWidth = medianOf(oursWidths);
      if (refMedianWidth !== null && oursMedianWidth !== null) {
        const scaledOurs = oursMedianWidth * (capRef / capOurs);
        if (refMedianWidth - scaledOurs >= 2) {
          const refSpace = ef.ref.gaps_px.length >= 2 ? Math.max(...ef.ref.gaps_px) : null;
          const oursSpace = ef.ours.gaps_px.length >= 2 ? Math.max(...ef.ours.gaps_px) : null;
          const oursSpaceScaled = oursSpace !== null
            ? Math.round(oursSpace * (capRef / capOurs) * 10) / 10 : null;
          corrections.push({
            element: fasherId,
            kind: "text",
            at_s: Math.round(refEntry.frame / 24 * 1000) / 1000,
            ours: correctionPoint(oursEntry),
            real: correctionPoint(refEntry),
            shift_px: shiftBetween(refEntry, oursEntry),
            fix: `Use a wider face for ${fasherId} (hme fonts matched Archivo Narrow; Anton ranks 53rd of 55): at the matched cap height ${capRef} px the ours glyphs are ${Math.round(scaledOurs * 10) / 10} px wide against ref ${refMedianWidth} px, and the word space is ${oursSpaceScaled} px against ref ${refSpace} px. A size change alone leaves the label too narrow.`,
            source: `hme type, EL FASHER frames ref ${refEntry.frame}, ours ${oursEntry.frame}`,
          });
        }
      }
    }
    // EL FASHER stroke: no correction. The stroke-over-cap-height
    // difference sits inside the 1 px quantisation band on both
    // sides, so no weight change is named from it.
  }
  return corrections;
}
// [--scene <scene.json>] [--frames <label:side:list>] [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runType(argv) {
  const positionals = [];
  const frameSpecs = [];
  let tracePath = null;
  let scenePath = null;
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--trace") {
      if (i + 1 >= argv.length) {
        console.error("hme type: --trace needs a file path");
        console.error(USAGE);
        return 2;
      }
      tracePath = argv[++i];
    } else if (a === "--scene") {
      if (i + 1 >= argv.length) {
        console.error("hme type: --scene needs a file path");
        console.error(USAGE);
        return 2;
      }
      scenePath = argv[++i];
    } else if (a === "--frames") {
      if (i + 1 >= argv.length) {
        console.error("hme type: --frames needs a spec like el-fasher:156,168,180");
        console.error(USAGE);
        return 2;
      }
      frameSpecs.push(argv[++i]);
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme type: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme type: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 2) {
    console.error("hme type: needs two frame directories, <ref-frames-dir> and <ours-frames-dir>");
    console.error(USAGE);
    return 2;
  }
  if (tracePath === null) {
    console.error("hme type: --trace <trace.json> is required");
    console.error(USAGE);
    return 2;
  }
  let frames;
  try {
    frames = resolveFrames(frameSpecs);
  } catch (err) {
    console.error(`hme type: ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  const [refArg, oursArg] = positionals;
  const refPath = resolve(refArg);
  const oursPath = resolve(oursArg);
  if (!isDir(refPath)) {
    console.error(`hme type: no such directory: ${refArg}`);
    return 2;
  }
  if (!isDir(oursPath)) {
    console.error(`hme type: no such directory: ${oursArg}`);
    return 2;
  }
  if (!isFile(resolve(tracePath))) {
    console.error(`hme type: no such file: ${tracePath}`);
    return 2;
  }
  if (scenePath !== null && !isFile(resolve(scenePath))) {
    console.error(`hme type: no such file: ${scenePath}`);
    return 2;
  }
  if (!isFile(VENV_PYTHON)) {
    console.error(`hme type: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  // Resolve every frame file by number before measuring, so a missing
  // frame is a usage error, not a half-written report.
  const refMap = frameFileMap(refPath, "ref");
  const oursMap = frameFileMap(oursPath, "ours");
  const pick = (label, side, frameList) => {
    const map = side === "ref" ? refMap : oursMap;
    const out = {};
    for (const frame of frameList) {
      const path = map.get(frame);
      if (!path) {
        return { error: `hme type: no frame ${frame} for ${label} in ${side === "ref" ? refArg : oursArg}` };
      }
      out[frame] = path;
    }
    return { files: out };
  };
  const config = { ref: {}, ours: {}, trace_path: resolve(tracePath), frames };
  for (const label of LABELS) {
    for (const side of ["ref", "ours"]) {
      const got = pick(label, side, frames[label][side]);
      if (got.error) {
        console.error(got.error);
        return 2;
      }
      config[side][label] = got.files;
    }
  }
  const fade = { ref: {}, ours: {} };
  for (const side of ["ref", "ours"]) {
    const got = pick("october", side, FADE_FRAMES);
    if (got.error) {
      console.error(got.error);
      return 2;
    }
    fade[side] = got.files;
  }
  config.fade_frames = fade;
  let measured;
  try {
    measured = await runDriver(config);
  } catch (err) {
    console.error(`hme type: ${err.message}`);
    return 2;
  }
  const october = labelFromMeasured(measured.labels.october, frames.october);
  const elFasher = labelFromMeasured(measured.labels["el-fasher"], frames["el-fasher"]);
  let scene = null;
  if (scenePath !== null) {
    try {
      scene = JSON.parse(readFileSync(resolve(scenePath), "utf8"));
    } catch (err) {
      console.error(`hme type: cannot read scene file ${scenePath}: ${err.message}`);
      return 2;
    }
  }
  const corrections = buildCorrections(measured, scene);
  const report = buildInsightReport({
    refDir: refArg,
    oursDir: oursArg,
    tracePath,
    scenePath,
    frames,
    october,
    elFasher,
    corrections,
    reproduction: measured.reproduction,
  });
  return writeInsightReport(report, outPath ? resolve(outPath) : null);
}
