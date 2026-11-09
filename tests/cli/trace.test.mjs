// Fast tests for `hme trace`. None of these run a real trace: the
// full run takes minutes on video, so the Seg4 reference is checked
// by the VERIFY run, not here. These tests cover the CLI surface
// and the pure pieces: arg parsing, hex colours, and --out paths.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SUBJECT_COLOUR,
  DEFAULT_BADGE_COLOUR,
  parseHex,
  parseTraceArgs,
  resolveProfilePath,
  findCv2SitePackages,
} from "../../src/cli/trace.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });

test("trace --help prints usage and exits 0", () => {
  const r = run(["trace", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme trace"));
  assert.ok(r.stdout.includes("Usage: hme trace video.mp4 --start-s <n> --end-s <n> --out <dir>"));
  assert.ok(r.stdout.includes("--skip-traces"));
  assert.ok(r.stdout.includes("--subject-colour"));
  assert.ok(r.stdout.includes("--labels"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("trace with no arguments is a usage error, not 'not implemented yet'", () => {
  const r = run(["trace"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs a video"));
  assert.ok(!r.stderr.includes("not implemented yet"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("trace without --start-s is a usage error", () => {
  const r = run(["trace", "ref.mp4", "--end-s", "8", "--out", "out/"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--start-s"));
});

test("trace without --end-s is a usage error", () => {
  const r = run(["trace", "ref.mp4", "--start-s", "0", "--out", "out/"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--end-s"));
});

test("trace with end before start is a usage error", () => {
  const r = run(["trace", "ref.mp4", "--start-s", "8", "--end-s", "0"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--end-s must be greater"));
});

test("trace with an unknown option is a usage error", () => {
  const r = run(["trace", "ref.mp4", "--start-s", "0", "--end-s", "8", "--nope"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('unknown option "--nope"'));
});

test("trace with a bad subject colour is a usage error", () => {
  const r = run(["trace", "ref.mp4", "--start-s", "0", "--end-s", "8", "--subject-colour", "teal"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--subject-colour"));
});

test("trace with a missing video file exits 2 with a plain error", () => {
  const r = run(["trace", "no-such-video.mp4", "--start-s", "0", "--end-s", "8"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file: no-such-video.mp4"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("parseHex reads #RRGGBB and rejects the rest", () => {
  assert.deepEqual(parseHex("#143C34"), [20, 60, 52]);
  assert.deepEqual(parseHex("#CC4726"), [204, 71, 38]);
  assert.deepEqual(parseHex("#ffffff"), [255, 255, 255]);
  assert.equal(parseHex("teal"), null);
  assert.equal(parseHex("#12345"), null);
  assert.equal(parseHex("#GGGGGG"), null);
  assert.equal(parseHex(null), null);
});

test("parseTraceArgs takes the full Seg4 check invocation", () => {
  const p = parseTraceArgs([
    "verify-seg4/evidence/refs/seg4-full-1080p.mp4",
    "--start-s", "0", "--end-s", "8", "--skip-traces",
    "--subject-colour", "#143C34", "--labels", "SUDAN,EL FASHER",
    "--out", "out/seg4/",
  ]);
  assert.equal(p.error, null);
  assert.equal(p.video, "verify-seg4/evidence/refs/seg4-full-1080p.mp4");
  assert.equal(p.startS, 0);
  assert.equal(p.endS, 8);
  assert.equal(p.skipTraces, true);
  assert.equal(p.subjectColour, "#143C34");
  assert.equal(p.badgeColour, DEFAULT_BADGE_COLOUR);
  assert.deepEqual(p.labels, ["SUDAN", "EL FASHER"]);
  assert.equal(p.out, "out/seg4/");
});

test("parseTraceArgs defaults the subject and badge colours", () => {
  const p = parseTraceArgs(["ref.mp4", "--start-s", "0", "--end-s", "8"]);
  assert.equal(p.error, null);
  assert.equal(p.subjectColour, DEFAULT_SUBJECT_COLOUR);
  assert.equal(p.badgeColour, DEFAULT_BADGE_COLOUR);
  assert.equal(p.skipTraces, false);
  assert.deepEqual(p.labels, []);
  assert.equal(p.out, null);
});

test("parseTraceArgs splits labels on commas and drops blanks", () => {
  const p = parseTraceArgs(["ref.mp4", "--start-s", "0", "--end-s", "8", "--labels", " SUDAN , ,EL FASHER "]);
  assert.equal(p.error, null);
  assert.deepEqual(p.labels, ["SUDAN", "EL FASHER"]);
});

test("parseTraceArgs rejects a second video", () => {
  const p = parseTraceArgs(["a.mp4", "b.mp4", "--start-s", "0", "--end-s", "8"]);
  assert.ok(p.error.includes("takes one video"));
});

test("resolveProfilePath keeps a .json path and fills a directory", () => {
  assert.equal(resolveProfilePath(null), null);
  assert.equal(resolveProfilePath("out/seg4/reference-profile.json"), "out/seg4/reference-profile.json");
  assert.equal(resolveProfilePath("out/seg4/"), join("out/seg4/", "reference-profile.json"));
  assert.equal(resolveProfilePath("out/seg4"), join("out/seg4", "reference-profile.json"));
});

test("findCv2SitePackages finds the code-map-explainer venv cv2", () => {
  const sp = findCv2SitePackages();
  assert.ok(sp !== null, "cv2 site-packages should exist in this repo setup");
  assert.ok(sp.endsWith("site-packages"), sp);
});
