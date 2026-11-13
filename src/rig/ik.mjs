// Two-bone IK for rigged arms. Pure and deterministic: no random,
// no date, no network. Screen coordinates, y grows down, angles are
// clockwise-positive degrees, matching CSS rotate() and the pivot math
// in src/rig/expand.mjs.
//
// Convention (read this before using a number from this file):
// - Shoulder angle 0 means the upper arm points straight down from
//   the shoulder, the way an arm hangs at rest.
// - Elbow angle 0 means the forearm continues straight on from the
//   upper arm. It is the bend *relative* to the upper arm, not an
//   absolute direction. That matches how expandRig composes a chain:
//   the forearm's flat rotation is shoulder + elbow.
// - A hand target is given relative to its shoulder, in units of
//   L = L1 + L2, with x to the right and y down. A target of
//   (0.86, -0.32) is up and to the right of the shoulder.
// - The elbow bends to the side that puts the elbow below the
//   shoulder-to-target line (larger y in screen coordinates). For a
//   character facing the viewer that is the natural elbow-out bend.
//   When the target is straight above the shoulder the bend side is
//   still below the line, so the elbow points down and out, never up.
//
// Segment rules, from the infographic rig spec:
// - L1 (upper arm) is 0.11 to 0.15 of figure height.
// - L2 (forearm) is 0.10 to 0.14 of figure height.
// - Arm thickness is 0.03 to 0.05 of figure height.
// Out-of-range lengths throw; they are never silently clamped, because
// a silently clamped arm would render a different length than the
// author asked for.

const DEG = Math.PI / 180;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Normalise an angle to (-180, 180]. */
export function normDeg(a) {
  let v = a % 360;
  if (v <= -180) v += 360;
  if (v > 180) v -= 360;
  return v;
}

const fmt3 = (n) => Number(n.toFixed(3)) + 0;

/**
 * Validate arm segment lengths against figure height.
 * @param {number} figureHeight px, must be > 0
 * @param {number} L1 upper-arm length px
 * @param {number} L2 forearm length px
 * @param {number} thickness arm thickness px
 * @throws {Error} ARM_LENGTH when a length is outside its range.
 */
export function validateArmLengths(figureHeight, L1, L2, thickness) {
  if (!(figureHeight > 0)) throw new Error("ARM_LENGTH: figureHeight must be > 0");
  const checks = [
    ["L1", L1, 0.11, 0.15],
    ["L2", L2, 0.10, 0.14],
    ["thickness", thickness, 0.03, 0.05],
  ];
  for (const [name, v, lo, hi] of checks) {
    if (!(v >= lo * figureHeight && v <= hi * figureHeight)) {
      throw new Error(
        `ARM_LENGTH: ${name} ${v} is outside ${lo}-${hi} of figure height ${figureHeight} (${fmt3(lo * figureHeight)}-${fmt3(hi * figureHeight)})`,
      );
    }
  }
  return true;
}

/**
 * Solve two-bone IK for one arm.
 *
 * @param {{x:number,y:number}} shoulder shoulder pivot, scene px
 * @param {{x:number,y:number}} target hand target, scene px
 * @param {number} L1 upper-arm length px
 * @param {number} L2 forearm length px
 * @returns {{elbow:{x:number,y:number}, shoulderDeg:number, elbowDeg:number, reached:boolean, clampedDistance:number}}
 *   `reached` is false when the target was further than L1+L2 or
 *   closer than |L1-L2| and the hand was clamped onto the reachable
 *   circle instead. `clampedDistance` is the distance actually used.
 */
export function solveTwoBone(shoulder, target, L1, L2) {
  if (!(L1 > 0 && L2 > 0)) throw new Error("ARM_LENGTH: L1 and L2 must be > 0");
  const dx = target.x - shoulder.x;
  const dy = target.y - shoulder.y;
  let d = Math.hypot(dx, dy);
  let reached = true;
  // A target exactly on the shoulder has no direction; point down.
  let tx = target.x;
  let ty = target.y;
  if (d < 1e-9) {
    tx = shoulder.x;
    ty = shoulder.y + L1 + L2;
    d = L1 + L2;
    reached = false;
  }
  const maxD = L1 + L2;
  const minD = Math.abs(L1 - L2);
  if (d > maxD) {
    const s = maxD / d;
    tx = shoulder.x + dx * s;
    ty = shoulder.y + dy * s;
    d = maxD;
    reached = false;
  } else if (d < minD) {
    const s = minD / d;
    tx = shoulder.x + dx * s;
    ty = shoulder.y + dy * s;
    d = minD;
    reached = false;
  }
  // Direction shoulder -> target, in screen coords (atan2, y down).
  const phi = Math.atan2(ty - shoulder.y, tx - shoulder.x);
  // Angle between the shoulder-target line and the upper arm.
  const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
  const alpha = Math.acos(cosA);
  // Two elbow positions exist, one on each side of the line. Pick the
  // one with the larger y (elbow below the line in screen coords).
  const c1 = phi - alpha;
  const c2 = phi + alpha;
  const e1 = { x: shoulder.x + L1 * Math.cos(c1), y: shoulder.y + L1 * Math.sin(c1) };
  const e2 = { x: shoulder.x + L1 * Math.cos(c2), y: shoulder.y + L1 * Math.sin(c2) };
  const theta1 = e1.y >= e2.y ? c1 : c2;
  const elbow = e1.y >= e2.y ? e1 : e2;
  // Forearm direction, elbow -> clamped target.
  const theta2 = Math.atan2(ty - elbow.y, tx - elbow.x);
  // Shoulder angle from straight down (90 deg in atan2 screen coords).
  const shoulderDeg = fmt3(normDeg(theta1 / DEG - 90));
  // Elbow bend relative to the upper arm.
  const elbowDeg = fmt3(normDeg((theta2 - theta1) / DEG));
  return {
    elbow: { x: fmt3(elbow.x), y: fmt3(elbow.y) },
    shoulderDeg,
    elbowDeg,
    reached,
    clampedDistance: fmt3(d),
  };
}

/**
 * Hand target in scene px from a target in units of L.
 * @param {{x:number,y:number}} shoulder
 * @param {{x:number,y:number}} targetUnits x right, y down, in units of L
 * @param {number} L L1 + L2, px
 */
export function handTargetPx(shoulder, targetUnits, L) {
  return { x: fmt3(shoulder.x + targetUnits.x * L), y: fmt3(shoulder.y + targetUnits.y * L) };
}

/**
 * Solve IK from a hand target given in units of L.
 * Returns the same shape as solveTwoBone, plus the px target used.
 */
export function solveArmPose(shoulder, targetUnits, L1, L2) {
  const L = L1 + L2;
  const target = handTargetPx(shoulder, targetUnits, L);
  const solved = solveTwoBone(shoulder, target, L1, L2);
  return { ...solved, target };
}

/** Blend two angles over p in [0,1] with ease-in-out (smoothstep). */
export function blendAngles(a, b, p) {
  const t = clamp(p, 0, 1);
  const s = t * t * (3 - 2 * t);
  return fmt3(a + (b - a) * s);
}
