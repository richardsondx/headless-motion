// Tests for the `hme fix` command (src/cli/fix.mjs): the shell
// that wires the unit A/B/C/D translators together, refuses the
// rest, runs the gate, and writes the new scene plus an insight
// report. CLI-level tests run the real binary
// (node src/cli/hme.mjs fix ...), so exit codes and --help are
// tested end to end; the label mapping is tested directly.
//
// Sources, read not guessed:
// - Timing report: handover-motion-timing/work/t1/seg4-report-final.json,
//   one timing correction for badge-rsf, numbers.warp_table 61
//   samples. Expected warp: badge group keys 90,96,120,144,168 ->
//   90,120,137,165,168, visible.in/out unchanged at 90/192
//   (unit A, fix-timing.test.mjs, D3 keys only, D5 no shift outside
//   the measured window).
// - Type report: handover-motion-type-meter/type-report-seg4.json,
//   numbers.labels el-fasher cap_height_px {ref 17, ours 27} and
//   october gap_median_px {ref 14, ours 1} (unit C). Its four
//   corrections: October letterSpacing (computable), October fade
//   timing (no warp table in a type report: refused), EL FASHER
//   font size (computable, 35 -> 22), EL FASHER wider face (no
//   computable target left: refused as already applied).
// - Layering report: verify-seg4/evidence/work/layering/layering-seg4.json,
//   one size correction for halo-fasher with ink counts only and
//   no target size (unit D): refused, no scene file.
// - Scene: tests/fixtures/seg4-scene-clone-v5.json, fps 24,
//   duration 192.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateInsight } from "../../src/cli/hme.mjs";
import {
  labelCandidates, findLabelEntry, textTargets, applyCorrections,
} from "../../src/cli/fix.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const TIMING_REPORT = join(ROOT, "..", "handover-motion-timing", "work", "t1", "seg4-report-final.json");
const TYPE_REPORT = join(ROOT, "..", "handover-motion-type-meter", "type-report-seg4.json");
const LAYERING_REPORT = join(ROOT, "verify-seg4", "evidence", "work", "layering", "layering-seg4.json");
const SCENE = join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json");

const scene = JSON.parse(readFileSync(SCENE, "utf8"));
const timingReport = JSON.parse(readFileSync(TIMING_REPORT, "utf8"));
const typeReport = JSON.parse(readFileSync(TYPE_REPORT, "utf8"));
const layeringReport = JSON.parse(readFileSync(LAYERING_REPORT, "utf8"));

const GROUP = ["badge-rsf", "rifle-rsf", "badge-rsf-text"];
const EXPECTED_FRAMES = [90, 120, 137, 165, 168];

const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hme-fix-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function runFix(args) {
  return spawnSync(process.execPath, [HME, "fix", ...args], { encoding: "utf8" });
}

function nodeOf(s, id) {
  return s.nodes.find((n) => n.id === id);
}

function tracksOf(s, nodeId) {
  return s.timeline.filter((t) => t.node === nodeId);
}

test("hme fix --help works and prints usage naming the command", () => {
  const r = runFix(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hme fix:/);
  assert.match(r.stdout, /--report <report\.json> --scene <scene\.json> --out <new-scene\.json>/);
  assert.match(r.stdout, /--dry-run/);
  assert.match(r.stdout, /Exit codes: 0 a file was written and the gate passed/);
  assert.match(r.stdout, /[Nn]ever overwrites an existing file/);
});

test("hme --help lists the fix command", () => {
  const r = spawnSync(process.execPath, [HME, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\s+fix\s+Apply an insight report's corrections/m);
});

test("label mapping: node text slugifies to the numbers.labels key", () => {
  // type.mjs has no slug mapping to reuse: it hardcodes the two
  // labels and finds nodes by exact text (sceneTextNode). The
  // fixer looks up candidates in order: element id, slugified
  // full text, slugified first word, slugified text minus a
  // trailing year.
  assert.deepEqual(labelCandidates(scene, "label-fasher"), ["label-fasher", "el-fasher", "el"]);
  assert.deepEqual(labelCandidates(scene, "title-october"), ["title-october", "october-2025", "october"]);
  const labels = typeReport.numbers.labels;
  assert.equal(findLabelEntry(labels, scene, "label-fasher").slug, "el-fasher");
  assert.equal(findLabelEntry(labels, scene, "title-october").slug, "october");
  assert.equal(findLabelEntry(labels, scene, "no-such-node").slug, null);
  // No numbers entry: the correction is refused, not guessed.
  const { refused } = applyCorrections(scene, {
    numbers: { labels },
    corrections: [{
      element: "label-sudan", kind: "text", at_s: 5,
      ours: { x: 0, y: 0, px: 0 }, real: { x: 0, y: 0, px: 0 },
      shift_px: { dx: 0, dy: 0 }, fix: "x", source: "test",
    }],
  });
  assert.equal(refused.length, 1);
  assert.match(refused[0].reason, /no numbers\.labels entry matches element label-sudan/);
});

test("text targets follow the type.mjs gates: size by cap ratio, spacing by gap", () => {
  const labels = typeReport.numbers.labels;
  // EL FASHER: caps 17 vs 27 (ratio 1.59, outside 0.9-1.1) -> size;
  // gaps 1 vs 1 -> no spacing.
  assert.deepEqual(textTargets(labels["el-fasher"]).size, { capRef: 17, capOurs: 27, ratio: 27 / 17 });
  assert.equal(textTargets(labels["el-fasher"]).spacing, null);
  // October: caps 133 vs 133 -> no size; gaps 14 vs 1 -> spacing.
  assert.equal(textTargets(labels.october).size, null);
  assert.deepEqual(textTargets(labels.october).spacing, { refGap: 14, oursGap: 1 });
});

test("timing run writes the fixed scene and the insight report, exit 0", (t) => {
  const dir = tmp(t);
  const out = join(dir, "seg4-scene-v6.json");
  const reportOut = join(dir, "fix-report.json");
  const r = runFix(["--report", TIMING_REPORT, "--scene", SCENE, "--out", out, "--report-out", reportOut]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(out), true);
  assert.equal(existsSync(reportOut), true);

  const fixed = JSON.parse(readFileSync(out, "utf8"));
  // Only the badge group moved: keys warped, visible.in/out
  // unchanged (D3, keys only).
  for (const nodeId of GROUP) {
    for (const track of tracksOf(fixed, nodeId)) {
      assert.deepEqual(track.keys.map((k) => k.f), EXPECTED_FRAMES, nodeId);
    }
    assert.deepEqual(nodeOf(fixed, nodeId).visible, { in: 90, out: 192 }, nodeId);
  }
  assert.deepEqual(fixed.nodes.filter((n) => !GROUP.includes(n.id)), scene.nodes.filter((n) => !GROUP.includes(n.id)));
  assert.deepEqual(fixed.timeline.filter((tr) => !GROUP.includes(tr.node)), scene.timeline.filter((tr) => !GROUP.includes(tr.node)));
  for (const key of Object.keys(scene)) {
    if (key === "nodes" || key === "timeline") continue;
    assert.deepEqual(fixed[key], scene[key], key);
  }
  // Key values untouched: only the frames moved.
  for (const track of tracksOf(fixed, "badge-rsf")) {
    const orig = tracksOf(scene, "badge-rsf").find((x) => x.prop === track.prop);
    assert.deepEqual(track.keys.map((k) => k.v), orig.keys.map((k) => k.v));
  }

  const outReport = JSON.parse(readFileSync(reportOut, "utf8"));
  assert.equal(validateInsight(outReport).valid, true, JSON.stringify(validateInsight(outReport).errors));
  assert.equal(outReport.verdict.status, "PASS");
  assert.equal(outReport.verdict.failed_bar, null);
  assert.equal(outReport.numbers.applied_count, 1);
  assert.equal(outReport.numbers.refused_count, 0);
  assert.equal(outReport.numbers.applied[0].element, "badge-rsf");
  assert.equal(outReport.numbers.applied[0].kind, "timing");
  assert.match(outReport.numbers.applied[0].change, /badge-rsf.*90,96,120,144,168 -> 90,120,137,165,168/);
  assert.equal(outReport.numbers.written, true);
  assert.equal(outReport.numbers.gate.passed, true);
  assert.ok(outReport.numbers.diff.changed_paths.length > 0);
  assert.deepEqual(outReport.numbers.diff.unexpected_paths, []);
  assert.match(outReport.next, /hme validate/);
});

test("--dry-run prints the planned edits and writes no file", (t) => {
  const dir = tmp(t);
  const out = join(dir, "seg4-scene-v6.json");
  const reportOut = join(dir, "fix-report.json");
  const r = runFix(["--report", TIMING_REPORT, "--scene", SCENE, "--out", out, "--report-out", reportOut, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(reportOut), false);
  const planned = JSON.parse(r.stdout);
  assert.equal(planned.verdict.status, "PASS");
  assert.equal(planned.numbers.dry_run, true);
  assert.equal(planned.numbers.written, false);
  assert.equal(planned.numbers.applied_count, 1);
  assert.equal(planned.numbers.applied[0].element, "badge-rsf");
  assert.match(planned.numbers.applied[0].change, /90,120,137,165,168/);
});

test("a second run with the same --out refuses to overwrite, file unchanged", (t) => {
  const dir = tmp(t);
  const out = join(dir, "seg4-scene-v6.json");
  const first = runFix(["--report", TIMING_REPORT, "--scene", SCENE, "--out", out, "--report-out", join(dir, "fix-1.json")]);
  assert.equal(first.status, 0, first.stderr);
  const before = readFileSync(out, "utf8");
  const second = runFix(["--report", TIMING_REPORT, "--scene", SCENE, "--out", out, "--report-out", join(dir, "fix-2.json")]);
  assert.notEqual(second.status, 0, second.stdout);
  assert.equal(readFileSync(out, "utf8"), before);
  const secondReport = JSON.parse(readFileSync(join(dir, "fix-2.json"), "utf8"));
  assert.equal(secondReport.verdict.status, "FAIL");
  assert.match(secondReport.numbers.gate.reason, /already exists/);
});

test("halo-only report writes no scene file and lists the refusal", (t) => {
  const dir = tmp(t);
  const out = join(dir, "seg4-scene-v6.json");
  const reportOut = join(dir, "fix-report.json");
  // The layering report holds exactly one correction: the halo
  // size correction, which names ink counts only and no target.
  assert.equal(layeringReport.corrections.length, 1);
  assert.equal(layeringReport.corrections[0].element, "halo-fasher");
  assert.equal(layeringReport.corrections[0].kind, "size");
  const r = runFix(["--report", LAYERING_REPORT, "--scene", SCENE, "--out", out, "--report-out", reportOut]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(reportOut), true);
  const outReport = JSON.parse(readFileSync(reportOut, "utf8"));
  assert.equal(outReport.verdict.status, "FAIL");
  assert.equal(outReport.numbers.applied_count, 0);
  assert.equal(outReport.numbers.refused_count, 1);
  assert.equal(outReport.numbers.refused[0].element, "halo-fasher");
  assert.equal(outReport.numbers.refused[0].kind, "size");
  assert.match(outReport.numbers.refused[0].reason, /no target size or opacity/);
  assert.equal(outReport.numbers.written, false);
});

test("type report run applies size and spacing, refuses fade timing and wider face", (t) => {
  const dir = tmp(t);
  const out = join(dir, "seg4-scene-v6.json");
  const reportOut = join(dir, "fix-report.json");
  const r = runFix(["--report", TYPE_REPORT, "--scene", SCENE, "--out", out, "--report-out", reportOut]);
  assert.equal(r.status, 0, r.stderr);
  const fixed = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(nodeOf(fixed, "label-fasher").props.font.size, 22);
  assert.equal(nodeOf(fixed, "title-october").props.font.letterSpacing, 7);
  // Nothing else moved: no timeline change, no other node change.
  assert.deepEqual(fixed.timeline, scene.timeline);
  assert.deepEqual(
    fixed.nodes.filter((n) => n.id !== "label-fasher" && n.id !== "title-october"),
    scene.nodes.filter((n) => n.id !== "label-fasher" && n.id !== "title-october"),
  );
  const outReport = JSON.parse(readFileSync(reportOut, "utf8"));
  assert.equal(outReport.verdict.status, "PASS");
  assert.equal(outReport.numbers.applied_count, 2);
  assert.equal(outReport.numbers.refused_count, 2);
  const appliedKinds = outReport.numbers.applied.map((a) => `${a.element}:${a.kind}`);
  assert.deepEqual(appliedKinds, ["title-october:text", "label-fasher:text"]);
  assert.match(outReport.numbers.applied[0].change, /letterSpacing -6 -> 7/);
  assert.match(outReport.numbers.applied[1].change, /font\.size 35 -> 22/);
  const refused = outReport.numbers.refused;
  assert.equal(refused[0].element, "title-october");
  assert.equal(refused[0].kind, "timing");
  assert.match(refused[0].reason, /warp_table is missing/);
  assert.equal(refused[1].element, "label-fasher");
  assert.equal(refused[1].kind, "text");
  assert.match(refused[1].reason, /already applied/);
});

test("position run shifts only the named node's box", (t) => {
  const dir = tmp(t);
  const positionReport = join(dir, "position-report.json");
  const shifted = structuredClone(timingReport);
  shifted.corrections = [{
    element: "badge-rsf", kind: "position", at_s: 5,
    ours: { x: 797, y: 663.2, px: 19907 }, real: { x: 807, y: 658.2, px: 19907 },
    shift_px: { dx: 10, dy: -5 },
    fix: "Move badge-rsf 10 px right and 5 px up.",
    source: "test",
  }];
  writeFileSync(positionReport, JSON.stringify(shifted, null, 2));
  const out = join(dir, "seg4-scene-v6.json");
  const reportOut = join(dir, "fix-report.json");
  const r = runFix(["--report", positionReport, "--scene", SCENE, "--out", out, "--report-out", reportOut]);
  assert.equal(r.status, 0, r.stderr);
  const fixed = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(nodeOf(fixed, "badge-rsf").box.x, nodeOf(scene, "badge-rsf").box.x + 10);
  assert.equal(nodeOf(fixed, "badge-rsf").box.y, nodeOf(scene, "badge-rsf").box.y - 5);
  assert.deepEqual(fixed.timeline, scene.timeline);
  assert.deepEqual(fixed.nodes.filter((n) => n.id !== "badge-rsf"), scene.nodes.filter((n) => n.id !== "badge-rsf"));
  const outReport = JSON.parse(readFileSync(reportOut, "utf8"));
  assert.equal(outReport.numbers.applied_count, 1);
  assert.match(outReport.numbers.applied[0].change, /box\.x .* -> .*, box\.y .* -> .*/);
});

test("usage errors and unreadable inputs exit 2", (t) => {
  const dir = tmp(t);
  const missingScene = runFix(["--report", TIMING_REPORT, "--out", join(dir, "x.json")]);
  assert.equal(missingScene.status, 2);
  assert.match(missingScene.stderr, /--report, --scene and --out are all required/);
  const unknown = runFix(["--report", TIMING_REPORT, "--scene", SCENE, "--out", join(dir, "x.json"), "--nope"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option/);
  const badReport = runFix(["--report", join(dir, "no-such.json"), "--scene", SCENE, "--out", join(dir, "x.json"), "--report-out", join(dir, "fix-report.json")]);
  assert.equal(badReport.status, 2);
  assert.equal(existsSync(join(dir, "x.json")), false);
  const badReportOut = JSON.parse(readFileSync(join(dir, "fix-report.json"), "utf8"));
  assert.equal(badReportOut.verdict.status, "FAIL");
});
