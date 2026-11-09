// U3 morph plus squash, evaluator side: scaleX/scaleY pass through,
// deform moves a named subset only, morph mid-frame matches
// interpolation within 0.001, topology mismatch fails loudly.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleScene, applyDeform, scalePoints } from "../../src/scene/evaluate.mjs";
import { loadScene, validateScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");
const load = (name) => JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8"));

test("squash fixture validates with zero errors", () => {
  const { errors } = validateScene(load("path-squash.json"));
  assert.deepEqual(errors, []);
});

test("scaleX and scaleY pass through, and fall back to uniform scale", () => {
  const scene = load("path-squash.json");
  const s = sampleScene(scene, 0).squash;
  assert.equal(s["transform.scaleX"], 1.5);
  assert.equal(s["transform.scaleY"], 0.5);
  assert.equal(s["transform.anchorX"], 100);
  assert.equal(s["transform.anchorY"], 75);
  // The deform node sets no scale: scaleX and scaleY fall back to 1.
  const d = sampleScene(scene, 0).deform;
  assert.equal(d["transform.scaleX"], 1);
  assert.equal(d["transform.scaleY"], 1);
  // A uniform scale of 2 with no scaleX declared falls back to 2.
  const uni = load("path-points.json");
  uni.nodes[1].transform = { scale: 2 };
  assert.equal(sampleScene(uni, 0).outline["transform.scaleX"], 2);
  assert.equal(sampleScene(uni, 0).outline["transform.scaleY"], 2);
});

test("scalePoints scales about the anchor, handles included", () => {
  const pts = [
    { id: "a", anchor: [0, 0], command: "line", in: null, out: [60, 0] },
    { id: "b", anchor: [200, 0], command: "line", in: null, out: [200, 60] },
  ];
  const scaled = scalePoints(pts, 1.5, 0.5, 100, 75);
  assert.deepEqual(scaled[0].anchor, [-50, 37.5]);
  assert.deepEqual(scaled[0].out, [40, 37.5]);
  assert.deepEqual(scaled[1].anchor, [250, 37.5]);
  assert.deepEqual(scaled[1].out, [250, 67.5]);
  // The input list is not mutated.
  assert.deepEqual(pts[0].anchor, [0, 0]);
});

test("deform moves a named subset and leaves the rest unchanged", () => {
  const scene = load("path-squash.json");
  const pts = sampleScene(scene, 0).deform["props.points"];
  assert.deepEqual(pts[1].anchor, [210, 0]);
  assert.deepEqual(pts[1].out, [210, 60]);
  assert.deepEqual(pts[0], { id: "p1", anchor: [0, 0], in: null, out: [60, 0], command: "line" });
  assert.deepEqual(pts[2].anchor, [200, 150]);
  assert.deepEqual(pts[3].anchor, [0, 150]);
});

test("applyDeform moves handles with the anchor and fails on an unknown id", () => {
  const pts = [
    { id: "a", anchor: [10, 20], command: "line", in: [5, 20], out: [15, 20] },
    { id: "b", anchor: [30, 40], command: "line", in: null, out: null },
  ];
  const moved = applyDeform(pts, [{ id: "a", dx: 3, dy: -4 }]);
  assert.deepEqual(moved[0].anchor, [13, 16]);
  assert.deepEqual(moved[0].in, [8, 16]);
  assert.deepEqual(moved[0].out, [18, 16]);
  assert.deepEqual(moved[1], pts[1]);
  assert.throws(() => applyDeform(pts, [{ id: "nope", dx: 1, dy: 1 }]), /PATH_UNKNOWN_POINT/);
  const scene = load("path-squash.json");
  scene.nodes[1].props.deform = [{ id: "nope", dx: 1, dy: 1 }];
  assert.throws(() => sampleScene(scene, 0), /PATH_UNKNOWN_POINT/);
});

test("morph mid-frame matches interpolation within 0.001", () => {
  const scene = load("path-points.json");
  for (const f of [0, 6, 12, 18, 24]) {
    const x = sampleScene(scene, f).outline["props.points"][1].anchor[0];
    assert.ok(Math.abs(x - (200 + f)) < 0.001, `frame ${f}: x is ${x}, expected ${200 + f}`);
  }
});

test("morph with mismatched topology fails loudly, never silently", () => {
  const scene = load("path-points.json");
  scene.timeline[0].keys[1].v = scene.timeline[0].keys[0].v.slice(0, 3);
  assert.throws(() => sampleScene(scene, 12), /PATH_TOPOLOGY_MISMATCH/);
});

test("a bad deform id fails validation, and old d-only scenes still validate", () => {
  const scene = load("path-squash.json");
  scene.nodes[1].props.deform = [{ id: "p2", dx: "wide", dy: 0 }];
  assert.ok(validateScene(scene).errors.length > 0, "expected a schema error for a string dx");
  const { errors } = validateScene(load("path-points.json"));
  assert.deepEqual(errors, []);
});
