// Tests for the `hme fix` position translator
// (src/cli/fix/position.mjs): a box-only shift from the real timing
// report's shift_px onto the real v5 scene.
//
// Sources, read not guessed:
// - Shift: handover-motion-timing/work/t1/seg4-report-final.json,
//   corrections[0].shift_px, element badge-rsf, dx 169.4, dy -69.2
//   (real minus ours, in scene px, per insight-schema.json).
// - Scene: tests/fixtures/seg4-scene-clone-v5.json, fps 24, duration
//   192 frames. badge-rsf box is x 613, y 649, so the fixed box is
//   x 782.4, y 579.8. badge-rsf transform.x keys are at frames 90,
//   96, 120, 144, 168 with values 289, 275, 106, 6, 0.
//
// The proof run uses the timing fix, not a position fix, on the
// badge; this is a test vector only. Do not apply both.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPositionFix } from "../../src/cli/fix/position.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "..", "handover-motion-timing", "work", "t1", "seg4-report-final.json");
const SCENE = join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json");

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const scene = JSON.parse(readFileSync(SCENE, "utf8"));

const SHIFT = { dx: 169.4, dy: -69.2 };

function nodeOf(s, nodeId) {
  return s.nodes.find((n) => n.id === nodeId);
}

function trackOf(s, nodeId, prop) {
  return s.timeline.find((t) => t.node === nodeId && t.prop === prop);
}

test("the report's correction[0] is the real badge shift vector", () => {
  const correction = report.corrections[0];
  assert.equal(correction.element, "badge-rsf");
  assert.equal(correction.kind, "timing");
  assert.deepEqual(correction.shift_px, SHIFT);
  assert.deepEqual(nodeOf(scene, "badge-rsf").box, { h: 166, w: 160, x: 613, y: 649 });
});

test("applyPositionFix moves only the badge box, by dx/dy", () => {
  const fixed = applyPositionFix(scene, "badge-rsf", SHIFT);
  assert.notEqual(fixed, scene);
  const badge = nodeOf(fixed, "badge-rsf");
  assert.equal(badge.box.x, 782.4);
  assert.equal(badge.box.y, 579.8);
  // Box size is untouched; only the position moves.
  assert.equal(badge.box.w, 160);
  assert.equal(badge.box.h, 166);
});

test("transform keys are untouched: no double-count", () => {
  const fixed = applyPositionFix(scene, "badge-rsf", SHIFT);
  const track = trackOf(fixed, "badge-rsf", "transform.x");
  assert.deepEqual(track.keys.map((k) => k.f), [90, 96, 120, 144, 168]);
  assert.deepEqual(track.keys.map((k) => k.v), [289, 275, 106, 6, 0]);
  // No timeline track changed at all.
  assert.deepEqual(fixed.timeline, scene.timeline);
});

test("no other node changed, and the badge changed only in its box", () => {
  const fixed = applyPositionFix(scene, "badge-rsf", SHIFT);
  // The companions do not move with the badge: a position
  // correction is measured on one element only.
  assert.deepEqual(nodeOf(fixed, "rifle-rsf").box, nodeOf(scene, "rifle-rsf").box);
  assert.deepEqual(nodeOf(fixed, "badge-rsf-text").box, nodeOf(scene, "badge-rsf-text").box);
  // Every other node is deep-equal.
  const otherNodes = (s) => s.nodes.filter((n) => n.id !== "badge-rsf");
  assert.deepEqual(otherNodes(fixed), otherNodes(scene));
  // The badge changed only in box.x/box.y: every other prop,
  // including visible, is untouched.
  const before = nodeOf(scene, "badge-rsf");
  const after = nodeOf(fixed, "badge-rsf");
  const { box: _boxAfter, ...afterRest } = after;
  const { box: _boxBefore, ...beforeRest } = before;
  assert.deepEqual(afterRest, beforeRest);
  // Everything above the nodes is untouched.
  for (const key of Object.keys(scene)) {
    if (key === "nodes") continue;
    assert.deepEqual(fixed[key], scene[key], key);
  }
});

test("applyPositionFix does not mutate its input", () => {
  const before = JSON.stringify(scene);
  applyPositionFix(scene, "badge-rsf", SHIFT);
  assert.equal(JSON.stringify(scene), before);
});

test("applyPositionFix refuses an unknown element and a bad shift", () => {
  assert.throws(() => applyPositionFix(scene, "no-such-node", SHIFT), /not found/);
  assert.throws(() => applyPositionFix(scene, "badge-rsf", null), /shift must be/);
  assert.throws(() => applyPositionFix(scene, "badge-rsf", { dx: 1 }), /shift must be/);
  assert.throws(
    () => applyPositionFix(scene, "badge-rsf", { dx: Number.NaN, dy: 0 }),
    /shift must be/,
  );
});
