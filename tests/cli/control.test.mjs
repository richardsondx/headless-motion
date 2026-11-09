// Fast tests for `hme control`. None of these run a real control:
// the full run takes a few minutes (screenshots plus LPIPS), so the
// real video is checked by the VERIFY run, not here. These tests
// cover the CLI surface and the pure pieces: arm summary and the
// insight report.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BAR, summarizeArm, buildControlReport } from "../../src/cli/control.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });

// Per-second pairs shaped like the ground truth in
// verify-seg4/evidence/work/control-ceiling.json, clean arm.
function groundTruthPairs() {
  return {
    1: { ssim: 0.9713, psnr_db: 39.51, lpips: 0.0471, worst_delta_e: 1.99, areas: {} },
    4: { ssim: 0.9703, psnr_db: 37.51, lpips: 0.0413, worst_delta_e: 0.93, areas: {} },
    5: { ssim: 0.9709, psnr_db: 37.83, lpips: 0.0409, worst_delta_e: 0.93, areas: {} },
    7: { ssim: 0.9708, psnr_db: 37.58, lpips: 0.0408, worst_delta_e: 0.79, areas: {} },
  };
}

function measured(overrides = {}) {
  return {
    fps: 24,
    arms: { clean: { pairs: groundTruthPairs() }, ...overrides },
  };
}

test("control --help prints usage and exits 0", () => {
  const r = run(["control", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme control"));
  assert.ok(r.stdout.includes("Usage: hme control video.mp4 [--crf <n>] [--out <report.json>]"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("control with no arguments is a usage error, not 'not implemented yet'", () => {
  const r = run(["control"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs one video"));
  assert.ok(!r.stderr.includes("not implemented yet"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("control with a missing video exits 2 with a plain error", () => {
  const r = run(["control", "no-such-video.mp4"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-video.mp4"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("control with a bad --crf value is a usage error", () => {
  const r = run(["control", "video.mp4", "--crf", "99"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--crf must be a whole number from 0 to 51"));
});

test("summarizeArm reproduces the ground truth clean means", () => {
  const arm = summarizeArm(groundTruthPairs());
  assert.deepEqual(arm.means_4_pairs, { ssim: 0.9708, psnr_db: 38.11, lpips: 0.0425 });
  assert.deepEqual(arm.worst_delta_e, { value: 1.99, second: 1 });
  assert.equal(arm.passes_pred_v1_seg4, true);
});

test("summarizeArm fails a low SSIM arm", () => {
  const pairs = groundTruthPairs();
  for (const p of Object.values(pairs)) p.ssim = 0.93;
  const arm = summarizeArm(pairs);
  assert.equal(arm.means_4_pairs.ssim, 0.93);
  assert.equal(arm.passes_pred_v1_seg4, false);
});

test("buildControlReport passes at the ground truth ceiling and validates", () => {
  const report = buildControlReport(measured(), "video.mp4", null);
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  assert.equal(report.numbers.arms.clean.means_4_pairs.ssim, 0.9708);
  assert.equal(report.context.control_ceiling.ssim, 0.9708);
  assert.equal(report.context.thresholds.ssim, BAR.ssim);
  assert.deepEqual(report.corrections, []);
  assert.ok(report.limits.some((l) => l.includes("UPPER bound")));
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("buildControlReport fails a low ceiling and names the SSIM bar", () => {
  const pairs = groundTruthPairs();
  for (const p of Object.values(pairs)) p.ssim = 0.9;
  const report = buildControlReport({ fps: 24, arms: { clean: { pairs } } }, "video.mp4", null);
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.verdict.failed_bar, "SSIM >= 0.96 (pred-v1)");
  const { valid } = validateInsight(report);
  assert.equal(valid, true);
});
