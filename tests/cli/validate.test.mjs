// Fast tests for `hme validate`. The v5 scene check runs the real
// validator and the real determinism lint. No render happens here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildValidateReport } from "../../src/cli/validate.mjs";
import { validateScene, loadScene } from "../../src/scene/validate.mjs";
import { lintDir } from "../../src/scene/lint-determinism.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
const V5 = join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json");

test("validate --help prints usage and exits 0", () => {
  const r = run(["validate", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme validate"));
  assert.ok(r.stdout.includes("Usage: hme validate <scene.json> [--out <report.json>]"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("validate on the v5 scene passes: 192 frames, 24 fps, 0 errors, 0 warnings", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-validate-"));
  try {
    const out = join(dir, "validate.json");
    const r = run(["validate", V5, "--out", out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "PASS");
    assert.equal(report.verdict.failed_bar, null);
    assert.equal(report.numbers.scene_id, "seg4-scene-v5");
    assert.equal(report.numbers.frames, 192);
    assert.equal(report.numbers.fps, 24);
    assert.equal(report.numbers.error_count, 0);
    assert.equal(report.numbers.warning_count, 0);
    assert.equal(report.numbers.determinism.hit_count, 0);
    assert.deepEqual(report.corrections, []);
    assert.equal(validateInsight(report).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate on a bad scene fails with exit 1 and names the error", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-validate-"));
  try {
    const out = join(dir, "validate.json");
    const bad = join(ROOT, "tests", "fixtures", "bad", "DUP_ID.json");
    const r = run(["validate", bad, "--out", out]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "FAIL");
    assert.ok(report.verdict.failed_bar.includes("0 errors allowed"));
    assert.ok(report.numbers.error_count > 0);
    assert.ok(report.numbers.errors.some((e) => e.code === "DUP_ID"));
    assert.equal(validateInsight(report).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate on a scene with a banned construct fails the determinism lint", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-validate-"));
  try {
    const scene = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "scene-min.json"), "utf8"));
    scene.nodes[0].props.text = "Math.random";
    const scenePath = join(dir, "scene.json");
    writeFileSync(scenePath, JSON.stringify(scene, null, 2) + "\n");
    const out = join(dir, "validate.json");
    const r = run(["validate", scenePath, "--out", out]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "FAIL");
    assert.equal(report.numbers.error_count, 0);
    assert.equal(report.numbers.determinism.hit_count, 1);
    assert.equal(report.numbers.determinism.hits[0].rule, "Math.random");
    assert.ok(report.verdict.failed_bar.includes("determinism lint"));
    assert.equal(validateInsight(report).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate with a missing file exits 2 and still writes a FAIL report", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-validate-"));
  try {
    const out = join(dir, "validate.json");
    const r = run(["validate", "no-such-scene.json", "--out", out]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.ok(r.stderr.includes("no such file"));
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "FAIL");
    assert.equal(report.numbers.errors[0].code, "SCENE_UNREADABLE");
    assert.equal(validateInsight(report).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate with no scene exits 2 without a stack trace", () => {
  const r = run(["validate"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs one scene file"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("buildValidateReport is pure: v5 scene, zero errors, zero hits", () => {
  const scene = loadScene(V5);
  const result = validateScene(scene);
  const report = buildValidateReport(scene, result, lintDir(V5), null, V5);
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.numbers.frames, 192);
  assert.equal(report.numbers.fps, 24);
  assert.equal(validateInsight(report).valid, true);
});
