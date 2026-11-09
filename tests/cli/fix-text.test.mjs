// Tests for the `hme fix` text translator
// (src/cli/fix/text.mjs): font size from the cap-height ratio and
// letterSpacing from the median letter-gap delta, on the real v5
// scene with the real type-run numbers.
//
// Sources, read not guessed:
// - Type report: handover-motion-type-meter/type-report-seg4.json,
//   numbers.labels. EL FASHER cap_height_px { ref: 17, ours: 27 };
//   October gap_median_px { ref: 14, ours: 1 }. The proof copy
//   (proof/type-seg4.json) carries the same four numbers.
// - Scene: tests/fixtures/seg4-scene-clone-v5.json. EL FASHER node
//   label-fasher, props.font.size 35; October node title-october,
//   props.font.letterSpacing -6.
//
// Hand-computed targets (from the report numbers, not the prose):
// - EL FASHER size: ratio = capOurs / capRef = 27 / 17 = 1.5882...;
//   newSize = Math.round(35 / ratio) = Math.round(35 * 17 / 27)
//   = Math.round(22.037...) = 22. (The prose fix says "from 35 to
//   22"; the test asserts the number-derived value, not the prose.)
// - October spacing: delta = Math.round(refGap - oursGap)
//   = Math.round(14 - 1) = 13; new letterSpacing = -6 + 13 = 7.
//   (The prose fix says "from -6 to 7"; again, numbers are the
//   source.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTextSizeFix, applyLetterSpacingFix } from "../../src/cli/fix/text.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "..", "handover-motion-type-meter", "type-report-seg4.json");
const SCENE = join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json");

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const scene = JSON.parse(readFileSync(SCENE, "utf8"));

const elFasherCaps = report.numbers.labels["el-fasher"].cap_height_px;
const octoberGaps = report.numbers.labels.october.gap_median_px;

function nodeOf(s, id) {
  return s.nodes.find((n) => n.id === id);
}

test("report and scene carry the real type-run numbers", () => {
  assert.deepEqual(elFasherCaps, { ref: 17, ours: 27 });
  assert.deepEqual(octoberGaps, { ref: 14, ours: 1 });
  assert.equal(nodeOf(scene, "label-fasher").props.font.size, 35);
  assert.equal(nodeOf(scene, "title-october").props.font.letterSpacing, -6);
  // The hand-computed targets, recomputed here from the numbers:
  // 35 * 17 / 27 = 22.037... -> 22; -6 + (14 - 1) = 7.
  assert.equal(Math.round(35 / (27 / 17)), 22);
  assert.equal(-6 + Math.round(14 - 1), 7);
});

test("applyTextSizeFix sets EL FASHER font size 35 to 22", () => {
  const fixed = applyTextSizeFix(scene, "label-fasher", elFasherCaps.ref, elFasherCaps.ours);
  assert.notEqual(fixed, scene);
  assert.equal(nodeOf(fixed, "label-fasher").props.font.size, 22);
  // Only that one value changed on the node: everything else on it
  // is untouched.
  const { props: afterProps, ...afterRest } = nodeOf(fixed, "label-fasher");
  const { props: beforeProps, ...beforeRest } = nodeOf(scene, "label-fasher");
  assert.deepEqual(afterRest, beforeRest);
  const { font: afterFont, ...afterPropsRest } = afterProps;
  const { font: beforeFont, ...beforePropsRest } = beforeProps;
  assert.deepEqual(afterPropsRest, beforePropsRest);
  const { size: _s, ...afterFontRest } = afterFont;
  const { size: _t, ...beforeFontRest } = beforeFont;
  assert.deepEqual(afterFontRest, beforeFontRest);
  // No other node changed, and nothing above the nodes changed.
  assert.deepEqual(fixed.nodes.filter((n) => n.id !== "label-fasher"),
    scene.nodes.filter((n) => n.id !== "label-fasher"));
  for (const key of Object.keys(scene)) {
    if (key === "nodes") continue;
    assert.deepEqual(fixed[key], scene[key], key);
  }
});

test("applyLetterSpacingFix sets October letterSpacing -6 to 7", () => {
  const fixed = applyLetterSpacingFix(scene, "title-october", octoberGaps.ref, octoberGaps.ours);
  assert.notEqual(fixed, scene);
  assert.equal(nodeOf(fixed, "title-october").props.font.letterSpacing, 7);
  // Only that one value changed on the node.
  const { props: afterProps, ...afterRest } = nodeOf(fixed, "title-october");
  const { props: beforeProps, ...beforeRest } = nodeOf(scene, "title-october");
  assert.deepEqual(afterRest, beforeRest);
  const { font: afterFont, ...afterPropsRest } = afterProps;
  const { font: beforeFont, ...beforePropsRest } = beforeProps;
  assert.deepEqual(afterPropsRest, beforePropsRest);
  const { letterSpacing: _s, ...afterFontRest } = afterFont;
  const { letterSpacing: _t, ...beforeFontRest } = beforeFont;
  assert.deepEqual(afterFontRest, beforeFontRest);
  // No other node changed, and nothing above the nodes changed.
  assert.deepEqual(fixed.nodes.filter((n) => n.id !== "title-october"),
    scene.nodes.filter((n) => n.id !== "title-october"));
  for (const key of Object.keys(scene)) {
    if (key === "nodes") continue;
    assert.deepEqual(fixed[key], scene[key], key);
  }
});

test("both fixes compose: size 22 and spacing 7, nothing else moves", () => {
  const sized = applyTextSizeFix(scene, "label-fasher", elFasherCaps.ref, elFasherCaps.ours);
  const fixed = applyLetterSpacingFix(sized, "title-october", octoberGaps.ref, octoberGaps.ours);
  assert.equal(nodeOf(fixed, "label-fasher").props.font.size, 22);
  assert.equal(nodeOf(fixed, "title-october").props.font.letterSpacing, 7);
  assert.deepEqual(
    fixed.nodes.filter((n) => n.id !== "label-fasher" && n.id !== "title-october"),
    scene.nodes.filter((n) => n.id !== "label-fasher" && n.id !== "title-october"),
  );
  for (const key of Object.keys(scene)) {
    if (key === "nodes") continue;
    assert.deepEqual(fixed[key], scene[key], key);
  }
});

test("the translators do not mutate their input", () => {
  const before = JSON.stringify(scene);
  applyTextSizeFix(scene, "label-fasher", elFasherCaps.ref, elFasherCaps.ours);
  applyLetterSpacingFix(scene, "title-october", octoberGaps.ref, octoberGaps.ours);
  assert.equal(JSON.stringify(scene), before);
});

test("missing numbers throw and change nothing", () => {
  const before = JSON.stringify(scene);
  // Absent (null / undefined) cap heights.
  assert.throws(() => applyTextSizeFix(scene, "label-fasher", null, 27), /cap height ref/);
  assert.throws(() => applyTextSizeFix(scene, "label-fasher", 17, undefined), /cap height ours/);
  assert.throws(() => applyLetterSpacingFix(scene, "title-october", null, 1), /letter gap ref/);
  assert.throws(() => applyLetterSpacingFix(scene, "title-october", 14, undefined), /letter gap ours/);
  // Zero or non-finite ratio denominator.
  assert.throws(() => applyTextSizeFix(scene, "label-fasher", 0, 27), /zero/);
  assert.throws(() => applyTextSizeFix(scene, "label-fasher", Infinity, 27), /finite/);
  assert.throws(() => applyTextSizeFix(scene, "label-fasher", 17, NaN), /finite/);
  assert.throws(() => applyLetterSpacingFix(scene, "title-october", NaN, 1), /finite/);
  assert.equal(JSON.stringify(scene), before);
});

test("an unknown element id throws", () => {
  assert.throws(() => applyTextSizeFix(scene, "no-such-node", 17, 27), /not found/);
  assert.throws(() => applyLetterSpacingFix(scene, "no-such-node", 14, 1), /not found/);
});
