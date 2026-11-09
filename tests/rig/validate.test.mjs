// Rig validation tests: schema walk plus cross-reference checks, reached
// through validateScene (the `hme validate` dispatch) and through the
// `hme validate` CLI on temp files. Rigs are built in memory so these
// tests do not depend on any fixture file.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateScene } from "../../src/scene/validate.mjs";
import { validateRig } from "../../src/rig/validate.mjs";

const HME = new URL("../../src/cli/hme.mjs", import.meta.url).pathname;

const validRig = () => ({
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
    { id: "elbow-left", part: "arm-left", pivot: { x: 760, y: 760 }, mode: "rotate", parent: "shoulder-left" },
    { id: "brow-left", part: "eyebrow-left", pivot: { x: 860, y: 380 }, mode: "translate", parent: null },
  ],
  poses: [
    { id: "eyes-closed", states: [{ part: "eye-left", scale: 0.08 }, { part: "eye-right", scale: 0.08 }] },
    { id: "eyes-open", states: [{ part: "eye-left", scale: 1 }, { part: "eye-right", scale: 1 }] },
    { id: "brows-raised", states: [{ part: "eyebrow-left", y: -12 }] },
    { id: "arms-raised", states: [{ part: "arm-left", rotation: -120 }] },
  ],
});

test("a valid rig passes through the validateScene dispatch", () => {
  const { errors, warnings } = validateScene(validRig());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("validateRig and validateScene agree on a rig", () => {
  assert.deepEqual(validateRig(validRig()), validateScene(validRig()));
});

test("a scene still validates as a scene, not a rig", () => {
  const { errors } = validateScene({ schema: "hme.scene/1.0" });
  assert.ok(errors.length > 0);
  assert.notEqual(errors[0].code, "BAD_JOINT");
});

test("a joint naming a missing part fails BAD_JOINT naming the joint", () => {
  const rig = validRig();
  rig.joints[0].part = "arm-missing";
  const { errors } = validateScene(rig);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "BAD_JOINT");
  assert.equal(errors[0].path, "/joints/0/part");
  assert.match(errors[0].message, /joint "shoulder-left"/);
  assert.match(errors[0].message, /part "arm-missing"/);
});

test("a joint cycle fails JOINT_CYCLE naming the joint", () => {
  const rig = validRig();
  rig.joints[0].parent = "elbow-left";
  const { errors } = validateScene(rig);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "JOINT_CYCLE");
  assert.match(errors[0].message, /joint "shoulder-left"/);
  assert.match(errors[0].message, /shoulder-left > elbow-left > shoulder-left/);
});

test("a joint naming a missing parent joint fails BAD_JOINT naming the joint", () => {
  const rig = validRig();
  rig.joints[1].parent = "wrist-left";
  const { errors } = validateScene(rig);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "BAD_JOINT");
  assert.match(errors[0].message, /joint "elbow-left"/);
});

test("a pose referencing a missing part fails MISSING_PART naming the part", () => {
  const rig = validRig();
  rig.poses[0].states[0].part = "eye-center";
  const { errors } = validateScene(rig);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "MISSING_PART");
  assert.equal(errors[0].path, "/poses/0/states/0/part");
  assert.match(errors[0].message, /pose "eyes-closed"/);
  assert.match(errors[0].message, /part "eye-center"/);
});

test("duplicate part, joint, and pose ids fail DUP_ID", () => {
  const a = validRig();
  a.parts.push({ id: "eye-left", kind: "eye", node: "eye-left-2" });
  assert.equal(validateScene(a).errors[0].code, "DUP_ID");
  const b = validRig();
  b.joints.push({ id: "shoulder-left", part: "arm-left", pivot: { x: 0, y: 0 }, mode: "rotate", parent: null });
  assert.equal(validateScene(b).errors[0].code, "DUP_ID");
  const c = validRig();
  c.poses.push({ id: "eyes-open", states: [{ part: "eye-left", scale: 1 }] });
  assert.equal(validateScene(c).errors[0].code, "DUP_ID");
});

test("schema errors fail before cross-reference checks", () => {
  const rig = validRig();
  rig.joints[0].mode = "bend";
  rig.joints[0].part = "arm-missing";
  const { errors } = validateScene(rig);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((e) => e.code !== "BAD_JOINT"));
});

test("a pose state setting no value fails", () => {
  const rig = validRig();
  rig.poses[0].states[0] = { part: "eye-left" };
  const { errors } = validateScene(rig);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /sets no value/);
});

const runCli = (rig) => {
  const dir = mkdtempSync(join(tmpdir(), "hme-rig-"));
  const file = join(dir, "rig.json");
  writeFileSync(file, JSON.stringify(rig));
  const r = spawnSync(process.execPath, [HME, "validate", file], { encoding: "utf8" });
  return { ...r, report: JSON.parse(r.stdout) };
};

test("hme validate exits 0 on a valid rig", () => {
  const { status, report } = runCli(validRig());
  assert.equal(status, 0);
  assert.equal(report.verdict.status, "PASS");
});

test("hme validate exits 1 naming the joint on a bad-joint rig", () => {
  const rig = validRig();
  rig.joints[0].part = "arm-missing";
  const { status, report } = runCli(rig);
  assert.equal(status, 1);
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.numbers.errors[0].code, "BAD_JOINT");
  assert.match(report.verdict.detail, /joint "shoulder-left"/);
});

test("hme validate exits 1 naming the missing part on a missing-part rig", () => {
  const rig = validRig();
  rig.poses[0].states[0].part = "eye-center";
  const { status, report } = runCli(rig);
  assert.equal(status, 1);
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.numbers.errors[0].code, "MISSING_PART");
  assert.match(report.verdict.detail, /part "eye-center"/);
});
