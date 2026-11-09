import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateInsight, writeInsightReport } from "../../src/cli/hme.mjs";
import { DEFAULT_FRAMES, FADE_FRAMES, parseFramesSpec, resolveFrames, buildInsightReport, frameFileMap, labelFromMeasured, buildCorrections, sceneTextNode } from "../../src/cli/type.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
const noStack = (text) => !/at .*\.mjs:\d+/.test(text);

// Shape fixtures only. These numbers are not measurements; they test
// that the report shape validates and that the verdict rule maps to
// the right exit code. Real numbers come from the T2 core.
function measuredLabel(overrides = {}) {
  return {
    measured: true,
    lettersRef: 8,
    lettersOurs: 8,
    meanIou: 0.81,
    worstLetter: "F",
    worstIou: 0.62,
    gapMedianPx: 3,
    gapOverCapHeight: 0.11,
    gapsPx: [3, 2, 3, 4, 3, 2, 3],
    strokePx: 2,
    strokeOverCapHeight: 0.07,
    strokeNote: null,
    aaTransitionPx: 1.2,
    aaFraction: 0.18,
    capHeightPx: 27,
    framesRef: [156, 168, 180],
    framesOurs: [156, 168, 180],
    ...overrides,
  };
}

function reportInput(overrides = {}) {
  return {
    refDir: "ref-frames",
    oursDir: "ours-frames",
    tracePath: "trace.json",
    scenePath: null,
    frames: resolveFrames([]),
    october: measuredLabel({ lettersRef: 11, lettersOurs: 11, framesRef: [12, 24], framesOurs: [24, 36], gapMedianPx: 15, capHeightPx: 133 }),
    elFasher: measuredLabel(),
    corrections: [],
    ...overrides,
  };
}

test("hme type --help exits 0 and lists inputs, options, and report fields", () => {
  const r = run(["type", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme type"), "help must name the command");
  assert.ok(r.stdout.includes("Usage:"), "help must show usage");
  assert.ok(r.stdout.includes("<ref-frames-dir>"), "help must list the ref frames dir");
  assert.ok(r.stdout.includes("<ours-frames-dir>"), "help must list the ours frames dir");
  assert.ok(r.stdout.includes("--trace"), "help must list --trace");
  assert.ok(r.stdout.includes("--scene"), "help must list --scene");
  assert.ok(r.stdout.includes("--frames"), "help must list --frames");
  assert.ok(r.stdout.includes("--out"), "help must list --out");
  assert.ok(r.stdout.includes("Report fields:"), "help must list the report fields");
  assert.ok(r.stdout.includes("verdict"), "help must name the verdict field");
  assert.ok(r.stdout.includes("corrections"), "help must name the corrections field");
  assert.ok(r.stdout.includes("156, 168, 180"), "help must document the EL FASHER default frames");
  assert.ok(r.stdout.includes("12, 24"), "help must document the October ref default frames");
  assert.ok(noStack(r.stderr + r.stdout), "help must not print a stack trace");
});

test("hme type with no arguments is a usage error and exits 2", () => {
  const r = run(["type"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs two frame directories"), `stderr was: ${r.stderr}`);
  assert.ok(noStack(r.stderr), "must not print a stack trace");
});

test("hme type with a missing ref dir exits 2 and names the dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    const r = run(["type", join(dir, "no-such-ref"), dir, "--trace", join(dir, "trace.json")]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("no such directory"), `stderr was: ${r.stderr}`);
    assert.ok(r.stderr.includes("no-such-ref"), `stderr was: ${r.stderr}`);
    assert.ok(noStack(r.stderr), "must not print a stack trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hme type with a missing ours dir exits 2 and names the dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    const r = run(["type", dir, join(dir, "no-such-ours"), "--trace", join(dir, "trace.json")]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("no-such-ours"), `stderr was: ${r.stderr}`);
    assert.ok(noStack(r.stderr), "must not print a stack trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hme type without --trace exits 2 and says it is required", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    const r = run(["type", dir, dir]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("--trace"), `stderr was: ${r.stderr}`);
    assert.ok(r.stderr.includes("required"), `stderr was: ${r.stderr}`);
    assert.ok(noStack(r.stderr), "must not print a stack trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hme type with a missing trace file exits 2 and names the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    const r = run(["type", dir, dir, "--trace", join(dir, "no-such-trace.json")]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("no such file"), `stderr was: ${r.stderr}`);
    assert.ok(noStack(r.stderr), "must not print a stack trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hme type with an unknown option exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    const trace = join(dir, "trace.json");
    writeFileSync(trace, "{}\n");
    const r = run(["type", dir, dir, "--trace", trace, "--bogus"]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('unknown option "--bogus"'), `stderr was: ${r.stderr}`);
    assert.ok(noStack(r.stderr), "must not print a stack trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hme type with valid arguments measures both labels and exits 0", () => {
  const r = run(["type", join(ROOT, "verify-seg4/evidence/work/full-192"),
    join(ROOT, "verify-seg4/evidence/work/full-192"),
    "--trace", join(ROOT, "verify-seg4/evidence/seg4-trace.json"),
    "--scene", join(ROOT, "tests/fixtures/seg4-scene-clone-v5.json")]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(noStack(r.stderr), "must not print a stack trace");
  const report = JSON.parse(r.stdout);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
  assert.equal(report.verdict.status, "PASS");
});

// The Seg4 proof run, once per file, shared by the measurement
// assertions below. It takes about 45 s: 10 main frames plus the
// October fade sampling.
const SEG4 = { run: null };
before(() => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-seg4-"));
  const out = join(dir, "type-seg4.json");
  const r = run(["type", join(ROOT, "verify-seg4/evidence/work/full-192"),
    join(ROOT, "verify-seg4/evidence/work/full-192"),
    "--trace", join(ROOT, "verify-seg4/evidence/seg4-trace.json"),
    "--scene", join(ROOT, "tests/fixtures/seg4-scene-clone-v5.json"),
    "--out", out]);
  if (r.status !== 0 || !existsSync(out)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`hme type failed with exit code ${r.status}: ${r.stderr}`);
  }
  SEG4.run = { status: r.status, stderr: r.stderr, report: JSON.parse(readFileSync(out, "utf8")) };
  rmSync(dir, { recursive: true, force: true });
});

test("Seg4 proof run passes with 11 October letters and 8 EL FASHER letters each side", () => {
  assert.equal(SEG4.run.status, 0, SEG4.run.stderr);
  const labels = SEG4.run.report.numbers.labels;
  assert.equal(labels.october.measured, true);
  assert.equal(labels.october.letters_ref, 11);
  assert.equal(labels.october.letters_ours, 11);
  assert.equal(labels["el-fasher"].measured, true);
  assert.equal(labels["el-fasher"].letters_ref, 8);
  assert.equal(labels["el-fasher"].letters_ours, 8);
  // Per-letter overlap is computed for both labels.
  assert.ok(labels.october.mean_iou > 0.5, `October mean IoU was ${labels.october.mean_iou}`);
  assert.ok(labels["el-fasher"].mean_iou > 0.5, `EL FASHER mean IoU was ${labels["el-fasher"].mean_iou}`);
  assert.equal(labels.october.overlap.paired, true);
  assert.equal(labels["el-fasher"].overlap.paired, true);
  assert.equal(labels.october.overlap.per_letter.length, 11);
  assert.equal(labels["el-fasher"].overlap.per_letter.length, 8);
});

test("Seg4 October ref frame 12 has 10 letters and frame 24 has 11 (the 5 pops in between)", () => {
  const perFrame = SEG4.run.report.numbers.labels.october.per_frame.ref;
  assert.equal(perFrame[0].frame, 12);
  assert.equal(perFrame[0].letters, 10);
  assert.equal(perFrame[0].fixed180.letters, 10);
  assert.equal(perFrame[1].frame, 24);
  assert.equal(perFrame[1].letters, 11);
  assert.equal(perFrame[1].fixed180.letters, 10);
});

test("Seg4 EL FASHER raw fixed 180 counts are 9 ref and 8 ours before the fix", () => {
  const perFrame = SEG4.run.report.numbers.labels["el-fasher"].per_frame;
  for (const side of ["ref", "ours"]) {
    for (const pf of perFrame[side]) {
      assert.equal(pf.fixed180.letters, side === "ref" ? 9 : 8,
        `${side} frame ${pf.frame} fixed 180 letters were ${pf.fixed180.letters}`);
    }
  }
});

test("Seg4 fixed 180 reproduction matches the U9 aggregates within tolerance", () => {
  const repro = SEG4.run.report.numbers.reproduction_fixed180;
  assert.deepEqual(repro.frames, [156, 168, 180]);
  // Ours letters exact.
  assert.equal(repro.trace_box.ours.letters_mean, 8);
  assert.equal(repro.trace_box.ours.letters_mean, repro.u9.ours_letters_mean);
  // Ref letters: trace-box mean 9.0 against U9 8.67, one dot-fragment
  // component the trace box keeps; the adaptive fix removes it.
  assert.equal(repro.trace_box.ref.letters_mean, 9);
  assert.equal(repro.within_tolerance.letters_ours_exact, true);
  // Gap within 1 px, stroke within 0.5 px, AA within 0.02.
  assert.ok(Math.abs(repro.trace_box.ref.median_gap_px_mean - 3) <= 1);
  assert.ok(Math.abs(repro.trace_box.ours.median_gap_px_mean - 2) <= 1);
  assert.equal(repro.trace_box.ref.median_stroke_px_mean, 2);
  assert.equal(repro.trace_box.ours.median_stroke_px_mean, 4);
  assert.ok(Math.abs(repro.trace_box.ref.aa_fraction_mean - 0.184) <= 0.02);
  assert.ok(Math.abs(repro.trace_box.ours.aa_fraction_mean - 0.1987) <= 0.02);
  assert.equal(repro.within_tolerance.gap_within_1px, true);
  assert.equal(repro.within_tolerance.stroke_within_0_5px, true);
  assert.equal(repro.within_tolerance.aa_within_0_02, true);
});

test("Seg4 fixed 180 reproduction uses U9's per-frame dot window and matches ref letters exactly", () => {
  const repro = SEG4.run.report.numbers.reproduction_fixed180;
  // U9 finds the dot per frame from the RSF badge corner, not from
  // the static trace centre (783, 646). The detected ref centres
  // are (804.9, 626.4) at 156, (788.1, 649.0) at 168, (788.0, 650.4)
  // at 180, giving letters 8, 9, 9, total 26, mean 8.6667.
  const dw = repro.dot_window;
  assert.deepEqual(dw.ref.per_frame.map((v) => v.letters), [8, 9, 9]);
  assert.deepEqual(dw.ours.per_frame.map((v) => v.letters), [8, 8, 8]);
  assert.equal(dw.ref.letters_mean, 8.6667);
  assert.equal(dw.ref.letters_mean, repro.u9.ref_letters_mean);
  assert.equal(dw.ours.letters_mean, 8);
  assert.deepEqual(dw.ref.per_frame[0].dot_centre, [804.9, 626.4]);
  assert.deepEqual(dw.ref.per_frame[0].window, [794, 601, 1024, 651]);
  assert.deepEqual(dw.ref.per_frame[1].dot_centre, [788.1, 649]);
  assert.deepEqual(dw.ref.per_frame[2].dot_centre, [788, 650.4]);
  // The other U9 aggregates match on the same window, not just letters.
  assert.equal(dw.ref.median_gap_px_mean, 3);
  assert.equal(dw.ours.median_gap_px_mean, 2);
  assert.equal(dw.ref.median_stroke_px_mean, 2);
  assert.equal(dw.ours.median_stroke_px_mean, 4);
  assert.equal(dw.ref.aa_fraction_mean, 0.184);
  assert.equal(dw.ours.aa_fraction_mean, 0.1987);
  assert.equal(repro.within_tolerance.letters_ref_exact, true);
  assert.equal(repro.within_tolerance.letters_ours_exact, true);
  assert.equal(repro.within_tolerance.letters_ref_mean, 8.6667);
  // The static trace-centre window and the trace box are kept for
  // the record and still show the old mismatch: 9.3333 and 9.0.
  assert.equal(repro.dot_window.ref.letters_mean, 8.6667);
  assert.equal(repro.trace_box.ref.letters_mean, 9);
});

test("Seg4 per-pair kerning gaps are reported, not just the median", () => {
  const labels = SEG4.run.report.numbers.labels;
  const oct = labels.october;
  assert.equal(oct.gaps_px.ref.length, 10);
  assert.equal(oct.gaps_px.ours.length, 10);
  assert.deepEqual(oct.gaps_px.ref, [13, 11, 13, 15, 13, 15, 51, 14, 14, 15]);
  assert.equal(oct.gap_median_px.ref, 14);
  assert.equal(oct.gap_median_px.ours, 1);
  assert.ok(oct.gap_over_cap_height.ref > 0.1);
  assert.ok(oct.gap_over_cap_height.ours < 0.01);
  const ef = labels["el-fasher"];
  assert.equal(ef.gaps_px.ref.length, 7);
  assert.equal(ef.gaps_px.ours.length, 7);
  assert.equal(ef.gaps_px.ref[1], 16);
  assert.equal(ef.gaps_px.ours[1], 9);
});

test("Seg4 stroke, cap height, and AA transition are reported per label", () => {
  const labels = SEG4.run.report.numbers.labels;
  const oct = labels.october;
  assert.equal(oct.stroke_px.ref, 16);
  assert.equal(oct.cap_height_px.ref, 133);
  assert.equal(oct.cap_height_px.ours, 133);
  assert.equal(oct.cap_height_ratio, 1);
  assert.equal(oct.aa_transition_px.ref, 2);
  assert.equal(oct.aa_transition_px.ours, 1);
  const ef = labels["el-fasher"];
  assert.equal(ef.stroke_px.ref, 2);
  assert.equal(ef.stroke_px.ours, 4);
  assert.equal(ef.cap_height_px.ref, 17);
  assert.equal(ef.cap_height_px.ours, 27);
  assert.ok(Math.abs(ef.cap_height_ratio - 1.5882) < 0.001);
  assert.equal(ef.aa_transition_px.ref, 2);
  assert.equal(ef.aa_transition_px.ours, 2);
});

test("Seg4 October fade difference names the frames on each side", () => {
  const fade = SEG4.run.report.numbers.labels.october.fade;
  assert.equal(fade.ref.first_full_frame, 12);
  assert.equal(fade.ref.last_visible_frame, 48);
  assert.equal(fade.ours.last_visible_frame, 60);
  assert.ok(fade.difference.includes("48"));
  assert.ok(fade.difference.includes("60"));
});

test("Seg4 report names the frames used per label", () => {
  const frames = SEG4.run.report.numbers.frames;
  assert.deepEqual(frames.october, { ref: [12, 24], ours: [24, 36] });
  assert.deepEqual(frames["el-fasher"], { ref: [156, 168, 180], ours: [156, 168, 180] });
  assert.deepEqual(FADE_FRAMES, [0, 12, 24, 36, 48, 60, 72]);
});

test("count mismatch refuses the pairing and fails with exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    const out = join(dir, "mismatch.json");
    const r = run(["type", join(ROOT, "verify-seg4/evidence/work/full-192"),
      join(ROOT, "verify-seg4/evidence/work/full-192"),
      "--trace", join(ROOT, "verify-seg4/evidence/seg4-trace.json"),
      "--frames", "october:ref:12",
      "--frames", "october:ours:24",
      "--frames", "el-fasher:156",
      "--out", out]);
    assert.equal(r.status, 1, r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "FAIL");
    assert.ok(report.verdict.failed_bar.includes("counts differ"), `failed_bar was: ${report.verdict.failed_bar}`);
    assert.equal(report.numbers.labels.october.overlap.paired, false);
    assert.equal(report.numbers.labels.october.overlap.letters_ref, 10);
    assert.equal(report.numbers.labels.october.overlap.letters_ours, 11);
    assert.equal(report.numbers.labels.october.mean_iou, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hme type with a bad --frames spec exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    const trace = join(dir, "trace.json");
    writeFileSync(trace, "{}\n");
    const r = run(["type", dir, dir, "--trace", trace, "--frames", "nope:1,2"]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("bad --frames label"), `stderr was: ${r.stderr}`);
    assert.ok(noStack(r.stderr), "must not print a stack trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default frame sets are the Seg4 proof plan", () => {
  assert.deepEqual(DEFAULT_FRAMES["el-fasher"], { ref: [156, 168, 180], ours: [156, 168, 180] });
  assert.deepEqual(DEFAULT_FRAMES.october, { ref: [12, 24], ours: [24, 36] });
});

test("parseFramesSpec sets both sides with two parts and one side with three", () => {
  const two = parseFramesSpec("el-fasher:156,168,180");
  assert.deepEqual(two["el-fasher"], { ref: [156, 168, 180], ours: [156, 168, 180] });
  assert.deepEqual(two.october, DEFAULT_FRAMES.october);
  const three = parseFramesSpec("october:ours:24,36");
  assert.deepEqual(three.october, { ref: [12, 24], ours: [24, 36] });
  const sorted = parseFramesSpec("october:ref:24,12,24");
  assert.deepEqual(sorted.october.ref, [12, 24]);
  assert.throws(() => parseFramesSpec("nope:1,2"), /bad --frames label/);
  assert.throws(() => parseFramesSpec("october:side:1,2"), /bad --frames side/);
  assert.throws(() => parseFramesSpec("october:ref:12,x"), /not a frame number/);
  assert.throws(() => parseFramesSpec("october"), /bad --frames spec/);
});

test("resolveFrames applies specs in order over the defaults", () => {
  const frames = resolveFrames(["el-fasher:156,180", "october:ref:12"]);
  assert.deepEqual(frames["el-fasher"], { ref: [156, 180], ours: [156, 180] });
  assert.deepEqual(frames.october, { ref: [12], ours: [24, 36] });
});

test("buildInsightReport with both labels measured is a valid PASS report", () => {
  const report = buildInsightReport(reportInput());
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    assert.equal(writeInsightReport(report, join(dir, "pass.json")), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildInsightReport with an unmeasured label is a valid FAIL report", () => {
  const report = buildInsightReport(reportInput({
    october: { measured: false, reason: "present False on the ours side after adaptive ink" },
  }));
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("october"), `failed_bar was: ${report.verdict.failed_bar}`);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    assert.equal(writeInsightReport(report, join(dir, "fail.json")), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildInsightReport with a count mismatch is a valid FAIL report", () => {
  const report = buildInsightReport(reportInput({
    elFasher: measuredLabel({ lettersRef: 9, lettersOurs: 8 }),
  }));
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("counts differ"), `failed_bar was: ${report.verdict.failed_bar}`);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("frameFileMap matches frames by number and splits a mixed dir by prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    for (const name of ["ref-0001.png", "ref-0156.png", "v5-0001.png", "v5-0156.png", "notes.txt"]) {
      writeFileSync(join(dir, name), "");
    }
    const ref = frameFileMap(dir, "ref");
    assert.equal(ref.get(1), join(dir, "ref-0001.png"));
    assert.equal(ref.get(156), join(dir, "ref-0156.png"));
    const ours = frameFileMap(dir, "ours");
    assert.equal(ours.get(1), join(dir, "v5-0001.png"));
    assert.equal(ours.get(156), join(dir, "v5-0156.png"));
    assert.equal(ref.has(999), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frameFileMap in a single-prefix dir gives both sides the same files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-type-test-"));
  try {
    for (const name of ["frame-0001.png", "frame-0002.png"]) {
      writeFileSync(join(dir, name), "");
    }
    assert.equal(frameFileMap(dir, "ref").get(1), join(dir, "frame-0001.png"));
    assert.equal(frameFileMap(dir, "ours").get(2), join(dir, "frame-0002.png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function measuredSide(overrides = {}) {
  return {
    measured: true, frame: 24, letters: 11, gaps_px: [13, 14], gap_median_px: 13.5,
    gap_over_cap_height: 0.1, stroke_px: 16, stroke_over_cap_height: 0.12,
    aa_fraction: 0.7, aa_transition_px: 2, aa_transition_letters: 5,
    cap_height_px: 133, ink_px: 90000, background_median: 36,
    ...overrides,
  };
}

test("labelFromMeasured maps a paired measurement to the report shape", () => {
  const measured = {
    letters: { ref: 11, ours: 11 },
    present: { ref: true, ours: true },
    ref: measuredSide(),
    ours: measuredSide({ frame: 36, gap_median_px: 1 }),
    overlap: { paired: true, mean_iou: 0.73, worst_letter: "r", worst_iou: 0.33,
      per_letter: [], cap_height_ratio: 1, centroid_shift_px: 45.7 },
    fade: { difference: "x" },
    per_frame: { ref: [], ours: [] },
    fullest_frame: { ref: 24, ours: 36 },
  };
  const label = labelFromMeasured(measured, { ref: [12, 24], ours: [24, 36] });
  assert.equal(label.measured, true);
  assert.equal(label.lettersRef, 11);
  assert.equal(label.meanIou, 0.73);
  assert.equal(label.worstLetter, "r");
  assert.equal(label.gapMedianPxRef, 13.5);
  assert.equal(label.gapMedianPxOurs, 1);
  assert.equal(label.capHeightRatio, 1);
  assert.equal(label.centroidShiftPx, 45.7);
});

test("labelFromMeasured with unequal counts reports no pairing", () => {
  const measured = {
    letters: { ref: 10, ours: 11 },
    present: { ref: true, ours: true },
    ref: measuredSide({ letters: 10 }),
    ours: measuredSide({ letters: 11 }),
    overlap: { paired: false, reason: "letter counts differ", letters_ref: 10, letters_ours: 11 },
    per_frame: { ref: [], ours: [] },
    fullest_frame: { ref: 12, ours: 24 },
  };
  const label = labelFromMeasured(measured, { ref: [12], ours: [24] });
  assert.equal(label.measured, true);
  assert.equal(label.meanIou, null);
  assert.equal(label.overlap.paired, false);
});

test("labelFromMeasured with an unmeasured side reports the reason", () => {
  const measured = {
    letters: { ref: 0, ours: 11 },
    present: { ref: false, ours: true },
    ref: { measured: false, reason: "present False on the ref side after adaptive ink" },
    ours: measuredSide(),
    overlap: { paired: false, reason: "one side has no fullest frame" },
    per_frame: { ref: [], ours: [] },
    fullest_frame: { ref: null, ours: 24 },
  };
  const label = labelFromMeasured(measured, { ref: [12], ours: [24] });
  assert.equal(label.measured, false);
  assert.ok(label.reason.includes("present False"), `reason was: ${label.reason}`);
});

test("buildInsightReport carries the fixed 180 reproduction in numbers", () => {
  const report = buildInsightReport(reportInput({
    reproduction: { frames: [156, 168, 180], within_tolerance: { gap_within_1px: true } },
  }));
  assert.equal(report.verdict.status, "PASS");
  assert.deepEqual(report.numbers.reproduction_fixed180.frames, [156, 168, 180]);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

// ---- T3: corrections in scene terms ----

const SEG4_SCENE = {
  nodes: [
    { id: "title-october", type: "text",
      props: { text: "October 2025", font: { size: 190, letterSpacing: -6 } } },
    { id: "label-fasher", type: "text",
      props: { text: "EL FASHER", font: { size: 35 } } },
  ],
};

function correctionSide(overrides = {}) {
  return {
    measured: true, frame: 24, letters: 11,
    gaps_px: [13, 11, 13, 15, 13, 15, 51, 14, 14, 15], gap_median_px: 14,
    gap_over_cap_height: 0.1053, stroke_px: 16, stroke_over_cap_height: 0.1203,
    aa_fraction: 0.77, aa_transition_px: 2, aa_transition_letters: 7,
    cap_height_px: 133, ink_px: 90228, background_median: 36,
    ...overrides,
  };
}

function correctionFrame(overrides = {}) {
  return {
    frame: 24, present: true, ink_px: 90228, background_median: 36,
    gaps_px: [13, 11, 13, 15, 13, 15, 51, 14, 14, 15], gap_median_px: 14,
    stroke_px: 16, aa_fraction: 0.77, aa_transition_px: 2, cap_height_px: 133,
    centroids: [[943.1, 546]], boxes: [[264, 473, 402, 606]],
    ...overrides,
  };
}

function correctionMeasured(overrides = {}) {
  const base = {
    labels: {
      october: {
        per_frame: {
          ref: [correctionFrame({ frame: 12, letters: 10 }), correctionFrame({ frame: 24 })],
          ours: [correctionFrame({ frame: 24, gaps_px: [7, 0, 0, 5, 1, 1, 1, 1, 1, 2], gap_median_px: 1, ink_px: 84291 }),
                 correctionFrame({ frame: 36, gaps_px: [7, 0, 0, 5, 1, 1, 1, 1, 1, 2], gap_median_px: 1, ink_px: 84291 })],
        },
        fullest_frame: { ref: 24, ours: 36 },
        letters: { ref: 11, ours: 11 },
        ref: correctionSide(),
        ours: correctionSide({ frame: 36, gaps_px: [7, 0, 0, 5, 1, 1, 1, 1, 1, 2], gap_median_px: 1, gap_over_cap_height: 0.0075, stroke_px: 15.23, stroke_over_cap_height: 0.1145, aa_fraction: 1, aa_transition_px: 1, ink_px: 84291, background_median: 24 }),
        overlap: { paired: true, mean_iou: 0.73, cap_height_ratio: 1, centroid_shift_px: 45.7 },
        fade: {
          ref: { ink_by_frame: { 0: 0, 12: 79819, 24: 79753, 36: 79484, 48: 78411, 60: 0, 72: 325 }, first_full_frame: 12, last_visible_frame: 48 },
          ours: { ink_by_frame: { 0: 3070, 12: 75874, 24: 77109, 36: 78846, 48: 78751, 60: 77147, 72: 6928 }, first_full_frame: 12, last_visible_frame: 60 },
          difference: "x",
        },
      },
      "el-fasher": {
        per_frame: {
          ref: [
            correctionFrame({ frame: 156, gaps_px: [2, 16, 1, 1, 1, 2, 2], gap_median_px: 2, stroke_px: 2, cap_height_px: 11, ink_px: 581, centroids: [[860.9, 633.2]], boxes: [[799, 625, 811, 636], [812, 625, 823, 636], [826, 625, 838, 641], [839, 625, 851, 641], [852, 625, 864, 641], [865, 625, 877, 641], [878, 625, 890, 641], [891, 625, 903, 641]] }),
            correctionFrame({ frame: 168, gaps_px: [2, 16, 2, 2, 1, 1, 1], gap_median_px: 2, stroke_px: 2, cap_height_px: 16, ink_px: 831, centroids: [[860.9, 633.2]], boxes: [[799, 625, 811, 641], [812, 625, 824, 641], [826, 625, 838, 641], [839, 625, 851, 641], [852, 625, 864, 641], [865, 625, 877, 641], [878, 625, 890, 641], [891, 625, 903, 641]] }),
            correctionFrame({ frame: 180, gaps_px: [1, 16, 2, 2, 1, 1, 1], gap_median_px: 1, stroke_px: 2, cap_height_px: 17, ink_px: 924, centroids: [[860.9, 633.2]], boxes: [[799, 625, 811, 642], [812, 625, 824, 642], [826, 625, 838, 642], [839, 625, 851, 642], [852, 625, 864, 642], [865, 625, 877, 642], [878, 625, 890, 642], [891, 625, 903, 642]] }),
          ],
          ours: [
            correctionFrame({ frame: 156, gaps_px: [1, 9, 1, 1, 1, 2, 1], gap_median_px: 1, stroke_px: 4, cap_height_px: 27, ink_px: 2333, centroids: [[849.3, 637.4]], boxes: [[785, 625, 798, 652], [799, 625, 812, 652], [821, 625, 834, 652], [835, 625, 851, 652], [852, 625, 867, 652], [868, 625, 884, 652], [886, 625, 899, 652], [900, 625, 916, 652]] }),
          ],
        },
        fullest_frame: { ref: 180, ours: 156 },
        letters: { ref: 8, ours: 8 },
        ref: correctionSide({ frame: 180, letters: 8, gaps_px: [1, 16, 2, 2, 1, 1, 1], gap_median_px: 1, gap_over_cap_height: 0.0588, stroke_px: 2, stroke_over_cap_height: 0.1176, aa_fraction: 0.88, cap_height_px: 17, ink_px: 924, background_median: 49.8 }),
        ours: correctionSide({ frame: 156, letters: 8, gaps_px: [1, 9, 1, 1, 1, 2, 1], gap_median_px: 1, gap_over_cap_height: 0.037, stroke_px: 4, stroke_over_cap_height: 0.1481, aa_fraction: 0.63, cap_height_px: 27, ink_px: 2333, background_median: 44.9 }),
        overlap: { paired: true, mean_iou: 0.63, cap_height_ratio: 1.5882, centroid_shift_px: 12.6 },
        fade: null,
      },
    },
  };
  return { ...base, ...overrides };
}

test("sceneTextNode finds the October and EL FASHER nodes by text", () => {
  assert.equal(sceneTextNode(SEG4_SCENE, "October 2025").id, "title-october");
  assert.equal(sceneTextNode(SEG4_SCENE, "EL FASHER").id, "label-fasher");
  assert.equal(sceneTextNode(SEG4_SCENE, "EL FASHER").props.font.size, 35);
  assert.equal(sceneTextNode(SEG4_SCENE, "October 2025").props.font.letterSpacing, -6);
  assert.equal(sceneTextNode(SEG4_SCENE, "nope"), null);
  assert.equal(sceneTextNode(null, "October 2025"), null);
});

test("buildCorrections names four Seg4 corrections in scene terms", () => {
  const corrections = buildCorrections(correctionMeasured(), SEG4_SCENE);
  assert.equal(corrections.length, 4);
  const byKey = (element, kind) => corrections.find((c) => c.element === element && c.kind === kind);
  const spacing = byKey("title-october", "text");
  assert.ok(spacing, "October spacing correction is named");
  assert.equal(spacing.at_s, 1);
  assert.ok(spacing.fix.includes("letterSpacing from -6 to 7"), `fix was: ${spacing.fix}`);
  assert.ok(spacing.fix.includes("increase by 13 px"), `fix was: ${spacing.fix}`);
  assert.ok(spacing.fix.includes("from 1 px to 14 px"), `fix was: ${spacing.fix}`);
  assert.equal(spacing.ours.px, 84291);
  assert.equal(spacing.real.px, 90228);
  assert.ok(typeof spacing.shift_px.dx === "number" && typeof spacing.shift_px.dy === "number");
  const timing = byKey("title-october", "timing");
  assert.ok(timing, "October timing correction is named");
  assert.equal(timing.at_s, 2.5);
  assert.ok(timing.fix.includes("by frame 60"), `fix was: ${timing.fix}`);
  assert.ok(timing.fix.includes("gone after frame 48"), `fix was: ${timing.fix}`);
  assert.equal(timing.ours.px, 77147);
  assert.equal(timing.real.px, 0);
  const size = corrections.find((c) => c.element === "label-fasher" && c.fix.includes("font size"));
  assert.ok(size, "EL FASHER size correction is named");
  assert.equal(size.at_s, 7.5);
  assert.ok(size.fix.includes("from 35 to 22"), `fix was: ${size.fix}`);
  assert.ok(size.fix.includes("from 27 px to 17 px"), `fix was: ${size.fix}`);
  const face = corrections.find((c) => c.element === "label-fasher" && c.fix.includes("wider face"));
  assert.ok(face, "EL FASHER face correction is named");
  assert.ok(face.fix.includes("Archivo Narrow"), `fix was: ${face.fix}`);
  assert.ok(face.fix.includes("8.8 px wide against ref 12 px"), `fix was: ${face.fix}`);
  // Every correction validates against the insight schema.
  const report = buildInsightReport(reportInput({ corrections }));
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("buildCorrections names nothing when the type matches", () => {
  const measured = correctionMeasured();
  measured.labels.october.ours.gap_median_px = 14;
  measured.labels.october.ours.gaps_px = [13, 11, 13, 15, 13, 15, 51, 14, 14, 15];
  measured.labels.october.fade.ours.last_visible_frame = 48;
  measured.labels.october.fade.ours.ink_by_frame[60] = 0;
  measured.labels["el-fasher"].ours.cap_height_px = 17;
  measured.labels["el-fasher"].overlap.cap_height_ratio = 1;
  const corrections = buildCorrections(measured, SEG4_SCENE);
  assert.deepEqual(corrections, []);
});

test("buildCorrections names no size correction when the ref cap is unsettled", () => {
  const measured = correctionMeasured();
  // Only one ref frame, mid-zoom, so settling cannot be evidenced.
  measured.labels["el-fasher"].per_frame.ref = [measured.labels["el-fasher"].per_frame.ref[0]];
  const corrections = buildCorrections(measured, SEG4_SCENE);
  assert.equal(corrections.some((c) => c.fix.includes("font size")), false);
  assert.equal(corrections.some((c) => c.fix.includes("wider face")), false);
});

test("buildCorrections names no stroke correction: the stroke gap is inside quantisation", () => {
  const corrections = buildCorrections(correctionMeasured(), SEG4_SCENE);
  assert.equal(corrections.some((c) => /stroke|weight/i.test(c.fix)), false);
});

test("buildCorrections works without a scene, in px only", () => {
  const corrections = buildCorrections(correctionMeasured(), null);
  assert.equal(corrections.length, 4);
  const spacing = corrections.find((c) => c.kind === "text" && c.fix.includes("letterSpacing"));
  assert.ok(spacing.fix.includes("increase by 13 px"), `fix was: ${spacing.fix}`);
  assert.equal(spacing.element, "october");
});

test("Seg4 report holds four corrections in scene terms", () => {
  assert.equal(SEG4.run.status, 0, SEG4.run.stderr);
  const corrections = SEG4.run.report.corrections;
  assert.equal(corrections.length, 4);
  const elements = corrections.map((c) => c.element).sort();
  assert.deepEqual(elements, ["label-fasher", "label-fasher", "title-october", "title-october"]);
  const fixes = corrections.map((c) => c.fix).join(" ");
  assert.ok(fixes.includes("letterSpacing from -6 to 7"), fixes);
  assert.ok(fixes.includes("from 35 to 22"), fixes);
  assert.ok(fixes.includes("Archivo Narrow"), fixes);
  assert.ok(fixes.includes("by frame 60"), fixes);
  assert.equal(SEG4.run.report.verdict.status, "PASS");
});
