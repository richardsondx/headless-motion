// Numeric expansion tests (Unit C): pivot rotation, parent-chain
// composition, and non-rotation poses, checked by number.
//
// Geometry convention, verified against the renderer
// (src/renderer/runtime.mjs, read-only): the element sits at
// left = box.x + transform.x, top = box.y + transform.y, styled with
// `scale(s) rotate(r deg)` about the element's own centre (the CSS
// default transform-origin). So rotating a part by theta about a joint
// pivot P must move its centre to P + R(theta).(C0 - P), where C0 is
// the rest centre and R is the screen-coordinate rotation (positive
// angles clockwise, y down). These tests assert the flat track values
// (x, y, rotation) exactly, then re-derive the same numbers from the
// sampled scene (src/scene/evaluate.mjs) with an independent rotation
// helper written in this file, so the check does not trust the
// implementation's own arithmetic.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { expandRig, KEYFRAMES_VERSION } from "../../src/rig/expand.mjs";
import { sampleScene } from "../../src/scene/evaluate.mjs";

const RIG_A = "/home/hatch/workspace/handover-character-rig/units/A/rig-valid.json";
const KF_B = "/home/hatch/workspace/handover-character-rig/units/B/proof-keyframes-v1.json";
const SCENE_B = "/home/hatch/workspace/handover-character-rig/units/B/test-scene-v1.json";

// Independent rotation helper (screen coords, positive = clockwise).
// Written here, not imported from expand.mjs.
const rot = (px, py, deg, x, y) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: px + c * (x - px) - s * (y - py), y: py + s * (x - px) + c * (y - py) };
};
const fmt = (n) => Number(n.toFixed(3)) + 0;

const keyframes = (rigId, keys) => ({ schema: KEYFRAMES_VERSION, rig: rigId, keys });

const track = (scene, node, prop) =>
  scene.timeline.find((t) => t.node === node && t.prop === prop);

const sceneWith = (nodes) => ({
  schema: "hme.scene/1.0",
  meta: { id: "rig-expand-test", fps: 24, width: 1920, height: 1080, duration: 120, seed: 1, register: "dark" },
  fonts: [{ family: "Montserrat", weight: 700, src: "fonts/Montserrat-Bold.ttf" }],
  palette: { ground: "#101820", ink: "#f4f1ea", accent: { color: "#e8a33d", source: 0 } },
  nodes,
  timeline: [],
  events: [],
});

const node = (id, x, y, w, h) => ({
  id, type: "shape", parent: null, z: 1,
  box: { x, y, w, h },
  props: { kind: "rect", fill: "ink" },
});

// One arm node, box (100,100,60,40), rest centre (130,120),
// shoulder pivot (130,100), 20 above the centre.
const singleJointRig = () => ({
  schema: "hme.rig/1.0",
  meta: { id: "single-joint-rig", fps: 24, duration: 120 },
  character: { id: "man", name: "Test man" },
  parts: [{ id: "arm", kind: "arm", node: "arm" }],
  joints: [{ id: "shoulder", part: "arm", pivot: { x: 130, y: 100 }, mode: "rotate", parent: null }],
  poses: [
    { id: "rest", states: [{ part: "arm", rotation: 0 }] },
    { id: "raise-90", states: [{ part: "arm", rotation: 90 }] },
    { id: "lower-neg90", states: [{ part: "arm", rotation: -90 }] },
    { id: "raise-90-shift", states: [{ part: "arm", rotation: 90, x: 5 }] },
  ],
});

const singleJointScene = () => sceneWith([node("arm", 100, 100, 60, 40)]);

// The sampled centre of a node at a frame, from the evaluator.
const sampledCentre = (scene, nodeId, frame) => {
  const n = scene.nodes.find((x) => x.id === nodeId);
  const s = sampleScene(scene, frame)[nodeId];
  return {
    x: fmt(n.box.x + s["transform.x"] + n.box.w / 2),
    y: fmt(n.box.y + s["transform.y"] + n.box.h / 2),
    rotation: s["transform.rotation"],
  };
};

test("(a) single joint: +90 deg about pivot (130,100) from centre (130,120)", () => {
  const { scene: out } = expandRig(
    singleJointRig(),
    keyframes("single-joint-rig", [{ frame: 10, pose: "raise-90" }]),
    singleJointScene(),
  );
  // C1 = (130,100) + R(90).(0,20) = (110,100);
  // x = 110-30-100 = -20, y = 100-20-100 = -20.
  assert.deepEqual(track(out, "arm", "transform.rotation").keys, [{ f: 10, v: 90 }]);
  assert.deepEqual(track(out, "arm", "transform.x").keys, [{ f: 10, v: -20 }]);
  assert.deepEqual(track(out, "arm", "transform.y").keys, [{ f: 10, v: -20 }]);
  // Same numbers back out of the evaluator, at the key frame.
  assert.deepEqual(sampledCentre(out, "arm", 10), { x: 110, y: 100, rotation: 90 });
  // And from the pivot, independently: the centre is the rest centre
  // rotated about the pivot, and its distance to the pivot is unchanged.
  const c1 = rot(130, 100, 90, 130, 120);
  assert.deepEqual({ x: fmt(c1.x), y: fmt(c1.y) }, { x: 110, y: 100 });
  assert.equal(fmt(Math.hypot(110 - 130, 100 - 100)), 20);
});

test("(a) single joint: -90 deg about the same pivot, and 0 deg is the identity", () => {
  const { scene: out } = expandRig(
    singleJointRig(),
    keyframes("single-joint-rig", [
      { frame: 0, pose: "rest" },
      { frame: 10, pose: "lower-neg90" },
    ]),
    singleJointScene(),
  );
  // C1 = (130,100) + R(-90).(0,20) = (150,100); x = 20, y = -20.
  assert.deepEqual(track(out, "arm", "transform.x").keys, [{ f: 0, v: 0 }, { f: 10, v: 20 }]);
  assert.deepEqual(track(out, "arm", "transform.y").keys, [{ f: 0, v: 0 }, { f: 10, v: -20 }]);
  assert.deepEqual(track(out, "arm", "transform.rotation").keys, [{ f: 0, v: 0 }, { f: 10, v: -90 }]);
  assert.deepEqual(sampledCentre(out, "arm", 10), { x: 150, y: 100, rotation: -90 });
  const c1 = rot(130, 100, -90, 130, 120);
  assert.deepEqual({ x: fmt(c1.x), y: fmt(c1.y) }, { x: 150, y: 100 });
});

test("(a) single joint: a pose x offset adds in scene space after the rotation", () => {
  const { scene: out } = expandRig(
    singleJointRig(),
    keyframes("single-joint-rig", [{ frame: 10, pose: "raise-90-shift" }]),
    singleJointScene(),
  );
  // Pivot math gives x = -20; the pose x = 5 adds after the rotation.
  assert.deepEqual(track(out, "arm", "transform.x").keys, [{ f: 10, v: -15 }]);
  assert.deepEqual(track(out, "arm", "transform.y").keys, [{ f: 10, v: -20 }]);
  assert.deepEqual(track(out, "arm", "transform.rotation").keys, [{ f: 10, v: 90 }]);
});

// Two-part chain: upper arm box (100,100,40,100), centre (120,150);
// forearm box (100,200,40,100), centre (120,250); shoulder pivot
// (120,100), elbow pivot (120,200), elbow parented to shoulder.
const chainRig = () => ({
  schema: "hme.rig/1.0",
  meta: { id: "chain-rig", fps: 24, duration: 120 },
  character: { id: "man", name: "Test man" },
  parts: [
    { id: "upper-arm", kind: "arm", node: "upper-arm" },
    { id: "forearm", kind: "arm", node: "forearm" },
  ],
  joints: [
    { id: "shoulder", part: "upper-arm", pivot: { x: 120, y: 100 }, mode: "rotate", parent: null },
    { id: "elbow", part: "forearm", pivot: { x: 120, y: 200 }, mode: "rotate", parent: "shoulder" },
  ],
  poses: [
    { id: "bend", states: [{ part: "upper-arm", rotation: 90 }, { part: "forearm", rotation: 90 }] },
    { id: "elbow-only", states: [{ part: "forearm", rotation: 90 }] },
    { id: "shoulder-only", states: [{ part: "upper-arm", rotation: 90 }, { part: "forearm", rotation: 0 }] },
  ],
});

const chainScene = () => sceneWith([
  node("upper-arm", 100, 100, 40, 100),
  node("forearm", 100, 200, 40, 100),
]);

test("(b) two-level chain: shoulder 90 + elbow 90 composes, pivots move with the parent", () => {
  const { scene: out } = expandRig(
    chainRig(),
    keyframes("chain-rig", [{ frame: 10, pose: "bend" }]),
    chainScene(),
  );
  // Upper arm: centre (120,150) about shoulder (120,100) by 90 -> (70,100);
  // x = 70-20-100 = -50, y = 100-50-100 = -50, rotation 90.
  assert.deepEqual(track(out, "upper-arm", "transform.x").keys, [{ f: 10, v: -50 }]);
  assert.deepEqual(track(out, "upper-arm", "transform.y").keys, [{ f: 10, v: -50 }]);
  assert.deepEqual(track(out, "upper-arm", "transform.rotation").keys, [{ f: 10, v: 90 }]);
  // Forearm: shoulder 90 moves the elbow pivot (120,200) -> (20,100) and
  // the centre (120,250) -> (-30,100); elbow 90 about (20,100) moves the
  // centre (-30,100) -> (20,50). Total rotation 90 + 90 = 180.
  // x = 20-20-100 = -100, y = 50-50-200 = -200.
  assert.deepEqual(track(out, "forearm", "transform.x").keys, [{ f: 10, v: -100 }]);
  assert.deepEqual(track(out, "forearm", "transform.y").keys, [{ f: 10, v: -200 }]);
  assert.deepEqual(track(out, "forearm", "transform.rotation").keys, [{ f: 10, v: 180 }]);
  assert.deepEqual(sampledCentre(out, "forearm", 10), { x: 20, y: 50, rotation: 180 });
  // Independent re-derivation of the composed centre.
  const elbowMoved = rot(120, 100, 90, 120, 200);
  assert.deepEqual({ x: fmt(elbowMoved.x), y: fmt(elbowMoved.y) }, { x: 20, y: 100 });
  const afterShoulder = rot(120, 100, 90, 120, 250);
  const afterElbow = rot(elbowMoved.x, elbowMoved.y, 90, afterShoulder.x, afterShoulder.y);
  assert.deepEqual({ x: fmt(afterElbow.x), y: fmt(afterElbow.y) }, { x: 20, y: 50 });
});

test("(b) two-level chain: elbow alone rotates about the unmoved elbow pivot", () => {
  const { scene: out } = expandRig(
    chainRig(),
    keyframes("chain-rig", [{ frame: 10, pose: "elbow-only" }]),
    chainScene(),
  );
  // Shoulder angle 0, so the elbow pivot stays at (120,200); the forearm
  // centre (120,250) -> (70,200); x = -50, y = -50, rotation 90.
  assert.deepEqual(track(out, "forearm", "transform.x").keys, [{ f: 10, v: -50 }]);
  assert.deepEqual(track(out, "forearm", "transform.y").keys, [{ f: 10, v: -50 }]);
  assert.deepEqual(track(out, "forearm", "transform.rotation").keys, [{ f: 10, v: 90 }]);
  assert.deepEqual(sampledCentre(out, "forearm", 10), { x: 70, y: 200, rotation: 90 });
});

test("(b) two-level chain: shoulder alone carries the forearm with it, elbow 0", () => {
  const { scene: out } = expandRig(
    chainRig(),
    keyframes("chain-rig", [{ frame: 10, pose: "shoulder-only" }]),
    chainScene(),
  );
  // Forearm centre (120,250) about the shoulder (120,100) by 90 -> (-30,100);
  // elbow 0 adds nothing. x = -30-20-100 = -150, y = 100-50-200 = -150,
  // total rotation 90 + 0 = 90.
  assert.deepEqual(track(out, "forearm", "transform.x").keys, [{ f: 10, v: -150 }]);
  assert.deepEqual(track(out, "forearm", "transform.y").keys, [{ f: 10, v: -150 }]);
  assert.deepEqual(track(out, "forearm", "transform.rotation").keys, [{ f: 10, v: 90 }]);
  assert.deepEqual(sampledCentre(out, "forearm", 10), { x: -30, y: 100, rotation: 90 });
});

// Non-rotation poses: eyes scale, brows y, body opacity. No joint moves
// these parts, so the values are written directly (Unit B behaviour).
const faceRig = () => ({
  schema: "hme.rig/1.0",
  meta: { id: "face-rig", fps: 24, duration: 120 },
  character: { id: "man", name: "Test man" },
  parts: [
    { id: "eye-left", kind: "eye", node: "eye-left" },
    { id: "eyebrow-left", kind: "eyebrow", node: "eyebrow-left" },
    { id: "body", kind: "body", node: "body" },
  ],
  joints: [
    { id: "brow-left", part: "eyebrow-left", pivot: { x: 860, y: 380 }, mode: "translate", parent: null },
  ],
  poses: [
    { id: "eyes-closed", states: [{ part: "eye-left", scale: 0.08 }] },
    { id: "eyes-open", states: [{ part: "eye-left", scale: 1 }] },
    { id: "brows-raised", states: [{ part: "eyebrow-left", y: -12 }] },
    { id: "body-fade", states: [{ part: "body", opacity: 0.5 }] },
  ],
});

test("(c) non-rotation pose states are unchanged from Unit B behaviour", () => {
  const { scene: out, summary } = expandRig(
    faceRig(),
    keyframes("face-rig", [
      { frame: 0, pose: "eyes-closed" },
      { frame: 48, pose: "eyes-open" },
      { frame: 72, pose: "brows-raised" },
      { frame: 96, pose: "body-fade" },
    ]),
    sceneWith([node("eye-left", 830, 360, 60, 40), node("eyebrow-left", 820, 320, 80, 16), node("body", 760, 300, 400, 600)]),
  );
  assert.equal(summary.posesApplied, 4);
  assert.deepEqual(track(out, "eye-left", "transform.scale").keys, [{ f: 0, v: 0.08 }, { f: 48, v: 1 }]);
  assert.deepEqual(track(out, "eyebrow-left", "transform.y").keys, [{ f: 72, v: -12 }]);
  assert.deepEqual(track(out, "body", "transform.opacity").keys, [{ f: 96, v: 0.5 }]);
  // No pivot tracks appear for parts no rotate joint moves.
  assert.equal(track(out, "eye-left", "transform.x"), undefined);
  assert.equal(track(out, "eye-left", "transform.rotation"), undefined);
  assert.deepEqual(sampleScene(out, 0)["eye-left"]["transform.scale"], 0.08);
  assert.deepEqual(sampleScene(out, 72)["eyebrow-left"]["transform.y"], -12);
});

// The proof rig itself: arms-raised at frame 72 must expand to the
// pivot-computed tracks and the sampled centres must sit on the rotated
// positions. Shoulder pivots (820,620) / (1100,620); arm boxes
// (700,620,60,220) / (1160,620,60,220); angles -120 / +120.
test("proof rig: arms-raised expands to the shoulder-pivot tracks", async () => {
  if (!existsSync(RIG_A) || !existsSync(KF_B) || !existsSync(SCENE_B)) return;
  const { readFileSync } = await import("node:fs");
  const rig = JSON.parse(readFileSync(RIG_A, "utf8"));
  const kf = JSON.parse(readFileSync(KF_B, "utf8"));
  const scene = JSON.parse(readFileSync(SCENE_B, "utf8"));
  const { scene: out, summary } = expandRig(rig, kf, scene);
  assert.equal(summary.posesApplied, 3);
  assert.deepEqual(track(out, "arm-left", "transform.rotation").keys, [{ f: 72, v: -120 }]);
  assert.deepEqual(track(out, "arm-left", "transform.x").keys, [{ f: 72, v: 230.263 }]);
  assert.deepEqual(track(out, "arm-left", "transform.y").keys, [{ f: 72, v: -87.058 }]);
  assert.deepEqual(track(out, "arm-right", "transform.rotation").keys, [{ f: 72, v: 120 }]);
  assert.deepEqual(track(out, "arm-right", "transform.x").keys, [{ f: 72, v: -230.263 }]);
  assert.deepEqual(track(out, "arm-right", "transform.y").keys, [{ f: 72, v: -87.058 }]);
  // Eyes still expand directly alongside the arms.
  assert.deepEqual(track(out, "eye-left", "transform.scale").keys, [{ f: 0, v: 0.08 }, { f: 48, v: 1 }]);
  // Sampled centres match the pivot rotation, independently re-derived.
  assert.deepEqual(sampledCentre(out, "arm-left", 72), { x: 960.263, y: 642.942, rotation: -120 });
  assert.deepEqual(sampledCentre(out, "arm-right", 72), { x: 959.737, y: 642.942, rotation: 120 });
  const left = rot(820, 620, -120, 730, 730);
  const right = rot(1100, 620, 120, 1190, 730);
  assert.deepEqual({ x: fmt(left.x), y: fmt(left.y) }, { x: 960.263, y: 642.942 });
  assert.deepEqual({ x: fmt(right.x), y: fmt(right.y) }, { x: 959.737, y: 642.942 });
});
