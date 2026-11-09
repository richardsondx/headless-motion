// pick-ease.mjs — easing/timing picker: pick motion by numbers, not words.
//
// Builds on src/scene/easing.mjs (18 named cubic-beziers + arbitrary bezier).
// It does not replace the easing library and does not edit it.
//
// Two modes:
//   --fit <reference-profile.json> --track <id>
//     Fit every named ease to a reference velocity profile taken from a
//     Unit A reference profile, and rank flow-guided interpolation
//     intervals (how many frames apart a trace can be warped before the
//     per-frame SSIM floor of 0.90 fails). --track accepts a shot id
//     (shot-01..shot-16) or a palette hex / target id (#1B073B,
//     target-1B073B). For a shot, the fitted track is the colour track
//     with the largest net centroid displacement inside that shot, read
//     as cumulative path progress sampled at 24 fps (clone frame f =
//     reference frame floor(f*2.5)). For a hex, the fit runs over the
//     shot that holds that track's peak-velocity frame.
//   --intent <travel|reveal|stamp|settle|draw|count-up> --frames N --distance D
//     Rank every named ease against a numeric target envelope for the
//     intent (peak/average velocity ratio, time-to-peak fraction,
//     overshoot cap, settle fraction). No adjective justifies a rank;
//     every candidate carries peak velocity, time-to-peak, overshoot,
//     settle time, and predicted per-frame RMS error.
//
// Every ranked candidate carries: peak_velocity, time_to_peak,
// overshoot, settle_time, rms_velocity_error (and rms_position_error
// when a reference exists). Output is JSON with fixed key order and
// fixed 4-decimal rounding, so the same input gives byte-identical
// output. Pure functions, no Date, no Math.random, no I/O in ranking.
//
// Defect classes cited in fit notes use Unit C taxonomy defects-v1
// (MOTION_ERR / MOTION_JUMP / HARD_FLOOR). A fit that fails the floor
// is a numbers failure, not a wording failure.
import { readFileSync, writeFileSync } from "node:fs";
import { CURVES, EASE_NAMES, ease } from "./easing.mjs";

export const FPS = 24;
export const FLOOR_SSIM = 0.9;
export const CANDIDATE_INTERVALS_60 = [1, 5, 10, 20, 40];

export const INTENT_NAMES = ["travel", "reveal", "stamp", "settle", "draw", "count-up"];

// Target envelope per intent. peak_ratio = peak velocity / average
// velocity. ttp_frac = time-to-peak as a fraction of the move.
// overshoot_max = largest allowed overshoot as a fraction of distance.
// settle_frac = largest allowed settle time as a fraction of the move.
export const INTENT_TARGETS = Object.freeze({
  travel: { peak_ratio: 1.8, ttp_frac: 0.35, overshoot_max: 0, settle_frac: 0.25 },
  reveal: { peak_ratio: 1.4, ttp_frac: 0.6, overshoot_max: 0, settle_frac: 0.3 },
  stamp: { peak_ratio: 2.5, ttp_frac: 0.15, overshoot_max: 0.1, settle_frac: 0.2 },
  settle: { peak_ratio: 1.5, ttp_frac: 0.7, overshoot_max: 0, settle_frac: 0.15 },
  draw: { peak_ratio: 1.0, ttp_frac: 0.5, overshoot_max: 0, settle_frac: 0.1 },
  "count-up": { peak_ratio: 2.0, ttp_frac: 0.85, overshoot_max: 0, settle_frac: 0.1 },
});

const r4 = (n) => Math.round(n * 10000) / 10000;

/** Positions 0..1 over `frames` frames for an ease name. */
export function sampleEase(name, frames) {
  const out = [];
  for (let i = 0; i < frames; i++) out.push(ease(name, frames <= 1 ? 1 : i / (frames - 1)));
  return out;
}

/** Per-frame velocity (units per frame) from positions. Length frames-1. */
export function velocityProfile(positions) {
  const v = [];
  for (let i = 0; i + 1 < positions.length; i++) v.push(positions[i + 1] - positions[i]);
  return v;
}

/**
 * Numbers for one candidate move. positions are in distance units
 * (0..distance); frames is the move length; refVelocity is the
 * reference per-frame velocity array or null.
 */
export function describeEase(name, positions, refVelocity) {
  const frames = positions.length;
  const v = velocityProfile(positions);
  const absV = v.map(Math.abs);
  const peak = Math.max(...absV, 0);
  const peakIdx = absV.indexOf(peak);
  const avg = frames > 1 ? (positions[frames - 1] - positions[0]) / (frames - 1) : 0;
  const maxPos = Math.max(...positions);
  const minPos = Math.min(...positions);
  const start = positions[0];
  const end = positions[frames - 1];
  const span = Math.abs(end - start) || 1;
  // Overshoot beyond the [start, end] span, in distance units.
  const overshoot = Math.max(0, maxPos - Math.max(start, end), Math.min(start, end) - minPos);
  // Settle time: first frame after the peak where |v| stays <= 5% of peak.
  const settleThreshold = 0.05 * peak;
  let settleIdx = frames - 1;
  for (let j = peakIdx; j < v.length; j++) {
    let settled = true;
    for (let k = j; k < v.length; k++) {
      if (Math.abs(v[k]) > settleThreshold) { settled = false; break; }
    }
    if (settled) { settleIdx = j; break; }
  }
  let rmsVelocity = null;
  let rmsPosition = null;
  if (refVelocity) {
    const n = Math.min(v.length, refVelocity.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += (v[i] - refVelocity[i]) ** 2;
    rmsVelocity = Math.sqrt(s / Math.max(n, 1));
  }
  return {
    name,
    frames,
    peak_velocity_per_frame: r4(peak),
    peak_velocity_per_s: r4(peak * FPS),
    peak_velocity_ratio_to_avg: r4(avg === 0 ? 0 : peak / Math.abs(avg)),
    time_to_peak_frames: peakIdx,
    time_to_peak_s: r4(peakIdx / FPS),
    time_to_peak_frac: r4(v.length ? peakIdx / v.length : 0),
    overshoot: r4(overshoot),
    overshoot_frac: r4(overshoot / span),
    settle_time_frames: settleIdx,
    settle_time_s: r4(settleIdx / FPS),
    settle_time_frac: r4(frames ? settleIdx / frames : 0),
    rms_velocity_error_per_frame: rmsVelocity === null ? null : r4(rmsVelocity),
    rms_position_error: rmsPosition,
  };
}

function rmsPositionError(candidate, reference) {
  const n = Math.min(candidate.length, reference.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (candidate[i] - reference[i]) ** 2;
  return Math.sqrt(s / Math.max(n, 1));
}

/**
 * Rank every named ease against a reference progress curve.
 * reference: array of positions, same units as distance (0..distance).
 * Returns candidates sorted by rms_velocity_error, then
 * rms_position_error, then name (deterministic tie-break).
 */
export function rankEases(reference, distance = 1) {
  const frames = reference.length;
  const refVelocity = velocityProfile(reference);
  const ranked = [];
  for (const name of EASE_NAMES) {
    const positions = sampleEase(name, frames).map((p) => p * distance);
    const d = describeEase(name, positions, refVelocity);
    d.rms_position_error = r4(rmsPositionError(positions, reference));
    ranked.push(d);
  }
  ranked.sort(
    (a, b) =>
      a.rms_velocity_error_per_frame - b.rms_velocity_error_per_frame ||
      a.rms_position_error - b.rms_position_error ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  ranked.forEach((c, i) => { c.rank = i + 1; });
  return ranked;
}

/**
 * Rank every named ease against an intent envelope. No reference
 * curve exists, so rms_velocity_error is the gap between the
 * candidate velocity profile and the intent's target peak ratio
 * shape, measured as the weighted score below; the reported
 * rms_velocity_error_per_frame is null and `intent_score` is the
 * ranking number (lower is closer to the target envelope).
 */
export function rankIntent(intent, frames, distance = 1) {
  const target = INTENT_TARGETS[intent];
  if (!target) throw new Error(`UNKNOWN_INTENT ${intent}`);
  const ranked = [];
  for (const name of EASE_NAMES) {
    const positions = sampleEase(name, frames).map((p) => p * distance);
    const d = describeEase(name, positions, null);
    const peakGap = Math.abs(d.peak_velocity_ratio_to_avg - target.peak_ratio) / target.peak_ratio;
    const ttpGap = Math.abs(d.time_to_peak_frac - target.ttp_frac);
    const overGap = Math.max(0, d.overshoot_frac - target.overshoot_max);
    const settleGap = Math.max(0, d.settle_time_frac - target.settle_frac);
    // Weights: peak shape 0.4, timing 0.3, overshoot 0.2, settle 0.1.
    d.intent_score = r4(0.4 * peakGap + 0.3 * ttpGap + 0.2 * overGap * 10 + 0.1 * settleGap);
    d.intent_target = {
      peak_ratio: target.peak_ratio,
      ttp_frac: target.ttp_frac,
      overshoot_max: target.overshoot_max,
      settle_frac: target.settle_frac,
    };
    ranked.push(d);
  }
  ranked.sort(
    (a, b) =>
      a.intent_score - b.intent_score ||
      a.rms_position_error - b.rms_position_error ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  ranked.forEach((c, i) => { c.rank = i + 1; });
  return ranked;
}

// ---- --fit: reference-profile support ----

function shotById(profile, id) {
  return (profile.shots || []).find((s) => s.id === id) || null;
}

function trackHex(track) {
  if (typeof track !== "string") return null;
  if (track.startsWith("#")) return track.toUpperCase();
  const m = /^target-([0-9A-Fa-f]{6})$/.exec(track);
  return m ? `#${m[1].toUpperCase()}` : null;
}

function shotOfPeak(profile, hex) {
  const derived = (profile.trajectory_derived || []).find((d) => d.hex === hex);
  if (!derived) return null;
  const f60 = derived.peak_velocity_frame_60;
  return (profile.shots || []).find((s) => f60 >= s.start_frame_60 && f60 < s.end_frame_60) || null;
}

/**
 * Cumulative path progress (0..1) of one colour track inside a shot,
 * sampled at 24 fps. Frames where the mask is absent (area 0) or the
 * area jumps by more than 25% between sampled frames are skipped, the
 * same appearance-jump filter the profile's velocity_filter uses.
 * Returns { positions, frames_24, skipped } or null when unusable.
 */
export function shotTrackProgress(profile, shot, hex) {
  const track = (profile.trajectories || {})[hex];
  if (!track) return null;
  const xs = track.x_ratio;
  const ys = track.y_ratio;
  const areas = track.area_frac;
  const W = 1920;
  const H = 1080;
  const start24 = Math.floor(shot.start_frame_60 / 2.5);
  const end24 = Math.floor(shot.end_frame_60 / 2.5);
  const pts = [];
  let skipped = 0;
  let prevArea = null;
  let breaks = 0;
  for (let f = start24; f <= end24; f++) {
    const f60 = Math.floor(f * 2.5);
    const area = areas[f60];
    if (!area || area <= 0) { skipped++; continue; }
    // Appearance jump (area ratio outside [0.8, 1.25]): keep the point
    // and re-baseline, but do not count the jumped segment as path
    // length. The old code never re-baselined, so one jump discarded
    // every later frame; shot-06 kept 3 of 232 frames that way.
    let jump = false;
    if (prevArea !== null && (area / prevArea < 0.8 || area / prevArea > 1.25)) { jump = true; breaks++; }
    prevArea = area;
    pts.push([xs[f60] * W, ys[f60] * H, jump]);
  }
  if (pts.length < 3) return null;
  const dist = [0];
  for (let i = 1; i < pts.length; i++) {
    dist.push(dist[i - 1] + (pts[i][2] ? 0 : Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])));
  }
  const total = dist[dist.length - 1];
  if (total <= 0) return null;
  return {
    positions: dist.map((d) => d / total),
    total_path_px: r4(total),
    frames_24: pts.length,
    skipped_frames: skipped,
    appearance_jumps: breaks,
    net_displacement_px: r4(Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1])),
  };
}

function bestTrackForShot(profile, shot) {
  const sampled = Math.floor(shot.end_frame_60 / 2.5) - Math.floor(shot.start_frame_60 / 2.5) + 1;
  const minUsable = Math.max(8, Math.floor(sampled / 2));
  const all = [];
  for (const hex of Object.keys(profile.trajectories || {})) {
    const progress = shotTrackProgress(profile, shot, hex);
    if (progress) all.push({ hex, progress });
  }
  // Prefer tracks present for at least half the shot; among those take
  // the largest net displacement. A sparse track (10 of 232 frames)
  // must not beat a full track on displacement alone.
  const dense = all.filter((c) => c.progress.frames_24 >= minUsable);
  const pool = dense.length ? dense : all;
  let best = null;
  for (const c of pool) {
    if (!best || c.progress.net_displacement_px > best.progress.net_displacement_px) best = c;
  }
  return best;
}

function traceStats(profile, shotId) {
  const rows = (profile.keyframes || []).filter((k) => k.shot_id === shotId);
  if (!rows.length) return null;
  const ssims = rows.map((k) => k.trace_ssim_960);
  const mean = ssims.reduce((a, b) => a + b, 0) / ssims.length;
  return {
    n_traces: rows.length,
    mean_trace_ssim: r4(mean),
    min_trace_ssim: r4(Math.min(...ssims)),
    traces_below_0_90: ssims.filter((s) => s < FLOOR_SSIM).length,
  };
}

/**
 * Rank warp intervals for one shot (or all shots) from the profile's
 * warp_intervals. interval is in 60 fps frames; interval_24 clamps
 * to >= 1 frame. keyframes_per_s at 24 fps = 60 / interval_60.
 * A interval passes when every measured SSIM at that interval is
 * >= FLOOR_SSIM (null = beyond the shot, not a failure).
 */
export function rankIntervals(profile, shotId = null) {
  const warps = (profile.warp_intervals || []).filter((w) => !shotId || w.shot_id === shotId);
  const ranked = CANDIDATE_INTERVALS_60.map((interval60) => {
    const ssims = [];
    let shotsPassing = 0;
    let shotsMeasured = 0;
    for (const w of warps) {
      const row = (w.warp || []).find((r) => r.distance_frames_60 === interval60);
      if (!row || row.ssim === null || row.ssim === undefined) continue;
      shotsMeasured++;
      ssims.push(row.ssim);
      if (row.ssim >= FLOOR_SSIM) shotsPassing++;
    }
    const mean = ssims.length ? ssims.reduce((a, b) => a + b, 0) / ssims.length : null;
    const interval24 = Math.max(1, interval60 / 2.5);
    return {
      interval_frames_60: interval60,
      interval_frames_24: r4(interval24),
      keyframes_per_s: r4(60 / interval60),
      shots_measured: shotsMeasured,
      shots_passing_floor: shotsPassing,
      mean_ssim: mean === null ? null : r4(mean),
      min_ssim: ssims.length ? r4(Math.min(...ssims)) : null,
      passes_floor: shotsMeasured > 0 && shotsPassing === shotsMeasured,
    };
  });
  // Rank: most shots passing first, then highest min SSIM, then
  // longest interval (fewest keyframes) among equal pass counts.
  ranked.sort(
    (a, b) =>
      b.shots_passing_floor - a.shots_passing_floor ||
      (b.min_ssim ?? -1) - (a.min_ssim ?? -1) ||
      b.interval_frames_60 - a.interval_frames_60,
  );
  ranked.forEach((c, i) => { c.rank = i + 1; });
  return ranked;
}

/** Per-shot recommended interval: largest interval passing the floor. */
export function recommendedIntervals(profile) {
  return (profile.warp_intervals || []).map((w) => {
    const passing = (w.warp || [])
      .filter((r) => r.ssim !== null && r.ssim !== undefined && r.ssim >= FLOOR_SSIM)
      .map((r) => r.distance_frames_60);
    const best = passing.length ? Math.max(...passing) : 1;
    const shot = shotById(profile, w.shot_id);
    const frames24 = shot ? Math.max(1, Math.round((shot.end_frame_60 - shot.start_frame_60) / 2.5)) : 0;
    const interval24 = Math.max(1, best / 2.5);
    return {
      shot_id: w.shot_id,
      profile_max_interval_frames_60: w["max_interval_frames_60_ssim_ge_0.90"],
      picker_max_interval_frames_60: best,
      agrees_with_profile: best === w["max_interval_frames_60_ssim_ge_0.90"],
      interval_frames_24: r4(interval24),
      keyframes_per_s: r4(60 / best),
      shot_frames_24: frames24,
      keyframes_needed: Math.ceil(frames24 / interval24),
      trace_stats: traceStats(profile, w.shot_id),
    };
  });
}

export function fitProfile(profile, track) {
  let shot = shotById(profile, track);
  let hex = trackHex(track);
  let trackNote;
  if (shot && !hex) {
    const best = bestTrackForShot(profile, shot);
    if (!best) throw new Error(`NO_USABLE_TRACK shot ${track}: no colour track moves inside it`);
    hex = best.hex;
    trackNote = `shot ${shot.id}: fitted track ${hex} (largest net displacement in shot, ${best.progress.net_displacement_px} px)`;
    var progress = best.progress;
  } else if (hex) {
    shot = shotOfPeak(profile, hex);
    if (!shot) throw new Error(`NO_SHOT_FOR_TRACK ${track}`);
    const prog = shotTrackProgress(profile, shot, hex);
    if (!prog) throw new Error(`NO_USABLE_TRACK ${track} in ${shot.id}`);
    trackNote = `track ${hex}: fitted over ${shot.id} (shot holding its peak-velocity frame ${profile.trajectory_derived.find((d) => d.hex === hex)?.peak_velocity_frame_60})`;
    var progress = prog;
  } else {
    throw new Error(`UNKNOWN_TRACK ${track}: use a shot id (shot-01..shot-16) or a palette hex (#1B073B)`);
  }
  const reference = progress.positions;
  const ranked = rankEases(reference, 1);
  const intervals = rankIntervals(profile, shot.id);
  const perShot = recommendedIntervals(profile);
  const totalKeyframes = perShot.reduce((a, s) => a + s.keyframes_needed, 0);
  const profileTotal = (profile.keyframes || []).length;
  return {
    mode: "fit",
    tool: "pick-ease.mjs",
    predicate: profile.predicate || "pred-v1",
    fps: FPS,
    floor_ssim: FLOOR_SSIM,
    track: hex,
    shot_id: shot.id,
    shot_start_s: shot.start_s,
    shot_end_s: shot.end_s,
    shot_frames_24: Math.max(1, Math.round((shot.end_frame_60 - shot.start_frame_60) / 2.5)),
    track_note: trackNote,
    reference: {
      kind: "cumulative path progress of colour-centroid track, 0..1, sampled at 24 fps",
      frames: reference.length,
      total_path_px: progress.total_path_px,
      net_displacement_px: progress.net_displacement_px,
      skipped_frames: progress.skipped_frames,
      appearance_jumps: progress.appearance_jumps,
      caveat: "Centroid of a colour mask, not a single element; segments crossing an area-ratio jump outside [0.8, 1.25] add 0 path length, per the profile velocity_filter.",
    },
    ranked_eases: ranked,
    ranked_intervals_shot: intervals,
    recommended_intervals_per_shot: perShot,
    keyframe_density: {
      total_keyframes_needed_24fps: totalKeyframes,
      profile_keyframe_count: profileTotal,
      window_frames_24: 1800,
      keyframes_per_240_frames: r4((totalKeyframes / 1800) * 240),
      note: "Sum over shots of ceil(shot frames at 24 fps / recommended interval at 24 fps). Tournament floor: 108 keyframes per 240 frames on Seg3; this window needs fewer because most shots hold interval 40 at 60 fps.",
    },
  };
}

// ---- CLI ----
function usage() {
  return [
    "pick-ease.mjs — pick motion by numbers, not words",
    "  node src/scene/pick-ease.mjs --fit <reference-profile.json> --track <shot-id|#hex> [--out <file>]",
    "  node src/scene/pick-ease.mjs --intent <travel|reveal|stamp|settle|draw|count-up> --frames N --distance N [--out <file>]",
    "  node src/scene/pick-ease.mjs --reference <positions.json> [--distance N] [--out <file>]",
    "positions.json: {\"positions\": [0, ..., 1]} or a bare array.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._ = a;
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  let result;
  if (args.fit) {
    if (!args.track) throw new Error("MISSING --track for --fit");
    const profile = JSON.parse(readFileSync(args.fit, "utf8"));
    result = fitProfile(profile, args.track);
  } else if (args.intent) {
    const frames = Number(args.frames || 48);
    const distance = Number(args.distance || 100);
    if (!Number.isFinite(frames) || frames < 2) throw new Error("INVALID --frames (need >= 2)");
    result = {
      mode: "intent",
      tool: "pick-ease.mjs",
      intent: args.intent,
      frames,
      distance,
      fps: FPS,
      ranked_eases: rankIntent(args.intent, frames, distance),
    };
  } else if (args.reference) {
    const raw = JSON.parse(readFileSync(args.reference, "utf8"));
    const positions = Array.isArray(raw) ? raw : raw.positions;
    if (!Array.isArray(positions) || positions.length < 2) throw new Error("INVALID --reference (need positions array, length >= 2)");
    const distance = Number(args.distance || 1);
    result = {
      mode: "reference",
      tool: "pick-ease.mjs",
      frames: positions.length,
      distance,
      fps: FPS,
      ranked_eases: rankEases(positions, distance),
    };
  } else {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, text);
  else process.stdout.write(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`pick-ease: ${err.message}\n`);
    process.exitCode = 1;
  }
}
