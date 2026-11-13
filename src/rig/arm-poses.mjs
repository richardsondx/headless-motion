// Named arm poses: hand targets and hand shapes, from the
// infographic rig spec. A pose names where the hand goes, in units of
// L = L1 + L2 relative to its shoulder (x right, y down). The IK
// solver in ./ik.mjs turns the target into shoulder and elbow angles.
// Nothing here writes a scene; it only names targets, so a pose can
// be checked (every target must be reachable, distance < L) without
// rendering anything.
//
// Side convention: for a target with two signs, the left arm takes
// the negative x and the right arm takes the positive x. Poses that
// name one hand only (point, present, wave, stop, chin) use the right
// hand; the other hand keeps its current pose.
// Hand shapes: mitt (default closed mitten), open, fist, point
// (one finger out).
//
// Targets with no value in the source spec (hands-on-head, chin)
// are marked derived: the numbers below are this file's choice,
// chosen so the hand lands on the head / at the neck for a figure
// whose head sits about 0.55 L above the shoulder. They are not
// quoted from the spec.

/**
 * @typedef {{x:number,y:number}} TargetUnits
 * @typedef {{targets:{left:TargetUnits|null,right:TargetUnits|null}, hands:{left:string,right:string}, derived:boolean}} ArmPose
 */

/** @type {Record<string, ArmPose>} */
export const ARM_POSES = Object.freeze({
  down: {
    targets: { left: { x: -0.04, y: 0.97 }, right: { x: 0.04, y: 0.97 } },
    hands: { left: "mitt", right: "mitt" },
    derived: false,
  },
  rest: {
    targets: { left: { x: -0.1, y: 0.9 }, right: { x: 0.1, y: 0.9 } },
    hands: { left: "mitt", right: "mitt" },
    derived: false,
  },
  hips: {
    targets: { left: { x: -0.42, y: 0.55 }, right: { x: 0.42, y: 0.55 } },
    hands: { left: "fist", right: "fist" },
    derived: false,
  },
  point: {
    targets: { left: null, right: { x: 0.86, y: -0.32 } },
    hands: { left: "mitt", right: "point" },
    derived: false,
  },
  present: {
    targets: { left: null, right: { x: 0.75, y: 0.25 } },
    hands: { left: "mitt", right: "open" },
    derived: false,
  },
  shrug: {
    targets: { left: { x: -0.62, y: 0.12 }, right: { x: 0.62, y: 0.12 } },
    hands: { left: "open", right: "open" },
    derived: false,
  },
  up: {
    targets: { left: { x: -0.32, y: -0.9 }, right: { x: 0.32, y: -0.9 } },
    hands: { left: "mitt", right: "mitt" },
    derived: false,
  },
  "hands-on-head": {
    targets: { left: { x: -0.28, y: -0.62 }, right: { x: 0.28, y: -0.62 } },
    hands: { left: "open", right: "open" },
    derived: true,
  },
  chin: {
    targets: { left: null, right: { x: 0.15, y: -0.5 } },
    hands: { left: "mitt", right: "fist" },
    derived: true,
  },
  hold: {
    targets: { left: { x: -0.42, y: 0.45 }, right: { x: 0.42, y: 0.45 } },
    hands: { left: "mitt", right: "mitt" },
    derived: false,
  },
  wave: {
    targets: { left: null, right: { x: 0.5, y: -0.75 } },
    hands: { left: "mitt", right: "open" },
    derived: false,
  },
  stop: {
    targets: { left: null, right: { x: 0.55, y: -0.1 } },
    hands: { left: "mitt", right: "open" },
    derived: false,
  },
  cheer: {
    targets: { left: { x: -0.55, y: -0.75 }, right: { x: 0.55, y: -0.75 } },
    hands: { left: "fist", right: "fist" },
    derived: false,
  },
});

export const ARM_POSE_NAMES = Object.freeze(Object.keys(ARM_POSES));

export const HAND_SHAPES = Object.freeze(["mitt", "open", "fist", "point"]);

/**
 * Look up a named arm pose. Throws on an unknown name.
 * @param {string} name
 * @returns {ArmPose}
 */
export function armPose(name) {
  const pose = ARM_POSES[name];
  if (!pose) throw new Error(`UNKNOWN_ARM_POSE "${name}"; known poses: ${ARM_POSE_NAMES.join(", ")}`);
  return pose;
}

/**
 * Distance of a hand target from its shoulder, in units of L.
 * Every pose in this file must read under 1, or the hand cannot
 * reach it and the IK solver would clamp it.
 */
export function targetDistance(targetUnits) {
  return Math.hypot(targetUnits.x, targetUnits.y);
}
