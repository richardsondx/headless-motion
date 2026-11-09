// Tests for `hme render`. The short render runs the real renderer
// CLI on scene-min at previs, frames 0 to 11 only, so the suite
// stays fast. The full 240-frame render is the U11 VERIFY command,
// not a unit test.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderReport, defaultRenderOut, PROFILES } from "../../src/cli/render.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
const MIN = join(ROOT, "tests", "fixtures", "scene-min.json");

test("render --help prints usage and exits 0", () => {
  const r = run(["render", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme render"));
  assert.ok(r.stdout.includes("Usage: hme render <scene.json> --profile previs|draft|final|final-max|preview-rt"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("render without --profile exits 2 without a stack trace", () => {
  const r = run(["render", MIN]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--profile is required"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("render with an unknown profile exits 2", () => {
  const r = run(["render", MIN, "--profile", "huge"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('unknown profile "huge"'));
});

test("render with a missing scene exits 2", () => {
  const r = run(["render", "no-such-scene.json", "--profile", "previs"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file"));
});

test("render with a bad --frames range exits 2", () => {
  const r = run(["render", MIN, "--profile", "previs", "--frames", "9:2"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--frames needs a:b"));
});

test("render previs frames 0 to 11 passes and the video exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-render-"));
  try {
    const out = join(dir, "render.json");
    const renderOut = join(dir, "scene-min-render");
    const r = run(["render", MIN, "--profile", "previs", "--frames", "0:11", "--render-out", renderOut, "--out", out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "PASS");
    assert.equal(report.verdict.failed_bar, null);
    assert.equal(report.numbers.profile, "previs");
    // The renderer range is half-open: 0:11 captures frames 0 to 10.
    assert.equal(report.numbers.frames_captured, 11);
    assert.equal(report.numbers.frames_requested, 11);
    assert.equal(report.numbers.video_exists, true);
    assert.ok(report.numbers.video_bytes > 0);
    assert.ok(existsSync(report.numbers.video));
    assert.ok(statSync(report.numbers.video).size > 0);
    assert.equal(report.numbers.renderer_exit, 0);
    assert.equal(validateInsight(report).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultRenderOut names the render dir beside the report", () => {
  const out = join("/tmp", "u11", "u11-render.json");
  assert.equal(defaultRenderOut(MIN, out), join("/tmp", "u11", "scene-min-render"));
  assert.ok(defaultRenderOut(MIN, null).endsWith(join("out", "scene-min-hme")));
});

test("buildRenderReport is pure: pass case and renderer exit 2 case", () => {
  const pass = buildRenderReport({
    exit: 0, stdout: "", stderr: "",
    renderReport: { frames_captured: 24, code: null, stage: "probe", message: "", scene_sha256: "abc" },
    renderReportPath: "/tmp/x/render-report.json",
    videoPath: "/tmp/x/video.mp4", videoBytes: 1234,
    framesRequested: 24, verifyDeterminism: false, renderOut: "/tmp/x",
  }, MIN, "previs", "/tmp/x/report.json");
  assert.equal(pass.verdict.status, "PASS");
  assert.equal(pass.numbers.frames_captured, 24);
  assert.equal(pass.numbers.video_bytes, 1234);
  assert.equal(validateInsight(pass).valid, true);
  const fail = buildRenderReport({
    exit: 2, stdout: "", stderr: "FONT_MISSING fonts/Missing.ttf\n",
    renderReport: { frames_captured: 0, code: "FONT_MISSING", stage: "load", message: "font missing" },
    renderReportPath: "/tmp/x/render-report.json",
    videoPath: "/tmp/x/video.mp4", videoBytes: null,
    framesRequested: 24, verifyDeterminism: false, renderOut: "/tmp/x",
  }, MIN, "previs", "/tmp/x/report.json");
  assert.equal(fail.verdict.status, "FAIL");
  assert.ok(fail.verdict.failed_bar.includes("renderer exit 2"));
  assert.ok(fail.verdict.failed_bar.includes("font"));
  assert.equal(fail.numbers.video_exists, false);
  assert.equal(validateInsight(fail).valid, true);
});

test("profiles cover previs, draft, final, final-max, preview-rt", () => {
  assert.deepEqual([...PROFILES].sort(), ["draft", "final", "final-max", "preview-rt", "previs"]);
});
