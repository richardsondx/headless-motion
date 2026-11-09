import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BAR, USAGE, buildInsightReport, parseBox, runFonts } from "../../src/cli/fonts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });

function fakeMeasured(overrides = {}) {
  return {
    frame: "frame.png",
    text: "EL FASHER",
    box: [784, 625, 918, 642],
    cap_height_px: 18,
    candidates_scored: 55,
    candidates_in_library: 55,
    cache_dir: "/tmp/hme-fonts-test",
    ranking: [
      { family: "Archivo Narrow", weight: 700, score: 0.8376, dice: 0.7277, note: "Condensed grotesque." },
      { family: "Barlow Semi Condensed", weight: 600, score: 0.8088, dice: 0.7111, note: "Semi-condensed sans face." },
      { family: "Roboto Condensed", weight: 500, score: 0.7957, dice: 0.7137, note: "Condensed sans face." },
      { family: "Anton", weight: 400, score: 0.42, dice: 0.4, note: "Very heavy condensed display face." },
      { family: "Montserrat", weight: 500, score: 0.4, dice: 0.38, note: "Wide geometric sans." },
    ],
    best_score: 0.8376,
    second_score: 0.8088,
    margin: 0.0288,
    match_bar: { score: BAR.score, margin: BAR.margin },
    passes_bar: false,
    verdict: "closest lookalike, not confirmed",
    weight_width: {
      top: { os2_weight: 700, stem_ratio: 0.167, width_ratio: 0.667 },
      anton: { os2_weight: 400, stem_ratio: 0.167, width_ratio: 0.5 },
      sudan_face: { os2_weight: 700, stem_ratio: 0.222, width_ratio: 0.944 },
      how_determined: "Measured on the rendered template.",
    },
    method: "Template matching.",
    limits: ["Template matching can only name fonts already in the library."],
    ...overrides,
  };
}

test("parseBox accepts four integers and rejects the rest", () => {
  assert.deepEqual(parseBox("780,623,140,27"), [780, 623, 140, 27]);
  assert.deepEqual(parseBox(" 780, 623, 140, 27 "), [780, 623, 140, 27]);
  assert.equal(parseBox("780,623,140"), null);
  assert.equal(parseBox("780,623,140,27,1"), null);
  assert.equal(parseBox("780,623,abc,27"), null);
  assert.equal(parseBox("780.5,623,140,27"), null);
  assert.equal(parseBox(""), null);
  assert.equal(parseBox(null), null);
});

test("buildInsightReport below the bar is FAIL, names the bar, and keeps Anton out of the top", () => {
  const report = buildInsightReport(fakeMeasured());
  assert.equal(report.verdict.status, "FAIL");
  assert.ok(report.verdict.failed_bar.includes("0.85"), report.verdict.failed_bar);
  assert.ok(report.verdict.detail.includes("closest lookalike"));
  assert.equal(report.numbers.ranking[0].family, "Archivo Narrow");
  assert.equal(report.numbers.ranking[0].weight, 700);
  assert.ok(!report.numbers.ranking.slice(0, 3).some((e) => e.family === "Anton"));
  assert.equal(report.numbers.ranking.length, 5);
  assert.equal(report.numbers.cap_height_px, 18);
  assert.equal(report.numbers.weight_width.top.stem_ratio, 0.167);
  assert.ok(report.context.meaning.includes("not Anton"));
  assert.equal(report.corrections.length, 0);
});

test("buildInsightReport above the bar is PASS with a null failed bar", () => {
  const measured = fakeMeasured({ passes_bar: true, best_score: 0.9, margin: 0.12, verdict: "confirmed match" });
  const report = buildInsightReport(measured);
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.verdict.failed_bar, null);
  assert.ok(report.verdict.detail.includes("0.9"));
});

test("the match bar is 0.85 with a 0.10 margin", () => {
  assert.equal(BAR.score, 0.85);
  assert.equal(BAR.margin, 0.1);
  assert.ok(USAGE.includes("hme fonts"));
  assert.ok(USAGE.includes("--box"));
});

test("hme fonts --help prints usage and exits 0", () => {
  const r = run(["fonts", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme fonts"));
  assert.ok(r.stdout.includes("--text"));
  assert.ok(r.stdout.includes("--box"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("hme fonts without --text exits 2 with a usage error", async () => {
  const code = await runFonts(["frame.png"]);
  assert.equal(code, 2);
});

test("hme fonts with a bad --box exits 2", async () => {
  const code = await runFonts(["frame.png", "--text", "EL FASHER", "--box", "1,2,3"]);
  assert.equal(code, 2);
});

test("hme fonts with an unknown option exits 2", async () => {
  const code = await runFonts(["frame.png", "--text", "EL FASHER", "--nope"]);
  assert.equal(code, 2);
});

test("hme fonts with a missing frame exits 2 without a stack trace", () => {
  const r = run(["fonts", "no-such-frame.png", "--text", "EL FASHER"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});
