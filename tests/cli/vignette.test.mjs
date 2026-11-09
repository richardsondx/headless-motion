// Tests for `hme vignette` (V1: command plus full measurement).
// The pair test runs the measurement on the real Seg4 pair and checks
// the ground truth from the first-principles ladder within 0.02:
// U9 means reference 0.6693 / ours 0.4218 (map frames 0 to 185) and
// matched means reference 0.987 / ours 0.606. The tool measures all
// frames in seconds 0 to 7, so the reference U9 mean reads 0.6566,
// 0.013 below the map-only ground truth, still inside 0.02.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInsightReport,
  correctionFromSweep,
  driftOf,
  sweepCrossingOpacity,
  unreliableRegions,
} from "../../src/cli/vignette.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
const REF = join(ROOT, "verify-seg4", "evidence", "refs", "seg4-ref-0-8s.mp4");
const OURS = join(ROOT, "out", "seg4-final-v5", "run-a", "video.mp4");

const within = (got, want, tol, what) => {
  assert.ok(
    typeof got === "number" && Math.abs(got - want) <= tol,
    `${what}: got ${got}, want ${want} within ${tol}`,
  );
};

test("vignette --help prints usage, args, options, and an example, and exits 0", () => {
  const r = run(["vignette", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme vignette"));
  assert.ok(r.stdout.includes("Usage: hme vignette <input.mp4> [--out <report.json>]"));
  assert.ok(r.stdout.includes("hme vignette <ref.mp4> <ours.mp4> [--out <report.json>]"));
  assert.ok(r.stdout.includes("Arguments:"));
  assert.ok(r.stdout.includes("<input.mp4>"));
  assert.ok(r.stdout.includes("<ref.mp4>"));
  assert.ok(r.stdout.includes("<ours.mp4>"));
  assert.ok(r.stdout.includes("Options:"));
  assert.ok(r.stdout.includes("--out"));
  assert.ok(r.stdout.includes("Example: hme vignette ref.mp4 ours.mp4 --out out/vignette.json"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("hme --help lists vignette with a one-line summary", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("vignette"));
  assert.ok(r.stdout.includes("Measure whether a video has a vignette, and how strong."));
});

test("vignette pair run reproduces the Seg4 ground truth within 0.02", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-vignette-"));
  try {
    const out = join(dir, "vignette.json");
    const r = run(["vignette", REF, OURS, "--out", out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(validateInsight(report).valid, true, JSON.stringify(validateInsight(report).errors));
    assert.equal(report.verdict.status, "PASS");
    assert.equal(report.verdict.failed_bar, null);
    assert.equal(report.numbers.mode, "pair");
    const [ref, ours] = report.numbers.videos;
    assert.equal(ref.label, "ref");
    assert.equal(ours.label, "ours");
    // Ground truth, map frames 0 to 185, within 0.02.
    within(ref.matched_mean, 0.987, 0.02, "ref matched mean");
    within(ours.matched_mean, 0.606, 0.02, "ours matched mean");
    within(ref.u9_mean, 0.6693, 0.02, "ref U9 mean");
    within(ours.u9_mean, 0.4218, 0.02, "ours U9 mean");
    // Per-second ours series, rounded: 0.78, 0.71, 0.60, 0.55, 0.55, 0.55, 0.55, 0.55.
    const wantOurs = [0.78, 0.71, 0.6, 0.55, 0.55, 0.55, 0.55, 0.55];
    for (let s = 0; s < 8; s++) {
      within(ours.matched_per_second[String(s)], wantOurs[s], 0.02, `ours matched second ${s}`);
    }
    // Verdict rule on the matched ratio: ref no vignette, ours vignette.
    assert.equal(ref.vignette_present, false);
    assert.equal(ours.vignette_present, true);
    assert.equal(ref.verdict, "no vignette");
    assert.equal(ours.verdict, "vignette present");
    // Drift: ours moves 0.23 and is flagged; ref moves 0.02 and is not.
    assert.equal(ours.drift_flagged, true);
    assert.ok(ours.drift_range > 0.05);
    assert.equal(ref.drift_flagged, false);
    assert.ok(ref.drift_range <= 0.05);
    // Radial profile: flat on the reference, a smooth falloff on ours.
    assert.deepEqual(ref.radial_profile.map((v) => Math.round(v * 100) / 100),
      [1, 0.99, 0.99, 0.99, 0.99]);
    assert.ok(ours.radial_profile[4] < 0.7, "ours outer ring must fall hard");
    assert.ok(ours.radial_profile[1] > ours.radial_profile[4], "ours rings must fall outward");
    // Coverage: every region above the 1% floor.
    for (const v of [ref, ours]) {
      assert.ok(v.coverage.corner >= 0.01, `${v.label} corner coverage`);
      assert.ok(v.coverage.centre >= 0.01, `${v.label} centre coverage`);
      assert.deepEqual(v.coverage_unreliable_regions, []);
    }
    within(ref.coverage.corner, 0.0165, 0.02, "ref corner coverage");
    // Synthetic sweep reproduces the ladder table within 0.02.
    const sweep = Object.fromEntries(report.numbers.sweep.map((s) => [s.opacity, s.matched_ratio]));
    within(sweep[0], 1.0, 0.02, "sweep opacity 0");
    within(sweep[0.05], 0.969, 0.02, "sweep opacity 0.05");
    within(sweep[0.1], 0.938, 0.02, "sweep opacity 0.10");
    within(sweep[0.28], 0.8256, 0.02, "sweep opacity 0.28");
    within(sweep[0.4], 0.751, 0.02, "sweep opacity 0.40");
    within(report.numbers.flat_control.no_vignette_ratio, 1.0, 0.02, "flat control");
    within(report.numbers.flat_control.gradient_0_28_ratio, 0.83, 0.02, "flat plus gradient 0.28");
    // Correction comes from the sweep only: lower 0.28 toward 0,
    // target is the reference matched ratio, prediction is the sweep
    // value at the proposed opacity. It never uses our video ratio.
    const corr = report.numbers.correction;
    assert.equal(corr.scene_value, "vignette stop opacity in the renderer gradient");
    assert.equal(corr.current_stop_opacity, 0.28);
    assert.equal(corr.proposed_stop_opacity, 0);
    assert.equal(corr.direction, "lower toward 0");
    assert.equal(corr.target_matched_ratio, 0.99);
    assert.equal(corr.predicted_flat_frame_ratio, 1);
    assert.ok(corr.predicted_from.includes("sweep"));
    assert.equal(report.corrections.length, 1);
    assert.equal(report.corrections[0].element, "vignette");
    assert.ok(report.corrections[0].fix.includes("0.28 toward 0"));
    assert.ok(report.corrections[0].fix.includes("Do not use our drifting video ratio"));
    // Open corner darkness gap is listed, with the measured corner base.
    assert.ok(report.numbers.open_corner_darkness_gap.text.includes("Cause unknown"));
    within(report.numbers.open_corner_darkness_gap.ours_corner_base_luma, 18.78, 0.5,
      "ours corner base luma");
    // The reference resize is recorded as a limit.
    assert.ok(report.limits.some((l) => l.includes("resized to our frame size (1920x1080)")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vignette on one video (the reference) reports no vignette", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-vignette-"));
  try {
    const out = join(dir, "vignette-ref.json");
    const r = run(["vignette", REF, "--out", out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(validateInsight(report).valid, true, JSON.stringify(validateInsight(report).errors));
    assert.equal(report.numbers.mode, "single");
    assert.equal(report.numbers.videos.length, 1);
    assert.equal(report.numbers.videos[0].vignette_present, false);
    within(report.numbers.videos[0].matched_mean, 0.987, 0.02, "single ref matched mean");
    assert.deepEqual(report.corrections, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vignette with no video exits 2 without a stack trace", () => {
  const r = run(["vignette"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs one video"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("vignette with three videos exits 2 without a stack trace", () => {
  const r = run(["vignette", REF, OURS, REF]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs one video"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("vignette with a missing file exits 2 without a stack trace", () => {
  const r = run(["vignette", "no-such-video.mp4"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("vignette with an unknown option exits 2 without a stack trace", () => {
  const r = run(["vignette", REF, "--bogus"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("unknown option"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("driftOf flags a move over 0.05 across seconds", () => {
  assert.deepEqual(driftOf({ 0: 0.78, 1: 0.55 }), { range: 0.23, flagged: true });
  assert.deepEqual(driftOf({ 0: 0.98, 1: 0.99 }), { range: 0.01, flagged: false });
  assert.deepEqual(driftOf({ 0: 0.9 }), { range: 0, flagged: false });
  assert.deepEqual(driftOf({}), { range: 0, flagged: false });
});

test("unreliableRegions flags coverage below 1%", () => {
  assert.deepEqual(unreliableRegions({ corner: 0.0165, centre: 0.073 }), []);
  assert.deepEqual(unreliableRegions({ corner: 0.005, centre: 0.073 }), ["corners"]);
  assert.deepEqual(unreliableRegions({ corner: 0.02, centre: 0.009 }), ["centre"]);
});

test("sweepCrossingOpacity interpolates between sweep points", () => {
  const sweep = [
    { opacity: 0, matched_ratio: 1 },
    { opacity: 0.05, matched_ratio: 0.9689 },
    { opacity: 0.1, matched_ratio: 0.9377 },
  ];
  within(sweepCrossingOpacity(sweep, 0.99), 0.0161, 0.001, "crossing for 0.99");
  assert.equal(sweepCrossingOpacity(sweep, 1.05), null);
  assert.equal(sweepCrossingOpacity(sweep, 0.9), null);
});

test("correctionFromSweep proposes from the sweep table only", () => {
  const sweep = [
    { opacity: 0, matched_ratio: 1 },
    { opacity: 0.05, matched_ratio: 0.9689 },
    { opacity: 0.28, matched_ratio: 0.8256 },
  ];
  const c = correctionFromSweep(sweep, 0.99, 0);
  assert.equal(c.current_stop_opacity, 0.28);
  assert.equal(c.proposed_stop_opacity, 0);
  assert.equal(c.direction, "lower toward 0");
  assert.equal(c.target_matched_ratio, 0.99);
  assert.equal(c.predicted_flat_frame_ratio, 1);
  assert.ok(c.predicted_from.includes("sweep"));
});

function fakeMeasured(videos, sweep) {
  return {
    mode: videos.length === 2 ? "pair" : "single",
    target_width: 1920,
    target_height: 1080,
    videos: videos.map((v) => ({
      label: v.label,
      path: `${v.label}.mp4`,
      width: 1920,
      height: 1080,
      fps: 24,
      frames: 192,
      matched_per_second: v.matched_per_second,
      matched_mean: v.matched_mean,
      matched_std: 0.01,
      matched_n: 192,
      u9_per_second: { 0: 0.5 },
      u9_mean: 0.5,
      u9_n: 192,
      radial_profile: [1, 0.99, 0.99, 0.99, 0.99],
      coverage: v.coverage ?? { corner: 0.02, centre: 0.07, corner_min: 0.015, centre_min: 0.04 },
      corner_base_luma_mean: 30,
      centre_base_luma_mean: 31,
    })),
    sweep: sweep ?? [
      { opacity: 0, matched_ratio: 1 },
      { opacity: 0.05, matched_ratio: 0.9689 },
      { opacity: 0.28, matched_ratio: 0.8256 },
    ],
  };
}

test("buildInsightReport fails when a region is below the coverage floor", () => {
  const measured = fakeMeasured([
    { label: "ref", matched_per_second: { 0: 0.99 }, matched_mean: 0.99 },
    {
      label: "ours",
      matched_per_second: { 0: 0.6 },
      matched_mean: 0.6,
      coverage: { corner: 0.005, centre: 0.07, corner_min: 0.001, centre_min: 0.04 },
    },
  ]);
  const report = buildInsightReport(measured, { ref: "ref.mp4", ours: "ours.mp4" });
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("coverage"));
  assert.equal(validateInsight(report).valid, true);
});

test("buildInsightReport fails when the reference itself is vignetted", () => {
  const measured = fakeMeasured([
    { label: "ref", matched_per_second: { 0: 0.9 }, matched_mean: 0.9 },
    { label: "ours", matched_per_second: { 0: 0.6 }, matched_mean: 0.6 },
  ]);
  const report = buildInsightReport(measured, { ref: "ref.mp4", ours: "ours.mp4" });
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("clean baseline"));
  assert.deepEqual(report.corrections, []);
  assert.equal(validateInsight(report).valid, true);
});

test("buildInsightReport on a clean pair names no correction", () => {
  const measured = fakeMeasured([
    { label: "ref", matched_per_second: { 0: 0.99 }, matched_mean: 0.99 },
    { label: "ours", matched_per_second: { 0: 0.98 }, matched_mean: 0.98 },
  ]);
  const report = buildInsightReport(measured, { ref: "ref.mp4", ours: "ours.mp4" });
  assert.equal(report.verdict.status, "PASS");
  assert.deepEqual(report.corrections, []);
  assert.equal(report.numbers.correction, null);
  assert.equal(validateInsight(report).valid, true);
});
