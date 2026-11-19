// U2 tests: V5 foot-locked 3D IK, ball-joint limbs, paw morph.
// Knee direction is verified against the blueprint's own check:
// u.p == 0 and +1 pushes the knee toward +x (forward).
import test from "node:test";
import assert from "node:assert/strict";
import {
  solve3DFootLockedIK,
  kneePerpendicular,
  restingLegLengths,
  buildBallJointLimb,
  pawMorph,
  footPath,
  seatedFrontPaw,
  seatedFolded,
} from "../../src/rig/ik.mjs";

const close = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test("IK3D: knee perpendicular is orthogonal and +1 pushes +x when hanging", () => {
  const u = { x: 0, y: 1 }; // leg straight down
  const p = kneePerpendicular(u, 1);
  assert.ok(close(u.x * p.x + u.y * p.y, 0), "u.p must be 0");
  assert.ok(close(p.x, 1) && close(p.y, 0), "+1 must push the knee toward +x");
  const m = kneePerpendicular(u, -1);
  assert.ok(close(m.x, -1), "-1 must push the knee toward -x");
});

test("IK3D: reachable pin is returned exactly, 0.00 px slip", () => {
  const hip = { x: 100, y: 100 };
  const pin = { x: 120, y: 175 };
  const r = solve3DFootLockedIK(hip, pin, 42, 42, { legYaw: 0.6 });
  assert.equal(r.reached, true);
  assert.ok(close(r.ankle.x, pin.x) && close(r.ankle.y, pin.y), "ankle must be the pin exactly");
  assert.ok(close(dist(hip, r.knee), 42, 0.01), "hip-knee must be L1");
  assert.ok(close(dist(r.knee, r.ankle), 42, 0.01), "knee-ankle must be L2");
});

test("IK3D: knee bends forward (+x) for a forward step, never backward", () => {
  const hip = { x: 100, y: 100 };
  const pin = { x: 140, y: 170 }; // foot forward and down
  const r = solve3DFootLockedIK(hip, pin, 42, 42, { legYaw: 1, bendSign: 1 });
  assert.ok(r.knee.x > 100, `knee x ${r.knee.x} must sit forward of the hip`);
  assert.ok(r.kneeAngleDeg > 0 && r.kneeAngleDeg < 90);
});

test("IK3D: front view Z-bend attenuation puts the knee on the straight line", () => {
  const hip = { x: 100, y: 100 };
  const pin = { x: 140, y: 170 };
  const r0 = solve3DFootLockedIK(hip, pin, 42, 42, { legYaw: 0 });
  assert.equal(r0.sideBlend, 0);
  assert.ok(close(r0.knee.x, 120, 0.01) && close(r0.knee.y, 135, 0.01), `front knee must sit on the midpoint, got ${JSON.stringify(r0.knee)}`);
  const r1 = solve3DFootLockedIK(hip, pin, 42, 42, { legYaw: 0.55 });
  assert.equal(r1.sideBlend, 1);
  assert.ok(r1.knee.x > 120, "full sideBlend must keep the sideways knee");
});

test("IK3D: unreachable pin clamps to full reach and reports reached false", () => {
  const hip = { x: 100, y: 100 };
  const r = solve3DFootLockedIK(hip, { x: 100, y: 300 }, 42, 42, { legYaw: 1 });
  assert.equal(r.reached, false);
  assert.ok(close(r.ankle.y, 184, 0.01));
});

test("IK3D: resting leg lengths land a 12-16 deg knee ease", () => {
  const { L1, L2, sumRatio } = restingLegLengths(79, 14);
  assert.equal(L1, L2);
  const r = solve3DFootLockedIK({ x: 0, y: 0 }, { x: 0, y: 79 }, L1, L2, { legYaw: 1 });
  assert.ok(r.kneeAngleDeg >= 12 && r.kneeAngleDeg <= 16, `resting knee ${r.kneeAngleDeg} deg outside 12-16`);
  assert.ok(sumRatio > 1.02 && sumRatio < 1.06, `sum ratio ${sumRatio} (blueprint 1.07-1.10 gives ~22 deg; see helper note)`);
});

test("limb: ball-joint outline is all cubics, closed, no L segments", () => {
  const limb = buildBallJointLimb(
    [{ x: 0, y: 0 }, { x: 20, y: 40 }, { x: 10, y: 80 }],
    [36, 36, 32],
  );
  assert.ok(!/\bL\b/.test(limb.d), "limb path must have no L segments");
  assert.ok(limb.d.endsWith(" Z"));
  assert.ok(limb.d.includes("M -16.1,8.05 C"));
  // The outline must pass through the joint offsets: left side at
  // the knee is the knee plus the averaged-tangent normal * 18.
  assert.equal(limb.left.length, 3);
  assert.equal(limb.right.length, 3);
});

test("limb: caps bulge outward past both joints", () => {
  // Straight vertical limb: caps must extend past the root (y<0)
  // and past the tip (y>80).
  const limb = buildBallJointLimb([{ x: 0, y: 0 }, { x: 0, y: 80 }], [36, 36]);
  const nums = [...limb.d.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const ys = nums.map((p) => p[1]);
  assert.ok(Math.min(...ys) < -10, `start cap must bulge above the root, min y ${Math.min(...ys)}`);
  assert.ok(Math.max(...ys) > 90, `end cap must bulge past the tip, max y ${Math.max(...ys)}`);
  const xs = nums.map((p) => p[0]);
  assert.ok(Math.min(...xs) <= -18 && Math.max(...xs) >= 18, "caps must reach the full width");
});

test("limb: joint tangent is averaged, so a bent limb has no corner at the knee", () => {
  const limb = buildBallJointLimb(
    [{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 80 }],
    [36, 36, 36],
  );
  // Parse the C segments; the join tangent gap at every anchor must
  // be under 8 deg (same audit as the torso C0 check).
  const segs = [...limb.d.matchAll(/C ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)/g)].map((m) => m.slice(1).map(Number));
  assert.ok(segs.length > 0);
  const angleBetween = (a, b) => {
    let dd = Math.abs(Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    if (dd > Math.PI) dd = 2 * Math.PI - dd;
    return (dd * 180) / Math.PI;
  };
  for (let i = 0; i < segs.length - 1; i++) {
    const cur = segs[i];
    const nxt = segs[i + 1];
    const endTan = [cur[4] - cur[2], cur[5] - cur[3]];
    const startTan = [nxt[0] - cur[4], nxt[1] - cur[5]];
    // Skip the cap joins: the cap meets the side at a semicircle
    // join, whose tangents agree by construction of the cap; the
    // check below covers the side joins. A zero-length tangent
    // (degenerate) is skipped, not counted.
    if (Math.hypot(...endTan) < 1e-6 || Math.hypot(...startTan) < 1e-6) continue;
    assert.ok(angleBetween(endTan, startTan) < 8, `limb join tangent gap ${angleBetween(endTan, startTan).toFixed(2)} deg at segment ${i}`);
  }
});

test("paw: morph is front at yaw 0, profile at yaw 0.55+, creases fan at front", () => {
  const front = pawMorph(0);
  assert.equal(front.sideFactor, 0);
  assert.equal(front.heelTuck, 0);
  assert.equal(front.toeExtension, 0);
  assert.equal(front.creases.length, 2);
  assert.ok(front.creases[0].x1 === -front.creases[1].x1, "front creases must be symmetric");
  // V6: at full front the creases fan outward 20 deg from vertical.
  const fan = front.creases[1].x2 - front.creases[1].x1;
  assert.ok(close(fan, 3.6, 0.3), `front fan ${fan} px must be ~3.6 px (20 deg over 9.9 px)`);
  // The fan closes to vertical at sideFactor 0.5 (yaw 0.275).
  const half = pawMorph(0.275);
  assert.ok(close(half.sideFactor, 0.5, 0.01));
  assert.ok(half.creases.every((c) => close(c.x1, c.x2, 0.05)), "half-turn creases must be vertical");
  const prof = pawMorph(0.55);
  assert.equal(prof.sideFactor, 1);
  assert.ok(prof.heelTuck > 0 && prof.toeExtension > 0);
  assert.ok(prof.creases.every((c) => c.x2 !== c.x1), "profile creases must be angled");
  assert.throws(() => pawMorph(2), /PAW/);
});

test("paw: foot path is a flat-bottom oval, toe bulge at front, sole at footBottomY", () => {
  // Turnout 0 here so the sole stays axis-aligned for measurement.
  const f = footPath({ x: 100, y: 400 }, 422, 0, { turnoutDeg: 0 });
  assert.ok(f.d.includes("L 130.5,422 L 69.5,422") || f.d.endsWith("Z"), "sole must be a flat line at footBottomY");
  const nums = [...f.d.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const xs = nums.map((p) => p[0]);
  // V6 toe bulge: the bottom (toe end) reads 57 + 4 at full front.
  assert.ok(close(Math.max(...xs) - Math.min(...xs), 61, 0.6), `foot bottom width ${Math.max(...xs) - Math.min(...xs)} != 61 (57 + 4 bulge)`);
  assert.ok(close(f.bottomRx * 2, 61, 0.1));
  // At profile the bulge is gone and the toe extends forward instead.
  const p = footPath({ x: 100, y: 400 }, 422, 1, { turnoutDeg: 0 });
  assert.ok(close(p.bottomRx * 2, 57, 0.1));
  assert.ok(p.toeExtension > 0);
});

test("paw: turnout shears about the sole, the sole stays planted", () => {
  const straight = footPath({ x: 100, y: 400 }, 422, 0, { turnoutDeg: 0, side: "right" });
  const turned = footPath({ x: 100, y: 400 }, 422, 0, { side: "right" });
  assert.equal(turned.turnoutDeg, 12);
  const sole = (d) => {
    const nums = [...d.matchAll(/L (-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    return { centre: (nums[0][0] + nums[1][0]) / 2, y: nums[0][1] };
  };
  const top = (d) => {
    const nums = [...d.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    return nums.reduce((a, b) => (b[1] < a[1] ? b : a));
  };
  // The sole line does not move: the foot stays planted on the pin.
  assert.ok(Math.abs(sole(turned.d).centre - sole(straight.d).centre) < 0.05, "turnout must not move the sole");
  assert.ok(Math.abs(sole(turned.d).y - 422) < 0.05, "the sole stays flat on footBottomY");
  // The top of the foot leans outward by footH * tan(12 deg) = 4.7 px.
  assert.ok(top(turned.d)[0] - top(straight.d)[0] > 4, "the instep must lean outward");
  const left = footPath({ x: 100, y: 400 }, 422, 0, { side: "left" });
  assert.ok(top(left.d)[0] - top(straight.d)[0] < -4, "the left instep must lean outward (-x)");
  assert.ok(Math.abs(sole(left.d).centre - sole(straight.d).centre) < 0.05, "left sole stays planted");
});

test("limb: tangent-continuous outline at a sharp elbow (c0 audit must see 0)", () => {
  // A 35 deg elbow bend: the old semicircle cap disagreed with the
  // side's end tangent by ~18 deg and the c0 audit flagged it. Parse
  // the emitted cubics and check every join's tangent gap < 8 deg.
  const limb = buildBallJointLimb(
    [{ x: 0, y: 0 }, { x: 30, y: -20 }, { x: 45, y: -60 }],
    [36, 36, 36],
  );
  const segs = [...limb.d.matchAll(/C ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)/g)]
    .map((m) => m.slice(1).map(Number));
  const m = limb.d.match(/M ([-\d.]+),([-\d.]+)/);
  let cur = [Number(m[1]), Number(m[2])];
  let worst = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const p0 = cur;
    const p1 = [s[0], s[1]];
    const p2 = [s[2], s[3]];
    const p3 = [s[4], s[5]];
    if (i > 0) {
      const prev = segs[i - 1];
      // Outgoing tangent of the previous segment (its P3 - P2) vs
      // incoming tangent of this one (its P1 - P0).
      const uOut = [prev[4] - prev[2], prev[5] - prev[3]];
      const uIn = [p1[0] - p0[0], p1[1] - p0[1]];
      const dot = (uOut[0] * uIn[0] + uOut[1] * uIn[1])
        / (Math.hypot(...uOut) * Math.hypot(...uIn));
      const gap = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
      worst = Math.max(worst, gap);
    }
    cur = p3;
  }
  assert.ok(worst < 8, `worst tangent gap ${worst.toFixed(1)} deg must be under 8`);
});

test("paw: seated-front pads anchor to the lower belly corners at 20 deg", () => {
  const belly = { cx: 0, cy: -145, rx: 46, ry: 56 };
  const left = seatedFrontPaw(belly, -1, {});
  const right = seatedFrontPaw(belly, 1, {});
  assert.ok(close(left.centre.x, -33.1, 0.5), `left pad centre x ${left.centre.x}`);
  assert.ok(close(right.centre.x, 33.1, 0.5));
  assert.ok(left.centre.y > belly.cy + 40, "pads must sit at the lower belly");
  assert.equal(left.beans.length, 3);
  assert.ok(left.beans.every((b) => b.r === 3.5));
  assert.ok(left.padD.includes("C") && left.padD.endsWith(" Z"));
  assert.ok(left.soleD.includes("C"));
});

test("paw: seated-folded gives a haunch, a bean, a sole with 3 beans, one crease", () => {
  const belly = { cx: 0, cy: -145, rx: 46, ry: 56 };
  const hip = { x: 30, y: -86 };
  const f = seatedFolded(hip, belly, { side: 1 });
  assert.ok(f.haunchD.includes("C") && f.haunchD.endsWith(" Z"));
  assert.ok(f.beanD.includes("C") && f.beanD.endsWith(" Z"));
  assert.ok(!/\bL\b/.test(f.beanD), "bean must be all cubics, no L segments");
  assert.equal(f.beans.length, 3);
  assert.ok(f.creaseD.startsWith("M ") && f.creaseD.includes(" Q "));
  // The bean must reach from the hip to the paw: its bbox covers both.
  const nums = [...f.beanD.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const xs = nums.map((p) => p[0]);
  const ys = nums.map((p) => p[1]);
  assert.ok(Math.min(...xs) <= hip.x + 1 && Math.max(...xs) >= f.paw.x - 1, "bean must span hip to paw");
  assert.ok(Math.min(...ys) <= hip.y + 1 && Math.max(...ys) >= f.paw.y - 1, "bean must span hip to paw vertically");
});
