// Fast tests for `hme compare`. None of these run a real compare:
// the full run takes about 8 minutes (LPIPS), so the real pair is
// checked by the VERIFY run, not here. These tests cover the CLI
// surface and the pure pieces: cut detection, frame summary, and the
// insight report.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BAR,
  findCut,
  summarizeFrames,
  buildInsightReport,
} from "../../src/cli/compare.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });

// Teal counts modelled on the Seg4 ground truth: about 2,017,000
// teal pixels through frame 185, about 43,000 from frame 186 on.
function seg4Counts() {
  const counts = [];
  for (let i = 0; i < 192; i++) counts.push(i < 186 ? 2000000 + i * 100 : 43000);
  return counts;
}

function rowsFor(ssims) {
  return ssims.map((ssim, i) => ({
    frame: i,
    second: Math.round((i / 24) * 1000) / 1000,
    ssim,
    psnr_db: 20,
  }));
}

// A minimal driver output, shaped like the real one, with numbers
// that fail the bar.
function fakeMeasured() {
  return {
    ref: "ref.mp4",
    ours: "ours.mp4",
    ref_fps: 23.976,
    ours_fps: 24,
    ref_width: 1920,
    ref_height: 1038,
    ours_width: 1920,
    ours_height: 1080,
    frames: 4,
    fps: 24,
    rows: rowsFor([0.8, 0.79, 0.81, 0.78]),
    teal_counts: [2000000, 2000000, 2000000, 2000000],
    lpips_by_frame: { 0: 0.63 },
    lpips_mean: 0.63,
    delta_e_seconds: {},
    worst_delta_e: { value: 1.5, second: 1, area: "sudan" },
  };
}

test("compare --help prints usage and exits 0", () => {
  const r = run(["compare", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme compare"));
  assert.ok(r.stdout.includes("Usage: hme compare <ref.mp4> <ours.mp4>"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("compare with no arguments is a usage error, not 'not implemented yet'", () => {
  const r = run(["compare"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs two videos"));
  assert.ok(!r.stderr.includes("not implemented yet"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("compare with one video is a usage error", () => {
  const r = run(["compare", "ref.mp4"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs two videos"));
});

test("compare with an unknown option is a usage error", () => {
  const r = run(["compare", "ref.mp4", "ours.mp4", "--nope"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('unknown option "--nope"'));
});

test("compare with a missing reference file exits 2 with a plain error", () => {
  const r = run(["compare", "no-such-ref.mp4", "ours.mp4"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-ref.mp4"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("compare with a missing ours file exits 2 with a plain error", () => {
  const r = run(["compare", "verify-seg4/evidence/refs/seg4-ref-0-8s.mp4", "no-such-ours.mp4"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-ours.mp4"));
});

test("findCut finds frame 186 on Seg4-like teal counts", () => {
  assert.equal(findCut(seg4Counts()), 186);
});

test("findCut returns null when the teal count never cliffs", () => {
  assert.equal(findCut([2000000, 2001000, 1999000, 2000000]), null);
  assert.equal(findCut([]), null);
  assert.equal(findCut([2000000]), null);
});

test("findCut returns null for a one-frame flicker that does not stick", () => {
  const counts = [2000000, 2000000, 40000, 2000000, 2000000, 2000000];
  assert.equal(findCut(counts), null);
});

test("summarizeFrames splits full-span and map-only means at the cut", () => {
  const rows = rowsFor([0.95, 0.95, 0.95, 0.6, 0.6, 0.6]);
  const s = summarizeFrames(rows, 3, 24);
  assert.equal(s.frames, 6);
  assert.equal(s.ssim_mean, 0.775);
  assert.equal(s.map_only.frames, 3);
  assert.equal(s.map_only.ssim_mean, 0.95);
  assert.equal(s.below_0_90, 3);
  assert.equal(s.map_only.below_0_90, 0);
  assert.equal(s.below_0_85, 3);
  assert.equal(s.map_only.below_0_85, 0);
});

test("summarizeFrames groups map-only per-second means by frame rate", () => {
  const rows = [];
  for (let i = 0; i < 48; i++) {
    rows.push({ frame: i, second: Math.round((i / 24) * 1000) / 1000, ssim: i < 24 ? 0.8 : 0.9, psnr_db: 20 });
  }
  const s = summarizeFrames(rows, null, 24);
  assert.deepEqual(s.map_only.per_second_ssim, { 0: 0.8, 1: 0.9 });
  assert.equal(s.map_only.per_second_psnr[0], 20);
});

test("summarizeFrames worst 5 is the lowest SSIM first", () => {
  const rows = rowsFor([0.9, 0.7, 0.85, 0.6, 0.95, 0.75, 0.8]);
  const s = summarizeFrames(rows, null, 24);
  assert.deepEqual(s.worst_5.map((r) => r.frame), [3, 1, 5, 6, 2]);
});

test("buildInsightReport fails vs the frozen bar and names it", () => {
  const measured = fakeMeasured();
  const summary = summarizeFrames(measured.rows, null, 24);
  const report = buildInsightReport(measured, summary, null);
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.verdict.failed_bar, "SSIM >= 0.96 (pred-v1)");
  assert.equal(report.numbers.ssim_mean, 0.795);
  assert.equal(report.numbers.map_only.frames, 4);
  assert.equal(report.numbers.cut.found, false);
  assert.deepEqual(report.corrections, []);
  assert.equal(report.context.thresholds.ssim, BAR.ssim);
  assert.equal(report.context.control_ceiling.ssim, 0.9708);
  assert.ok(report.limits.some((l) => l.includes("LPIPS is every 8th frame")));
  assert.ok(report.limits.some((l) => l.includes("human gate")));
});

test("buildInsightReport passes when all three bars clear", () => {
  const measured = fakeMeasured();
  measured.rows = rowsFor([0.97, 0.97, 0.97, 0.97]);
  measured.rows.forEach((r) => { r.psnr_db = 40; });
  measured.lpips_mean = 0.05;
  const summary = summarizeFrames(measured.rows, null, 24);
  const report = buildInsightReport(measured, summary, null);
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
});

test("buildInsightReport output passes the insight validator", () => {
  const measured = fakeMeasured();
  const cut = findCut(seg4Counts());
  assert.equal(cut, 186);
  const rows = rowsFor(Array.from({ length: 192 }, (_, i) => (i < 186 ? 0.8 : 0.68)));
  measured.rows = rows;
  measured.teal_counts = seg4Counts();
  const summary = summarizeFrames(measured.rows, cut, 24);
  const report = buildInsightReport(measured, summary, cut);
  assert.equal(report.numbers.cut.frame, 186);
  assert.equal(report.numbers.cut.second, 7.75);
  assert.equal(report.numbers.map_only.frames, 186);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});
