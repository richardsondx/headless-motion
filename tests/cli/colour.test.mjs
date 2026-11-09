// Fast tests for `hme colour`, plus one real-pair check.
// The real 7 s pair takes about 15 s in Python, so only one test runs
// it; the rest cover the CLI surface and the pure report builder with
// the Seg4 7 s ground-truth numbers at the found centroid.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAtS,
  buildCorrections,
  buildInsightReport,
} from "../../src/cli/colour.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args, cwd = ROOT) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8", cwd });
const REF7 = "verify-seg4/evidence/work/full-192/ref-0168.png";
const OURS7 = "verify-seg4/evidence/work/full-192/v5-0168.png";

// The Seg4 7 s ground truth at the found centroid, from the design
// record (found-centroid values) and the probe that built this tool:
// ref dot (788.1, 649.0), 47 px, bbox 7 by 7; ours dot (788.5, 640.8),
// 351 px, bbox 20 by 30. Background medians 49.78 and 45.85. Halo
// excess 59.10 ref against 111.58 ours at radii 5 to 15. U9 falloff
// 124.37 ref against 158.21 ours. Joint 8-cube 0.7615.
function fake7s() {
  const cube = (rgb, mass, refPx, oursPx) => ({
    cube: rgb.map((v) => Math.floor(v / 32)),
    rgb_centre: rgb,
    mass,
    ref: { pixels: refPx, centroid: [895.2, 530.7] },
    ours: { pixels: oursPx, centroid: [913.5, 534.6] },
  });
  const side = (centroid, pixels, bbox, oversize, bg, excess, falloff, peak, u9, fine, centre) => ({
    status: "PRESENT",
    badge: { bbox: [616, 648, 776, 815], centroid: [696.9, 727.4], n: 20685 },
    dot: { centroid, pixels, bbox },
    oversize,
    centre,
    u9_rings: u9,
    fine_rings: fine,
    background_median_30_60: bg,
    background_mean_30_60: 60.26,
    excess_u9_rings: { 5: 134.88, 10: 83.14, 15: 44.5 },
    excess_fine_rings: { 2: 177.96, 4: 157.56, 6: 86.5 },
    halo_excess_5_15: excess,
    peak_ring: peak,
    peak_value: fine["2"],
  });
  return {
    shape: [1080, 1920, 3],
    histogram: {
      joint_8cube: 0.7615,
      per_channel_32bin: { r: 0.1996, g: 0.428, b: 0.4629, mean: 0.3635 },
      per_channel_32bin_full_res: { r: 0.1991, g: 0.4265, b: 0.4601, mean: 0.3619 },
      per_channel_unmatched_mass: {
        ref_only: { r: 0.8004, g: 0.572, b: 0.5371 },
        ours_only: { r: 0.8004, g: 0.572, b: 0.5371 },
      },
      per_channel_zero_bin_mass: {
        ref_only: { r: 0.0, g: 0.0, b: 0.0 },
        ours_only: { r: 0.0077, g: 0.0, b: 0.0 },
      },
      top_ref_only_cubes: [cube([16, 48, 48], 0.2354, 114940, 84431)],
      top_ours_only_cubes: [cube([16, 48, 16], 0.1253, 16, 16259)],
    },
    halo: {
      ref: side([788.1, 649.0], 47, [785, 646, 792, 653], false, 49.78, 59.1, 124.37, 2,
        { 5: 184.66, 10: 132.92, 15: 94.28, 20: 64.57, 30: 65.86, 45: 60.23, 60: 60.29, falloff: 124.37 },
        { 2: 227.74, 4: 207.34, 6: 136.28, 8: 132.85, 10: 132.8, 12: 131.11, 15: 75.14, 20: 64.57, 30: 65.86, falloff: 161.88 },
        { x: 788.1, y: 649.0, luma: 226.46, rgb: [210, 231, 230] }),
      ours: side([788.5, 640.8], 351, [778, 625, 798, 655], true, 45.85, 111.58, 158.21, 2,
        { 5: 225.69, 10: 157.78, 15: 157.22, 20: 105.72, 30: 56.04, 45: 65.94, 60: 67.48, falloff: 158.21 },
        { 2: 251.92, 4: 235.37, 6: 194.05, 8: 169.88, 10: 138.61, 12: 149.21, 15: 161.58, 20: 105.72, 30: 56.04, falloff: 195.88 },
        { x: 788.5, y: 640.8, luma: 252, rgb: [252, 252, 252] }),
    },
  };
}

test("colour --help prints usage and exits 0", () => {
  const r = run(["colour", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme colour"));
  assert.ok(r.stdout.includes("Usage: hme colour <ref-frame.png> <ours-frame.png> [--at-s <n>] [--out <report.json>]"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("hme --help lists colour", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("colour"));
});

test("colour with no arguments is a usage error", () => {
  const r = run(["colour"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs two frames"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("colour with a missing reference file exits 2 with a plain error", () => {
  const r = run(["colour", "no-such-ref.png", "v5-7s.png"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-ref.png"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("colour with an unknown flag exits 2", () => {
  const r = run(["colour", REF7, OURS7, "--bogus"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('unknown option "--bogus"'));
});

test("parseAtS reads the seconds from the ref frame number at 24 fps", () => {
  assert.equal(parseAtS("ref-0168.png"), 7);
  assert.equal(parseAtS("ref-0024.png"), 1);
  assert.equal(parseAtS("ref-0096.png"), 4);
  assert.equal(parseAtS("real-7s.png"), 7);
  assert.equal(parseAtS("frame.png"), null);
});

test("buildCorrections on the 7s pair names the histogram and halo corrections", () => {
  const cs = buildCorrections(fake7s(), { atS: 7, ref: REF7, ours: OURS7 });
  assert.equal(cs.length, 2);
  const hist = cs.find((c) => c.element === "map");
  assert.equal(hist.kind, "colour");
  assert.ok(hist.fix.includes("RGB (16, 48, 48)"));
  assert.ok(hist.fix.includes("0.2354"));
  assert.ok(hist.fix.includes("nodes.map.props.focus.flood"));
  assert.ok(hist.fix.includes("#123B34"));
  assert.deepEqual(hist.shift_px, { dx: -18.3, dy: -3.9 });
  const halo = cs.find((c) => c.element === "halo-fasher");
  assert.equal(halo.kind, "shape");
  assert.ok(halo.fix.includes("nodes.halo-fasher"));
  assert.ok(halo.fix.includes("111.58"));
  assert.ok(halo.fix.includes("59.1"));
  assert.ok(halo.fix.includes("351 px"));
  assert.deepEqual(halo.shift_px, { dx: -0.4, dy: 8.2 });
  assert.equal(halo.ours.px, 351);
  assert.equal(halo.real.px, 47);
});

test("buildInsightReport on the 7s pair fails by design and validates", () => {
  const report = buildInsightReport(fake7s(), {
    ref: REF7, ours: OURS7, atS: 7, atSFrom: "--at-s flag", outPath: null,
  });
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("No corrections named"));
  assert.equal(report.numbers.histogram.joint_8cube.intersection, 0.7615);
  assert.equal(report.numbers.histogram.per_channel_32bin.r, 0.1996);
  assert.equal(report.numbers.histogram.per_channel_32bin_full_res.r, 0.1991);
  assert.equal(report.numbers.halo.ref.dot.pixels, 47);
  assert.equal(report.numbers.halo.ours.dot.pixels, 351);
  assert.equal(report.numbers.halo.ref.peak_ring, 2);
  assert.equal(report.numbers.halo.ours.peak_ring, 2);
  assert.equal(report.numbers.halo.ref.halo_excess_5_15, 59.1);
  assert.equal(report.numbers.halo.ours.halo_excess_5_15, 111.58);
  assert.equal(report.numbers.halo.ref.u9_rings.falloff, 124.37);
  assert.equal(report.numbers.halo.ours.u9_rings.falloff, 158.21);
  assert.equal(report.numbers.u9_aggregates.halo_falloff_ref_mean, 94.07);
  assert.ok(report.context.meaning.includes("fixed centre (783, 646)"));
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("colour on the real 7s pair reproduces the joint cube, R channel, and halo peak ring", () => {
  const out = join(mkdtempSync(join(tmpdir(), "hme-colour-")), "colour-7s.json");
  const r = run(["colour", REF7, OURS7, "--at-s", "7", "--out", out]);
  // FAIL by design: corrections are named, so the exit code is 1.
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.numbers.histogram.joint_8cube.intersection, 0.7615);
  assert.equal(report.numbers.histogram.per_channel_32bin.r, 0.1996);
  assert.equal(report.numbers.histogram.per_channel_32bin_full_res.r, 0.1991);
  assert.equal(report.numbers.halo.ref.dot.centroid[0], 788.1);
  assert.equal(report.numbers.halo.ref.dot.centroid[1], 649.0);
  assert.equal(report.numbers.halo.ours.dot.centroid[0], 788.5);
  assert.equal(report.numbers.halo.ours.dot.centroid[1], 640.8);
  assert.equal(report.numbers.halo.ref.peak_ring, 2);
  assert.equal(report.numbers.halo.ours.peak_ring, 2);
  assert.equal(report.numbers.halo.ref.background_median_30_60, 49.78);
  assert.equal(report.numbers.halo.ours.background_median_30_60, 45.85);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});
