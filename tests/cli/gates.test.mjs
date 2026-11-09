// Tests for `hme gates`. The map-sample check runs the real map CLI
// (G8 on sampled frames, G9 on all frames). No render happens here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGatesReport } from "../../src/cli/gates.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
const SAMPLE = join(ROOT, "tests", "fixtures", "map-sample.json");

test("gates --help prints usage and exits 0", () => {
  const r = run(["gates", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme gates"));
  assert.ok(r.stdout.includes("Usage: hme gates <scene.json> [--out <report.json>]"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("gates on map-sample passes and names G8 and G9 separately", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-gates-"));
  try {
    const out = join(dir, "gates.json");
    const r = run(["gates", SAMPLE, "--out", out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "PASS");
    assert.equal(report.verdict.failed_bar, null);
    assert.equal(report.numbers.g8, "pass");
    assert.equal(report.numbers.g9, "pass");
    assert.equal(report.numbers.g8_failure_count, 0);
    assert.equal(report.numbers.g9_failure_count, 0);
    assert.equal(report.numbers.frames, 240);
    assert.ok(report.numbers.sampled_frame_count > 0);
    assert.ok(report.numbers.sampled_frames.includes(120));
    assert.equal(report.numbers.map_report, "out/map-sample/g8-g9-report.json");
    assert.equal(validateInsight(report).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gates on a scene with no map node fails with exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-gates-"));
  try {
    const out = join(dir, "gates.json");
    const r = run(["gates", join(ROOT, "tests", "fixtures", "scene-min.json"), "--out", out]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "FAIL");
    assert.equal(report.numbers.g8, null);
    assert.equal(report.numbers.g9, null);
    assert.equal(validateInsight(report).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gates on a failing map scene fails and names the gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-gates-"));
  try {
    const out = join(dir, "gates.json");
    const r = run(["gates", join(ROOT, "tests", "fixtures", "map-bad", "G8_TEXT.json"), "--out", out]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "FAIL");
    assert.equal(report.numbers.g8, "fail");
    assert.ok(report.numbers.g8_failure_count > 0);
    assert.ok(report.numbers.g8_failures.some((f) => f.code === "G8_TEXT"));
    assert.ok(report.verdict.failed_bar.includes("G8"));
    assert.equal(validateInsight(report).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gates with a missing file exits 2 and still writes a FAIL report", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-gates-"));
  try {
    const out = join(dir, "gates.json");
    const r = run(["gates", "no-such-scene.json", "--out", out]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "FAIL");
    assert.equal(report.numbers.g8, null);
    assert.equal(report.numbers.g9, null);
    assert.equal(validateInsight(report).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gates with no scene exits 2 without a stack trace", () => {
  const r = run(["gates"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs one scene file"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("buildGatesReport names each gate and counts its failures", () => {
  const report = buildGatesReport({
    exit: 1,
    stdout: "G8 fail (1 failures) G9 pass (0 failures)\n",
    stderr: "",
    report: { g8: "fail", g9: "pass", sampledFrames: [72, 120], g8Failures: [{ code: "G8_TEXT", frame: 120, detail: "label l-sudan text on #000000 1.00:1, needs 7:1" }], g9Failures: [] },
  }, SAMPLE, null);
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.numbers.g8, "fail");
  assert.equal(report.numbers.g9, "pass");
  assert.equal(report.numbers.g8_failure_count, 1);
  assert.equal(report.numbers.g9_failure_count, 0);
  assert.ok(report.verdict.failed_bar.includes("G8"));
  assert.ok(!report.verdict.failed_bar.includes("G9"));
  assert.equal(validateInsight(report).valid, true);
});
