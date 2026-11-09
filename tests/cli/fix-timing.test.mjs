// Tests for the `hme fix` timing translator
// (src/cli/fix/timing.mjs): per-keyframe warp from the real timing
// report's warp table onto the real v5 scene.
//
// Sources, read not guessed:
// - Warp table: handover-motion-timing/work/t1/seg4-report-final.json,
//   numbers.warp_table, 61 samples, t_s 4.0 to 6.5. dt at 4.0 s is
//   0.987, at 5.0 s is 0.727, at 6.0 s is 0.874, at 6.5 s is 0.456.
//   (numbers.dt_at_5s_s is 0.73, the 2-decimal rounding of 0.727;
//   the translator interpolates the table samples, so the 5.0 s
//   shift below uses the exact 0.727.)
// - Scene: tests/fixtures/seg4-scene-clone-v5.json, fps 24, duration
//   192 frames. badge-rsf transform keys at frames 90, 96, 120, 144,
//   168; visible { in: 90, out: 192 }.
//
// Hand-computed shifts (shift = Math.round(dt * 24), dt interpolated
// at the key time frame / 24; 0 outside the measured window [4.0,
// 6.5] (D5, fix cycle 4): no measurement, no shift):
// - f90:  t 3.75 s, below window, dt 0 -> stays 90
// - f96:  t 4.00 s, dt 0.987 -> round(23.688) = 24 -> 120
// - f120: t 5.00 s, dt 0.727 -> round(17.448) = 17 -> 137
// - f144: t 6.00 s, dt 0.874 -> round(20.976) = 21 -> 165
// - f168: t 7.00 s, above window, dt 0 -> stays 168
// - visible.in/out: NEVER shifted (D3, fix cycle 2). The path dt
//   measures path lag, not appearance lag; the appearance was
//   already correct (real first seen 3.712 s, v5 first seen 3.75 s),
//   so shifting in by the in-point dt (+24) delayed it and failed
//   the first proof (median dt -0.79 s). In stays 90, out stays 192.
//   D5: the old edge clamp also over-shifted the first KEY (90 ->
//   114 on dt 0.987, where the true dt is about +0.17 s: the
//   reference reaches the start pose at 3.92 s). With in at 90 and
//   the first key at 114 the render froze at its start pose for 24
//   frames and proof 2 failed at median dt -0.62 s; the in-window
//   keys aligned (nearest-neighbour dt +0.005 s at 5.0 s).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTimingFix, interpolateDt, rigidMotionGroup } from "../../src/cli/fix/timing.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "..", "handover-motion-timing", "work", "t1", "seg4-report-final.json");
const SCENE = join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json");

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const warpTable = report.numbers.warp_table;
const scene = JSON.parse(readFileSync(SCENE, "utf8"));

const GROUP = ["badge-rsf", "rifle-rsf", "badge-rsf-text"];
const EXPECTED_FRAMES = [90, 120, 137, 165, 168];

function tracksOf(fixed, nodeId) {
  return fixed.timeline.filter((t) => t.node === nodeId);
}

test("warp table is the real 61-sample table, 4.0 to 6.5 s", () => {
  assert.equal(warpTable.length, 61);
  assert.equal(warpTable[0].t_s, 4.0);
  assert.equal(warpTable[0].dt_s, 0.987);
  assert.equal(warpTable[60].t_s, 6.5);
  assert.equal(warpTable[60].dt_s, 0.456);
  assert.equal(scene.meta.fps, 24);
  assert.equal(scene.meta.duration, 192);
});

test("interpolateDt returns table samples exactly and zero outside the window", () => {
  assert.equal(interpolateDt(warpTable, 4.0), 0.987);
  assert.equal(interpolateDt(warpTable, 5.0), 0.727);
  assert.equal(interpolateDt(warpTable, 6.0), 0.874);
  assert.equal(interpolateDt(warpTable, 6.5), 0.456);
  // Outside the window there is no measurement, so no shift (D5):
  // the old clamp held the edge dt here, which over-shifted the
  // first key by 0.82 s in proof 2 (median dt -0.62 s).
  assert.equal(interpolateDt(warpTable, 3.75), 0);
  assert.equal(interpolateDt(warpTable, 7.0), 0);
  // Midpoint of 4.0 (0.987) and 4.042 (1.071) interpolates linearly.
  assert.ok(Math.abs(interpolateDt(warpTable, 4.021) - 1.029) < 1e-12);
});

test("rigidMotionGroup detects the badge group from the scene, not hardcoded values", () => {
  // The three nodes share the identical keyframe frame set
  // {90, 96, 120, 144, 168}; label-sudan shares those frames but
  // also has 24, 48, 78, so it is not in the group.
  assert.deepEqual(rigidMotionGroup(scene, "badge-rsf"), GROUP);
  // The grouping is by frame set, not by key values: the text node
  // rides the same frames with different transform.y values.
  const badgeY = tracksOf(scene, "badge-rsf").find((t) => t.prop === "transform.y").keys.map((k) => k.v);
  const textY = tracksOf(scene, "badge-rsf-text").find((t) => t.prop === "transform.y").keys.map((k) => k.v);
  assert.notDeepEqual(textY, badgeY);
});

test("applyTimingFix shifts badge-rsf keys by the per-keyframe warp", () => {
  const fixed = applyTimingFix(scene, warpTable, "badge-rsf");
  assert.notEqual(fixed, scene);
  for (const track of tracksOf(fixed, "badge-rsf")) {
    assert.deepEqual(track.keys.map((k) => k.f), EXPECTED_FRAMES);
  }
  // Key values are untouched: only the frames move.
  for (const track of tracksOf(fixed, "badge-rsf")) {
    const orig = tracksOf(scene, "badge-rsf").find((t) => t.prop === track.prop);
    assert.deepEqual(track.keys.map((k) => k.v), orig.keys.map((k) => k.v));
  }
  // Keys stay in ascending frame order afterwards.
  for (const track of tracksOf(fixed, "badge-rsf")) {
    const frames = track.keys.map((k) => k.f);
    assert.deepEqual(frames, [...frames].sort((a, b) => a - b));
  }
  // visible.in/out are never shifted (D3): in stays 90, out stays
  // 192. The first key is below the measured window, so it stays 90
  // too (D5): its dt is 0, not the clamped edge value.
  const badge = fixed.nodes.find((n) => n.id === "badge-rsf");
  assert.deepEqual(badge.visible, { in: 90, out: 192 });
});

test("visible.in/out stay unchanged even though the path dt is about 1 s", () => {
  // The first key sits below the measured window, so its dt is 0
  // (D5): under the old clamp it was 0.987 s, which shifted the
  // first key 90 -> 114 and froze the badge at its start pose for
  // 24 frames (proof 2, median dt -0.62 s). Keys only now.
  assert.equal(interpolateDt(warpTable, 90 / 24), 0);
  const fixed = applyTimingFix(scene, warpTable, "badge-rsf");
  for (const nodeId of GROUP) {
    const node = fixed.nodes.find((n) => n.id === nodeId);
    assert.deepEqual(node.visible, { in: 90, out: 192 }, nodeId);
  }
});

test("the rigid group shifts by the same amounts, nothing else moves", () => {
  const fixed = applyTimingFix(scene, warpTable, "badge-rsf");
  for (const nodeId of ["rifle-rsf", "badge-rsf-text"]) {
    for (const track of tracksOf(fixed, nodeId)) {
      assert.deepEqual(track.keys.map((k) => k.f), EXPECTED_FRAMES, nodeId);
    }
    const node = fixed.nodes.find((n) => n.id === nodeId);
    assert.deepEqual(node.visible, { in: 90, out: 192 }, nodeId);
  }
  // No other node's timeline track changed.
  const otherTracks = (s) => s.timeline.filter((t) => !GROUP.includes(t.node));
  assert.deepEqual(otherTracks(fixed), otherTracks(scene));
  // No other node changed at all.
  const otherNodes = (s) => s.nodes.filter((n) => !GROUP.includes(n.id));
  assert.deepEqual(otherNodes(fixed), otherNodes(scene));
  // Group nodes are entirely unchanged (D3: visible.in/out no
  // longer shift, so nothing on the node itself moves).
  for (const nodeId of GROUP) {
    const before = scene.nodes.find((n) => n.id === nodeId);
    const after = fixed.nodes.find((n) => n.id === nodeId);
    assert.deepEqual(after, before, nodeId);
  }
  // Everything above the nodes/timeline is untouched.
  for (const key of Object.keys(scene)) {
    if (key === "nodes" || key === "timeline") continue;
    assert.deepEqual(fixed[key], scene[key], key);
  }
});

test("applyTimingFix does not mutate its input", () => {
  const before = JSON.stringify(scene);
  const beforeTable = JSON.stringify(warpTable);
  applyTimingFix(scene, warpTable, "badge-rsf");
  assert.equal(JSON.stringify(scene), before);
  assert.equal(JSON.stringify(warpTable), beforeTable);
});

test("applyTimingFix refuses a missing warp table and an unknown element", () => {
  assert.throws(() => applyTimingFix(scene, [], "badge-rsf"), /warp_table is missing/);
  assert.throws(() => applyTimingFix(scene, null, "badge-rsf"), /warp_table is missing/);
  assert.throws(() => applyTimingFix(scene, warpTable, "no-such-node"), /no timeline tracks/);
});
