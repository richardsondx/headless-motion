// hme diagnose: list the corrections for one frame pair, in scene terms.
//
// Promotes src/checker/overlay.py and run-overlay-check.py into a tool
// command. The measurement is Python (src/checker), so this module
// spawns the engine venv Python with a small driver on stdin. Nothing
// here reimplements phase cross-correlation, layer masks, stroke
// counts, or rifle counts in JavaScript. Nothing is hardcoded to a
// video, a segment, or a frame count: the two frames and the scene
// come from the arguments, and the time comes from --at-s or from the
// frame name (for example real-7s.png means 7 s).
//
// What it writes:
// - overlay.png: the 50/50 blend of the two frames.
// - diff.png: the per-channel absolute difference, amplified 4x.
// - One JSON report in the insight format, to --out or to stdout.
//   The PNGs sit next to the report when --out is given, and in the
//   current directory when it is not.
//
// Method, matching overlay.py exactly:
// - Shift per element from skimage phase cross-correlation on the
//   element binary mask, with the reliability gate: a shift only
//   counts as measured when shifting improves the overlap and agrees
//   with the centroid delta within 15 px per axis. Otherwise the row
//   is unreliable and the correction falls back to the centroid delta.
// - Stroke: signal-red pixels around the Sudan bbox. Rifle: dark
//   non-orange pixels inside each frame's own RSF badge bbox.
// - A correction is built only from the measured numbers, with the
//   same gates overlay.py uses: a move over 1 px, a stroke when ours
//   has 100 or more red pixels and real has under 100, a rifle when
//   real has 100 or more rifle pixels and ours has under a quarter
//   of that, a colour gap of 15 levels or more over a shared area.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

export const SHIFT_MIN_PX = 1.0;
export const SHIFT_AGREE_PX = 15.0;
export const LAYER_DIFF_MIN = 15.0;
export const STROKE_MIN_PX = 100;
export const RIFLE_MIN_PX = 100;

export const USAGE = [
  "hme diagnose: List the corrections for one frame pair, in scene terms.",
  "",
  "Usage: hme diagnose <ref-frame.png> <ours-frame.png> --scene <scene.json> [--out <report.json>]",
  "",
  "Arguments:",
  "  <ref-frame.png>  One frame from the reference video.",
  "  <ours-frame.png>  The same frame from our video.",
  "",
  "Options:",
  "  --scene <file>  Path to the scene file. Required.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "                overlay.png and diff.png are written next to the report,",
  "                or to the current directory when --out is absent.",
  "  --at-s <n>  Time in seconds of the frame. Detected from the frame name",
  "              (for example real-7s.png means 7 s) when absent.",
  "  --trace-ref <file>  Badge trajectory for the reference video, as a trace",
  "              profile JSON (badge_trajectory with time_s and x_1920x1080 /",
  "              y_1920x1080 per frame). Needs --trace-ours too.",
  "  --trace-ours <file>  Badge trajectory for our video, same format.",
  "              With both traces, diagnose checks the badge across time:",
  "              when our badge at this second sits where the real badge is",
  "              at another second, the badge correction becomes kind timing",
  "              and names how far to move the badge path (for example",
  "              \"move the badge path 0.75 s later\"). Without the traces,",
  "              diagnose only sees this one frame pair and can only report",
  "              a position move. The two frames must be the same size;",
  "              when the reference video is 1920x1038, scale its frame to",
  "              1920x1080 first (ffmpeg scale=1920:1080), the same stretch",
  "              the stills prep uses, so the frames line up.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// Overlay element key to display name and scene node id. The Sudan
// shape lives in the map node, the badge is badge-rsf, and the rifle
// is the rifle-rsf image node on the badge.
export const ELEMENTS = {
  sudan: { display: "Sudan", scene: "map" },
  rsf: { display: "RSF badge", scene: "badge-rsf" },
  october: { display: "October 2025 title", scene: "title-october" },
  sudan_label: { display: "SUDAN label", scene: "label-sudan" },
  el_fasher_label: { display: "EL FASHER label", scene: "label-fasher" },
  el_fasher_dot: { display: "El Fasher dot", scene: "dot-fasher" },
};

const LAYER_ELEMENTS = {
  sudan: { display: "Sudan", scene: "map" },
  base: { display: "base", scene: "map" },
  rsf: { display: "RSF badge", scene: "badge-rsf" },
  october: { display: "October 2025 title", scene: "title-october" },
  white_text: { display: "white_text", scene: "white_text" },
};

// Plain-words move for one shift, the same wording overlay.py uses:
// "12 px right, 4 px down". A move under 1 px on both axes is "".
export function moveWords(dx, dy) {
  const parts = [];
  if (Math.abs(dx) >= SHIFT_MIN_PX) {
    parts.push(`${Math.round(Math.abs(dx))} px ${dx > 0 ? "right" : "left"}`);
  }
  if (Math.abs(dy) >= SHIFT_MIN_PX) {
    parts.push(`${Math.round(Math.abs(dy))} px ${dy > 0 ? "down" : "up"}`);
  }
  return parts.join(", ");
}

// Time in seconds from a frame name such as real-7s.png or v5-1.5s.png.
// Returns null when the name carries no time.
export function parseAtS(name) {
  const m = /-(\d+(?:\.\d+)?)s\.[^.]+$/.exec(basename(String(name)));
  return m ? Number(m[1]) : null;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// Timing gates. A timing claim needs a real shift (over the 15 px
// agreement band), a time gap of at least a quarter of a second, a
// good match (our badge within 20 px of where the real badge is at
// the matched second), and a real badge that actually moves between
// the two seconds (otherwise the match time is meaningless, as at 7 s
// when the badge has settled and every nearby second matches).
export const TIMING_MIN_DT_S = 0.25;
export const TIMING_MAX_MATCH_PX = 20.0;
export const TIMING_MIN_REF_MOVE_PX = 15.0;

// A badge trajectory from a trace profile JSON. The trace writes
// badge_trajectory as parallel arrays: frames, time_s, x_1920x1080,
// y_1920x1080, area_frac. A list of {time_s, x_1920x1080, y_1920x1080}
// points is accepted too. Returns { samples: [{t, x, y, px}] } sorted
// by time, with frames where the badge is absent dropped, or null
// when the profile carries no usable badge trajectory. Pure function.
export function parseTrajectory(profile) {
  const bt = profile?.badge_trajectory;
  if (!bt) return null;
  const samples = [];
  const push = (t, x, y, area) => {
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    samples.push({
      t,
      x,
      y,
      px: Number.isFinite(area) ? Math.round(area * 1920 * 1080) : null,
    });
  };
  if (Array.isArray(bt)) {
    for (const p of bt) {
      const x = p?.x_1920x1080 ?? (Number.isFinite(p?.x_ratio) ? p.x_ratio * 1920 : null);
      const y = p?.y_1920x1080 ?? (Number.isFinite(p?.y_ratio) ? p.y_ratio * 1080 : null);
      push(p?.time_s, x, y, p?.area_frac);
    }
  } else if (Array.isArray(bt.time_s)) {
    const n = bt.time_s.length;
    for (let i = 0; i < n; i++) {
      const x = bt.x_1920x1080?.[i] ?? (Number.isFinite(bt.x_ratio?.[i]) ? bt.x_ratio[i] * 1920 : null);
      const y = bt.y_1920x1080?.[i] ?? (Number.isFinite(bt.y_ratio?.[i]) ? bt.y_ratio[i] * 1080 : null);
      push(bt.time_s[i], x, y, bt.area_frac?.[i]);
    }
  } else {
    return null;
  }
  if (samples.length < 2) return null;
  samples.sort((a, b) => a.t - b.t);
  return { samples };
}

// Badge position at time t, linearly interpolated between the two
// nearest samples. Null outside the sampled range. Pure function.
export function trajectoryAt(traj, t) {
  if (!traj || !Number.isFinite(t)) return null;
  const s = traj.samples;
  if (s.length === 0) return null;
  if (t < s[0].t || t > s[s.length - 1].t) return null;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (a.t <= t && t <= b.t) {
      if (b.t === a.t) return { x: a.x, y: a.y, px: a.px };
      const f = (t - a.t) / (b.t - a.t);
      return {
        x: a.x + f * (b.x - a.x),
        y: a.y + f * (b.y - a.y),
        px: a.px != null && b.px != null ? Math.round(a.px + f * (b.px - a.px)) : (a.px ?? b.px),
      };
    }
  }
  const last = s[s.length - 1];
  return t === last.t ? { x: last.x, y: last.y, px: last.px } : null;
}

// The second at which the reference badge is closest to pos, found
// as the closest point on the reference path (straight segments
// between samples). Returns { t, dist } or null when the path is
// empty. Pure function.
export function matchTrajectoryTime(refTraj, pos) {
  if (!refTraj || !pos) return null;
  const s = refTraj.samples;
  if (s.length < 2) return null;
  let best = null;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let f = len2 === 0 ? 0 : ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / len2;
    f = Math.max(0, Math.min(1, f));
    const d = Math.hypot(pos.x - (a.x + f * dx), pos.y - (a.y + f * dy));
    if (best === null || d < best.dist) {
      best = { t: a.t + f * (b.t - a.t), dist: d };
    }
  }
  return best;
}

// Short number for the fix wording: up to 2 decimals, no trailing
// zeros ("0.75", "5.75", "5").
function fixNum(v) {
  return String(Math.round(v * 100) / 100);
}

// The badge timing check for one second. trajectories is
// { ref, ours } of parsed trajectories, or null. Returns null when
// no trajectories were given. Otherwise an object with fired true
// and the timing correction facts when our badge at atS sits where
// the real badge is at another second, or fired false with the reason
// when it does not. Pure function.
export function timingInfo({ atS, trajectories }) {
  if (!trajectories?.ref || !trajectories?.ours) return null;
  const refPos = trajectoryAt(trajectories.ref, atS);
  const oursPos = trajectoryAt(trajectories.ours, atS);
  if (!refPos || !oursPos) {
    return { fired: false, reason: "badge trajectory has no position at this second on one side" };
  }
  const shift = { dx: round1(refPos.x - oursPos.x), dy: round1(refPos.y - oursPos.y) };
  const shiftMag = Math.hypot(refPos.x - oursPos.x, refPos.y - oursPos.y);
  if (shiftMag <= SHIFT_AGREE_PX) {
    return { fired: false, reason: "badge positions agree within 15 px at this second", shift_px: shift };
  }
  const match = matchTrajectoryTime(trajectories.ref, oursPos);
  if (!match) {
    return { fired: false, reason: "reference badge path is empty", shift_px: shift };
  }
  const dt = match.t - atS;
  if (Math.abs(dt) < TIMING_MIN_DT_S) {
    return { fired: false, reason: "best time match is under 0.25 s away, not a timing error", shift_px: shift, matched_at_s: round2(match.t), match_distance_px: round1(match.dist), dt_s: round2(dt) };
  }
  if (match.dist > TIMING_MAX_MATCH_PX) {
    return { fired: false, reason: "our badge sits nowhere on the real badge path", shift_px: shift, matched_at_s: round2(match.t), match_distance_px: round1(match.dist), dt_s: round2(dt) };
  }
  const refAtMatch = trajectoryAt(trajectories.ref, match.t);
  const refMove = refAtMatch ? Math.hypot(refAtMatch.x - refPos.x, refAtMatch.y - refPos.y) : 0;
  if (refMove < TIMING_MIN_REF_MOVE_PX) {
    return { fired: false, reason: "real badge barely moves near this second, so the match time means nothing", shift_px: shift, matched_at_s: round2(match.t), match_distance_px: round1(match.dist), dt_s: round2(dt) };
  }
  // The headline time is rounded to the nearest 0.05 s, about one
  // frame, because the trajectory is sampled once per frame: quoting
  // the gap to 0.01 s would overstate the precision. The precise
  // match stays in the report numbers.
  const dtHeadline = Math.round(Math.abs(dt) * 20) / 20;
  const matchedHeadline = round2(atS + Math.sign(dt) * dtHeadline);
  return {
    fired: true,
    element: "badge-rsf",
    at_s: atS,
    ours: { x: round1(oursPos.x), y: round1(oursPos.y), px: oursPos.px },
    real: { x: round1(refPos.x), y: round1(refPos.y), px: refPos.px },
    shift_px: shift,
    matched_at_s: round2(match.t),
    match_distance_px: round1(match.dist),
    dt_s: round2(dt),
    dt_headline_s: dtHeadline,
    fix: dt > 0
      ? `RSF badge: move the badge path ${fixNum(dtHeadline)} s later; at ${fixNum(atS)} s it sits where the real badge is at ${fixNum(matchedHeadline)} s`
      : `RSF badge: move the badge path ${fixNum(dtHeadline)} s earlier; at ${fixNum(atS)} s it sits where the real badge was at ${fixNum(matchedHeadline)} s`,
  };
}


function centroidOf(measured, key, side) {
  const c = measured.centroids?.[key]?.[side];
  if (Array.isArray(c) && c.length === 2) return { x: round1(c[0]), y: round1(c[1]) };
  const seg = measured.segments?.[side]?.[key]?.centroid;
  if (Array.isArray(seg) && seg.length === 2) return { x: round1(seg[0]), y: round1(seg[1]) };
  return { x: 0, y: 0 };
}

// Build the structured corrections from the overlay numbers, with
// the same gates and the same plain-words fixes overlay.py uses.
// measured is the parsed driver JSON: { report, segments, centroids }.
// trajectories is { ref, ours } of parsed badge trajectories, or
// null: with them, a badge position correction becomes a timing
// correction when our badge at this second sits where the real badge
// is at another second. Without them the single-pair behaviour is
// unchanged. Pure function, tested without any frames.
export function buildCorrections(measured, { atS, ref, ours, trajectories = null }) {
  const report = measured.report;
  const source = `hme diagnose, ${basename(ref)} vs ${basename(ours)}`;
  const out = [];
  const shifts = report.shifts ?? {};
  for (const [key, row] of Object.entries(shifts)) {
    if (!row || row.shift === null) continue;
    const el = ELEMENTS[key];
    if (!el) continue;
    const real = centroidOf(measured, key, "real");
    const oursC = centroidOf(measured, key, "ours");
    if (row.status === "measured") {
      const words = moveWords(row.shift.dx_px, row.shift.dy_px);
      if (words) {
        out.push({
          element: el.scene,
          kind: "position",
          at_s: atS,
          ours: { ...oursC, px: row.ours_pixels },
          real: { ...real, px: row.real_pixels },
          shift_px: { dx: row.shift.dx_px, dy: row.shift.dy_px },
          fix: `${el.display}: move ${words}`,
          source,
        });
      }
    } else if (row.status === "unreliable" && row.centroid_delta_px) {
      const cd = row.centroid_delta_px;
      let words = moveWords(cd.dx_px, cd.dy_px);
      // The dot is excepted when the two masks differ in size by
      // more than 3x: in ours the dot touches the E glyph and the two
      // merge into one component, so the centroid is pulled toward
      // the E and is not a measure of the dot alone.
      if (key === "el_fasher_dot") {
        const lo = Math.min(row.real_pixels, row.ours_pixels);
        const hi = Math.max(row.real_pixels, row.ours_pixels);
        if (lo === 0 || hi / lo > 3.0) words = "";
      }
      if (words) {
        out.push({
          element: el.scene,
          kind: "position",
          at_s: atS,
          ours: { ...oursC, px: row.ours_pixels },
          real: { ...real, px: row.real_pixels },
          shift_px: { dx: cd.dx_px, dy: cd.dy_px },
          fix: `${el.display}: move ${words} (from centroids; phase correlation disagreed)`,
          source,
        });
      }
    }
  }
  const stroke = report.stroke ?? {};
  const oursRed = stroke.ours?.red_pixels_around_sudan;
  const realRed = stroke.real?.red_pixels_around_sudan;
  if (oursRed != null && realRed != null && oursRed >= STROKE_MIN_PX && realRed < STROKE_MIN_PX) {
    const real = centroidOf(measured, "sudan", "real");
    const oursC = centroidOf(measured, "sudan", "ours");
    out.push({
      element: "map",
      kind: "shape",
      at_s: atS,
      ours: { ...oursC, px: oursRed },
      real: { ...real, px: realRed },
      shift_px: { dx: 0, dy: 0 },
      fix: `Sudan: remove the red subject stroke (ours has ${oursRed} red pixels around Sudan, real has ${realRed})`,
      source,
    });
  }
  const rifle = report.rifle ?? {};
  if (rifle.real != null && rifle.ours != null && rifle.real >= RIFLE_MIN_PX && rifle.ours < 0.25 * rifle.real) {
    const real = centroidOf(measured, "rsf", "real");
    const oursC = centroidOf(measured, "rsf", "ours");
    out.push({
      element: "rifle-rsf",
      kind: "shape",
      at_s: atS,
      ours: { ...oursC, px: rifle.ours },
      real: { ...real, px: rifle.real },
      shift_px: { dx: 0, dy: 0 },
      fix: `RSF badge: add the rifle (real has ${rifle.real} rifle pixels inside the badge, ours has ${rifle.ours})`,
      source,
    });
  }
  const layers = report.layers ?? {};
  for (const [name, row] of Object.entries(layers)) {
    const inter = row.intersection_pixels;
    const union = row.union_pixels;
    const diff = row.mean_abs_diff_intersection;
    if (diff != null && diff >= LAYER_DIFF_MIN && inter >= 100 && inter >= 0.25 * union) {
      const el = LAYER_ELEMENTS[name] ?? { display: name, scene: name };
      const real = centroidOf(measured, name, "real");
      const oursC = centroidOf(measured, name, "ours");
      out.push({
        element: el.scene,
        kind: "colour",
        at_s: atS,
        ours: { ...oursC, px: row.ours_pixels },
        real: { ...real, px: row.real_pixels },
        shift_px: { dx: 0, dy: 0 },
        fix: `${el.display} fill: colours differ by ${diff.toFixed(1)} levels on average over the shared area, re-measure the colour`,
        source,
      });
    }
  }
  // Timing: with badge trajectories, a badge position error that is
  // really a path running early or late is reported as kind timing,
  // not position. The timing correction replaces the badge position
  // correction (same element, same shift), so the report names the
  // error once, with the time gap in the fix.
  const timing = timingInfo({ atS, trajectories });
  if (timing?.fired) {
    const idx = out.findIndex((c) => c.element === "badge-rsf" && c.kind === "position");
    const old = idx >= 0 ? out[idx] : null;
    const layer = report.layers?.rsf ?? {};
    const corr = {
      element: "badge-rsf",
      kind: "timing",
      at_s: atS,
      ours: { ...timing.ours, px: timing.ours.px ?? old?.ours.px ?? layer.ours_pixels ?? 0 },
      real: { ...timing.real, px: timing.real.px ?? old?.real.px ?? layer.real_pixels ?? 0 },
      shift_px: timing.shift_px,
      fix: timing.fix,
      source,
    };
    if (idx >= 0) out[idx] = corr;
    else out.push(corr);
  }
  return out;
}

// The timing facts for the report numbers, or null when no
// trajectories were given. Same measurement as buildCorrections
// uses, so the numbers and the correction never disagree.
export function timingNumbers({ atS, trajectories }) {
  const info = timingInfo({ atS, trajectories });
  if (!info) return null;
  if (!info.fired) {
    return {
      fired: false,
      reason: info.reason,
      shift_px: info.shift_px ?? null,
      matched_at_s: info.matched_at_s ?? null,
      match_distance_px: info.match_distance_px ?? null,
      dt_s: info.dt_s ?? null,
    };
  }
  return {
    fired: true,
    element: info.element,
    at_s: info.at_s,
    ours: info.ours,
    real: info.real,
    shift_px: info.shift_px,
    matched_at_s: info.matched_at_s,
    match_distance_px: info.match_distance_px,
    dt_s: info.dt_s,
    dt_headline_s: info.dt_headline_s,
  };
}

// Build the insight report from the driver output. Pure function,
// tested without any frames.
export function buildInsightReport(measured, { ref, ours, scene, sceneId, atS, outPath, outDir, trajectories = null }) {
  const report = measured.report;
  const corrections = buildCorrections(measured, { atS, ref, ours, trajectories });
  const mean = report.mean_abs_diff;
  const status = corrections.length === 0 ? "PASS" : "FAIL";
  const overlayPng = join(outDir, "overlay.png");
  const diffPng = join(outDir, "diff.png");
  return {
    verdict: {
      status,
      failed_bar: status === "PASS"
        ? null
        : "Zero corrections: every element within 1 px, no red subject stroke, no missing element",
      detail: status === "PASS"
        ? `Mean absolute difference ${mean} with no correction over 1 px.`
        : `${corrections.length} correction(s) found. First: ${corrections[0].fix}`,
    },
    numbers: {
      ref,
      ours,
      scene,
      at_s: atS,
      shape: report.shape,
      mean_abs_diff: mean,
      mean_abs_diff_by_channel: report.mean_abs_diff_by_channel,
      layers: report.layers,
      shifts: report.shifts,
      stroke: report.stroke,
      rifle: report.rifle,
      timing: timingNumbers({ atS, trajectories }),
      files: {
        ref,
        ours,
        scene,
        overlay_png: overlayPng,
        diff_png: diffPng,
        report_json: outPath ?? null,
      },
    },
    corrections,
    context: {
      thresholds: {
        shift_min_px: SHIFT_MIN_PX,
        shift_agree_px: SHIFT_AGREE_PX,
        layer_diff_min: LAYER_DIFF_MIN,
        stroke_min_px: STROKE_MIN_PX,
        rifle_min_px: RIFLE_MIN_PX,
      },
      control_ceiling: null,
      meaning: status === "PASS"
        ? `Mean absolute difference ${mean} and no element needs a move over 1 px. A perfect clone scores 0 here with no corrections.`
        : `Mean absolute difference ${mean} with ${corrections.length} correction(s). A perfect clone scores 0 here with no corrections, so this is a real clone gap, not a measurement gap.`,
    },
    next: `hme render ${scene} --profile draft --out out/${sceneId}`,
    limits: report.limits ?? [],
  };
}

// The Python driver. It loads the two frames, runs the overlay
// report, writes overlay.png and diff.png into the output directory,
// and prints exactly one JSON object to stdout: the overlay report
// plus the per-element centroids the structured corrections need.
const DRIVER = `
import json
import sys
from pathlib import Path

REF, OURS, OUTDIR, SRC = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
sys.path.insert(0, SRC)
from checker import overlay, layout
import numpy as np
from PIL import Image

def load(p):
    return np.array(Image.open(p).convert("RGB"))

real = load(REF)
ours = load(OURS)
if real.shape != ours.shape:
    raise RuntimeError(f"frames differ in shape: real {real.shape}, ours {ours.shape}")
report = overlay.overlay_report(real, ours, label="overlay check")
rseg = layout.segment_frame(real)
oseg = layout.segment_frame(ours)
em = overlay.element_masks(real, ours)
centroids = {k: {"real": v["real_centroid"], "ours": v["ours_centroid"]}
             for k, v in em.items()}
out_dir = Path(OUTDIR)
out_dir.mkdir(parents=True, exist_ok=True)
Image.fromarray(overlay.blend_overlay(real, ours)).save(out_dir / "overlay.png")
Image.fromarray(overlay.amplified_diff(real, ours)).save(out_dir / "diff.png")
print(json.dumps({"report": report,
                  "segments": {"real": rseg, "ours": oseg},
                  "centroids": centroids}))
`;

function runDriver(refPath, oursPath, outDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", refPath, oursPath, outDir, SRC_DIR], {
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
        rejectPromise(new Error(`diagnose measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`diagnose measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Run `hme diagnose <ref-frame> <ours-frame> --scene <scene> [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runDiagnose(argv) {
  const positionals = [];
  let sceneArg = null;
  let outPath = null;
  let atS = null;
  let traceRefArg = null;
  let traceOursArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scene") {
      if (i + 1 >= argv.length) {
        console.error("hme diagnose: --scene needs a file path");
        console.error(USAGE);
        return 2;
      }
      sceneArg = argv[++i];
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme diagnose: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a === "--trace-ref") {
      if (i + 1 >= argv.length) {
        console.error("hme diagnose: --trace-ref needs a file path");
        console.error(USAGE);
        return 2;
      }
      traceRefArg = argv[++i];
    } else if (a === "--trace-ours") {
      if (i + 1 >= argv.length) {
        console.error("hme diagnose: --trace-ours needs a file path");
        console.error(USAGE);
        return 2;
      }
      traceOursArg = argv[++i];
    } else if (a === "--at-s") {
      if (i + 1 >= argv.length) {
        console.error("hme diagnose: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
      atS = Number(argv[++i]);
      if (!Number.isFinite(atS)) {
        console.error("hme diagnose: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
    } else if (a.startsWith("--")) {
      console.error(`hme diagnose: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 2) {
    console.error("hme diagnose: needs two frames, <ref-frame.png> and <ours-frame.png>");
    console.error(USAGE);
    return 2;
  }
  if (!sceneArg) {
    console.error("hme diagnose: --scene is required");
    console.error(USAGE);
    return 2;
  }
  if ((traceRefArg === null) !== (traceOursArg === null)) {
    console.error("hme diagnose: --trace-ref and --trace-ours go together, give both or neither");
    console.error(USAGE);
    return 2;
  }
  const [refArg, oursArg] = positionals;
  const refPath = resolve(refArg);
  const oursPath = resolve(oursArg);
  const scenePath = resolve(sceneArg);
  if (!existsSync(refPath)) {
    console.error(`hme diagnose: no such file: ${refArg}`);
    return 2;
  }
  if (!existsSync(oursPath)) {
    console.error(`hme diagnose: no such file: ${oursArg}`);
    return 2;
  }
  if (!existsSync(scenePath)) {
    console.error(`hme diagnose: no such file: ${sceneArg}`);
    return 2;
  }
  let trajectories = null;
  if (traceRefArg !== null) {
    const readTraj = (arg) => {
      const p = resolve(arg);
      if (!existsSync(p)) {
        console.error(`hme diagnose: no such file: ${arg}`);
        return undefined;
      }
      let profile;
      try {
        profile = JSON.parse(readFileSync(p, "utf8"));
      } catch (err) {
        console.error(`hme diagnose: cannot read trace ${arg}: ${err.message}`);
        return undefined;
      }
      const traj = parseTrajectory(profile);
      if (!traj) {
        console.error(`hme diagnose: no usable badge trajectory in ${arg}`);
        return undefined;
      }
      return traj;
    };
    const refTraj = readTraj(traceRefArg);
    if (refTraj === undefined) return 2;
    const oursTraj = readTraj(traceOursArg);
    if (oursTraj === undefined) return 2;
    trajectories = { ref: refTraj, ours: oursTraj };
  }
  let scene;
  try {
    scene = JSON.parse(readFileSync(scenePath, "utf8"));
  } catch (err) {
    console.error(`hme diagnose: cannot read scene ${sceneArg}: ${err.message}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme diagnose: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  const sceneId = typeof scene?.meta?.id === "string" && scene.meta.id.length > 0
    ? scene.meta.id
    : basename(sceneArg).replace(/\.json$/, "");
  const atSValue = atS ?? parseAtS(refArg) ?? 0;
  const outDir = outPath ? dirname(resolve(outPath)) : process.cwd();
  try {
    mkdirSync(outDir, { recursive: true });
    const measured = await runDriver(refPath, oursPath, outDir);
    const report = buildInsightReport(measured, {
      ref: refArg,
      ours: oursArg,
      scene: sceneArg,
      sceneId,
      atS: atSValue,
      outPath: outPath ? resolve(outPath) : null,
      outDir: resolve(outDir),
      trajectories,
    });
    return writeInsightReport(report, outPath);
  } catch (err) {
    console.error(`hme diagnose: ${err.message}`);
    return 2;
  }
}
