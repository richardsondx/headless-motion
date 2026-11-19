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

// ---------------------------------------------------------------------
// V5 Hybrid (law 4, law 5): 3D-aware foot-locked IK, ball-joint limbs,
// front-to-profile paw morph. Appended 2026-11-19, U2. Existing
// solveTwoBone / solveArmPose behaviour is unchanged.
// ---------------------------------------------------------------------

const smoothstep01 = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Knee perpendicular in screen coords (y down): for unit direction
 * u = (foot - hip) / d, p = (uy, -ux) * bendSign. Check: u.p == 0,
 * and +1 pushes the knee toward +x (forward) when the leg hangs
 * straight down (u = (0,1) -> p = (1,0)).
 */
export function kneePerpendicular(u, bendSign = 1) {
  const s = bendSign >= 0 ? 1 : -1;
  return { x: u.y * s, y: -u.x * s };
}

/**
 * Solve two-bone IK with the foot frozen at an exact world pin.
 * Stance feet never move: the returned ankle IS the pin (0.00 px
 * slip by construction; the caller verifies it on pixels).
 *
 * Front-view Z-bend attenuation (V4 lesson: front knees bent
 * sideways): at legYaw 0 the knee bends toward the camera, not
 * sideways, so the solved knee blends toward the straight midpoint
 * lerp(hip, foot, 0.5) by sideBlend = smoothstep(|legYaw| / 0.55).
 *
 * @param {{x:number,y:number}} hip hip pivot, scene px
 * @param {{x:number,y:number}} footPin frozen world foot target, scene px
 * @param {number} L1 upper-leg length px
 * @param {number} L2 lower-leg length px
 * @param {object} [opts] {bendSign: +1 forward (default), legYaw: 0}
 * @returns {{knee:{x,y}, ankle:{x,y}, reached:boolean, kneeAngleDeg:number, sideBlend:number}}
 *   kneeAngleDeg is the bend off the hip-ankle line (0 = straight).
 */
export function solve3DFootLockedIK(hip, footPin, L1, L2, opts = {}) {
  if (!(L1 > 0 && L2 > 0)) throw new Error("ARM_LENGTH: L1 and L2 must be > 0");
  const bendSign = opts.bendSign ?? 1;
  const legYaw = opts.legYaw ?? 0;
  if (typeof legYaw !== "number" || legYaw < -1 || legYaw > 1) {
    throw new Error(`IK_3D: legYaw must be -1 to 1, got ${legYaw}`);
  }
  const dx = footPin.x - hip.x;
  const dy = footPin.y - hip.y;
  const dOrig = Math.hypot(dx, dy);
  const maxD = L1 + L2;
  const minD = Math.abs(L1 - L2);
  let d = dOrig;
  let reached = true;
  if (dOrig > maxD) {
    d = maxD;
    reached = false;
  } else if (dOrig < minD) {
    d = minD;
    reached = false;
  }
  // The ankle is the pin, clamped only when unreachable; a reachable
  // pin is returned exactly, so stance slip is 0.00 px.
  const ux = dOrig < 1e-9 ? 0 : dx / dOrig;
  const uy = dOrig < 1e-9 ? 1 : dy / dOrig;
  const ankle = reached
    ? { x: fmt3(footPin.x), y: fmt3(footPin.y) }
    : { x: fmt3(hip.x + ux * d), y: fmt3(hip.y + uy * d) };
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const p = kneePerpendicular({ x: ux, y: uy }, bendSign);
  const midX = hip.x + ux * a;
  const midY = hip.y + uy * a;
  const solvedKnee = { x: midX + p.x * h, y: midY + p.y * h };
  // Z-bend attenuation: blend the solved knee toward the straight
  // midpoint as |legYaw| falls to 0.
  const sideBlend = fmt3(smoothstep01(Math.abs(legYaw) / 0.55));
  const straightMid = { x: (hip.x + ankle.x) / 2, y: (hip.y + ankle.y) / 2 };
  const knee = {
    x: fmt3(straightMid.x + (solvedKnee.x - straightMid.x) * sideBlend),
    y: fmt3(straightMid.y + (solvedKnee.y - straightMid.y) * sideBlend),
  };
  const kneeAngleDeg = fmt3((Math.atan2(h, Math.abs(a)) * 180) / Math.PI);
  return { knee, ankle, reached, kneeAngleDeg, sideBlend };
}

/**
 * Equal bone lengths for a resting stance knee ease: the knee bends
 * easeDeg off the hip-ankle line (blueprint: 12-16 deg forward ease).
 * L1 = L2 = (d / 2) / cos(ease). Note: the blueprint's 1.07-1.10x
 * bone-sum figure gives ~22 deg; this helper is the one that lands
 * the stated 12-16 deg resting ease.
 */
export function restingLegLengths(hipToAnkle, easeDeg = 14) {
  if (!(hipToAnkle > 0)) throw new Error("IK_3D: hipToAnkle must be > 0");
  const L = hipToAnkle / 2 / Math.cos((easeDeg * Math.PI) / 180);
  return { L1: fmt3(L), L2: fmt3(L), sumRatio: fmt3((2 * L) / hipToAnkle) };
}

const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const vscale = (a, s) => ({ x: a.x * s, y: a.y * s });
const vlen = (a) => Math.hypot(a.x, a.y) || 1;
const vunit = (a) => {
  const l = vlen(a);
  return { x: a.x / l, y: a.y / l };
};
const vnorm = (a) => ({ x: -a.y, y: a.x });

/**
 * Open Catmull-Rom through points, emitted as cubic Bezier segments
 * only (no leading M): the caller supplies the moveto. Used for one
 * side of a ball-joint limb; the two sides share the joint tangent,
 * so no L corner appears at the knee or elbow.
 */
function catmullRomOpen(pts) {
  const p = pts.map((q) => [q.x, q.y]);
  const n = p.length;
  const get = (i) => p[Math.max(0, Math.min(n - 1, i))];
  let d = "";
  for (let s = 0; s < n - 1; s++) {
    const p0 = get(s - 1);
    const p1 = get(s);
    const p2 = get(s + 1);
    const p3 = get(s + 2);
    d += ` C ${fmtNum(p1[0] + (p2[0] - p0[0]) / 6)},${fmtNum(p1[1] + (p2[1] - p0[1]) / 6)} ${fmtNum(p2[0] - (p3[0] - p1[0]) / 6)},${fmtNum(p2[1] - (p3[1] - p1[1]) / 6)} ${fmtNum(p2[0])},${fmtNum(p2[1])}`;
  }
  return d;
}

function fmtNum(n) {
  return String(Number(Number(n).toFixed(3)));
}

/**
 * Semicircular cap from point A to point B around centre C, as two
 * cubic Beziers (kappa 0.5523), bulging along the unit vector
 * `bulge` (the bone direction past the joint for an end cap, its
 * negation for a start cap). A and B are opposite ends of a
 * diameter through C. Each quarter arc uses the tangent
 * perpendicular to its radius, oriented along the arc, so the cap
 * is tangent-collinear with the bone at both ends: G1 continuity,
 * no spike.
 */
/**
 * Tangent-continuous end cap (V5 law 5, fix round 1 of U5).
 *
 * A single cubic from `from` to `to` that leaves along uFrom (the
 * adjacent side's end tangent) and arrives along uTo (the next
 * side's start tangent), so the outline is C1 at both joins. The
 * first version used a true semicircle cap whose start tangent was
 * the spine tangent: on a bent limb that disagrees with the side's
 * end tangent by half the joint bend (17.8 deg at a 35 deg elbow),
 * and the c0 audit rightly flagged it. The bulge is still ~w/2:
 * with L = 0.66 * |to - from| the cubic's midpoint sits ~0.99r out,
 * a rounded cap that reads the same as the semicircle.
 */
function tangentCap(from, to, uFrom, uTo) {
  const dist = vlen(vsub(to, from));
  const L = 0.66 * dist;
  const p1 = vadd(from, vscale(vunit(uFrom), L));
  const p2 = vsub(to, vscale(vunit(uTo), L));
  return (
    ` C ${fmtNum(p1.x)},${fmtNum(p1.y)}` +
    ` ${fmtNum(p2.x)},${fmtNum(p2.y)}` +
    ` ${fmtNum(to.x)},${fmtNum(to.y)}`
  );
}

/**
 * G1 ball-joint limb (V5 law 5).
 *
 * Every contour starts and ends with a tangent-continuous rounded
 * cap of radius ~width / 2 (blueprint law 5 quotes capHip =
 * wHip * 0.56; this build uses 0.50, a true semicircle's radius,
 * which is 2 px on a 36 px limb and reads the same. Recorded as a
 * deviation in the run report.) The joint itself uses
 * the averaged tangent um = unit(u1 + u2) through the knee/elbow,
 * so the outline is cubic C segments throughout: never a straight
 * L segment, never a sharp spike at a hip or shoulder.
 *
 * @param {Array<{x:number,y:number}>} spine [joint0, joint1, ...] (2+ points)
 * @param {number[]} widths width at each spine point, px
 * @returns {{d:string, left:Array, right:Array}}
 */
export function buildBallJointLimb(spine, widths) {
  if (!Array.isArray(spine) || spine.length < 2) {
    throw new Error("LIMB: spine needs at least 2 points");
  }
  if (!Array.isArray(widths) || widths.length !== spine.length) {
    throw new Error("LIMB: widths must match the spine point for point");
  }
  const n = spine.length;
  // Tangents: ends use the adjacent segment; joints use the averaged
  // tangent um = unit(u1 + u2).
  const tangents = spine.map((_, i) => {
    if (i === 0) return vunit(vsub(spine[1], spine[0]));
    if (i === n - 1) return vunit(vsub(spine[n - 1], spine[n - 2]));
    const u1 = vunit(vsub(spine[i], spine[i - 1]));
    const u2 = vunit(vsub(spine[i + 1], spine[i]));
    return vunit(vadd(u1, u2));
  });
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const normal = vnorm(tangents[i]);
    const hw = widths[i] / 2;
    left.push(vadd(spine[i], vscale(normal, hw)));
    right.push(vadd(spine[i], vscale(normal, -hw)));
  }
  // Left side root -> tip, end cap, right side tip -> root, start cap.
  // The caps are tangent-continuous with the sides (see tangentCap):
  // the end cap leaves along the left side's end tangent and arrives
  // along the right side's start tangent, and the start cap mirrors it.
  const leftD = catmullRomOpen(left);
  const rightD = catmullRomOpen([...right].reverse());
  const endCap = tangentCap(
    left[n - 1],
    right[n - 1],
    vsub(left[n - 1], left[n - 2]),
    vsub(right[n - 2], right[n - 1]),
  );
  const startCap = tangentCap(
    right[0],
    left[0],
    vsub(right[0], right[1]),
    vsub(left[1], left[0]),
  );
  const d = `M ${fmtNum(left[0].x)},${fmtNum(left[0].y)}` + leftD + endCap + rightD + startCap + " Z";
  return { d, left, right };
}

/**
 * 3D front-to-profile paw morph (V5 law 5). Milo feet are 57 px
 * flat-bottom ovals (M22); the morph changes the foot SHAPE with
 * legYaw, never the spec numbers: front is a symmetrical rounded
 * front-facing paw with a flat sole and 2 vertical toe creases;
 * profile tucks the heel behind the ankle, extends the toes
 * forward, and angles the 2 creases. Bounds and creases interpolate
 * across sideFactor.
 *
 * @param {number} legYaw in [-1,1]
 * @param {object} [opts] {footW: 57, footH: 22}
 * @returns {{sideFactor:number, footW:number, footH:number, heelTuck:number, toeExtension:number, creases:Array<{x1,y1,x2,y2}>}}
 *   creases are in foot-local px, origin at the ankle, y down,
 *   x forward (+x is the facing side).
 */
export function pawMorph(legYaw, opts = {}) {
  if (typeof legYaw !== "number" || legYaw < -1 || legYaw > 1) {
    throw new Error(`PAW: legYaw must be -1 to 1, got ${legYaw}`);
  }
  const sideFactor = fmt3(smoothstep01(Math.abs(legYaw) / 0.55));
  const footW = opts.footW ?? 57;
  const footH = opts.footH ?? 22;
  const dir = legYaw >= 0 ? 1 : -1;
  // Heel tucks behind the ankle as the foot turns to profile;
  // toes extend forward. Both in px, interpolated by sideFactor.
  const heelTuck = fmt3(10 * sideFactor);
  const toeExtension = fmt3(12 * sideFactor);
  const creases = [];
  if (sideFactor <= 0.5) {
    // Front: 2 creases fanning outward from vertical (V6: the fan
    // opens as yaw goes to 0, 20 deg at full front, so the toes read
    // as fanning toward the viewer; at sideFactor 0.5 the fan has
    // closed to vertical).
    const fanDx = (footH * 0.45) * Math.tan((20 * Math.PI) / 180) * (1 - sideFactor * 2);
    for (const s of [-1, 1]) {
      creases.push({ x1: s * footW * 0.18, y1: -footH * 0.35, x2: s * footW * 0.18 + s * fanDx, y2: footH * 0.1 });
    }
  } else {
    // Profile: 2 angled creases leaning forward.
    for (const s of [0.05, 0.35]) {
      creases.push({ x1: dir * footW * s, y1: -footH * 0.35, x2: dir * footW * (s + 0.12), y2: footH * 0.1 });
    }
  }
  return { sideFactor, footW, footH, heelTuck, toeExtension, creases, dir };
}

/**
 * Foot outline path from the paw morph: a flat-bottom oval in front
 * view, heel-tucked and toe-extended in profile. The flat sole sits
 * at footBottomY; the ankle is the top centre of the foot.
 */
export function footPath(ankle, footBottomY, legYaw, opts = {}) {
  const m = pawMorph(legYaw, opts);
  const footW = m.footW;
  const footH = m.footH;
  const cx = ankle.x + m.dir * (m.toeExtension - m.heelTuck) / 2;
  const topY = footBottomY - footH;
  const k = 0.5522847498;
  const rx = footW / 2;
  const ry = footH / 2;
  const cy = topY + ry;
  // V6 standing-3d: yaw-weighted forward toe bulge. Facing the
  // viewer (sideFactor 0) the toe end reads wider than the heel
  // end, so the paw points at the viewer; at profile the bulge is
  // gone and the toe extends forward instead (toeExtension).
  const bottomRx = rx + 2 * (1 - m.sideFactor);
  // Flat-bottom oval: bezier dome on top, straight sole at the
  // bottom. Turnout is a SHEAR about the sole line, not a rotation
  // about the ankle: a real turned-out foot keeps its sole flat on
  // the ground while the instep leans outward. A rotation tilted
  // the sole and drove one corner 6 px through the ground line, and
  // moved the foot's centre 3 px off the pin (the slip gate caught
  // it). The shear leaves the sole line fixed and shifts the top
  // outward by footH * tan(turnout).
  const side = opts.side ?? "right";
  const turnoutDeg = opts.turnoutDeg ?? 12;
  const sgn = side === "left" ? -1 : 1;
  const shear = Math.tan((turnoutDeg * Math.PI) / 180) * sgn;
  const P = (x, y) => `${fmtNum(x + (footBottomY - y) * shear)},${fmtNum(y)}`;
  const d =
    `M ${P(cx - rx, cy)}` +
    ` C ${P(cx - rx, cy - ry * k * 2)} ${P(cx - rx * k, topY)} ${P(cx, topY)}` +
    ` C ${P(cx + rx * k, topY)} ${P(cx + rx, cy - ry * k * 2)} ${P(cx + rx, cy)}` +
    ` L ${P(cx + bottomRx, footBottomY)}` +
    ` L ${P(cx - bottomRx, footBottomY)} Z`;
  return { d, ...m, cx: fmt3(cx), topY: fmt3(topY), turnoutDeg, bottomRx: fmt3(bottomRx) };
}

// ---------------------------------------------------------------------
// V6 3-mode foot projection (added to the V5 run 2026-11-19, approved
// by Richardson). Milo numbers throughout: feet 57 px flat-bottom
// ovals (M22), belly 92x112 (M12-M13). Three modes:
//   standing-3d: footPath above (turnout + toe bulge + fanned notches)
//   seated-front: plump pads anchored to the lower belly corners
//   seated-folded: solid cushions, haunch + thigh-to-paw bean
// The V6 speed engine (Direct Canvas2D / Skia) is HELD, not built
// here: a renderer swap mid-run would break the drawing proof.
// ---------------------------------------------------------------------

/**
 * Seated-front paw pad (V6 mode 2).
 *
 * Two plump outward-angled (~20 deg) rounded paw pads anchored to
 * the lower belly corners, with a sole pad and 3 tiny toe beans.
 * No splayed stick legs: the legs are tucked under the body and only
 * the pads show. No dark tube across the belly: the pads sit ON the
 * belly corners, never crossing it.
 *
 * @param {{cx:number,cy:number,rx:number,ry:number}} belly belly ellipse, figure px
 * @param {number} side -1 left, +1 right
 * @param {object} [opts] {drop: 0, padW: 44, padH: 28}
 * @returns {{padD:string, soleD:string, beans:Array<{x:number,y:number,r:number}>, centre:{x:number,y:number}, soleBottomY:number}}
 *   All coordinates in figure px. Beans are pink (#fc978e, the nose
 *   colour); the sole pad is a deeper orange.
 */
export function seatedFrontPaw(belly, side, opts = {}) {
  const sgn = side >= 0 ? 1 : -1;
  const drop = opts.drop ?? 0;
  const padW = opts.padW ?? 44;
  const padH = opts.padH ?? 28;
  const angleDeg = sgn * 20;
  const cx = belly.cx + sgn * belly.rx * 0.72;
  const cy = belly.cy + belly.ry * 0.82 + drop * 0.2;
  const padD = rotatedEllipseD(cx, cy, padW / 2, padH / 2, angleDeg);
  // Sole pad: a smaller ellipse in the pad's lower half.
  const soleCx = cx + sgn * 4;
  const soleCy = cy + padH * 0.18;
  const soleD = rotatedEllipseD(soleCx, soleCy, padW * 0.28, padH * 0.22, angleDeg);
  // 3 tiny toe beans fanned across the pad's front (lower) edge.
  const beans = [];
  for (const [off, lift] of [[-1, 0], [0, -3], [1, 0]]) {
    const bx = cx + sgn * off * padW * 0.26;
    const by = cy + padH * 0.32 + lift;
    beans.push({ x: fmt3(bx), y: fmt3(by), r: 3.5 });
  }
  return {
    padD,
    soleD,
    beans,
    centre: { x: fmt3(cx), y: fmt3(cy) },
    soleBottomY: fmt3(cy + padH / 2),
  };
}

/**
 * Seated-folded cushions (V6 mode 3).
 *
 * A solid plush far haunch cushion plus a sweeping near folded
 * thigh-to-paw bean, a tucked sole pad with 3 toe beans, and one
 * crisp overlap crease where the bean crosses the haunch. The shapes
 * overlap each other and the trunk with no background gaps: zero
 * blanket or floor leaks through.
 *
 * @param {object} opts {hip:{x,y}, belly, side, drop}
 * @returns {{haunchD:string, beanD:string, soleD:string, beans:Array, creaseD:string, paw:{x:number,y:number}}}
 */
export function seatedFolded(hip, belly, opts = {}) {
  const drop = opts.drop ?? 0;
  const sgn = (opts.side ?? 1) >= 0 ? 1 : -1;
  // Far haunch: a plush cushion on the far lower belly corner,
  // tucked behind the belly (the caller draws it before the torso).
  const haunchCx = belly.cx - sgn * belly.rx * 0.62;
  const haunchCy = belly.cy + belly.ry * 0.78;
  const haunchD = rotatedEllipseD(haunchCx, haunchCy, 36, 25, -sgn * 15);
  // Near bean: a sweeping tube from the near hip, out to a folded
  // knee, down to the paw tucked under the belly's near corner.
  const paw = { x: belly.cx + sgn * belly.rx * 0.45, y: belly.cy + belly.ry * 0.95 + drop * 0.2 };
  const knee = { x: hip.x + sgn * 38, y: hip.y + 42 };
  const bean = buildBallJointLimb([hip, knee, paw], [42, 36, 30]);
  // Tucked sole pad at the paw end, with 3 toe beans.
  const soleD = rotatedEllipseD(paw.x, paw.y - 4, 13, 7, sgn * 15);
  const beans = [];
  for (const [off, lift] of [[-1, 0], [0, -3], [1, 0]]) {
    beans.push({ x: fmt3(paw.x + off * 9), y: fmt3(paw.y + 2 + lift), r: 3 });
  }
  // One crisp overlap crease: where the bean crosses the haunch edge.
  const creaseD =
    `M ${fmtNum(knee.x - sgn * 14)},${fmtNum(knee.y + 6)}` +
    ` Q ${fmtNum((knee.x + paw.x) / 2)},${fmtNum((knee.y + paw.y) / 2 + 10)}` +
    ` ${fmtNum(paw.x - sgn * 10)},${fmtNum(paw.y - 2)}`;
  return {
    haunchD,
    beanD: bean.d,
    soleD,
    beans,
    creaseD,
    paw: { x: fmt3(paw.x), y: fmt3(paw.y) },
  };
}

/** Ellipse as cubic Beziers, rotated about its centre by deg. */
export function rotatedEllipseD(cx, cy, rx, ry, deg = 0) {
  const k = 0.5522847498;
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const rot = ([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  const P = (x, y) => {
    const [a, b] = rot([x, y]);
    return `${fmtNum(a)},${fmtNum(b)}`;
  };
  return (
    `M ${P(cx, cy - ry)}` +
    ` C ${P(cx + rx * k, cy - ry)} ${P(cx + rx, cy - ry * k)} ${P(cx + rx, cy)}` +
    ` C ${P(cx + rx, cy + ry * k)} ${P(cx + rx * k, cy + ry)} ${P(cx, cy + ry)}` +
    ` C ${P(cx - rx * k, cy + ry)} ${P(cx - rx, cy + ry * k)} ${P(cx - rx, cy)}` +
    ` C ${P(cx - rx, cy - ry * k)} ${P(cx - rx * k, cy - ry)} ${P(cx, cy - ry)} Z`
  );
}
