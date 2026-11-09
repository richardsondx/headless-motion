// Tests for `hme blur-grain` (B1: single-video path; B2: pair mode,
// per-second blur, denoised blur, blur ratio; B3: grain over time,
// flat-region residual correlation, flat-region frame-diff energy,
// flat-region grain level; B4: corrections in scene terms, one per
// gap, each firing only when its gap is present).
// The real-video tests run the measurement on our Seg4 v5 video
// (192 frames at 24 fps). The pair-mode ratio check is a pure
// function test on synthetic series, so the suite stays light; the
// full pair run on the real Seg4 pair is the VERIFY command.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInsightReport, buildPairInsightReport, measureOneVideo, summarizeBlur, summarizeGrain } from "../../src/cli/blur-grain.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
const OURS = join(ROOT, "out", "seg4-final-v5", "run-a", "video.mp4");

test("blur-grain --help prints usage, flags, and an example, and exits 0", () => {
  const r = run(["blur-grain", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme blur-grain"));
  assert.ok(r.stdout.includes("Usage: hme blur-grain video.mp4 [--out <report.json>]"));
  assert.ok(r.stdout.includes("--out"));
  assert.ok(r.stdout.includes("Example: hme blur-grain ours.mp4 --out out/blur-grain.json"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("hme --help lists blur-grain with a one-line summary", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("blur-grain"));
  assert.ok(r.stdout.includes("Measure motion blur and grain over time in one video."));
});

test("blur-grain on one video writes a valid single-video insight report", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-blur-grain-"));
  try {
    const out = join(dir, "blur-grain.json");
    const r = run(["blur-grain", OURS, "--out", out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(validateInsight(report).valid, true, JSON.stringify(validateInsight(report).errors));
    assert.equal(report.verdict.status, "PASS");
    assert.equal(report.verdict.failed_bar, null);
    assert.ok(report.verdict.detail.includes("one video"), "detail must say one video was measured");
    assert.ok(report.verdict.detail.includes("No pair bar applies"), "detail must say no pair bar applies");
    assert.deepEqual(report.corrections, []);
    assert.equal(report.numbers.frames, 192);
    assert.equal(report.numbers.fps, 24);
    assert.equal(report.numbers.width, 1920);
    assert.equal(report.numbers.height, 1080);
    assert.equal(report.numbers.blur_laplacian_variance_per_frame.length, 192);
    assert.equal(report.numbers.grain_level_per_frame.length, 192);
    assert.equal(report.numbers.frame_diff_energy_per_frame.length, 192);
    assert.ok(report.numbers.blur_laplacian_variance_per_frame.every((v) => typeof v === "number" && v >= 0));
    assert.ok(report.numbers.grain_level_per_frame.every((v) => typeof v === "number" && v >= 0));
    assert.ok(report.numbers.frame_diff_energy_per_frame.every((v) => typeof v === "number" && v >= 0));
    assert.equal(report.numbers.frame_diff_energy_per_frame[0], 0);
    assert.ok(typeof report.numbers.blur_laplacian_variance_mean === "number");
    assert.ok(typeof report.numbers.grain_level_mean === "number");
    assert.ok(typeof report.numbers.frame_diff_energy_mean === "number");
    assert.equal(report.numbers.blur_laplacian_variance_per_second.length, 8);
    assert.equal(report.numbers.blur_denoised_laplacian_variance_per_second.length, 8);
    assert.equal(report.numbers.blur_denoised_laplacian_variance_per_frame.length, 192);
    assert.equal(report.numbers.flat_grain_level_per_frame.length, 192);
    assert.equal(report.numbers.flat_frame_diff_energy_per_frame.length, 192);
    assert.equal(report.numbers.flat_residual_correlation_per_frame.length, 192);
    assert.equal(report.numbers.flat_residual_correlation_per_frame[0], null);
    assert.equal(report.numbers.flat_residual_correlation_per_second.length, 8);
    assert.equal(report.numbers.flat_frame_diff_energy_per_second.length, 8);
    assert.equal(report.numbers.flat_grain_level_per_second.length, 8);
    assert.equal(report.numbers.flat_fraction_per_second.length, 8);
    assert.ok(report.numbers.flat_residual_correlation_per_second.every((v) => typeof v === "number"));
    assert.ok(report.numbers.flat_frame_diff_energy_per_second.every((v) => typeof v === "number"));
    assert.ok(report.numbers.flat_grain_level_per_second.every((v) => typeof v === "number"));
    // Our render is frozen by construction (one grain tile): the
    // B3 bands for ours are mean residual correlation 0.95 or
    // higher with every second 0.90 or higher, and flat diff mean
    // 0.05 or lower.
    assert.ok(report.numbers.flat_residual_correlation_mean >= 0.95,
      `ours mean residual correlation ${report.numbers.flat_residual_correlation_mean} must be 0.95 or higher`);
    assert.ok(report.numbers.flat_residual_correlation_per_second.every((v) => v >= 0.9),
      "every ours residual correlation second must be 0.90 or higher");
    assert.ok(report.numbers.flat_frame_diff_energy_mean <= 0.05,
      `ours flat diff mean ${report.numbers.flat_frame_diff_energy_mean} must be 0.05 or lower`);
    assert.ok(typeof report.numbers.blur_ratio === "number");
    assert.ok(typeof report.numbers.blur_laplacian_variance_map_span_mean === "number");
    assert.ok(typeof report.numbers.fast_zoom_2_3s === "number");
    assert.ok(typeof report.numbers.held_second_7_mean === "number");
    assert.ok(report.limits.some((l) => l.includes("cannot judge blur or grain gaps")),
      "limits must say a single video cannot judge blur or grain gaps");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blur-grain with two videos and a missing second file exits 2 without a stack trace", () => {
  const r = run(["blur-grain", OURS, "no-such-video.mp4"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("blur-grain with no video exits 2 without a stack trace", () => {
  const r = run(["blur-grain"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs one video"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("blur-grain with a missing file exits 2 without a stack trace", () => {
  const r = run(["blur-grain", "no-such-video.mp4"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("measureOneVideo returns per-frame series, frame count, and fps", async () => {
  const measured = await measureOneVideo(OURS);
  assert.equal(measured.frames, 192);
  assert.equal(measured.fps, 24);
  assert.equal(measured.width, 1920);
  assert.equal(measured.height, 1080);
  assert.equal(measured.blur_laplacian_variance_per_frame.length, 192);
  assert.equal(measured.grain_level_per_frame.length, 192);
  assert.equal(measured.frame_diff_energy_per_frame.length, 192);
  assert.ok(measured.blur_laplacian_variance_mean > 0);
  assert.ok(measured.grain_level_mean > 0);
  assert.ok(measured.frame_diff_energy_mean > 0);
});

test("buildInsightReport is a pure single-video report with no corrections", () => {
  const measured = {
    width: 1920,
    height: 1080,
    fps: 24,
    frames: 3,
    blur_laplacian_variance_per_frame: [100, 200, 300],
    blur_denoised_laplacian_variance_per_frame: [10, 20, 30],
    grain_level_per_frame: [5, 6, 7],
    frame_diff_energy_per_frame: [0, 0.5, 0.6],
    flat_grain_level_per_frame: [4, 4, 4],
    flat_frame_diff_energy_per_frame: [null, 0.02, 0.03],
    flat_residual_correlation_per_frame: [null, 0.99, 0.98],
    flat_fraction_per_frame: [0.5, 0.5, 0.5],
    blur_laplacian_variance_mean: 200,
    blur_denoised_laplacian_variance_mean: 20,
    grain_level_mean: 6,
    frame_diff_energy_mean: 0.367,
  };
  const report = buildInsightReport(measured, "ours.mp4");
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  assert.deepEqual(report.corrections, []);
  assert.equal(report.numbers.video, "ours.mp4");
  assert.equal(report.numbers.frames, 3);
  assert.deepEqual(report.numbers.blur_laplacian_variance_per_frame, [100, 200, 300]);
  assert.deepEqual(report.numbers.blur_denoised_laplacian_variance_per_frame, [10, 20, 30]);
  assert.deepEqual(report.numbers.blur_laplacian_variance_per_second, [200]);
  assert.deepEqual(report.numbers.blur_denoised_laplacian_variance_per_second, [20]);
  assert.deepEqual(report.numbers.flat_residual_correlation_per_second, [0.99]);
  assert.deepEqual(report.numbers.flat_frame_diff_energy_per_second, [0.02]);
  assert.deepEqual(report.numbers.flat_grain_level_per_second, [4]);
  assert.equal(report.numbers.flat_residual_correlation_mean, 0.99);
  assert.equal(report.numbers.flat_frame_diff_energy_mean, 0.02);
  assert.equal(report.numbers.flat_grain_level_mean, 4);
  assert.equal(report.numbers.blur_ratio, null);
  assert.equal(validateInsight(report).valid, true);
});

// Fake measured video: 192 frames at 24 fps, one constant blur value
// per second, so the ratio math is exact by hand. Grain takes one
// constant value per second too: residual correlation, flat diff,
// and flat grain level. Defaults are frozen (ours-like): corr 0.99,
// flat diff 0.02, flat grain 4.18.
function fakeMeasured(blurPerSecond, denoisedPerSecond,
  corrPerSecond = [0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99],
  flatDiffPerSecond = [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02],
  flatGrainPerSecond = [4.18, 4.18, 4.18, 4.18, 4.18, 4.18, 4.18, 4.18]) {
  const blur = [];
  const denoised = [];
  const corr = [];
  const flatDiff = [];
  const flatGrain = [];
  for (let s = 0; s < 8; s++) {
    for (let i = 0; i < 24; i++) {
      blur.push(blurPerSecond[s]);
      denoised.push(denoisedPerSecond[s]);
      corr.push(corrPerSecond[s]);
      flatDiff.push(flatDiffPerSecond[s]);
      flatGrain.push(flatGrainPerSecond[s]);
    }
  }
  const mean = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 1000) / 1000;
  return {
    width: 1920,
    height: 1080,
    fps: 24,
    frames: 192,
    blur_laplacian_variance_per_frame: blur,
    blur_denoised_laplacian_variance_per_frame: denoised,
    grain_level_per_frame: new Array(192).fill(5),
    frame_diff_energy_per_frame: [0, ...new Array(191).fill(0.5)],
    flat_residual_correlation_per_frame: corr,
    flat_frame_diff_energy_per_frame: flatDiff,
    flat_grain_level_per_frame: flatGrain,
    flat_fraction_per_frame: new Array(192).fill(0.5),
    blur_laplacian_variance_mean: mean(blur),
    blur_denoised_laplacian_variance_mean: mean(denoised),
    grain_level_mean: 5,
    frame_diff_energy_mean: 0.497,
  };
}

// Live reference grain: corr mean 0.69, flat diff 0.19, flat grain 0.48.
const REF_CORR = [0.6, 0.65, 0.7, 0.75, 0.8, 0.72, 0.68, 0.62];
const REF_FLAT_DIFF = [0.19, 0.19, 0.19, 0.19, 0.19, 0.19, 0.19, 0.19];
const REF_FLAT_GRAIN = [0.48, 0.48, 0.48, 0.48, 0.48, 0.48, 0.48, 0.48];

function fakeRef(blurPerSecond, denoisedPerSecond) {
  return fakeMeasured(blurPerSecond, denoisedPerSecond, REF_CORR, REF_FLAT_DIFF, REF_FLAT_GRAIN);
}

test("summarizeBlur computes per-second blur, fast zoom, held second, and the ratio", () => {
  // Reference: fast seconds 2-3 at 100, held second 7 at 300.
  const ref = fakeMeasured([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50]);
  const s = summarizeBlur(ref);
  assert.deepEqual(s.blur_laplacian_variance_per_second, [800, 800, 100, 100, 400, 400, 400, 300]);
  assert.deepEqual(s.blur_denoised_laplacian_variance_per_second, [50, 50, 50, 50, 50, 50, 50, 50]);
  assert.equal(s.blur_laplacian_variance_map_span_mean, 416.129);
  assert.equal(s.fast_zoom_2_3s, 100);
  assert.equal(s.fast_seconds_2_3_mean, 100);
  assert.equal(s.held_second_7_mean, 300);
  assert.equal(s.blur_ratio, 0.333);
});

test("summarizeGrain takes the first pair of each second, not the mean of all pairs", () => {
  // Probe pairs (frames 1, 25, 49, ...) correlate 0.99; mid-second
  // pairs decorrelate to 0.5 during the zoom. The per-second value
  // must be the probe pair, so the mean stays 0.99.
  const corr = new Array(192).fill(0.5);
  const flatDiff = new Array(192).fill(0.4);
  for (let s = 0; s < 8; s++) {
    corr[s * 24 + 1] = 0.99;
    flatDiff[s * 24 + 1] = 0.02;
  }
  const g = summarizeGrain({
    fps: 24,
    flat_residual_correlation_per_frame: corr,
    flat_frame_diff_energy_per_frame: flatDiff,
    flat_grain_level_per_frame: new Array(192).fill(4),
    flat_fraction_per_frame: new Array(192).fill(0.5),
  });
  assert.deepEqual(g.flat_residual_correlation_per_second, [0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99]);
  assert.deepEqual(g.flat_frame_diff_energy_per_second, [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02]);
  assert.equal(g.flat_residual_correlation_mean, 0.99);
  assert.equal(g.flat_frame_diff_energy_mean, 0.02);
});

test("summarizeGrain computes per-second grain, means, and flat fraction", () => {
  const ref = fakeRef([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50]);
  const g = summarizeGrain(ref);
  assert.deepEqual(g.flat_residual_correlation_per_second, REF_CORR);
  assert.deepEqual(g.flat_frame_diff_energy_per_second, REF_FLAT_DIFF);
  assert.deepEqual(g.flat_grain_level_per_second, REF_FLAT_GRAIN);
  assert.equal(g.flat_residual_correlation_mean, 0.69);
  assert.equal(g.flat_frame_diff_energy_mean, 0.19);
  assert.equal(g.flat_grain_level_mean, 0.48);
  assert.deepEqual(g.flat_fraction_per_second, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
});

test("summarizeGrain skips null first-frame pairs", () => {
  const measured = {
    fps: 24,
    flat_residual_correlation_per_frame: [null, 0.9, 0.9],
    flat_frame_diff_energy_per_frame: [null, 0.1, 0.1],
    flat_grain_level_per_frame: [4, 4, 4],
    flat_fraction_per_frame: [0.5, 0.5, 0.5],
  };
  const g = summarizeGrain(measured);
  assert.deepEqual(g.flat_residual_correlation_per_second, [0.9]);
  assert.deepEqual(g.flat_frame_diff_energy_per_second, [0.1]);
  assert.equal(g.flat_residual_correlation_mean, 0.9);
});

test("buildPairInsightReport passes when the ratios separate, and names the gap", () => {
  const ref = fakeRef([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50]);
  const ours = fakeMeasured([3000, 3000, 750, 750, 3500, 3500, 3500, 1000], [200, 200, 200, 200, 200, 200, 200, 200]);
  const report = buildPairInsightReport(ref, ours, "ref.mp4", "ours.mp4");
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  // B4: both gaps are present, so both corrections are named in
  // scene terms, with the time span and the scene change.
  assert.equal(report.corrections.length, 2);
  const [blurFix, grainFix] = report.corrections;
  assert.equal(blurFix.element, "camera zoom");
  assert.equal(blurFix.kind, "motion-blur");
  assert.equal(blurFix.at_s, 2);
  assert.deepEqual(blurFix.ours, { x: 0.75, y: 750, px: 0 });
  assert.deepEqual(blurFix.real, { x: 0.333, y: 100, px: 0 });
  assert.deepEqual(blurFix.shift_px, { dx: -0.417, dy: -650 });
  assert.ok(blurFix.fix.includes("Add motion blur to the camera zoom between 0:02 and 0:03"),
    `blur fix must name the scene change and span: ${blurFix.fix}`);
  assert.ok(blurFix.fix.includes("0.75") && blurFix.fix.includes("0.333"),
    `blur fix must carry the ratio gap: ${blurFix.fix}`);
  assert.equal(blurFix.source, "hme blur-grain, Seg4 pair");
  assert.equal(grainFix.element, "grain");
  assert.equal(grainFix.kind, "live-grain");
  assert.equal(grainFix.at_s, 0);
  assert.deepEqual(grainFix.ours, { x: 0.99, y: 0.02, px: 0 });
  assert.deepEqual(grainFix.real, { x: 0.69, y: 0.19, px: 0 });
  assert.deepEqual(grainFix.shift_px, { dx: -0.3, dy: 0.17 });
  assert.ok(grainFix.fix.includes("Make the grain change every frame instead of one fixed tile"),
    `grain fix must name the scene change: ${grainFix.fix}`);
  assert.ok(grainFix.fix.includes("0:00 to 0:08"),
    `grain fix must name the time span: ${grainFix.fix}`);
  assert.ok(grainFix.fix.includes("0.99") && grainFix.fix.includes("0.69"),
    `grain fix must rest on the correlation means: ${grainFix.fix}`);
  assert.equal(grainFix.source, "hme blur-grain, Seg4 pair");
  assert.equal(report.numbers.reference.blur_ratio, 0.333);
  assert.equal(report.numbers.ours.blur_ratio, 0.75);
  assert.equal(report.numbers.gap.blur_ratio_reference, 0.333);
  assert.equal(report.numbers.gap.blur_ratio_ours, 0.75);
  assert.equal(report.numbers.gap.blur_ratio_gap, 0.417);
  assert.equal(report.numbers.reference.blur_laplacian_variance_map_span_mean, 416.129);
  assert.equal(report.numbers.ours.blur_laplacian_variance_map_span_mean, 2419.355);
  assert.equal(report.numbers.gap.fast_zoom_2_3s_reference, 100);
  assert.equal(report.numbers.gap.fast_zoom_2_3s_ours, 750);
  assert.equal(report.numbers.reference.blur_laplacian_variance_per_second.length, 8);
  assert.equal(report.numbers.ours.blur_denoised_laplacian_variance_per_second.length, 8);
  assert.equal(report.numbers.reference.video, "ref.mp4");
  assert.equal(report.numbers.ours.video, "ours.mp4");
  // Grain: reference live (mean 0.69), ours frozen (mean 0.99),
  // flat diff separates (0.19 vs 0.02). Flat grain level is amount
  // only: ours has more grain yet is frozen.
  assert.equal(report.numbers.gap.flat_residual_correlation_mean_reference, 0.69);
  assert.equal(report.numbers.gap.flat_residual_correlation_mean_ours, 0.99);
  assert.equal(report.numbers.gap.flat_frame_diff_energy_mean_reference, 0.19);
  assert.equal(report.numbers.gap.flat_frame_diff_energy_mean_ours, 0.02);
  assert.equal(report.numbers.gap.flat_grain_level_mean_reference, 0.48);
  assert.equal(report.numbers.gap.flat_grain_level_mean_ours, 4.18);
  assert.equal(report.numbers.reference.flat_residual_correlation_per_second.length, 8);
  assert.equal(report.numbers.ours.flat_frame_diff_energy_per_second.length, 8);
  assert.equal(report.numbers.ours.flat_grain_level_per_second.length, 8);
  assert.equal(validateInsight(report).valid, true, JSON.stringify(validateInsight(report).errors));
});

test("buildPairInsightReport fails when the ratios do not separate", () => {
  const ref = fakeRef([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50]);
  const ours = fakeMeasured([3000, 3000, 500, 500, 3500, 3500, 3500, 1000], [200, 200, 200, 200, 200, 200, 200, 200]);
  const report = buildPairInsightReport(ref, ours, "ref.mp4", "ours.mp4");
  assert.equal(report.numbers.ours.blur_ratio, 0.5);
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("blur ratio separation"));
  // B4: no blur gap (ours ratio 0.5 is below the crisp bar), so no
  // blur correction; the grain gap is present, so the grain
  // correction is named.
  assert.equal(report.corrections.length, 1);
  assert.equal(report.corrections[0].kind, "live-grain");
  assert.ok(report.corrections[0].fix.includes("Make the grain change every frame instead of one fixed tile"));
  assert.equal(validateInsight(report).valid, true);
});

test("buildPairInsightReport fails when ours grain is not frozen", () => {
  const ref = fakeRef([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50]);
  const ours = fakeMeasured([3000, 3000, 750, 750, 3500, 3500, 3500, 1000], [200, 200, 200, 200, 200, 200, 200, 200],
    [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8]);
  const report = buildPairInsightReport(ref, ours, "ref.mp4", "ours.mp4");
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("frozen grain"));
  // B4: no grain gap (ours grain is not frozen), so no grain
  // correction; the blur gap is present, so the blur correction is
  // named.
  assert.equal(report.corrections.length, 1);
  assert.equal(report.corrections[0].kind, "motion-blur");
  assert.ok(report.corrections[0].fix.includes("Add motion blur to the camera zoom between 0:02 and 0:03"));
  assert.equal(validateInsight(report).valid, true);
});

test("buildPairInsightReport fails when one ours second drops below 0.90", () => {
  const ref = fakeRef([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50]);
  const ours = fakeMeasured([3000, 3000, 750, 750, 3500, 3500, 3500, 1000], [200, 200, 200, 200, 200, 200, 200, 200],
    [0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.85]);
  const report = buildPairInsightReport(ref, ours, "ref.mp4", "ours.mp4");
  assert.equal(report.numbers.ours.flat_residual_correlation_mean, 0.973);
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("frozen grain"));
  // B4: one ours second at 0.85 breaks frozen-ness, so no grain
  // correction; the blur correction stands alone.
  assert.equal(report.corrections.length, 1);
  assert.equal(report.corrections[0].kind, "motion-blur");
  assert.equal(validateInsight(report).valid, true);
});

test("buildPairInsightReport fails when the reference grain is not live", () => {
  const ref = fakeMeasured([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50],
    [0.96, 0.96, 0.96, 0.96, 0.96, 0.96, 0.96, 0.96]);
  const ours = fakeMeasured([3000, 3000, 750, 750, 3500, 3500, 3500, 1000], [200, 200, 200, 200, 200, 200, 200, 200]);
  const report = buildPairInsightReport(ref, ours, "ref.mp4", "ours.mp4");
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("live grain"));
  // B4: the reference grain is not live, so no grain correction;
  // the blur correction stands alone.
  assert.equal(report.corrections.length, 1);
  assert.equal(report.corrections[0].kind, "motion-blur");
  assert.equal(validateInsight(report).valid, true);
});

test("buildPairInsightReport fails when flat diff does not separate", () => {
  const ref = fakeMeasured([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50],
    REF_CORR, [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05], REF_FLAT_GRAIN);
  const ours = fakeMeasured([3000, 3000, 750, 750, 3500, 3500, 3500, 1000], [200, 200, 200, 200, 200, 200, 200, 200]);
  const report = buildPairInsightReport(ref, ours, "ref.mp4", "ours.mp4");
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("flat-region frame-difference energy"));
  // B4: flat diff is supporting evidence, not the grain trigger, so
  // both corrections are still named: the correlation gap is there.
  assert.equal(report.corrections.length, 2);
  assert.deepEqual(report.corrections.map((c) => c.kind), ["motion-blur", "live-grain"]);
  assert.equal(validateInsight(report).valid, true);
});

test("buildPairInsightReport names no correction when neither gap is present", () => {
  // Ours matches the reference: ratio 0.333 on both sides, grain
  // live on both sides (mean 0.69). Both bars fail, but neither gap
  // exists, so no correction is named. Corrections trigger only on
  // the gaps, never on a FAIL alone.
  const ref = fakeRef([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50]);
  const ours = fakeMeasured([800, 800, 100, 100, 400, 400, 400, 300], [50, 50, 50, 50, 50, 50, 50, 50],
    REF_CORR, REF_FLAT_DIFF, REF_FLAT_GRAIN);
  const report = buildPairInsightReport(ref, ours, "ref.mp4", "ours.mp4");
  assert.equal(report.numbers.ours.blur_ratio, 0.333);
  assert.equal(report.numbers.ours.flat_residual_correlation_mean, 0.69);
  assert.equal(report.verdict.status, "FAIL");
  assert.deepEqual(report.corrections, []);
  assert.equal(validateInsight(report).valid, true);
});
