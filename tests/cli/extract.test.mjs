// Fast tests for `hme extract`. None of these run a real extract:
// the real frame is checked by the VERIFY run, not here. These tests
// cover the CLI surface and the pure pieces: colour and rect parsing
// and the insight report built from the Seg4 rifle ground truth.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHex,
  parseRect,
  buildInsightReport,
  DEFAULT_DIST_MIN,
  DEFAULT_LUMA_MAX,
} from "../../src/cli/extract.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });

// The Seg4 rifle ground truth, from extract-rifle.py on real-7s.png
// with colour #CC4726: 2,671 opaque pixels, bbox x 6-154, y 8-119 in
// badge coordinates, zero opaque pixels in the text zone (y > 130).
function fakeRifle() {
  return {
    frame: "verify-seg4/evidence/work/real-7s.png",
    colour: "#CC4726",
    dist_min: 50,
    luma_max: 150,
    exclude: { x: 0, y: 131, w: 160, h: 35 },
    region_bbox: { x: 613, y: 649, w: 160, h: 166 },
    opaque_pixels: 2671,
    rifle_bbox: { x0: 6, y0: 8, x1: 154, y1: 119, w: 149, h: 112 },
    mask_pixels: 2700,
    components: 12,
    output: "/tmp/u3/rifle.png",
  };
}

test("extract --help prints usage and exits 0", () => {
  const r = run(["extract", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme extract"));
  assert.ok(r.stdout.includes("Usage: hme extract <frame.png> --colour <hex> --out <png>"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("extract with no arguments is a usage error, not 'not implemented yet'", () => {
  const r = run(["extract"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs one frame"));
  assert.ok(!r.stderr.includes("not implemented yet"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("extract without --colour is a usage error", () => {
  const r = run(["extract", "frame.png", "--out", "/tmp/u3/rifle.png"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--colour is required"));
});

test("extract without --out is a usage error", () => {
  const r = run(["extract", "frame.png", "--colour", "#CC4726"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--out is required"));
});

test("extract with a bad colour is a usage error", () => {
  const r = run(["extract", "frame.png", "--colour", "red", "--out", "/tmp/u3/rifle.png"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--colour needs a hex colour"));
});

test("extract with a bad exclude rect is a usage error", () => {
  const r = run(["extract", "frame.png", "--colour", "#CC4726", "--out", "/tmp/u3/rifle.png", "--exclude", "0,131"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--exclude needs a rect as x,y,w,h"));
});

test("extract with a missing frame file exits 2 with a plain error", () => {
  const r = run(["extract", "no-such-frame.png", "--colour", "#CC4726", "--out", "/tmp/u3/rifle.png"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-frame.png"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("parseHex reads #RRGGBB and rejects anything else", () => {
  assert.deepEqual(parseHex("#CC4726"), [204, 71, 38]);
  assert.deepEqual(parseHex("#c8102e"), [200, 16, 46]);
  assert.equal(parseHex("red"), null);
  assert.equal(parseHex("#CC47"), null);
  assert.equal(parseHex("#CC4726FF"), null);
});

test("parseRect reads x,y,w,h and rejects anything else", () => {
  assert.deepEqual(parseRect("0,131,160,35"), { x: 0, y: 131, w: 160, h: 35 });
  assert.equal(parseRect("0,131"), null);
  assert.equal(parseRect("0,131,160"), null);
  assert.equal(parseRect("a,b,c,d"), null);
  assert.equal(parseRect("-1,0,10,10"), null);
});

test("defaults match extract-rifle.py", () => {
  assert.equal(DEFAULT_DIST_MIN, 50);
  assert.equal(DEFAULT_LUMA_MAX, 150);
});

test("buildInsightReport passes on the rifle ground truth and passes the insight validator", () => {
  const measured = fakeRifle();
  const report = buildInsightReport(measured, {
    frame: measured.frame, colour: "#CC4726", outPath: "/tmp/u3/rifle.png",
  });
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  assert.equal(report.numbers.opaque_pixels, 2671);
  assert.deepEqual(report.numbers.rifle_bbox, { x0: 6, y0: 8, x1: 154, y1: 119, w: 149, h: 112 });
  assert.deepEqual(report.numbers.region_bbox, { x: 613, y: 649, w: 160, h: 166 });
  assert.deepEqual(report.corrections, []);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("buildInsightReport fails when nothing is found", () => {
  const measured = fakeRifle();
  measured.opaque_pixels = 0;
  const report = buildInsightReport(measured, {
    frame: measured.frame, colour: "#CC4726", outPath: "/tmp/u3/rifle.png",
  });
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("opaque pixel"));
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});
