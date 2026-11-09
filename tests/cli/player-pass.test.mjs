// Fast tests for `hme player-pass`. None of these run a real player
// pass: screenshots need a browser, so the real video is checked by
// the VERIFY run, not here. These tests cover the CLI surface and
// the pure pieces: second parsing, the player page bytes, and the
// insight report.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_VIEWPORT,
  DEFAULT_CROP,
  parseSeconds,
  buildPlayerPage,
  buildInsightReport,
} from "../../src/cli/player-pass.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });

test("player-pass --help prints usage and exits 0", () => {
  const r = run(["player-pass", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme player-pass"));
  assert.ok(r.stdout.includes("Usage: hme player-pass"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("player-pass with no arguments is a usage error, not 'not implemented yet'", () => {
  const r = run(["player-pass"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs one video"));
  assert.ok(!r.stderr.includes("not implemented yet"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("player-pass without --seconds is a usage error", () => {
  const r = run(["player-pass", "video.mp4"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--seconds is required"));
});

test("player-pass with a missing video exits 2 with a plain error", () => {
  const r = run(["player-pass", "no-such-video.mp4", "--seconds", "1,4,5,7"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-video.mp4"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("player-pass with bad --seconds is a usage error", () => {
  const r = run(["player-pass", "video.mp4", "--seconds", "1,,x"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--seconds must be a comma list of seconds"));
});

test("parseSeconds takes ints and floats, rejects bad input", () => {
  assert.deepEqual(parseSeconds("1,4,5,7"), [1, 4, 5, 7]);
  assert.deepEqual(parseSeconds("0,5,7.75"), [0, 5, 7.75]);
  assert.equal(parseSeconds(""), null);
  assert.equal(parseSeconds("1,,x"), null);
  assert.equal(parseSeconds("-1,4"), null);
});

test("buildPlayerPage is byte-identical to the recorded player-pass run", () => {
  const videoPath = join(ROOT, "out", "seg4-final-v5", "run-a", "video.mp4");
  const recorded = readFileSync(
    join(ROOT, "verify-seg4", "evidence", "work", "player-pass-v5", "player.html"), "utf8");
  const built = buildPlayerPage({
    videoUri: `file://${videoPath}`,
    seconds: [1, 4, 5, 7],
    viewport: DEFAULT_VIEWPORT,
    crop: DEFAULT_CROP,
  });
  assert.equal(built, recorded);
});

test("buildInsightReport passes when all shots are present and validates", () => {
  const measured = {
    video: "/tmp/video.mp4",
    seconds: [1, 4, 5, 7],
    viewport: [1919, 1497],
    crop: [185, 55, 1533, 831],
    resize: [1920, 1080],
    shots: {
      1: { file: "shot-1.png", bytes: 100, current_time: 1, mean_luma: 13.5, frame: "frame-1.png", frame_bytes: 200 },
      4: { file: "shot-4.png", bytes: 100, current_time: 4, mean_luma: 14.9, frame: "frame-4.png", frame_bytes: 200 },
      5: { file: "shot-5.png", bytes: 100, current_time: 5, mean_luma: 15.4, frame: "frame-5.png", frame_bytes: 200 },
      7: { file: "shot-7.png", bytes: 100, current_time: 7, mean_luma: 16.0, frame: "frame-7.png", frame_bytes: 200 },
    },
  };
  const report = buildInsightReport(measured);
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  assert.equal(report.context.control_ceiling, null);
  assert.deepEqual(report.corrections, []);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("buildInsightReport fails when a shot is missing", () => {
  const measured = {
    video: "/tmp/video.mp4",
    seconds: [1, 4, 5, 7],
    viewport: [1919, 1497],
    crop: [185, 55, 1533, 831],
    resize: [1920, 1080],
    shots: { 1: { file: "shot-1.png", bytes: 100, current_time: 1, mean_luma: 13.5 } },
  };
  const report = buildInsightReport(measured);
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.detail.includes("4, 5, 7"));
  const { valid } = validateInsight(report);
  assert.equal(valid, true);
});
