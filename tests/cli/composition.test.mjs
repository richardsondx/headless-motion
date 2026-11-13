// Tests for `hme composition`: measure the subject box of one
// frame: box share, margins, thirds position, and eye placement.
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
  parseExpect,
  measureComposition,
  checkExpect,
  buildCorrections,
  buildInsightReport,
  DEFAULT_THRESHOLD,
  DEFAULT_TOLERANCE,
} from "../../src/cli/composition.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args, cwd = ROOT) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8", cwd });

const FRAME360 = "/home/hatch/workspace/handover-frame-first-batch2/units/K/work/frame-360.png";
const S1 = "/home/hatch/workspace/handover-frame-first-ant/subjects/S1-woman/frame.png";

// The frame 360 proof measurement: linear-sky branch, largest
// component [21, 554, 697, 724], 676 by 170 px, centroid
// (358.4, 609.7), head top (342, 562). The scale bar and the
// caption word are separate smaller components.
function fake360Measured() {
  return {
    shape: [1280, 720, 3],
    background: {
      branch: "linear-sky",
      largest_band_step: 11,
      step_bar: 20,
      threshold: 40,
      top_band_median: [132, 172, 254],
      bottom_band_median: [75, 94, 241],
    },
    subject_pixels: 66612,
    subject_frac: 0.0723,
    components: [
      { n: 48196, bbox: [21, 554, 697, 724], centroid: [358.4, 609.7] },
      { n: 8693, bbox: [20, 440, 700, 476], centroid: [359.4, 459.3] },
      { n: 2941, bbox: [406, 990, 541, 1020], centroid: [470.0, 1006.0] },
    ],
    head_top: { x: 342, y: 562 },
  };
}

// The batch 1 S1 proof measurement: per-row-median branch, one
// component [197, 206, 523, 1080], 326 by 874 px, centroid
// (362.1, 706.4), head top (355, 206).
function fakeS1Measured() {
  return {
    shape: [1280, 720, 3],
    background: {
      branch: "per-row-median",
      largest_band_step: 168,
      step_bar: 20,
      threshold: 40,
      top_band_median: [125, 157, 249],
      bottom_band_median: [34, 9, 81],
    },
    subject_pixels: 173282,
    subject_frac: 0.1881,
    components: [
      { n: 173282, bbox: [197, 206, 523, 1080], centroid: [362.1, 706.4] },
    ],
    head_top: { x: 355, y: 206 },
  };
}

test("hme composition --help lists inputs, outputs, and the proof", () => {
  const r = run(["composition", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hme composition/);
  assert.match(r.stdout, /--threshold <n>/);
  assert.match(r.stdout, /--expect <w_pct,h_pct>/);
  assert.match(r.stdout, /--tolerance <n>/);
  assert.match(r.stdout, /--out <file>/);
  assert.match(r.stdout, /45\.3 percent wide, 68\.3 percent tall/);
  assert.match(r.stdout, /93\.9 percent wide, 13\.3 percent tall/);
});

test("hme composition appears in the top help list", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /composition\s+Measure the subject box/);
});

test("hme composition with no frame exits 2", () => {
  const r = run(["composition"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs one frame/);
});

test("hme composition with a missing frame exits 2", () => {
  const r = run(["composition", "no-such-frame.png", "--at-s", "0"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no such file/);
});

test("hme composition with a bad --expect exits 2", () => {
  const r = run(["composition", "frame.png", "--expect", "70", "--at-s", "0"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad --expect/);
});

test("hme composition with a bad --threshold exits 2", () => {
  const r = run(["composition", "frame.png", "--threshold", "0", "--at-s", "0"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--threshold needs a positive number/);
});

test("parseAtS reads frame-N names at 60 fps and Ns names", () => {
  assert.equal(parseAtS("frame-360.png"), 6);
  assert.equal(parseAtS("frame-360.png", 60), 6);
  assert.equal(parseAtS("frame-360.png", 24), 15);
  assert.equal(parseAtS("real-7s.png"), 7);
  assert.equal(parseAtS("frame.png"), null);
});

test("parseExpect accepts a pair and rejects bad input", () => {
  assert.deepEqual(parseExpect("70,36"), { width_pct: 70, height_pct: 36 });
  assert.deepEqual(parseExpect("45.3,68.3"), { width_pct: 45.3, height_pct: 68.3 });
  assert.equal(parseExpect("70"), null);
  assert.equal(parseExpect("0,36"), null);
  assert.equal(parseExpect("101,36"), null);
  assert.equal(parseExpect("a,b"), null);
});

test("measureComposition reproduces the frame 360 proof numbers", () => {
  const c = measureComposition(fake360Measured());
  assert.deepEqual(c.box, { x0: 21, y0: 554, x1: 697, y1: 724, width: 676, height: 170 });
  assert.deepEqual(c.share, { width_pct: 93.9, height_pct: 13.3 });
  assert.deepEqual(c.margins.left_px, 21);
  assert.deepEqual(c.margins.right_px, 23);
  assert.deepEqual(c.margins.top_px, 554);
  assert.deepEqual(c.margins.bottom_px, 556);
  assert.deepEqual(c.eye.focal, { x: 358.4, y: 609.7, x_frac: 0.498, y_frac: 0.476 });
  assert.deepEqual(c.eye.head_top, { x: 342, y: 562, y_frac: 0.439 });
  assert.equal(c.thirds.centroid_cell_name, "centre-middle");
  assert.deepEqual(c.thirds.box_rows, [1, 1]);
  assert.equal(c.components.length, 3);
});

test("measureComposition reproduces the S1 proof numbers", () => {
  const c = measureComposition(fakeS1Measured());
  assert.deepEqual(c.box, { x0: 197, y0: 206, x1: 523, y1: 1080, width: 326, height: 874 });
  assert.deepEqual(c.share, { width_pct: 45.3, height_pct: 68.3 });
  assert.deepEqual(c.margins.left_px, 197);
  assert.deepEqual(c.margins.right_px, 197);
  assert.deepEqual(c.margins.top_px, 206);
  assert.deepEqual(c.margins.bottom_px, 200);
  assert.deepEqual(c.eye.focal, { x: 362.1, y: 706.4, x_frac: 0.503, y_frac: 0.552 });
  assert.deepEqual(c.eye.head_top, { x: 355, y: 206, y_frac: 0.161 });
  assert.equal(c.thirds.centroid_cell_name, "centre-middle");
  assert.deepEqual(c.thirds.box_rows, [0, 2]);
  assert.equal(c.components.length, 1);
});

test("measureComposition returns null with no components", () => {
  const measured = { ...fakeS1Measured(), components: [], subject_pixels: 0, subject_frac: 0 };
  assert.equal(measureComposition(measured), null);
});

test("checkExpect passes S1 and fails frame 360 at tolerance 5", () => {
  const s1 = checkExpect(measureComposition(fakeS1Measured()), { width_pct: 45, height_pct: 68 }, DEFAULT_TOLERANCE);
  assert.equal(s1.pass, true);
  assert.deepEqual(s1.gap, { width_pct_points: 0.3, height_pct_points: 0.3 });
  const f360 = checkExpect(measureComposition(fake360Measured()), { width_pct: 70, height_pct: 36 }, DEFAULT_TOLERANCE);
  assert.equal(f360.pass, false);
  assert.equal(f360.width_pass, false);
  assert.equal(f360.height_pass, false);
  assert.deepEqual(f360.gap, { width_pct_points: 23.9, height_pct_points: -22.7 });
});

test("frame 360 report is FAIL with one expect correction and a valid shape", () => {
  const measured = fake360Measured();
  const c = measureComposition(measured);
  const proof = checkExpect(c, { width_pct: 70, height_pct: 36 }, DEFAULT_TOLERANCE);
  const report = buildInsightReport(measured, c, proof, {
    frame: "frame-360.png", atS: 6, atSFrom: "--at-s flag", threshold: DEFAULT_THRESHOLD,
    expect: { width_pct: 70, height_pct: 36 }, tolerance: DEFAULT_TOLERANCE, outPath: null,
  });
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.corrections.length, 1);
  assert.match(report.corrections[0].fix, /93\.9 percent against expected 70/);
  assert.match(report.corrections[0].fix, /13\.3 percent against expected 36/);
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});

test("S1 report is PASS with no corrections and a valid shape", () => {
  const measured = fakeS1Measured();
  const c = measureComposition(measured);
  const proof = checkExpect(c, { width_pct: 45, height_pct: 68 }, DEFAULT_TOLERANCE);
  const report = buildInsightReport(measured, c, proof, {
    frame: "frame.png", atS: 0, atSFrom: "--at-s flag", threshold: DEFAULT_THRESHOLD,
    expect: { width_pct: 45, height_pct: 68 }, tolerance: DEFAULT_TOLERANCE, outPath: null,
  });
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  assert.deepEqual(report.corrections, []);
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});

test("no-subject report is FAIL with a valid shape", () => {
  const measured = { ...fakeS1Measured(), components: [], subject_pixels: 0, subject_frac: 0 };
  const report = buildInsightReport(measured, null, null, {
    frame: "frame.png", atS: 0, atSFrom: "--at-s flag", threshold: DEFAULT_THRESHOLD,
    expect: null, tolerance: DEFAULT_TOLERANCE, outPath: null,
  });
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.corrections.length, 1);
  assert.match(report.corrections[0].fix, /No subject component was found/);
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});

test("real frame 360 run fails the stated 70 by 36 with the proof numbers", { skip: !existsSync(FRAME360) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-composition-"));
  const out = join(dir, "composition-frame360.json");
  const r = run(["composition", FRAME360, "--expect", "70,36", "--at-s", "6", "--out", out]);
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.numbers.composition.share.width_pct, 93.9);
  assert.equal(report.numbers.composition.share.height_pct, 13.3);
  assert.deepEqual(report.numbers.proof.gap, { width_pct_points: 23.9, height_pct_points: -22.7 });
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});

test("real S1 run passes the stated 45 by 68 with the proof numbers", { skip: !existsSync(S1) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-composition-"));
  const out = join(dir, "composition-S1.json");
  const r = run(["composition", S1, "--expect", "45,68", "--at-s", "0", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.numbers.composition.share.width_pct, 45.3);
  assert.equal(report.numbers.composition.share.height_pct, 68.3);
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});

test("real frame 360 run without --expect passes as measurement only", { skip: !existsSync(FRAME360) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-composition-"));
  const out = join(dir, "composition-frame360-plain.json");
  const r = run(["composition", FRAME360, "--at-s", "6", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.numbers.proof, null);
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});
