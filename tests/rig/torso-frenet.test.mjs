// U1 tests: V5 torso Frenet + head 3D. Numbers from the spec and
// the blueprint, checked against the modules' own outputs, not
// against a second copy of the same arithmetic.
import test from "node:test";
import assert from "node:assert/strict";
import { torsoFrenet, bellyInSpineSpace, pearRaw, smoothstep } from "../../src/rig/torso-frenet.mjs";
import { headWidthCurve, headGeometry, skullPathD, earPathD } from "../../src/rig/head-3d.mjs";

const close = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

test("torso: front yaw reads max width 128, turnScale 1", () => {
  const t = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0 });
  assert.ok(close(t.maxWidth, 128, 0.6), `maxWidth ${t.maxWidth} != 128`);
  assert.equal(t.turnScale, 1);
  assert.equal(t.tailVisible, false);
});

test("torso: full yaw narrows to 0.76 and shows the tail", () => {
  const t = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 1 });
  assert.ok(close(t.turnScale, 0.76, 0.01));
  assert.ok(close(t.maxWidth, 128 * 0.76, 0.6));
  assert.equal(t.tailVisible, true);
  const t2 = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0.2 });
  assert.equal(t2.tailVisible, false);
  const t3 = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0.23 });
  assert.equal(t3.tailVisible, true);
});

test("torso: outline is all cubics, no straight segments, poles closed", () => {
  const t = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0.4 });
  assert.ok(!/\bL\b/.test(t.d), "torso path must have no L segments");
  assert.ok(t.d.endsWith(" Z"));
  assert.equal(t.points.length, 26);
  // Poles pinch to the spine: half-width 0 at t=0 and t=1.
  assert.ok(close(t.halfWidth(0), 0, 0.01));
  assert.ok(close(t.halfWidth(1), 0, 0.01));
  const front = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0 });
  assert.ok(front.halfWidth(0.5) > 60, "mid torso must be near full width");
});

test("torso: sockets sit inside the outline at t 0.24 and 0.84", () => {
  const t = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0 });
  for (const key of ["nearShoulder", "farShoulder", "nearHip", "farHip"]) {
    const s = t.sockets[key];
    assert.ok(Math.abs(s.x) < 64, `${key} x ${s.x} outside torso`);
  }
  assert.ok(t.sockets.nearShoulder.y < t.sockets.nearHip.y, "shoulders above hips");
  assert.ok(t.sockets.nearShoulder.y > -280 && t.sockets.nearHip.y < -86);
});

test("torso: spine lean moves the neck forward (+x), curve shifts the mid", () => {
  const a = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0 });
  const b = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0, spineLeanDeg: 10 });
  assert.ok(b.spine(0).x > a.spine(0).x, "positive lean must move the neck toward +x (forward)");
  const c = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0, spineCurveX: 20 });
  assert.ok(c.spine(0.5).x > a.spine(0.5).x, "spineCurveX must shift the mid-spine");
});

test("torso: belly foreshortens 92 / 60 / 29 by yaw", () => {
  const mk = (yaw) => {
    const t = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: yaw });
    return bellyInSpineSpace(t, { torsoYaw: yaw });
  };
  assert.ok(close(mk(0).w, 92, 0.6), `belly front ${mk(0).w}`);
  assert.ok(close(mk(0.55).w, 60, 1.5), `belly 3/4 ${mk(0.55).w}`);
  assert.ok(close(mk(1).w, 29, 1.5), `belly profile ${mk(1).w}`);
  assert.ok(close(mk(0).h, 112, 0.6));
});

test("torso: yaw out of range throws", () => {
  assert.throws(() => torsoFrenet({ torsoYaw: 1.2 }), /TORSO_FRENENT/);
});

test("head: width curve reads 217 / 182 / 169 within 2 px", () => {
  assert.ok(close(headWidthCurve(0), 217, 0.1));
  assert.ok(close(headWidthCurve(0.55), 182, 0.1));
  assert.ok(close(headWidthCurve(1), 169, 0.1));
  assert.ok(close(headWidthCurve(-1), 169, 0.1));
  assert.throws(() => headWidthCurve(1.5), /HEAD_3D/);
});

test("head: snout extrudes toward the facing side, eyes foreshorten", () => {
  const g = headGeometry({ cx: 0, cy: 0, headYaw: 1 });
  assert.ok(g.snoutCx > 0, "profile snout must sit on the facing (+x) side");
  assert.ok(g.eyeFar.visible === false, "far eye hidden at full profile");
  assert.ok(g.eyeNear.r >= 4.3 && g.eyeNear.r <= 6, `near eye r ${g.eyeNear.r}`);
  const f = headGeometry({ cx: 0, cy: 0, headYaw: 0 });
  assert.equal(f.snoutCx, 0);
  assert.equal(f.eyeFar.visible, true);
  assert.equal(f.eyeNear.r, 6);
});

test("head: both ears sit behind the skull (base above centre, y -ry*0.84)", () => {
  const g = headGeometry({ cx: 100, cy: 200, headYaw: 0.55 });
  for (const key of ["near", "far"]) {
    const e = g.ears[key];
    assert.ok(e.baseY < g.cy, `${key} ear base must sit above the head centre`);
    assert.ok(close(e.baseY, g.cy - g.ry * 0.84, 1.5), `${key} ear base y ${e.baseY}`);
    assert.ok(e.tipY < e.baseY, "ear tip above its base");
  }
  const d = earPathD(g.ears.near);
  assert.ok(d.startsWith("M ") && d.endsWith(" Z"));
});

test("head: skull path is a closed bezier ellipse front, anchored profile", () => {
  const front = skullPathD({ cx: 0, cy: 0, headYaw: 0 });
  assert.ok(front.d.includes("C") && front.d.endsWith(" Z"));
  assert.equal(front.w, 217);
  const prof = skullPathD({ cx: 0, cy: 0, headYaw: 1 });
  assert.equal(prof.view, "profile");
  assert.equal(prof.w, 169);
  assert.ok(prof.d.includes("C"));
});

test("pear outline is C1: Bezier join tangents agree within 8 deg", () => {
  // The C0 audit (blueprint law 7) measures tangent discontinuity
  // across the emitted cubic Bezier joins, not chord turns of the
  // sampled anchors: near the poles the anchors bunch, so chords
  // turn fast while the curve stays smooth. Parse the C segments
  // and compare each segment's end tangent with the next one's
  // start tangent. Catmull-Rom shares tangents at anchors, so the
  // gap must be ~0 (rounding only).
  const t = torsoFrenet({ cx: 0, topY: -280, bottomY: -86, halfW: 64, torsoYaw: 0.3 });
  const segs = [...t.d.matchAll(/C ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)/g)].map((m) => m.slice(1).map(Number));
  assert.ok(segs.length === 26, `expected 26 cubic segments, got ${segs.length}`);
  const angleBetween = (a, b) => {
    const d = Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]);
    let dd = Math.abs(d);
    if (dd > Math.PI) dd = 2 * Math.PI - dd;
    return (dd * 180) / Math.PI;
  };
  for (let i = 0; i < segs.length; i++) {
    const cur = segs[i];
    const nxt = segs[(i + 1) % segs.length];
    // End tangent of cur: end point minus second control point.
    const endTan = [cur[4] - cur[2], cur[5] - cur[3]];
    // Start tangent of next: first control point minus its start
    // point, which is cur's end point.
    const startTan = [nxt[0] - cur[4], nxt[1] - cur[5]];
    const gap = angleBetween(endTan, startTan);
    assert.ok(gap < 8, `Bezier join tangent gap ${gap.toFixed(2)} deg at segment ${i}`);
  }
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
});

test("torso: stadium profile keeps 128 across the visible band", () => {
  const t = torsoFrenet({ cx: 0, topY: -296, bottomY: -86, halfW: 64, torsoYaw: 0, profile: "stadium" });
  assert.ok(close(t.maxWidth, 128, 0.6));
  // Measurement band M8 (figure y -129 to -105) is t 0.80-0.91 here.
  for (const tt of [0.8, 0.85, 0.9]) {
    assert.ok(close(2 * t.halfWidth(tt), 128, 1.0), `stadium width at t=${tt} is ${2 * t.halfWidth(tt)}, not 128`);
  }
  // And it still pinches to the spine at the poles (C1 closure).
  assert.ok(close(t.halfWidth(0), 0, 0.01));
  assert.ok(close(t.halfWidth(1), 0, 0.01));
  assert.throws(() => torsoFrenet({ profile: "banana" }), /TORSO_FRENENT/);
});

test("torso: belly centre sits at figure y -145.5 (spineT 0.72)", () => {
  const t = torsoFrenet({ cx: 0, topY: -296, bottomY: -86, halfW: 64, torsoYaw: 0, profile: "stadium" });
  const b = bellyInSpineSpace(t, { torsoYaw: 0 });
  assert.ok(close(b.cy, -145.5, 2), `belly cy ${b.cy} != -145.5`);
  assert.ok(close(b.w, 92, 0.6));
  assert.ok(close(b.h, 112, 0.6));
});

test("head: superellipse skull stays full at the eye row (M4: longest span on the eye row)", () => {
  // Sample every cubic in the emitted skull path; the widest x at
  // |y - cy| in [12, 16] (the eye row sits 14 px above centre) must
  // read within 2 px of the full 217. A bezier ellipse reads ~215
  // there; the model sheet reads its longest span on that row.
  const cubic = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  };
  const { d } = skullPathD({ cx: 0, cy: 0, headYaw: 0 });
  const segs = [...d.matchAll(/C ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)/g)].map((m) => m.slice(1).map(Number));
  const m = d.match(/M ([-\d.]+),([-\d.]+)/);
  let cur = [Number(m[1]), Number(m[2])];
  let widest = 0;
  for (const s of segs) {
    const p0 = cur;
    const p1 = [s[0], s[1]];
    const p2 = [s[2], s[3]];
    const p3 = [s[4], s[5]];
    for (let i = 0; i <= 20; i++) {
      const [x, y] = cubic(p0, p1, p2, p3, i / 20);
      if (Math.abs(y) >= 12 && Math.abs(y) <= 16) widest = Math.max(widest, Math.abs(x));
    }
    cur = p3;
  }
  assert.ok(widest >= 106.5, `eye-row half-width ${widest.toFixed(1)} must be within 2 px of 108.5`);
  assert.ok(widest <= 108.5, `eye-row half-width ${widest.toFixed(1)} must not exceed the equator`);
});
