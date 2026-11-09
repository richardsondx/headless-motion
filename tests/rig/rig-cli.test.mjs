// Rig CLI tests: `hme rig` define, keyframe, and expand, reached through
// the real CLI on temp files. The proof rig fixture from Unit A is read
// from the run folder when present; every other rig and scene is built in
// memory so these tests do not depend on a fixture file.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandRig, validateKeyframes, KEYFRAMES_VERSION } from "../../src/rig/expand.mjs";

const HME = new URL("../../src/cli/hme.mjs", import.meta.url).pathname;
const RIG_A = "/home/hatch/workspace/handover-character-rig/units/A/rig-valid.json";

const rig = () => ({
  schema: "hme.rig/1.0",
  meta: { id: "test-rig", fps: 24, duration: 120 },
  character: { id: "man", name: "Test man" },
  parts: [
    { id: "eye-left", kind: "eye", node: "eye-left" },
    { id: "eye-right", kind: "eye", node: "eye-right" },
    { id: "eyebrow-left", kind: "eyebrow", node: "eyebrow-left" },
    { id: "arm-left", kind: "arm", node: "arm-left" },
    { id: "body", kind: "body", node: "body" },
  ],
  joints: [
    { id: "shoulder-left", part: "arm-left", pivot: { x: 820, y: 620 }, mode: "rotate", parent: null },
    { id: "brow-left", part: "eyebrow-left", pivot: { x: 860, y: 380 }, mode: "translate", parent: null },
  ],
  poses: [
    { id: "eyes-closed", states: [{ part: "eye-left", scale: 0.08 }, { part: "eye-right", scale: 0.08 }] },
    { id: "eyes-open", states: [{ part: "eye-left", scale: 1 }, { part: "eye-right", scale: 1 }] },
    { id: "brows-raised", states: [{ part: "eyebrow-left", y: -12 }] },
    { id: "arms-down", states: [{ part: "arm-left", rotation: 0 }] },
    { id: "arms-raised", states: [{ part: "arm-left", rotation: -120 }] },
  ],
});

const scene = () => ({
  schema: "hme.scene/1.0",
  meta: { id: "rig-test", fps: 24, width: 1920, height: 1080, duration: 120, seed: 1, register: "dark" },
  fonts: [{ family: "Montserrat", weight: 700, src: "fonts/Montserrat-Bold.ttf" }],
  palette: { ground: "#101820", ink: "#f4f1ea", accent: { color: "#e8a33d", source: 0 } },
  nodes: ["eye-left", "eye-right", "eyebrow-left", "arm-left", "body"].map((id, i) => ({
    id, type: "shape", parent: null, z: 1,
    box: { x: 100 + i * 100, y: 100, w: 60, h: 60 },
    props: { kind: "rect", fill: "ink" },
  })),
  timeline: [],
  events: [],
});

const keyframes = (keys) => ({ schema: KEYFRAMES_VERSION, rig: "test-rig", keys });

function run(args) {
  return spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
}

test("rig --help lists define, keyframe, and expand", () => {
  const r = run(["rig", "--help"]);
  assert.equal(r.status, 0);
  for (const sub of ["define", "keyframe", "expand"]) assert.match(r.stdout, new RegExp(sub));
});

test("rig define passes the proof rig and fails a bad joint", () => {
  if (!existsSync(RIG_A)) return; // proof rig lives in the run folder
  const ok = run(["rig", "define", RIG_A]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /"status": "PASS"/);
  const bad = rig();
  bad.joints[0].part = "arm-missing";
  const dir = mkdtempSync(join(tmpdir(), "hme-rig-"));
  const file = join(dir, "rig.json");
  writeFileSync(file, JSON.stringify(bad));
  const fail = run(["rig", "define", file]);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /BAD_JOINT/);
});

test("rig keyframe appends to an existing keyframes file and refuses an unknown pose", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-rig-"));
  const rigFile = join(dir, "rig.json");
  const kfFile = join(dir, "kf.json");
  writeFileSync(rigFile, JSON.stringify(rig()));
  const first = run(["rig", "keyframe", rigFile, "--pose", "eyes-closed", "--frame", "0", "--out", kfFile]);
  assert.equal(first.status, 0, first.stderr);
  const second = run(["rig", "keyframe", rigFile, "--pose", "eyes-open", "--frame", "48", "--out", kfFile]);
  assert.equal(second.status, 0, second.stderr);
  const kf = JSON.parse(readFileSync(kfFile, "utf8"));
  assert.equal(kf.schema, KEYFRAMES_VERSION);
  assert.equal(kf.rig, "test-rig");
  assert.deepEqual(kf.keys, [
    { frame: 0, pose: "eyes-closed" },
    { frame: 48, pose: "eyes-open" },
  ]);
  const bad = run(["rig", "keyframe", rigFile, "--pose", "no-such-pose", "--frame", "0", "--out", kfFile]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /UNKNOWN_POSE/);
  assert.deepEqual(JSON.parse(readFileSync(kfFile, "utf8")).keys.length, 2, "refused key is not recorded");
});

test("expand writes direct tracks for non-rotation poses", () => {
  const { scene: out, summary } = expandRig(
    rig(),
    keyframes([
      { frame: 0, pose: "eyes-closed" },
      { frame: 48, pose: "eyes-open" },
      { frame: 72, pose: "brows-raised" },
    ]),
    scene(),
  );
  assert.equal(summary.posesApplied, 3);
  assert.equal(summary.keysWritten, 5);
  const track = (node, prop) => out.timeline.find((t) => t.node === node && t.prop === prop);
  assert.deepEqual(track("eye-left", "transform.scale").keys, [{ f: 0, v: 0.08 }, { f: 48, v: 1 }]);
  assert.deepEqual(track("eyebrow-left", "transform.y").keys, [{ f: 72, v: -12 }]);
});

test("expand writes rotation 0 and expands non-zero joint rotation around the pivot", () => {
  const { scene: out } = expandRig(rig(), keyframes([{ frame: 0, pose: "arms-down" }]), scene());
  assert.deepEqual(
    out.timeline.find((t) => t.node === "arm-left" && t.prop === "transform.rotation").keys,
    [{ f: 0, v: 0 }],
  );
  // Unit C: non-zero rotation no longer throws. Arm-left box is
  // (400,100,60,60), centre (430,130); shoulder pivot (820,620);
  // -120 deg moves the centre to (590.648, 1202.75), so the flat tracks
  // are rotation -120, x = 160.648, y = 1072.75.
  const raised = expandRig(rig(), keyframes([{ frame: 72, pose: "arms-raised" }]), scene());
  const track = (node, prop) => raised.scene.timeline.find((t) => t.node === node && t.prop === prop);
  assert.deepEqual(track("arm-left", "transform.rotation").keys, [{ f: 72, v: -120 }]);
  assert.deepEqual(track("arm-left", "transform.x").keys, [{ f: 72, v: 160.648 }]);
  assert.deepEqual(track("arm-left", "transform.y").keys, [{ f: 72, v: 1072.75 }]);
});

test("expand fails clearly when a pose part node is missing from the scene", () => {
  const s = scene();
  s.nodes = s.nodes.filter((n) => n.id !== "eyebrow-left");
  assert.throws(
    () => expandRig(rig(), keyframes([{ frame: 72, pose: "brows-raised" }]), s),
    /MISSING_NODE.*brows-raised.*eyebrow-left/,
  );
});

test("validateKeyframes rejects an unknown pose and a frame past the duration", () => {
  const r = rig();
  const badPose = validateKeyframes(keyframes([{ frame: 0, pose: "nope" }]), r);
  assert.equal(badPose.errors[0].code, "UNKNOWN_POSE");
  const badFrame = validateKeyframes(keyframes([{ frame: 121, pose: "eyes-open" }]), r);
  assert.equal(badFrame.errors[0].code, "KEY_RANGE");
});
