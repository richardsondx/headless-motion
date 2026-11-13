// Tests for `hme gradient`: measure the vertical colour gradient of
// one frame.
//
// Fast tests cover the CLI surface and the pure report builder with
// the proof numbers. Real-frame tests run the tool on frame 360 and
// on batch 1 S1 when those files are present, and skip otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAtS,
  parseRegion,
  linearFit,
  measureGradient,
  buildCorrections,
  buildInsightReport,
  DEFAULT_BANDS,
  FLAT_DROP_MAX,
  STEP_JUMP_MIN,
} from "../../src/cli/gradient.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args, cwd = ROOT) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8", cwd });

const FRAME360 = "/home/hatch/workspace/handover-frame-first-batch2/units/G/work/frame-360.png";
const S1 = "/home/hatch/workspace/handover-frame-first-ant/subjects/S1-woman/frame.png";

// The frame 360 proof bands: medians fall smoothly from
// (132, 172, 254) to (75, 94, 241). Means differ in bands 3 and 4
// where a shape passes, which is why medians are the headline.
function fake360Measured() {
  const medians = [
    [132, 172, 254], [127, 165, 253], [120, 156, 251], [114, 148, 250],
    [110, 140, 249], [101, 129, 247], [94, 121, 246], [88, 112, 243],
    [82, 102, 242], [75, 94, 241],
  ];
  return {
    shape: [1280, 720, 3],
    region: { x: 0, y: 0, w: 720, h: 1280 },
    bands: medians.map((median, i) => ({
      index: i,
      y0: i * 128,
      y1: (i + 1) * 128,
      centre_y: i * 128 + 64,
      pixels: 720 * 128,
      mean: median,
      median,
    })),
  };
}

// The batch 1 S1 proof bands: flat (125, 157, 249) for bands 0 to 7,
// then the dark band (34, 9, 81) for bands 8 and 9.
function fakeS1Measured() {
  const medians = Array.from({ length: 8 }, () => [125, 157, 249])
    .concat([[34, 9, 81], [34, 9, 81]]);
  return {
    shape: [1280, 720, 3],
    region: { x: 0, y: 0, w: 720, h: 1280 },
    bands: medians.map((median, i) => ({
      index: i,
      y0: i * 128,
      y1: (i + 1) * 128,
      centre_y: i * 128 + 64,
      pixels: 720 * 128,
      mean: median,
      median,
    })),
  };
}

test("hme gradient --help lists inputs, outputs, and the proof", () => {
  const r = run(["gradient", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hme gradient/);
  assert.match(r.stdout, /--region <x,y,w,h>/);
  assert.match(r.stdout, /--bands <n>/);
  assert.match(r.stdout, /--out <file>/);
  assert.match(r.stdout, /132, 172, 254/);
  assert.match(r.stdout, /34, 9, 81/);
});

test("hme gradient appears in the top help list", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gradient\s+Measure the vertical colour gradient/);
});

test("hme gradient with no frame exits 2", () => {
  const r = run(["gradient"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs one frame/);
});

test("hme gradient with a missing frame exits 2", () => {
  const r = run(["gradient", "no-such-frame.png", "--at-s", "0"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no such file/);
});

test("hme gradient with a bad --region exits 2", () => {
  const r = run(["gradient", "frame.png", "--region", "0,0,720", "--at-s", "0"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad --region/);
});

test("hme gradient with --bands 1 exits 2", () => {
  const r = run(["gradient", "frame.png", "--bands", "1", "--at-s", "0"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--bands needs a whole number/);
});

test("parseAtS reads frame-N names at 60 fps and Ns names", () => {
  assert.equal(parseAtS("frame-360.png"), 6);
  assert.equal(parseAtS("frame-360.png", 60), 6);
  assert.equal(parseAtS("frame-360.png", 24), 15);
  assert.equal(parseAtS("real-7s.png"), 7);
  assert.equal(parseAtS("frame.png"), null);
});

test("parseRegion accepts a full rect and rejects bad input", () => {
  assert.deepEqual(parseRegion("0,0,720,1024"), { x: 0, y: 0, w: 720, h: 1024 });
  assert.equal(parseRegion("0,0,720"), null);
  assert.equal(parseRegion("0,0,0,10"), null);
  assert.equal(parseRegion("a,b,c,d"), null);
});

test("linearFit recovers a known slope", () => {
  const fit = linearFit([0, 100, 200, 300], [10, 8, 6, 4]);
  assert.ok(Math.abs(fit.slope - (-0.02)) < 1e-9);
  assert.ok(fit.r2 > 0.999);
});

test("measureGradient reproduces the frame 360 proof numbers", () => {
  const g = measureGradient(fake360Measured());
  assert.deepEqual(g.top_median, [132, 172, 254]);
  assert.deepEqual(g.bottom_median, [75, 94, 241]);
  assert.deepEqual(g.drop_top_to_bottom, { r: 57, g: 78, b: 13 });
  assert.equal(g.max_drop, 78);
  assert.equal(g.largest_step.biggest, 11);
  assert.ok(g.slope_r2.g > 0.99);
  assert.equal(g.falloff_curve.length, 10);
  assert.deepEqual(g.falloff_curve[0].median, [132, 172, 254]);
  assert.deepEqual(g.falloff_curve[9].median, [75, 94, 241]);
});

test("measureGradient finds S1 flat with a step at y 1024", () => {
  const g = measureGradient(fakeS1Measured());
  assert.deepEqual(g.top_median, [125, 157, 249]);
  assert.deepEqual(g.bottom_median, [34, 9, 81]);
  assert.deepEqual(g.variation_outside_step, { r: 0, g: 0, b: 0 });
  assert.equal(g.max_variation_outside_step, 0);
  assert.equal(g.largest_step.biggest, 168);
  assert.equal(g.largest_step.y, 1024);
  assert.deepEqual(g.largest_step.jump, { r: -91, g: -148, b: -168 });
});

test("frame 360 report is PASS with no corrections and a valid shape", () => {
  const measured = fake360Measured();
  const g = measureGradient(measured);
  const report = buildInsightReport(measured, g, {
    frame: "frame-360.png", atS: 6, atSFrom: "--at-s flag", bands: DEFAULT_BANDS,
    regionText: "full", outPath: null,
  });
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  assert.deepEqual(report.corrections, []);
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});

test("S1 report is FAIL with flat and step corrections and a valid shape", () => {
  const measured = fakeS1Measured();
  const g = measureGradient(measured);
  const report = buildInsightReport(measured, g, {
    frame: "frame.png", atS: 0, atSFrom: "--at-s flag", bands: DEFAULT_BANDS,
    regionText: "full", outPath: null,
  });
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.corrections.length, 2);
  assert.match(report.corrections[0].fix, /Sky is flat/);
  assert.match(report.corrections[1].fix, /Abrupt step/);
  assert.match(report.corrections[1].fix, /y=1024/);
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});

test("thresholds sit between the two proof cases", () => {
  const g360 = measureGradient(fake360Measured());
  const gS1 = measureGradient(fakeS1Measured());
  assert.ok(gS1.max_variation_outside_step < FLAT_DROP_MAX);
  assert.ok(g360.max_variation_outside_step > FLAT_DROP_MAX);
  assert.ok(g360.largest_step.biggest < STEP_JUMP_MIN);
  assert.ok(gS1.largest_step.biggest > STEP_JUMP_MIN);
});

test("real frame 360 run passes with the proof numbers", { skip: !existsSync(FRAME360) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-gradient-"));
  const out = join(dir, "gradient-frame360.json");
  const r = run(["gradient", FRAME360, "--at-s", "6", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.verdict.status, "PASS");
  const g = report.numbers.gradient;
  assert.deepEqual(g.top_median, [132, 172, 254]);
  assert.deepEqual(g.bottom_median, [75, 94, 241]);
  assert.deepEqual(g.drop_top_to_bottom, { r: 57, g: 78, b: 13 });
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});

test("real S1 run fails flat with the step named", { skip: !existsSync(S1) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-gradient-"));
  const out = join(dir, "gradient-S1.json");
  const r = run(["gradient", S1, "--at-s", "0", "--out", out]);
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.corrections.length, 2);
  const g = report.numbers.gradient;
  assert.equal(g.max_variation_outside_step, 0);
  assert.equal(g.largest_step.biggest, 168);
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});
