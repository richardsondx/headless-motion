// hme timing: measure the semantic time offset of one object between
// two videos, and tell a timing error from a path error.
//
// The badge trajectory comes from `hme trace` pass_extra (radius-30
// mask centroid at 960x540), run internally for video inputs or read
// from two trace profiles with --ref-profile / --render-profile.
// The match reuses the diagnose pure functions parseTrajectory,
// trajectoryAt, matchTrajectoryTime and timingInfo with their gates:
// shift over 15 px, match within 20 px, time gap at least 0.25 s,
// reference badge must move at least 15 px. No new alignment code
// is written here, and no smoothing is applied: raw samples only.
//
// Per render sample in the fit window, dt is the reference second
// where the render badge sits, minus the render second. Positive dt
// means the render is early: it reaches the position before the
// reference does. The headline offset is the median dt. The spread
// (max dt minus min dt) decides the fix: under 0.15 s a single
// delay suffices, over 0.15 s the path must be re-timed per keyframe.
//
// Kind rule: timing when the median match distance is at most 20 px
// and the median absolute dt is at least 0.25 s; path when the
// median match distance is over 20 px; inconclusive when no sample
// passes the gates (or the badge is on the path and on time, so
// there is no timing error to fix).
//
// Times are compared in seconds, never in frame numbers: the two
// videos may run at different frame rates. Coordinates are in
// 1920x1080, the space the trace already reports.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTrajectory,
  trajectoryAt,
  matchTrajectoryTime,
  timingInfo,
  TIMING_MIN_DT_S,
  TIMING_MAX_MATCH_PX,
  TIMING_MIN_REF_MOVE_PX,
  SHIFT_AGREE_PX,
} from "./diagnose.mjs";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const HME = join(HERE, "hme.mjs");

export const DEFAULT_COLOUR = "#CC4726";
export const DEFAULT_OBJECT = "#CC4726";

// Labels resolve through this alias table shipped in the command.
// Trace labels carry no OCR identity, so a label never resolves
// through the profile.
export const OBJECT_ALIASES = {
  "rsf badge": "#CC4726",
};

export const SPREAD_SINGLE_DELAY_MAX_S = 0.15;
export const CENTROID_BBOX_FLAG_PX = 10;
export const GRID_MIN_S = -2;
export const GRID_MAX_S = 2;
export const GRID_STEP_S = 0.005;
export const WINDOW_SNAP_S = 0.5;
export const ANCHOR_SECONDS = [4, 5, 6, 7];

export const USAGE = [
  "hme timing: Measure the time offset of one object between two videos.",
  "",
  "Usage: hme timing --ref ref.mp4 --render ours.mp4 [--object #CC4726] [--out report.json]",
  "       hme timing --ref-profile ref.json --render-profile ours.json [--object #CC4726] [--out report.json]",
  "",
  "Options:",
  "  --ref <file>  Path to the reference video. Required, unless --ref-profile is given.",
  "  --render <file>  Path to the rendered video. Required, unless --render-profile is given.",
  "  --object <colour or label>  Hex colour (for example #CC4726) or a label from the alias table (for example RSF badge). Default #CC4726.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "  --ref-profile <file>  Trace profile JSON for the reference video, instead of the video. Needs --render-profile too.",
  "  --render-profile <file>  Trace profile JSON for the rendered video, instead of the video. Needs --ref-profile too.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

function round1(v) {
  return Math.round(v * 10) / 10;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// Round to 2 decimals, halves away from zero, so -0.785 becomes -0.79.
function round2Away(v) {
  return Math.sign(v) * Math.round(Math.abs(v) * 100) / 100;
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmtSeconds(v) {
  return String(Math.round(Math.abs(v) * 100) / 100);
}

// Resolve --object to a colour. A hex colour is used as given; a
// label resolves through OBJECT_ALIASES. Returns
// { colour, label, input } or null when the value is unknown.
// Pure function, tested.
export function resolveObject(value) {
  const input = value === undefined || value === null || String(value).trim() === ""
    ? DEFAULT_OBJECT
    : String(value).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(input)) {
    return { colour: input.toUpperCase(), label: null, input };
  }
  const colour = OBJECT_ALIASES[input.toLowerCase()];
  if (colour) return { colour, label: input, input };
  return null;
}

// Parse timing argv. Returns the options plus error (null on success).
// Pure function, tested without any video.
export function parseTimingArgs(argv) {
  const out = {
    ref: null,
    render: null,
    object: DEFAULT_OBJECT,
    out: null,
    refProfile: null,
    renderProfile: null,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref" || a === "--render" || a === "--object" || a === "--out"
      || a === "--ref-profile" || a === "--render-profile") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        out.error = `option "${a}" needs a value`;
        return out;
      }
      i++;
      if (a === "--ref") out.ref = v;
      else if (a === "--render") out.render = v;
      else if (a === "--object") out.object = v;
      else if (a === "--out") out.out = v;
      else if (a === "--ref-profile") out.refProfile = v;
      else if (a === "--render-profile") out.renderProfile = v;
    } else if (a.startsWith("--")) {
      out.error = `unknown option "${a}"`;
      return out;
    } else {
      out.error = `unexpected argument "${a}"`;
      return out;
    }
  }
  if ((out.refProfile === null) !== (out.renderProfile === null)) {
    out.error = "--ref-profile and --render-profile go together, give both or neither";
    return out;
  }
  if (out.refProfile === null && (out.ref === null || out.render === null)) {
    out.error = "needs --ref and --render, or --ref-profile and --render-profile";
    return out;
  }
  return out;
}

// Badge trajectory samples from a raw trace profile, with area and
// bbox per sample. The trace writes badge_trajectory as parallel
// arrays: time_s, x_1920x1080, y_1920x1080, area_frac,
// bbox_1920x1080. Absent frames (null position) are dropped.
export function trajectorySamples(profile) {
  const bt = profile?.badge_trajectory;
  if (!bt || !Array.isArray(bt.time_s)) return [];
  const out = [];
  for (let i = 0; i < bt.time_s.length; i++) {
    const x = bt.x_1920x1080?.[i];
    const y = bt.y_1920x1080?.[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const area = bt.area_frac?.[i];
    const bbox = Array.isArray(bt.bbox_1920x1080?.[i]) ? bt.bbox_1920x1080[i] : null;
    out.push({
      t: bt.time_s[i],
      x,
      y,
      area_px: Number.isFinite(area) ? Math.round(area * 1920 * 1080) : null,
      bbox: bbox && bbox.length === 4 ? bbox : null,
    });
  }
  return out;
}

// Bbox centre at time t, linearly interpolated between the two
// nearest samples that carry a bbox. Null outside the sampled range.
export function bboxCentreAt(samples, t) {
  const withBox = samples.filter((s) => s.bbox !== null);
  if (withBox.length === 0 || !Number.isFinite(t)) return null;
  const centre = (s) => ({ x: (s.bbox[0] + s.bbox[2]) / 2, y: (s.bbox[1] + s.bbox[3]) / 2 });
  if (t < withBox[0].t || t > withBox[withBox.length - 1].t) return null;
  for (let i = 0; i < withBox.length - 1; i++) {
    const a = withBox[i];
    const b = withBox[i + 1];
    if (a.t <= t && t <= b.t) {
      if (b.t === a.t) return centre(a);
      const f = (t - a.t) / (b.t - a.t);
      const ca = centre(a);
      const cb = centre(b);
      return { x: ca.x + f * (cb.x - ca.x), y: ca.y + f * (cb.y - ca.y) };
    }
  }
  return centre(withBox[withBox.length - 1]);
}

// Match one render sample against the reference path, with the
// diagnose gates. Always returns the match facts (dt, distance,
// shift) when the reference has a position and the badges disagree
// by over 15 px; `pass` is true only when every gate passes. The
// kind rule needs the ungated distances too: a render badge on a
// parallel path fails the distance gate on every sample, and that
// failure itself is the path verdict, not an inconclusive run.
function gateSample(refTraj, sample) {
  const refPos = trajectoryAt(refTraj, sample.t);
  if (!refPos) return { pass: false, reason: "reference badge has no position at this second" };
  const shift = Math.hypot(refPos.x - sample.x, refPos.y - sample.y);
  if (shift <= SHIFT_AGREE_PX) return { pass: false, reason: "badge positions agree within 15 px at this second", shift_px: round1(shift) };
  const match = matchTrajectoryTime(refTraj, { x: sample.x, y: sample.y });
  if (!match) return { pass: false, reason: "reference badge path is empty", shift_px: round1(shift) };
  const dt = match.t - sample.t;
  const refAtMatch = trajectoryAt(refTraj, match.t);
  const refMove = refAtMatch ? Math.hypot(refAtMatch.x - refPos.x, refAtMatch.y - refPos.y) : 0;
  const facts = {
    t: sample.t,
    dt,
    dt_s: round2(dt),
    matched_at_s: round2(match.t),
    match_distance_px: round1(match.dist),
    shift_px: round1(shift),
    ref_x: round1(refPos.x),
    ref_y: round1(refPos.y),
    render_x: round1(sample.x),
    render_y: round1(sample.y),
    ref_area_px: refPos.px,
    render_area_px: sample.area_px,
  };
  if (Math.abs(dt) < TIMING_MIN_DT_S) {
    return { ...facts, pass: false, reason: "best time match is under 0.25 s away, not a timing error" };
  }
  if (match.dist > TIMING_MAX_MATCH_PX) {
    return { ...facts, pass: false, reason: "render badge sits nowhere on the reference badge path" };
  }
  if (refMove < TIMING_MIN_REF_MOVE_PX) {
    return { ...facts, pass: false, reason: "reference badge barely moves near this second, so the match time means nothing" };
  }
  return { ...facts, pass: true };
}

// Mean distance between the render badge at time t and the reference
// badge at time t minus shift, over the gated samples. Shift is the
// constant time shift applied to the render clock: negative means
// the render path runs early.
function gridResidual(refTraj, renderTraj, gated, shift) {
  let sum = 0;
  let n = 0;
  for (const g of gated) {
    const oursPos = trajectoryAt(renderTraj, g.t);
    const refPos = trajectoryAt(refTraj, g.t - shift);
    if (!oursPos || !refPos) continue;
    sum += Math.hypot(oursPos.x - refPos.x, oursPos.y - refPos.y);
    n++;
  }
  return n === 0 ? null : sum / n;
}

function anchorAt(traj, samples, t) {
  const pos = trajectoryAt(traj, t);
  if (!pos) return null;
  const centre = bboxCentreAt(samples, t);
  return {
    t_s: t,
    x: round1(pos.x),
    y: round1(pos.y),
    area_px: pos.px,
    bbox_1920x1080: (() => {
      const near = samples.reduce((best, s) => (best === null || Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best), null);
      return near?.bbox ?? null;
    })(),
    centroid_vs_bbox_centre_px: centre === null ? null : round1(Math.hypot(pos.x - centre.x, pos.y - centre.y)),
  };
}

// The timing analysis for two trace profiles. Pure function, tested
// on the Seg4 profiles without any video.
export function computeTiming({ refProfile, renderProfile, object }) {
  const refTraj = parseTrajectory(refProfile);
  const renderTraj = parseTrajectory(renderProfile);
  if (!refTraj) throw new Error("no usable badge trajectory in the reference profile");
  if (!renderTraj) throw new Error("no usable badge trajectory in the render profile");
  const refSamples = trajectorySamples(refProfile);
  const renderSamples = trajectorySamples(renderProfile);

  // Fit window: the longest run of render samples that pass the
  // diagnose gates, snapped inward to half-second boundaries, so
  // the settled tail and the appearance edge never enter the fit.
  const gatedFlags = renderSamples.map((s) => gateSample(refTraj, s));
  let bestRun = [];
  let run = [];
  for (let i = 0; i < gatedFlags.length; i++) {
    if (gatedFlags[i].pass) run.push(i);
    else {
      if (run.length > bestRun.length) bestRun = run;
      run = [];
    }
  }
  if (run.length > bestRun.length) bestRun = run;
  const runStart = bestRun.length ? renderSamples[bestRun[0]].t : null;
  const runEnd = bestRun.length ? renderSamples[bestRun[bestRun.length - 1]].t : null;
  let windowStart = null;
  let windowEnd = null;
  if (runStart !== null) {
    windowStart = Math.ceil(runStart / WINDOW_SNAP_S) * WINDOW_SNAP_S;
    windowEnd = Math.floor(runEnd / WINDOW_SNAP_S) * WINDOW_SNAP_S;
    if (windowStart >= windowEnd) {
      windowStart = round3(runStart);
      windowEnd = round3(runEnd);
    } else {
      windowStart = round2(windowStart);
      windowEnd = round2(windowEnd);
    }
  }

  // When no sample passes the gates, the window falls back to the
  // overlap of badge presence, snapped inward to half-second
  // boundaries, so a parallel path still gets a window to be
  // judged in instead of no window at all.
  if (windowStart === null && refSamples.length && renderSamples.length) {
    const overlapStart = Math.max(refSamples[0].t, renderSamples[0].t);
    const overlapEnd = Math.min(refSamples[refSamples.length - 1].t, renderSamples[renderSamples.length - 1].t);
    windowStart = round2(Math.ceil(overlapStart / WINDOW_SNAP_S) * WINDOW_SNAP_S);
    windowEnd = round2(Math.floor(overlapEnd / WINDOW_SNAP_S) * WINDOW_SNAP_S);
    if (windowStart >= windowEnd) {
      windowStart = round3(overlapStart);
      windowEnd = round3(overlapEnd);
    }
  }

  // Candidates are the window samples with a match at all (badges
  // disagree by over 15 px). Gated samples are the candidates that
  // pass every diagnose gate. The headline numbers come from the
  // gated samples; the kind rule also reads the candidates, so a
  // parallel path (every distance over 20 px) reads as path.
  const candidates = [];
  const gated = [];
  let agreed = 0;
  if (windowStart !== null) {
    for (let i = 0; i < renderSamples.length; i++) {
      const s = renderSamples[i];
      if (s.t < windowStart - 1e-9 || s.t > windowEnd + 1e-9) continue;
      const f = gatedFlags[i];
      if (f.reason === "badge positions agree within 15 px at this second") agreed++;
      if (f.dt === undefined) continue;
      candidates.push(f);
      if (f.pass) gated.push(f);
    }
  }
  const table = gated.length ? gated : candidates;

  const analysis = {
    object: object?.input ?? DEFAULT_OBJECT,
    colour: object?.colour ?? DEFAULT_COLOUR,
    label: object?.label ?? null,
    ref_trajectory: refSamples,
    render_trajectory: renderSamples,
    presence: {
      ref: refSamples.length ? { first_s: refSamples[0].t, last_s: refSamples[refSamples.length - 1].t, frames: refSamples.length } : null,
      render: renderSamples.length ? { first_s: renderSamples[0].t, last_s: renderSamples[renderSamples.length - 1].t, frames: renderSamples.length } : null,
    },
    window: windowStart === null ? null : { start_s: windowStart, end_s: windowEnd, samples: table.length, samples_gated: gated.length },
    samples: table.map((g) => ({
      t_s: round3(g.t),
      dt_s: round3(g.dt),
      matched_at_s: g.matched_at_s,
      match_distance_px: g.match_distance_px,
      shift_px: g.shift_px,
      ref_x: g.ref_x,
      ref_y: g.ref_y,
      render_x: g.render_x,
      render_y: g.render_y,
      ref_area_px: g.ref_area_px,
      render_area_px: g.render_area_px,
    })),
    anchors: {},
    kind: "inconclusive",
    kind_reason: "",
    median_offset_s: null,
    median_dt_s: null,
    signed_offset_s: null,
    offset_direction: null,
    plain_words: "",
    dt_min_s: null,
    dt_max_s: null,
    dt_spread_s: null,
    is_warp: false,
    single_delay_suffices: null,
    median_match_distance_px: null,
    max_match_distance_px: null,
    dt_at_5s_s: null,
    residuals: { unshifted_mean_px: null, best_constant_shift_mean_px: null, best_constant_shift_s: null },
    areas: { ref: {}, render: {} },
    bbox: { ref: {}, render: {} },
    centroid_vs_bbox: {},
    centroid_vs_bbox_max_px: null,
    centroid_vs_bbox_flagged: false,
    fix: "",
  };

  for (const t of ANCHOR_SECONDS) {
    analysis.anchors[String(t)] = {
      ref: anchorAt(refTraj, refSamples, t),
      render: anchorAt(renderTraj, renderSamples, t),
    };
    const refA = analysis.anchors[String(t)].ref;
    const renderA = analysis.anchors[String(t)].render;
    analysis.areas.ref[`at_${t}s_px`] = refA?.area_px ?? null;
    analysis.areas.render[`at_${t}s_px`] = renderA?.area_px ?? null;
    analysis.bbox.ref[`at_${t}s`] = refA?.bbox_1920x1080 ?? null;
    analysis.bbox.render[`at_${t}s`] = renderA?.bbox_1920x1080 ?? null;
    analysis.centroid_vs_bbox[`at_${t}s`] = {
      ref_px: refA?.centroid_vs_bbox_centre_px ?? null,
      render_px: renderA?.centroid_vs_bbox_centre_px ?? null,
    };
  }
  const diffs = Object.values(analysis.centroid_vs_bbox)
    .flatMap((d) => [d.ref_px, d.render_px])
    .filter((v) => v !== null);
  analysis.centroid_vs_bbox_max_px = diffs.length ? Math.max(...diffs) : null;
  analysis.centroid_vs_bbox_flagged = analysis.centroid_vs_bbox_max_px !== null
    && analysis.centroid_vs_bbox_max_px > CENTROID_BBOX_FLAG_PX;

  if (table.length === 0) {
    if (agreed > 0) {
      analysis.kind = "inconclusive";
      analysis.kind_reason = "badge follows the same path on time (positions agree within 15 px), so there is no timing error to fix";
      analysis.median_offset_s = 0;
      analysis.median_dt_s = 0;
      analysis.signed_offset_s = 0;
      analysis.offset_direction = "on time";
      analysis.plain_words = "The badge is on time (median offset 0 s).";
      analysis.fix = "No timing fix is needed: the badge is on time (median offset 0 s).";
      return analysis;
    }
    analysis.kind = "inconclusive";
    analysis.kind_reason = "no sample in the fit window has a match, so no offset can be measured";
    analysis.plain_words = "The badge timing cannot be measured: no sample in the fit window has a match.";
    analysis.fix = "No timing fix can be given: no sample in the fit window has a match, so measure the badge trajectory first.";
    return analysis;
  }

  const candDists = candidates.map((g) => g.match_distance_px);
  const candMedDist = median(candDists);
  if (gated.length === 0 && candMedDist !== null && candMedDist > TIMING_MAX_MATCH_PX) {
    analysis.median_match_distance_px = round1(candMedDist);
    analysis.max_match_distance_px = round1(Math.max(...candDists));
    analysis.kind = "path";
    analysis.kind_reason = `median match distance ${analysis.median_match_distance_px} px is over 20 px, so the render badge follows a different path`;
    analysis.plain_words = `The render badge follows a different path (median match distance ${analysis.median_match_distance_px} px).`;
    analysis.fix = `The badge follows a different path (median match distance ${analysis.median_match_distance_px} px over 20 px), so a delay does not fix it; rework the badge path to follow the reference path.`;
    return analysis;
  }

  if (gated.length === 0) {
    analysis.kind = "inconclusive";
    analysis.kind_reason = "no sample passes the diagnose gates, so no offset can be measured";
    analysis.plain_words = "The badge timing cannot be measured: no sample passes the gates.";
    analysis.fix = "No timing fix can be given: no sample passes the gates, so measure the badge trajectory first.";
    return analysis;
  }

  const dts = gated.map((g) => g.dt);
  const dists = gated.map((g) => g.match_distance_px);
  const medDt = median(dts);
  const medDist = median(dists);
  const dtMin = Math.min(...dts);
  const dtMax = Math.max(...dts);
  const spread = dtMax - dtMin;
  analysis.median_dt_s = round2(medDt);
  analysis.median_offset_s = round2(medDt);
  analysis.signed_offset_s = round2(-medDt);
  analysis.offset_direction = medDt > 0 ? "early" : medDt < 0 ? "late" : "on time";
  analysis.dt_min_s = round2(dtMin);
  analysis.dt_max_s = round2(dtMax);
  analysis.dt_spread_s = round2(spread);
  analysis.is_warp = spread > SPREAD_SINGLE_DELAY_MAX_S;
  analysis.single_delay_suffices = spread <= SPREAD_SINGLE_DELAY_MAX_S;
  analysis.median_match_distance_px = round1(medDist);
  analysis.max_match_distance_px = round1(Math.max(...dists));

  const info5 = timingInfo({ atS: 5, trajectories: { ref: refTraj, ours: renderTraj } });
  if (info5?.fired) {
    analysis.dt_at_5s_s = info5.dt_s;
  } else {
    const near = gated.reduce((best, g) => (best === null || Math.abs(g.t - 5) < Math.abs(best.t - 5) ? g : best), null);
    analysis.dt_at_5s_s = near ? round2(near.dt) : null;
  }

  const unshifted = gridResidual(refTraj, renderTraj, gated, 0);
  let bestShift = null;
  let bestMean = null;
  for (let c = GRID_MIN_S; c <= GRID_MAX_S + 1e-9; c += GRID_STEP_S) {
    const mean = gridResidual(refTraj, renderTraj, gated, round3(c));
    if (mean === null) continue;
    if (bestMean === null || mean < bestMean) {
      bestMean = mean;
      bestShift = round3(c);
    }
  }
  analysis.residuals = {
    unshifted_mean_px: unshifted === null ? null : round1(unshifted),
    best_constant_shift_mean_px: bestMean === null ? null : round1(bestMean),
    best_constant_shift_s: bestShift === null ? null : round2Away(bestShift),
  };

  if (Math.abs(medDt) >= TIMING_MIN_DT_S) {
    analysis.kind = "timing";
    analysis.kind_reason = `median match distance ${analysis.median_match_distance_px} px is within 20 px and median absolute dt ${fmtSeconds(medDt)} s is at least 0.25 s`;
    const early = medDt > 0;
    analysis.plain_words = early
      ? `The render is ${fmtSeconds(medDt)} s early (median).`
      : `The render is ${fmtSeconds(medDt)} s late (median).`;
    const move = early
      ? `Delay the badge path by ${fmtSeconds(medDt)} s`
      : `Move the badge path ${fmtSeconds(medDt)} s earlier`;
    // Range in ascending absolute order: a late render has negative
    // dt (-0.54 to -0.5 s), so min first would print 0.54 to 0.5 s.
    const dtLo = fmtSeconds(Math.min(Math.abs(dtMin), Math.abs(dtMax)));
    const dtHi = fmtSeconds(Math.max(Math.abs(dtMin), Math.abs(dtMax)));
    if (analysis.is_warp) {
      analysis.fix = `${move} (median; it varies ${dtLo} to ${dtHi} s across the move, so re-time the path, a single delay leaves about ${analysis.residuals.best_constant_shift_mean_px} px of error)`;
    } else {
      analysis.fix = `${move} (median; it varies ${dtLo} to ${dtHi} s across the move, a single delay is enough)`;
    }
  } else {
    analysis.kind = "inconclusive";
    analysis.kind_reason = "badge follows the same path on time (median offset under 0.25 s), so there is no timing error to fix";
    analysis.plain_words = `The badge is on time (median offset ${fmtSeconds(medDt)} s).`;
    analysis.fix = `No timing fix is needed: the badge is on time (median offset ${fmtSeconds(medDt)} s).`;
  }
  return analysis;
}

// Build the insight report from an analysis. Pure function, tested
// without any video.
export function buildInsightReport(analysis, { ref, render, outPath }) {
  const onTime = analysis.kind === "inconclusive" && analysis.median_offset_s !== null;
  const status = analysis.kind === "timing" || analysis.kind === "path" || !onTime ? "FAIL" : "PASS";
  const corrections = [];
  if (status === "FAIL") {
    const anchor = analysis.anchors["5"] ?? null;
    const oursPos = anchor?.render;
    const realPos = anchor?.ref;
    const atS = oursPos && realPos ? 5 : (analysis.samples[0]?.t_s ?? 0);
    const ours = oursPos
      ? { x: oursPos.x, y: oursPos.y, px: oursPos.area_px ?? 0 }
      : { x: analysis.samples[0]?.render_x ?? 0, y: analysis.samples[0]?.render_y ?? 0, px: analysis.samples[0]?.render_area_px ?? 0 };
    const real = realPos
      ? { x: realPos.x, y: realPos.y, px: realPos.area_px ?? 0 }
      : { x: analysis.samples[0]?.ref_x ?? 0, y: analysis.samples[0]?.ref_y ?? 0, px: analysis.samples[0]?.ref_area_px ?? 0 };
    corrections.push({
      element: "badge-rsf",
      kind: analysis.kind,
      at_s: atS,
      ours,
      real,
      shift_px: { dx: round1(real.x - ours.x), dy: round1(real.y - ours.y) },
      fix: analysis.fix,
      source: `hme timing, ${ref} vs ${render}`,
    });
  }
  const numbers = {
    object: analysis.object,
    colour: analysis.colour,
    label: analysis.label,
    ref,
    render,
    kind: analysis.kind,
    kind_reason: analysis.kind_reason,
    ref_trajectory: analysis.ref_trajectory,
    render_trajectory: analysis.render_trajectory,
    trajectories: { ref: analysis.ref_trajectory, render: analysis.render_trajectory },
    presence: analysis.presence,
    window: analysis.window,
    samples: analysis.samples,
    per_sample_dt: analysis.samples,
    dt_table: analysis.samples,
    warp_table: analysis.samples,
    anchors: analysis.anchors,
    median_offset_s: analysis.median_offset_s,
    median_dt_s: analysis.median_dt_s,
    dt_median_s: analysis.median_dt_s,
    signed_offset_s: analysis.signed_offset_s,
    offset_direction: analysis.offset_direction,
    plain_words: analysis.plain_words,
    dt_min_s: analysis.dt_min_s,
    dt_max_s: analysis.dt_max_s,
    dt_spread_s: analysis.dt_spread_s,
    spread_s: analysis.dt_spread_s,
    is_warp: analysis.is_warp,
    single_delay_suffices: analysis.single_delay_suffices,
    median_match_distance_px: analysis.median_match_distance_px,
    match_distance_median_px: analysis.median_match_distance_px,
    max_match_distance_px: analysis.max_match_distance_px,
    dt_at_5s_s: analysis.dt_at_5s_s,
    residuals: analysis.residuals,
    best_constant_shift_s: analysis.residuals.best_constant_shift_s,
    unshifted_mean_residual_px: analysis.residuals.unshifted_mean_px,
    best_constant_shift_mean_residual_px: analysis.residuals.best_constant_shift_mean_px,
    areas: analysis.areas,
    badge_area_px: analysis.areas,
    bbox: analysis.bbox,
    badge_bbox_1920x1080: analysis.bbox,
    centroid_vs_bbox: analysis.centroid_vs_bbox,
    centroid_vs_bbox_max_px: analysis.centroid_vs_bbox_max_px,
    centroid_vs_bbox_flagged: analysis.centroid_vs_bbox_flagged,
    fix: analysis.fix,
    thresholds: {
      shift_min_px: SHIFT_AGREE_PX,
      match_max_px: TIMING_MAX_MATCH_PX,
      min_dt_s: TIMING_MIN_DT_S,
      min_ref_move_px: TIMING_MIN_REF_MOVE_PX,
      spread_single_delay_max_s: SPREAD_SINGLE_DELAY_MAX_S,
      centroid_bbox_flag_px: CENTROID_BBOX_FLAG_PX,
    },
  };
  return {
    verdict: {
      status,
      failed_bar: status === "PASS"
        ? null
        : analysis.kind === "timing"
          ? "Badge timing: render follows the same path but shifted in time (median offset at least 0.25 s)"
          : analysis.kind === "path"
            ? "Badge path: render badge follows a different path (median match distance over 20 px)"
            : "Badge timing: no sample passes the gates, so no offset can be measured",
      detail: status === "PASS"
        ? (onTime ? `Badge is on time (median offset ${analysis.median_offset_s} s).` : "Badge timing cannot be measured: no sample passes the gates.")
        : `${analysis.plain_words} ${analysis.fix}`,
    },
    numbers,
    corrections,
    context: {
      thresholds: numbers.thresholds,
      control_ceiling: null,
      meaning: analysis.kind === "timing"
        ? `${analysis.plain_words} The offset varies ${analysis.dt_min_s} to ${analysis.dt_max_s} s across the move, so it is a time warp, not a single delay.`
        : analysis.kind === "path"
          ? `${analysis.plain_words} A delay cannot fix a different path.`
          : analysis.plain_words,
    },
    next: `hme timing --ref ${ref} --render ${render} --object ${analysis.colour} --out ${outPath ?? "out/timing.json"}`,
    limits: [
      "The trace centroid uses the full mask mean, not the largest component: a second region sharing the badge colour would pull it. The report flags a centroid-vs-bbox-centre diff over 10 px.",
      "Badge areas come from the trace mask; the audit text cites larger areas (real 15,200 px at 5 s, 23,108 px at 7 s) than the trace gives (about 14,100 px at 5 s, 21,500 px at 7 s). The trace file is ground truth here.",
      "Times are compared in seconds, never in frame numbers: the two videos may run at different frame rates.",
    ],
  };
}

function videoDurationSeconds(videoPath) {
  const r = spawnSync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const d = Number(String(r.stdout).trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

// Run `hme trace` on one video into a temp profile file, and return
// the parsed profile, or null when the trace fails.
function traceVideoToProfile(videoPath, colour, tmpDir, tag) {
  const profilePath = join(tmpDir, `${tag}-profile.json`);
  const duration = videoDurationSeconds(videoPath);
  if (duration === null) {
    console.error(`hme timing: could not read the duration of ${videoPath} (ffprobe)`);
    return null;
  }
  const r = spawnSync(process.execPath, [
    HME, "trace", resolve(videoPath),
    "--start-s", "0", "--end-s", String(duration),
    "--skip-traces", "--badge-colour", colour,
    "--out", profilePath,
  ], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`hme timing: trace failed for ${videoPath}`);
    if (r.stderr) process.stderr.write(r.stderr);
    return null;
  }
  try {
    return JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (err) {
    console.error(`hme timing: could not read the trace profile for ${videoPath}: ${err.message}`);
    return null;
  }
}

function readProfile(arg) {
  const p = resolve(arg);
  if (!existsSync(p)) {
    console.error(`hme timing: no such file: ${arg}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`hme timing: cannot read profile ${arg}: ${err.message}`);
    return undefined;
  }
}

// Run `hme timing ...`. Returns the process exit code: 0 PASS,
// 1 FAIL, 2 usage or run error. Never prints a stack trace.
export async function runTiming(argv) {
  const parsed = parseTimingArgs(argv);
  if (parsed.error) {
    console.error(`hme timing: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const object = resolveObject(parsed.object);
  if (!object) {
    console.error(`hme timing: unknown object "${parsed.object}": give a hex colour like #CC4726, or a label from the alias table (${Object.keys(OBJECT_ALIASES).join(", ")})`);
    console.error(USAGE);
    return 2;
  }
  let refProfile = null;
  let renderProfile = null;
  let tmpDir = null;
  try {
    if (parsed.refProfile !== null) {
      refProfile = readProfile(parsed.refProfile);
      if (refProfile === undefined) return 2;
      renderProfile = readProfile(parsed.renderProfile);
      if (renderProfile === undefined) return 2;
    } else {
      for (const [flag, arg] of [["--ref", parsed.ref], ["--render", parsed.render]]) {
        if (!existsSync(resolve(arg))) {
          console.error(`hme timing: no such file: ${arg} (${flag})`);
          return 2;
        }
      }
      tmpDir = mkdtempSync(join(tmpdir(), "hme-timing-"));
      refProfile = traceVideoToProfile(parsed.ref, object.colour, tmpDir, "ref");
      if (refProfile === null) return 1;
      renderProfile = traceVideoToProfile(parsed.render, object.colour, tmpDir, "render");
      if (renderProfile === null) return 1;
    }
    let analysis;
    try {
      analysis = computeTiming({ refProfile, renderProfile, object });
    } catch (err) {
      console.error(`hme timing: ${err.message}`);
      return 1;
    }
    const report = buildInsightReport(analysis, {
      ref: parsed.refProfile ?? parsed.ref,
      render: parsed.renderProfile ?? parsed.render,
      outPath: parsed.out ? resolve(parsed.out) : null,
    });
    return writeInsightReport(report, parsed.out);
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}
