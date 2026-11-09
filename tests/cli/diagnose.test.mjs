// Fast tests for `hme diagnose`. None of these run a real diagnose:
// the real pair takes about a minute in Python, so it is checked by
// the VERIFY run, not here. These tests cover the CLI surface and the
// pure pieces: move wording, frame-time parsing, and the insight
// report built from the Seg4 7s ground-truth numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  moveWords,
  parseAtS,
  buildCorrections,
  buildInsightReport,
  parseTrajectory,
  trajectoryAt,
  matchTrajectoryTime,
  timingInfo,
} from "../../src/cli/diagnose.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
const SCENE = "tests/fixtures/seg4-scene-clone-v5.json";
const TRACE_REF = "verify-seg4/evidence/work/teardown-diff/real/reference-profile.json";
const TRACE_OURS = "verify-seg4/evidence/work/teardown-diff/v5-resubject/reference-profile.json";

// The real trace profiles, read once for the timing tests.
function realTrajectories() {
  return {
    ref: parseTrajectory(JSON.parse(readFileSync(join(ROOT, TRACE_REF), "utf8"))),
    ours: parseTrajectory(JSON.parse(readFileSync(join(ROOT, TRACE_OURS), "utf8"))),
  };
}

// The Seg4 7s ground truth, from
// verify-seg4/evidence/work/overlay-7s/overlay-report.json, plus the
// centroids the driver returns from overlay.element_masks.
function fake7s() {
  return {
    report: {
      label: "overlay check",
      shape: [1080, 1920, 3],
      mean_abs_diff: 11.29,
      mean_abs_diff_by_channel: [13.08, 10.46, 10.32],
      layers: {
        sudan: { real_pixels: 255800, ours_pixels: 159808, union_pixels: 260850, mean_abs_diff: 12.79, intersection_pixels: 154758, mean_abs_diff_intersection: 5.18 },
        base: { real_pixels: 1634431, ours_pixels: 987838, union_pixels: 1704042, mean_abs_diff: 10.25, intersection_pixels: 918227, mean_abs_diff_intersection: 4.93 },
        rsf: { real_pixels: 16819, ours_pixels: 24933, union_pixels: 25324, mean_abs_diff: 15.98, intersection_pixels: 16428, mean_abs_diff_intersection: 2.64 },
        october: { real_pixels: 896, ours_pixels: 1195, union_pixels: 2086, mean_abs_diff: 126.31, intersection_pixels: 5, mean_abs_diff_intersection: 5.0 },
        white_text: { real_pixels: 7357, ours_pixels: 5464, union_pixels: 11990, mean_abs_diff: 159.14, intersection_pixels: 831, mean_abs_diff_intersection: 40.0 },
      },
      shifts: {
        sudan: { status: "unreliable", shift: { dx_px: -72.0, dy_px: 115.1, magnitude_px: 135.8, phase_error: 1.0, iou_before: 0.5971, iou_after_shift: 0.3842 }, reliable: false, centroid_delta_px: { dx_px: 0.2, dy_px: -6.3 }, real_pixels: 253757, ours_pixels: 157622 },
        rsf: { status: "unreliable", shift: { dx_px: -0.8, dy_px: 19.1, magnitude_px: 19.1, phase_error: 1.0, iou_before: 0.3869, iou_after_shift: 0.3812 }, reliable: false, centroid_delta_px: { dx_px: 1.2, dy_px: 9.8 }, real_pixels: 10113, ours_pixels: 24848 },
        october: { status: "too_small_to_measure", shift: null, reliable: null, centroid_delta_px: null, real_pixels: 896, ours_pixels: 1195 },
        sudan_label: { status: "measured", shift: { dx_px: 0.8, dy_px: 0.1, magnitude_px: 0.8, phase_error: 1.0, iou_before: 0.5365, iou_after_shift: 0.5879 }, reliable: true, centroid_delta_px: { dx_px: -1.6, dy_px: 0.5 }, real_pixels: 2454, ours_pixels: 2810 },
        el_fasher_label: { status: "unreliable", shift: { dx_px: -53.0, dy_px: -1.8, magnitude_px: 53.0, phase_error: 1.0, iou_before: 0.0574, iou_after_shift: 0.0186 }, reliable: false, centroid_delta_px: { dx_px: -7.8, dy_px: 2.8 }, real_pixels: 211, ours_pixels: 2424 },
        el_fasher_dot: { status: "unreliable", shift: { dx_px: 1.1, dy_px: 23.1, magnitude_px: 23.1, phase_error: 1.0, iou_before: 0.0912, iou_after_shift: 0.0912 }, reliable: false, centroid_delta_px: { dx_px: 0.0, dy_px: -9.7 }, real_pixels: 32, ours_pixels: 351 },
      },
      stroke: {
        real: { red_pixels_whole_frame: 0, red_pixels_around_sudan: 0 },
        ours: { red_pixels_whole_frame: 8360, red_pixels_around_sudan: 8360 },
        sudan_bbox: [656, 270, 1326, 838],
      },
      rifle: { real_bbox: [618, 652, 774, 818], real: 4090, ours_bbox: [614, 650, 772, 814], ours: 131 },
      corrections: [
        "Sudan: move 6 px up (from centroids; phase correlation disagreed)",
        "RSF badge: move 1 px right, 10 px down (from centroids; phase correlation disagreed)",
        "EL FASHER label: move 8 px left, 3 px down (from centroids; phase correlation disagreed)",
        "Sudan: remove the red subject stroke (ours has 8360 red pixels around Sudan, real has 0)",
        "RSF badge: add the rifle (real has 4090 rifle pixels inside the badge, ours has 131)",
      ],
      limits: ["Real frames are screenshots of a compressed YouTube stream, not studio frames."],
    },
    segments: {
      real: {
        sudan: { centroid: [994.2, 528.3], bbox: [656, 270, 1326, 838], present: true },
        rsf: { centroid: [690.8, 719.0], bbox: [618, 652, 774, 818], present: true },
      },
      ours: {
        sudan: { centroid: [994.4, 522.0], bbox: [656, 270, 1326, 838], present: true },
        rsf: { centroid: [692.0, 728.8], bbox: [614, 650, 772, 814], present: true },
      },
    },
    centroids: {
      sudan: { real: [994.2, 528.3], ours: [994.4, 522.0] },
      rsf: { real: [690.8, 719.0], ours: [692.0, 728.8] },
      october: { real: [894.0, 943.0], ours: [750.0, 509.0] },
      sudan_label: { real: [982.17, 528.58], ours: [980.54, 529.07] },
      el_fasher_label: { real: [856.83, 637.02], ours: [849.01, 639.78] },
      el_fasher_dot: { real: [788.5, 650.5], ours: [788.5, 640.8] },
    },
  };
}

test("diagnose --help prints usage and exits 0", () => {
  const r = run(["diagnose", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme diagnose"));
  assert.ok(r.stdout.includes("Usage: hme diagnose <ref-frame.png> <ours-frame.png> --scene <scene.json>"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("diagnose with no arguments is a usage error, not 'not implemented yet'", () => {
  const r = run(["diagnose"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs two frames"));
  assert.ok(!r.stderr.includes("not implemented yet"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("diagnose without --scene is a usage error", () => {
  const r = run(["diagnose", "real-7s.png", "v5-7s.png"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--scene is required"));
});

test("diagnose with a missing reference file exits 2 with a plain error", () => {
  const r = run(["diagnose", "no-such-ref.png", "v5-7s.png", "--scene", SCENE]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-ref.png"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("moveWords says the move in plain words and drops moves under 1 px", () => {
  assert.equal(moveWords(1.2, 9.8), "1 px right, 10 px down");
  assert.equal(moveWords(0.2, -6.3), "6 px up");
  assert.equal(moveWords(-7.8, 2.8), "8 px left, 3 px down");
  assert.equal(moveWords(0.8, 0.1), "");
});

test("parseAtS reads the seconds from a frame name", () => {
  assert.equal(parseAtS("real-7s.png"), 7);
  assert.equal(parseAtS("v5-1.5s.png"), 1.5);
  assert.equal(parseAtS("frame.png"), null);
});

test("buildCorrections reproduces the 7s ground-truth corrections", () => {
  const cs = buildCorrections(fake7s(), { atS: 7, ref: "real-7s.png", ours: "v5-7s.png" });
  assert.deepEqual(cs.map((c) => c.fix), fake7s().report.corrections);
  assert.equal(cs.length, 5);
  const badge = cs.find((c) => c.element === "badge-rsf");
  assert.deepEqual(badge.shift_px, { dx: 1.2, dy: 9.8 });
  assert.equal(badge.kind, "position");
  assert.equal(badge.at_s, 7);
  assert.equal(badge.ours.px, 24848);
  assert.equal(badge.real.px, 10113);
  const stroke = cs.find((c) => c.fix.includes("red subject stroke"));
  assert.equal(stroke.ours.px, 8360);
  assert.equal(stroke.real.px, 0);
  const rifle = cs.find((c) => c.fix.includes("add the rifle"));
  assert.equal(rifle.element, "rifle-rsf");
  assert.equal(rifle.ours.px, 131);
  assert.equal(rifle.real.px, 4090);
  // The dot is excepted: its masks differ by more than 3x, so no
  // dot correction appears even though its centroid moved 10 px.
  assert.equal(cs.some((c) => c.element === "dot-fasher"), false);
  // The SUDAN label moved under 1 px, so it has no correction.
  assert.equal(cs.some((c) => c.element === "label-sudan"), false);
});

test("buildInsightReport fails on the 7s pair and passes the insight validator", () => {
  const report = buildInsightReport(fake7s(), {
    ref: "real-7s.png", ours: "v5-7s.png", scene: SCENE,
    sceneId: "seg4-scene-v5", atS: 7, outPath: "/tmp/u3/diagnose-7s.json", outDir: "/tmp/u3",
  });
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("Zero corrections"));
  assert.equal(report.numbers.mean_abs_diff, 11.29);
  assert.equal(report.numbers.at_s, 7);
  assert.equal(report.numbers.files.overlay_png, "/tmp/u3/overlay.png");
  assert.equal(report.numbers.files.diff_png, "/tmp/u3/diff.png");
  assert.equal(report.next, `hme render ${SCENE} --profile draft --out out/seg4-scene-v5`);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("buildInsightReport passes when nothing needs a correction", () => {
  const m = fake7s();
  for (const row of Object.values(m.report.shifts)) {
    row.status = "measured";
    row.shift = { dx_px: 0.2, dy_px: 0.1, magnitude_px: 0.2, phase_error: 1.0, iou_before: 0.9, iou_after_shift: 0.95 };
    row.centroid_delta_px = { dx_px: 0.2, dy_px: 0.1 };
  }
  m.report.stroke.ours.red_pixels_around_sudan = 0;
  m.report.rifle.ours = 4090;
  const report = buildInsightReport(m, {
    ref: "real-7s.png", ours: "v5-7s.png", scene: SCENE,
    sceneId: "seg4-scene-v5", atS: 7, outPath: null, outDir: "/tmp/u3",
  });
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  assert.deepEqual(report.corrections, []);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

// The 5s pair as the judge ran it: the screenshot pair real-5s.png
// vs v5-5s.png, measured by hme diagnose before the timing fix.
// The real screenshot is about 0.75 s late, so both badges sit near
// (790, 650) and the single-pair badge correction is a small
// position move, dx +12.3 dy +29. That is the failure the timing fix
// addresses: one frame pair cannot see that our badge at 5 s is
// where the real badge is at 5.75 s.
function fake5s() {
  return {
    report: {
      label: "overlay check",
      shape: [1080, 1920, 3],
      mean_abs_diff: 11.43,
      mean_abs_diff_by_channel: [13.11, 10.73, 10.45],
      layers: {
        sudan: { real_pixels: 196039, ours_pixels: 126047, union_pixels: 200846, mean_abs_diff: 12.6, intersection_pixels: 121240, mean_abs_diff_intersection: 5.17 },
        base: { real_pixels: 1722645, ours_pixels: 937737, union_pixels: 1777911, mean_abs_diff: 10.62, intersection_pixels: 882471, mean_abs_diff_intersection: 4.85 },
        rsf: { real_pixels: 11857, ours_pixels: 20048, union_pixels: 20144, mean_abs_diff: 16.12, intersection_pixels: 11761, mean_abs_diff_intersection: 2.83 },
        october: { real_pixels: 814, ours_pixels: 2974, union_pixels: 3786, mean_abs_diff: 131.72, intersection_pixels: 2, mean_abs_diff_intersection: 7.5 },
        white_text: { real_pixels: 6992, ours_pixels: 2603, union_pixels: 8887, mean_abs_diff: 162.96, intersection_pixels: 708, mean_abs_diff_intersection: 40.02 },
      },
      shifts: {
        sudan: { status: "unreliable", shift: { dx_px: 68.9, dy_px: 147.0, magnitude_px: 162.3, phase_error: 1.0, iou_before: 0.6086, iou_after_shift: 0.2599 }, reliable: false, centroid_delta_px: { dx_px: -2.7, dy_px: -6.0 }, real_pixels: 193464, ours_pixels: 123551 },
        rsf: { status: "unreliable", shift: { dx_px: 32.2, dy_px: -2.1, magnitude_px: 32.3, phase_error: 1.0, iou_before: 0.3363, iou_after_shift: 0.2597 }, reliable: false, centroid_delta_px: { dx_px: 12.3, dy_px: 29.0 }, real_pixels: 6801, ours_pixels: 19995 },
        october: { status: "too_small_to_measure", shift: null, reliable: null, centroid_delta_px: null, real_pixels: 814, ours_pixels: 2974 },
        sudan_label: { status: "measured", shift: { dx_px: 3.2, dy_px: -0.2, magnitude_px: 3.2, phase_error: 1.0, iou_before: 0.4499, iou_after_shift: 0.5674 }, reliable: true, centroid_delta_px: { dx_px: -2.3, dy_px: -0.8 }, real_pixels: 1805, ours_pixels: 2275 },
        el_fasher_label: { status: "absent_in_real", shift: null, reliable: null, centroid_delta_px: null, real_pixels: 0, ours_pixels: 89 },
        el_fasher_dot: { status: "absent_in_real", shift: null, reliable: null, centroid_delta_px: null, real_pixels: 0, ours_pixels: 21 },
      },
      stroke: {
        real: { red_pixels_whole_frame: 0, red_pixels_around_sudan: 0 },
        ours: { red_pixels_whole_frame: 6339, red_pixels_around_sudan: 6339 },
        sudan_bbox: [674, 280, 1282, 782],
      },
      rifle: { real_bbox: [732, 594, 870, 742], real: 3352, ours_bbox: [728, 592, 870, 740], ours: 143 },
      limits: ["Real frames are screenshots of a compressed YouTube stream, not studio frames."],
    },
    segments: {
      real: {
        sudan: { centroid: [990.0, 497.9], bbox: [674, 280, 1282, 782], present: true },
        rsf: { centroid: [785.9, 633.8], bbox: [732, 594, 870, 742], present: true },
      },
      ours: {
        sudan: { centroid: [987.3, 491.9], bbox: [674, 280, 1282, 782], present: true },
        rsf: { centroid: [798.2, 662.8], bbox: [728, 592, 870, 740], present: true },
      },
    },
    centroids: {
      sudan: { real: [990.0, 497.9], ours: [987.3, 491.9] },
      rsf: { real: [785.9, 633.8], ours: [798.2, 662.8] },
      october: { real: [894.0, 943.0], ours: [750.0, 509.0] },
      sudan_label: { real: [974.0, 504.8], ours: [971.7, 504.0] },
      el_fasher_label: { real: null, ours: null },
      el_fasher_dot: { real: null, ours: null },
    },
  };
}

test("buildCorrections without trajectories reproduces the judge's 5s result", () => {
  const cs = buildCorrections(fake5s(), { atS: 5, ref: "real-5s.png", ours: "v5-5s.png" });
  const badge = cs.find((c) => c.element === "badge-rsf");
  assert.equal(badge.kind, "position");
  assert.deepEqual(badge.shift_px, { dx: 12.3, dy: 29 });
  assert.equal(badge.fix, "RSF badge: move 12 px right, 29 px down (from centroids; phase correlation disagreed)");
});

test("parseTrajectory reads the trace profile shape and drops absent frames", () => {
  const traj = parseTrajectory({
    badge_trajectory: {
      frames: [0, 1, 2],
      time_s: [0, 0.5, 1.0],
      x_1920x1080: [100, null, 120],
      y_1920x1080: [200, null, 220],
      area_frac: [0.01, 0, 0.02],
    },
  });
  assert.deepEqual(traj.samples.map((s) => s.t), [0, 1.0]);
  assert.equal(traj.samples[1].px, Math.round(0.02 * 1920 * 1080));
  assert.equal(parseTrajectory({}), null);
  assert.equal(parseTrajectory({ badge_trajectory: { time_s: [0], x_1920x1080: [1], y_1920x1080: [2] } }), null);
});

test("trajectoryAt interpolates and returns null outside the range", () => {
  const traj = parseTrajectory({
    badge_trajectory: {
      time_s: [0, 10],
      x_1920x1080: [0, 100],
      y_1920x1080: [0, 50],
      area_frac: [0.01, 0.01],
    },
  });
  assert.deepEqual(trajectoryAt(traj, 5), { x: 50, y: 25, px: Math.round(0.01 * 1920 * 1080) });
  assert.equal(trajectoryAt(traj, -1), null);
  assert.equal(trajectoryAt(traj, 11), null);
  assert.equal(trajectoryAt(null, 5), null);
});

test("matchTrajectoryTime finds the second our badge sits at", () => {
  const ref = parseTrajectory({
    badge_trajectory: {
      time_s: [0, 1, 2],
      x_1920x1080: [0, 100, 200],
      y_1920x1080: [0, 0, 0],
      area_frac: [0.01, 0.01, 0.01],
    },
  });
  const m = matchTrajectoryTime(ref, { x: 150, y: 0 });
  assert.equal(m.t, 1.5);
  assert.equal(m.dist, 0);
});

test("timingInfo on the real traces fires at 5s with the 0.75 s error", () => {
  const t = realTrajectories();
  const info = timingInfo({ atS: 5, trajectories: t });
  assert.equal(info.fired, true);
  assert.deepEqual(info.shift_px, { dx: 169.4, dy: -69.2 });
  assert.deepEqual([info.ours.x, info.ours.y], [797, 663.2]);
  assert.deepEqual([info.real.x, info.real.y], [966.4, 594]);
  assert.equal(info.matched_at_s, 5.73);
  assert.equal(info.match_distance_px, 1.5);
  assert.equal(info.dt_s, 0.73);
  assert.equal(info.dt_headline_s, 0.75);
  assert.equal(info.fix, "RSF badge: move the badge path 0.75 s later; at 5 s it sits where the real badge is at 5.75 s");
});

test("timingInfo on the real traces does not fire at 7s or 1s", () => {
  const t = realTrajectories();
  assert.equal(timingInfo({ atS: 7, trajectories: t }).fired, false);
  assert.equal(timingInfo({ atS: 1, trajectories: t }).fired, false);
  assert.equal(timingInfo({ atS: 5, trajectories: null }), null);
});

test("buildCorrections with trajectories returns kind timing at 5s", () => {
  const t = realTrajectories();
  const cs = buildCorrections(fake5s(), { atS: 5, ref: "real-5s.png", ours: "v5-5s.png", trajectories: t });
  const badges = cs.filter((c) => c.element === "badge-rsf");
  assert.equal(badges.length, 1);
  const badge = badges[0];
  assert.equal(badge.kind, "timing");
  assert.deepEqual(badge.shift_px, { dx: 169.4, dy: -69.2 });
  assert.deepEqual([badge.ours.x, badge.ours.y], [797, 663.2]);
  assert.deepEqual([badge.real.x, badge.real.y], [966.4, 594]);
  assert.equal(badge.fix, "RSF badge: move the badge path 0.75 s later; at 5 s it sits where the real badge is at 5.75 s");
  // The other 5s corrections survive: Sudan, SUDAN label, stroke, rifle.
  assert.equal(cs.length, 5);
  assert.ok(cs.some((c) => c.fix.includes("red subject stroke")));
  assert.ok(cs.some((c) => c.fix.includes("add the rifle")));
  assert.ok(cs.some((c) => c.element === "label-sudan"));
});

test("buildCorrections with trajectories keeps the 7s pair unchanged", () => {
  const t = realTrajectories();
  const plain = buildCorrections(fake7s(), { atS: 7, ref: "real-7s.png", ours: "v5-7s.png" });
  const withTraces = buildCorrections(fake7s(), { atS: 7, ref: "real-7s.png", ours: "v5-7s.png", trajectories: t });
  assert.deepEqual(withTraces, plain);
});

test("buildInsightReport with trajectories records the timing numbers and validates", () => {
  const t = realTrajectories();
  const report = buildInsightReport(fake5s(), {
    ref: "real-5s.png", ours: "v5-5s.png", scene: SCENE,
    sceneId: "seg4-scene-v5", atS: 5, outPath: "/tmp/u3/diagnose-5s.json", outDir: "/tmp/u3",
    trajectories: t,
  });
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.numbers.timing.fired, true);
  assert.equal(report.numbers.timing.dt_headline_s, 0.75);
  assert.deepEqual(report.numbers.timing.shift_px, { dx: 169.4, dy: -69.2 });
  assert.ok(report.corrections.some((c) => c.kind === "timing"));
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("buildInsightReport without trajectories records timing null", () => {
  const report = buildInsightReport(fake5s(), {
    ref: "real-5s.png", ours: "v5-5s.png", scene: SCENE,
    sceneId: "seg4-scene-v5", atS: 5, outPath: null, outDir: "/tmp/u3",
  });
  assert.equal(report.numbers.timing, null);
  assert.equal(report.corrections.find((c) => c.element === "badge-rsf").kind, "position");
});

test("diagnose usage text documents the trace options", () => {
  // The command's own usage text (printed on a usage error) documents
  // the trace options. The hme --help registry lives in hme.mjs,
  // outside this fix cycle's scope, so it does not list them yet.
  const r = run(["diagnose", "a.png", "b.png", "--scene", SCENE, "--trace-ref", "trace.json"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--trace-ref"));
  assert.ok(r.stderr.includes("--trace-ours"));
  assert.ok(r.stderr.includes("0.75 s later"));
});

test("diagnose with only one trace option is a usage error", () => {
  const r = run(["diagnose", "a.png", "b.png", "--scene", SCENE, "--trace-ref", "trace.json"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("go together"));
});

test("diagnose with a missing trace file exits 2 with a plain error", () => {
  const r = run(["diagnose", "verify-seg4/evidence/work/real-7s.png", "verify-seg4/evidence/work/v5-7s.png", "--scene", SCENE, "--trace-ref", "no-such-trace.json", "--trace-ours", TRACE_OURS]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-trace.json"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});
