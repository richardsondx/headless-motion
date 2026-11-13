// Scene camera: schema validation and evaluator sampling.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateScene } from "../../src/scene/validate.mjs";
import { sampleScene } from "../../src/scene/evaluate.mjs";

const FIXTURE = new URL("../fixtures/camera-sample.json", import.meta.url);
const base = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

test("camera fixture validates and samples the push-in", () => {
  const s = base();
  assert.deepEqual(validateScene(s).errors, []);
  assert.equal(sampleScene(s, 0).camera.zoom, 1);
  assert.equal(sampleScene(s, 108).camera.zoom, 1.05);
  assert.deepEqual(sampleScene(s, 54).camera.center, [960, 540]);
});

test("a scene without a camera has no camera key in the sample", () => {
  const s = base();
  s.timeline = [];
  assert.deepEqual(validateScene(s).errors, []);
  assert.equal(sampleScene(s, 0).camera, undefined);
});

test("a static camera validates and samples", () => {
  const s = base();
  s.timeline = [];
  s.camera = { center: [1360, 540], zoom: 1.5 };
  assert.deepEqual(validateScene(s).errors, []);
  assert.deepEqual(sampleScene(s, 0).camera, { zoom: 1.5, center: [1360, 540] });
  assert.deepEqual(sampleScene(s, 108).camera, { zoom: 1.5, center: [1360, 540] });
});

test("camera zoom 0, negative zoom, and center outside the canvas are rejected", () => {
  const zero = base();
  zero.timeline = [];
  zero.camera = { center: [960, 540], zoom: 0 };
  assert.ok(validateScene(zero).errors.some((e) => e.path === "/camera/zoom"), "zoom 0 rejected");
  const neg = base();
  neg.timeline = [];
  neg.camera = { center: [960, 540], zoom: -2 };
  assert.ok(validateScene(neg).errors.some((e) => e.path === "/camera/zoom"), "negative zoom rejected");
  const wide = base();
  wide.timeline = [];
  wide.camera = { center: [2000, 540], zoom: 2 };
  assert.ok(validateScene(wide).errors.some((e) => e.path === "/camera/center/0"), "center x outside rejected");
  const tall = base();
  tall.timeline = [];
  tall.camera = { center: [960, 1200], zoom: 2 };
  assert.ok(validateScene(tall).errors.some((e) => e.path === "/camera/center/1"), "center y outside rejected");
  const edge = base();
  edge.timeline = [];
  edge.camera = { center: [1920, 1080], zoom: 2 };
  assert.deepEqual(validateScene(edge).errors, [], "center on the canvas edge is accepted");
});

test("camera track values are range checked", () => {
  const zero = base();
  zero.timeline[0].keys[1].v = 0;
  assert.ok(validateScene(zero).errors.some((e) => e.path === "/timeline/0/keys/1/v"), "track zoom 0 rejected");
  const bad = base();
  bad.timeline = [{ node: "camera", prop: "center.x", keys: [{ f: 0, v: 0 }, { f: 108, v: 2500 }] }];
  assert.ok(validateScene(bad).errors.some((e) => e.path === "/timeline/0/keys/1/v"), "track center x outside rejected");
  const unknown = base();
  unknown.timeline = [{ node: "camera", prop: "bearing", keys: [{ f: 0, v: 0 }] }];
  assert.equal(validateScene(unknown).errors[0].code, "UNKNOWN_FIELD");
  const ghost = base();
  ghost.timeline = [{ node: "camera", prop: "zoom", keys: [{ f: 0, v: 1 }, { f: 200, v: 2 }] }];
  assert.ok(validateScene(ghost).errors.some((e) => e.code === "KEY_RANGE"), "track key past duration rejected");
});

test("a center track and a center.x track conflict, axis tracks pair", () => {
  const s = base();
  s.timeline = [
    { node: "camera", prop: "center", keys: [{ f: 0, v: [960, 540] }, { f: 108, v: [1360, 540] }] },
    { node: "camera", prop: "center.x", keys: [{ f: 0, v: 960 }, { f: 108, v: 1360 }] },
  ];
  assert.ok(validateScene(s).errors.some((e) => e.code === "PROP_TYPE"), "center plus center.x rejected");
  const pair = base();
  pair.timeline = [
    { node: "camera", prop: "center.x", keys: [{ f: 0, v: 960 }, { f: 108, v: 1360 }] },
    { node: "camera", prop: "center.y", keys: [{ f: 0, v: 540 }, { f: 108, v: 540 }] },
  ];
  assert.deepEqual(validateScene(pair).errors, []);
  assert.deepEqual(sampleScene(pair, 108).camera.center, [1360, 540]);
});

test("a center track moves the fixed point over the clip", () => {
  const s = base();
  s.timeline = [{ node: "camera", prop: "center", keys: [{ f: 0, v: [960, 540] }, { f: 108, v: [1360, 540] }] }];
  assert.deepEqual(validateScene(s).errors, []);
  assert.deepEqual(sampleScene(s, 0).camera.center, [960, 540]);
  assert.deepEqual(sampleScene(s, 108).camera.center, [1360, 540]);
  assert.deepEqual(sampleScene(s, 54).camera.center, [1160, 540]);
});

test("node id camera is reserved", () => {
  const s = base();
  s.nodes.push({ id: "camera", type: "shape", parent: null, z: 1, box: { x: 0, y: 0, w: 10, h: 10 }, props: { kind: "rect", fill: "accent" } });
  assert.ok(validateScene(s).errors.some((e) => e.message.includes("reserved")), "node id camera rejected");
});
