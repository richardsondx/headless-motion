// Fast tests for `hme timing`. None of these run a real video
// trace: the video path is checked by the VERIFY run, not here.
// These tests cover the CLI surface and the pure pieces: object
// resolution, arg parsing, the Seg4 analysis from the two real
// trace profiles, the synthetic timing / path / on-time cases, and
// the insight report.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveObject,
  parseTimingArgs,
  trajectorySamples,
  bboxCentreAt,
  computeTiming,
  buildInsightReport,
} from "../../src/cli/timing.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
const TRACE_REF = "verify-seg4/evidence/work/teardown-diff/real/reference-profile.json";
const TRACE_OURS = "verify-seg4/evidence/work/teardown-diff/v5-resubject/reference-profile.json";

function seg4Profiles() {
  return {
    refProfile: JSON.parse(readFileSync(join(ROOT, TRACE_REF), "utf8")),
    renderProfile: JSON.parse(readFileSync(join(ROOT, TRACE_OURS), "utf8")),
  };
}

function seg4Analysis() {
  const { refProfile, renderProfile } = seg4Profiles();
  return computeTiming({
    refProfile,
    renderProfile,
    object: resolveObject("#CC4726"),
  });
}

// A synthetic profile: a dot moving on a straight line, one sample
// per frame at 24 fps over 8 s.
function lineProfile(fn, fps = 24) {
  const n = 8 * fps + 1;
  const time_s = [];
  const x = [];
  const y = [];
  const area = [];
  const bbox = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    time_s.push(Math.round(t * 1000) / 1000);
    const p = fn(t);
    x.push(p[0]);
    y.push(p[1]);
    area.push(0.005);
    bbox.push([p[0] - 50, p[1] - 50, p[0] + 50, p[1] + 50]);
  }
  return {
    badge_trajectory: {
      frames: [...Array(n).keys()],
      time_s,
      x_1920x1080: x,
      y_1920x1080: y,
      area_frac: area,
      bbox_1920x1080: bbox,
    },
  };
}

test("timing --help lists the command, its flags, and one example", () => {
  const r = run(["timing", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme timing"));
  assert.ok(r.stdout.includes("--ref"));
  assert.ok(r.stdout.includes("--render"));
  assert.ok(r.stdout.includes("--object"));
  assert.ok(r.stdout.includes("--out"));
  assert.ok(r.stdout.includes("--ref-profile"));
  assert.ok(r.stdout.includes("--render-profile"));
  assert.ok(r.stdout.includes("Example: hme timing"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("timing with no arguments is a usage error", () => {
  const r = run(["timing"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs --ref and --render"));
  assert.ok(!r.stderr.includes("not implemented yet"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("timing with only one profile is a usage error", () => {
  const r = run(["timing", "--ref-profile", TRACE_REF]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("go together"));
});

test("timing with a missing video exits 2 with a plain error", () => {
  const r = run(["timing", "--ref", "no-such-ref.mp4", "--render", "ours.mp4"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-ref.mp4"));
});

test("timing with an unknown object label exits 2 and names the alias table", () => {
  const r = run(["timing", "--ref-profile", TRACE_REF, "--render-profile", TRACE_OURS, "--object", "Green dot"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("unknown object"));
  assert.ok(r.stderr.includes("RSF badge"));
});

test("resolveObject takes a hex colour, a label, or the default", () => {
  assert.deepEqual(resolveObject("#cc4726"), { colour: "#CC4726", label: null, input: "#cc4726" });
  assert.deepEqual(resolveObject("RSF badge"), { colour: "#CC4726", label: "RSF badge", input: "RSF badge" });
  assert.deepEqual(resolveObject("rsf badge"), { colour: "#CC4726", label: "rsf badge", input: "rsf badge" });
  assert.deepEqual(resolveObject(undefined), { colour: "#CC4726", label: null, input: "#CC4726" });
  assert.equal(resolveObject("Green dot"), null);
  assert.equal(resolveObject("#12345"), null);
});

test("parseTimingArgs parses both input forms", () => {
  const videos = parseTimingArgs(["--ref", "r.mp4", "--render", "o.mp4", "--object", "RSF badge", "--out", "t.json"]);
  assert.equal(videos.error, null);
  assert.equal(videos.ref, "r.mp4");
  assert.equal(videos.object, "RSF badge");
  const profiles = parseTimingArgs(["--ref-profile", "r.json", "--render-profile", "o.json"]);
  assert.equal(profiles.error, null);
  assert.equal(profiles.refProfile, "r.json");
  assert.equal(parseTimingArgs(["--ref", "r.mp4"]).error, "needs --ref and --render, or --ref-profile and --render-profile");
  assert.equal(parseTimingArgs(["timing"]).error, 'unexpected argument "timing"');
  assert.equal(parseTimingArgs(["--nope"]).error, 'unknown option "--nope"');
  assert.equal(parseTimingArgs(["--ref"]).error, 'option "--ref" needs a value');
});

test("trajectorySamples reads the trace shape and drops absent frames", () => {
  const { refProfile } = seg4Profiles();
  const samples = trajectorySamples(refProfile);
  assert.equal(samples.length, 97);
  assert.equal(samples[0].t, 3.712);
  assert.equal(samples[samples.length - 1].t, 7.716);
  assert.equal(samples[0].area_px, 415);
  assert.deepEqual(samples[0].bbox, [980, 684, 1044, 690]);
  assert.deepEqual(trajectorySamples({}), []);
});

test("bboxCentreAt interpolates the bbox centre", () => {
  const samples = [
    { t: 0, bbox: [0, 0, 100, 100] },
    { t: 10, bbox: [100, 0, 300, 100] },
  ];
  assert.deepEqual(bboxCentreAt(samples, 5), { x: 125, y: 50 });
  assert.equal(bboxCentreAt(samples, -1), null);
  assert.equal(bboxCentreAt(samples, 11), null);
  assert.equal(bboxCentreAt([], 5), null);
});

test("Seg4 analysis: kind timing, median 0.71 s, warp 0.46 to 1.08 s", () => {
  const a = seg4Analysis();
  assert.equal(a.kind, "timing");
  assert.equal(a.median_offset_s, 0.71);
  assert.equal(a.median_dt_s, 0.71);
  assert.equal(a.signed_offset_s, -0.71);
  assert.equal(a.offset_direction, "early");
  assert.equal(a.plain_words, "The render is 0.71 s early (median).");
  assert.equal(a.dt_at_5s_s, 0.73);
  assert.equal(a.dt_min_s, 0.46);
  assert.equal(a.dt_max_s, 1.08);
  assert.equal(a.dt_spread_s, 0.62);
  assert.equal(a.is_warp, true);
  assert.equal(a.single_delay_suffices, false);
  assert.deepEqual(a.window, { start_s: 4, end_s: 6.5, samples: 61, samples_gated: 61 });
  assert.equal(a.samples.length, 61);
  assert.ok(a.median_match_distance_px <= 20);
  assert.equal(a.median_match_distance_px, 1.6);
  assert.equal(a.max_match_distance_px, 8.7);
});

test("Seg4 analysis: grid numbers are -0.79 s, 20.3 px, 96.2 px", () => {
  const a = seg4Analysis();
  assert.ok(Math.abs(a.residuals.best_constant_shift_s - -0.79) <= 0.1);
  assert.ok(Math.abs(a.residuals.best_constant_shift_mean_px - 20.3) <= 5);
  assert.ok(Math.abs(a.residuals.unshifted_mean_px - 96.2) <= 5);
});

test("Seg4 analysis: trajectories match the trace within 15 px at 4, 5, 6, 7 s", () => {
  const a = seg4Analysis();
  const ground = {
    ref: { 4: [981, 634], 5: [966, 594], 6: [752, 693], 7: [696, 728] },
    render: { 4: [967, 594], 5: [797, 663], 6: [698, 725], 7: [694, 729] },
  };
  for (const side of ["ref", "render"]) {
    for (const t of [4, 5, 6, 7]) {
      const anchor = a.anchors[String(t)][side];
      const [gx, gy] = ground[side][t];
      assert.ok(Math.hypot(anchor.x - gx, anchor.y - gy) <= 15, `${side} at ${t} s is off by over 15 px`);
    }
  }
});

test("Seg4 analysis: areas match the trace within 5 percent and centroid diffs stay under 10 px", () => {
  const a = seg4Analysis();
  const { refProfile, renderProfile } = seg4Profiles();
  for (const [side, profile] of [["ref", refProfile], ["render", renderProfile]]) {
    const bt = profile.badge_trajectory;
    for (const t of [4, 5, 6, 7]) {
      let best = 0;
      let bestD = Infinity;
      bt.time_s.forEach((tt, i) => {
        if (Math.abs(tt - t) < bestD) { bestD = Math.abs(tt - t); best = i; }
      });
      const tracePx = Math.round(bt.area_frac[best] * 1920 * 1080);
      const reportPx = a.areas[side][`at_${t}s_px`];
      assert.ok(Math.abs(reportPx - tracePx) / tracePx <= 0.05, `${side} area at ${t} s is off by over 5 percent`);
      assert.ok(a.centroid_vs_bbox[`at_${t}s`][`${side === "ref" ? "ref" : "render"}_px`] <= 10);
    }
  }
  assert.equal(a.centroid_vs_bbox_flagged, false);
  assert.ok(a.centroid_vs_bbox_max_px <= 10);
  assert.deepEqual(a.presence.ref, { first_s: 3.712, last_s: 7.716, frames: 97 });
  assert.deepEqual(a.presence.render, { first_s: 3.75, last_s: 7.958, frames: 102 });
});

test("Seg4 report: fix names the median and the spread, and the report validates", () => {
  const a = seg4Analysis();
  assert.ok(a.fix.includes("0.71"), "fix must name the median offset");
  assert.ok(a.fix.includes("Delay") || a.fix.includes("later") || a.fix.includes("delay"), "fix must name the delay");
  assert.ok(a.fix.includes("re-time"), "fix must say re-time when the spread is over 0.15 s");
  const report = buildInsightReport(a, { ref: TRACE_REF, render: TRACE_OURS, outPath: "/tmp/timing/seg4.json" });
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.numbers.kind, "timing");
  assert.equal(report.numbers.median_offset_s, 0.71);
  assert.equal(report.corrections.length, 1);
  assert.equal(report.corrections[0].element, "badge-rsf");
  assert.equal(report.corrections[0].kind, "timing");
  assert.equal(report.corrections[0].at_s, 5);
  assert.deepEqual(report.corrections[0].shift_px, { dx: 169.4, dy: -69.2 });
  assert.equal(report.corrections[0].fix, a.fix);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("Seg4 profile run writes the same kind, offset, and fix as computeTiming", () => {
  const out = "/tmp/timing/seg4-cli.json";
  const r = run(["timing", "--ref-profile", TRACE_REF, "--render-profile", TRACE_OURS, "--object", "#CC4726", "--out", out]);
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.numbers.kind, "timing");
  assert.equal(report.numbers.median_offset_s, 0.71);
  assert.equal(report.numbers.fix, seg4Analysis().fix);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("Seg4 label run matches the hex-colour run", () => {
  const out = "/tmp/timing/seg4-label.json";
  const r = run(["timing", "--ref-profile", TRACE_REF, "--render-profile", TRACE_OURS, "--object", "RSF badge", "--out", out]);
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  const a = seg4Analysis();
  assert.equal(report.numbers.kind, a.kind);
  assert.equal(report.numbers.median_offset_s, a.median_offset_s);
  assert.equal(report.numbers.fix, a.fix);
  assert.equal(report.numbers.label, "RSF badge");
});

test("synthetic timing fixture: same path 0.5 s late reads as timing with offset -0.5 s", () => {
  const line = (t) => [100 + 50 * t, 500];
  const a = computeTiming({
    refProfile: lineProfile(line),
    renderProfile: lineProfile((t) => line(t - 0.5)),
    object: resolveObject("#CC4726"),
  });
  assert.equal(a.kind, "timing");
  assert.equal(a.median_offset_s, -0.5);
  assert.equal(a.offset_direction, "late");
  assert.equal(a.median_match_distance_px, 0);
});

test("late render with growing lag lists the dt range ascending in the fix", () => {
  const line = (t) => [100 + 50 * t, 500];
  const a = computeTiming({
    refProfile: lineProfile(line),
    renderProfile: lineProfile((t) => line(t - 0.5 - 0.04 * t)),
    object: resolveObject("#CC4726"),
  });
  assert.equal(a.kind, "timing");
  assert.equal(a.dt_min_s, -0.82);
  assert.equal(a.dt_max_s, -0.5);
  assert.ok(a.fix.includes("it varies 0.5 to 0.82 s"), `fix range must read ascending, got: ${a.fix}`);
});

test("synthetic path fixture: parallel line 100 px away reads as path", () => {
  const a = computeTiming({
    refProfile: lineProfile((t) => [100 + 50 * t, 500]),
    renderProfile: lineProfile((t) => [100 + 50 * t, 600]),
    object: resolveObject("#CC4726"),
  });
  assert.equal(a.kind, "path");
  assert.equal(a.median_match_distance_px, 100);
});

test("synthetic on-time fixture: identical paths read as on time, not timing", () => {
  const line = (t) => [100 + 50 * t, 500];
  const a = computeTiming({
    refProfile: lineProfile(line),
    renderProfile: lineProfile(line),
    object: resolveObject("#CC4726"),
  });
  assert.equal(a.kind, "inconclusive");
  assert.equal(a.median_offset_s, 0);
  assert.equal(a.offset_direction, "on time");
  const report = buildInsightReport(a, { ref: "r.mp4", render: "o.mp4", outPath: null });
  assert.equal(report.verdict.status, "PASS");
  assert.deepEqual(report.corrections, []);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("computeTiming throws when a profile has no badge trajectory", () => {
  assert.throws(() => computeTiming({ refProfile: {}, renderProfile: {}, object: resolveObject("#CC4726") }), /no usable badge trajectory/);
});
