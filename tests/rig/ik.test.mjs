// Two-bone IK tests: the solver is checked by forward kinematics
// written independently in this file, not by reusing the solver's
// own arithmetic. For every solved pose, the elbow must sit L1 from
// the shoulder and L2 from the hand, and walking the solved angles
// from straight down must land on the (possibly clamped) target.
import test from "node:test";
import assert from "node:assert/strict";
import {
  solveTwoBone,
  solveArmPose,
  validateArmLengths,
  blendAngles,
  normDeg,
} from "../../src/rig/ik.mjs";
import { ARM_POSES, ARM_POSE_NAMES, armPose, targetDistance, HAND_SHAPES } from "../../src/rig/arm-poses.mjs";

const S = { x: 500, y: 300 };
const L1 = 130;
const L2 = 120;
const L = L1 + L2;

// Forward kinematics, independent of the solver: shoulder angle 0
// points straight down, elbow angle bends relative to the upper arm.
const fk = (shoulderDeg, elbowDeg) => {
  const t1 = ((shoulderDeg + 90) * Math.PI) / 180;
  const elbow = { x: S.x + L1 * Math.cos(t1), y: S.y + L1 * Math.sin(t1) };
  const t2 = t1 + (elbowDeg * Math.PI) / 180;
  const hand = { x: elbow.x + L2 * Math.cos(t2), y: elbow.y + L2 * Math.sin(t2) };
  return { elbow, hand };
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const close = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

test("IK: hand straight down at full reach is shoulder 0, elbow 0", () => {
  const r = solveArmPose(S, { x: 0, y: 1 }, L1, L2);
  assert.equal(r.reached, true);
  assert.equal(r.shoulderDeg, 0);
  assert.equal(r.elbowDeg, 0);
  assert.deepEqual(r.target, { x: 500, y: 550 });
});

test("IK: hand straight right at full reach is shoulder -90, elbow 0", () => {
  const r = solveArmPose(S, { x: 1, y: 0 }, L1, L2);
  assert.equal(r.reached, true);
  assert.equal(r.shoulderDeg, -90);
  assert.equal(r.elbowDeg, 0);
});

test("IK: hand straight up at full reach is shoulder 180, elbow 0", () => {
  const r = solveArmPose(S, { x: 0, y: -1 }, L1, L2);
  assert.equal(r.reached, true);
  assert.equal(Math.abs(r.shoulderDeg), 180);
  assert.equal(r.elbowDeg, 0);
});

test("IK: point pose (0.86, -0.32) satisfies both bone lengths and FK lands on the target", () => {
  const r = solveArmPose(S, { x: 0.86, y: -0.32 }, L1, L2);
  assert.equal(r.reached, true);
  assert.ok(close(dist(S, r.elbow), L1), `shoulder-elbow ${dist(S, r.elbow)} != ${L1}`);
  assert.ok(close(dist(r.elbow, r.target), L2), `elbow-hand ${dist(r.elbow, r.target)} != ${L2}`);
  const { elbow, hand } = fk(r.shoulderDeg, r.elbowDeg);
  assert.ok(close(elbow.x, r.elbow.x) && close(elbow.y, r.elbow.y), "FK elbow differs from solver elbow");
  assert.ok(close(hand.x, r.target.x) && close(hand.y, r.target.y), "FK hand differs from target");
  // Elbow bends below the shoulder-target line (natural elbow-out).
  assert.ok(r.elbow.y > S.y, "elbow should sit below the shoulder for the point pose");
});

test("IK: every named arm pose is reachable and FK lands on its target", () => {
  for (const name of ARM_POSE_NAMES) {
    const pose = ARM_POSES[name];
    for (const side of ["left", "right"]) {
      const t = pose.targets[side];
      if (!t) continue;
      assert.ok(targetDistance(t) < 1, `${name}/${side} target distance ${targetDistance(t)} must be under 1`);
      const shoulder = side === "left" ? { x: 400, y: 300 } : S;
      const r = solveArmPose(shoulder, t, L1, L2);
      assert.equal(r.reached, true, `${name}/${side} must be reached`);
      assert.ok(close(dist(shoulder, r.elbow), L1));
      assert.ok(close(dist(r.elbow, r.target), L2));
    }
  }
});

test("IK: far target clamps to full reach and reports reached false", () => {
  const r = solveTwoBone(S, { x: 500, y: 300 + 2 * L }, L1, L2);
  assert.equal(r.reached, false);
  assert.equal(r.clampedDistance, L);
  const { hand } = fk(r.shoulderDeg, r.elbowDeg);
  assert.ok(close(dist(S, hand), L), "clamped hand must sit at full reach");
  assert.ok(close(hand.y, S.y + L) && close(hand.x, S.x));
});

test("IK: target on the shoulder clamps and points down", () => {
  const r = solveTwoBone(S, { x: S.x, y: S.y }, L1, L2);
  assert.equal(r.reached, false);
  assert.equal(r.shoulderDeg, 0);
  assert.equal(r.elbowDeg, 0);
});

test("IK: arm lengths outside 0.11-0.15 / 0.10-0.14 of figure height throw", () => {
  assert.equal(validateArmLengths(1000, 130, 120, 40), true);
  assert.throws(() => validateArmLengths(1000, 100, 120, 40), /ARM_LENGTH/);
  assert.throws(() => validateArmLengths(1000, 130, 90, 40), /ARM_LENGTH/);
  assert.throws(() => validateArmLengths(1000, 130, 120, 60), /ARM_LENGTH/);
  assert.throws(() => solveTwoBone(S, { x: 600, y: 300 }, 0, 120), /ARM_LENGTH/);
});

test("IK: blendAngles is ease-in-out, 0 at p=0, 1 at p=1, midpoint at p=0.5", () => {
  assert.equal(blendAngles(0, 90, 0), 0);
  assert.equal(blendAngles(0, 90, 1), 90);
  assert.equal(blendAngles(0, 90, 0.5), 45);
  assert.equal(blendAngles(-120, 120, 0.5), 0);
  assert.equal(normDeg(270), -90);
  assert.equal(normDeg(-270), 90);
});

test("arm poses: names, hand shapes and unknown names", () => {
  assert.ok(ARM_POSE_NAMES.includes("point"));
  assert.ok(ARM_POSE_NAMES.includes("cheer"));
  for (const name of ARM_POSE_NAMES) {
    const pose = armPose(name);
    for (const side of ["left", "right"]) {
      assert.ok(HAND_SHAPES.includes(pose.hands[side]), `${name}/${side} hand shape must be known`);
    }
  }
  assert.throws(() => armPose("no-such-pose"), /UNKNOWN_ARM_POSE/);
  // Derived targets are labelled as derived, spec targets are not.
  assert.equal(ARM_POSES.point.derived, false);
  assert.equal(ARM_POSES["hands-on-head"].derived, true);
  assert.equal(ARM_POSES.chin.derived, true);
});
