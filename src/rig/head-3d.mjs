// head-3d.mjs — V5 law 3: analytical 3D spherical head.
//
// Width curve via smoothstep (blueprint law 3): |headYaw| <= 0.55
// lerps 217 -> 182; above 0.55 lerps 182 -> 169. Milo numbers
// (M39-M41), never Bluey eye ratios: Milo eyes are 12 px dots and
// the face is the 11-mark set from src/draw/face.mjs.
//
// Theta = headYaw * 1.08 rad (~62 deg at full profile). Snout is a
// 3D extrusion: snoutCx = sin(theta) * (rx * 0.60 + muzzleDepth *
// 0.46). Eye angles foreshorten by cos(angle): near eye keeps
// [0.72, 1.0] of full width, far eye [0.28, 1.0].
//
// Ear rule (V4 lesson): BOTH ears sit BEHIND the skull path, at
// upper-back cranial coordinates (y approx -ry * 0.84 rel the head
// centre). Never draw a near ear on top of the skull.
//
// Pure and deterministic: no Math.random, no Date, no mutable state.

const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(x) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Head fill width in px at U 128, from the yaw in [-1, 1]. */
export function headWidthCurve(headYaw) {
  if (typeof headYaw !== "number" || headYaw < -1 || headYaw > 1) {
    throw new Error(`HEAD_3D: headYaw must be -1 to 1, got ${headYaw}`);
  }
  const ay = Math.abs(headYaw);
  if (ay <= 0.55) return r1(lerp(217, 182, smoothstep(ay / 0.55)));
  return r1(lerp(182, 169, smoothstep((ay - 0.55) / 0.45)));
}

/** Head height is 216 px in every view (M6, probe B2). */
export const HEAD_HEIGHT = 216;

/** Muzzle depth for the snout extrusion, px (technique log: apex ~28 px past the head edge at the nose row). */
export const MUZZLE_DEPTH = 24;

/**
 * Full 3D head geometry at a head centre.
 * @param {object} opts {cx, cy, headYaw}
 * @returns geometry: w, h, rx, ry, theta, dir, snoutCx, snoutDepth,
 *   eyeNear {x,y,r,visible}, eyeFar, ears {near,far} with base/tip.
 *   Eye x/y are figure px; eye r is the dot radius (6 px front).
 */
export function headGeometry(opts = {}) {
  const cx = opts.cx ?? 0;
  const cy = opts.cy ?? 0;
  const headYaw = opts.headYaw ?? 0;
  if (typeof headYaw !== "number" || headYaw < -1 || headYaw > 1) {
    throw new Error(`HEAD_3D: headYaw must be -1 to 1, got ${headYaw}`);
  }
  const w = headWidthCurve(headYaw);
  const h = HEAD_HEIGHT;
  const rx = w / 2;
  const ry = h / 2;
  const dir = headYaw >= 0 ? 1 : -1;
  const theta = headYaw * 1.08;
  const snoutCx = cx + Math.sin(theta) * (rx * 0.6 + MUZZLE_DEPTH * 0.46);
  const snoutDepth = Math.abs(Math.sin(theta)) * MUZZLE_DEPTH;

  // Eye angles around the facing direction; widths foreshorten by
  // cos(angle), normalised so the front view reads full 6 px dots
  // (M28) and clamped to the blueprint bands: near [0.72, 1.0],
  // far [0.28, 1.0]. Eye x uses sin(angle) scaled so front-view
  // spacing reads 81 px (M30: 0.19H each side).
  const nearAngle = theta - dir * 0.42;
  const farAngle = theta + dir * 0.42;
  const eyeY = cy - 0.065 * w;
  const eyeBaseR = 6;
  const cos0 = Math.cos(0.42);
  const nearScale = clamp(Math.cos(nearAngle) / cos0, 0.72, 1.0);
  const farScale = clamp(Math.cos(farAngle) / cos0, 0.28, 1.0);
  const eyeNear = {
    x: r1(cx + Math.sin(nearAngle) * rx * 0.93),
    y: r1(eyeY),
    r: r1(eyeBaseR * nearScale),
    visible: true,
  };
  const farVisible = Math.abs(headYaw) < 0.9;
  const eyeFar = {
    x: r1(cx + Math.sin(farAngle) * rx * 0.93),
    y: r1(eyeY),
    r: r1(eyeBaseR * farScale),
    visible: farVisible,
  };

  // Ears: upper-back cranial, y approx -ry * 0.84, behind the skull.
  // Base widths from M16-M17 (41 left, 48 right at U 128); tips rise
  // 29-36 px above the head arc (M18). Near ear is the facing side.
  const earBaseY = cy - ry * 0.84;
  const mkEar = (side, widthPx) => {
    const baseX = cx + side * rx * 0.62;
    const tipX = baseX + side * widthPx * 0.12;
    const tipY = earBaseY - (side < 0 ? 29 : 36) - 18;
    return {
      baseX: r1(baseX),
      baseY: r1(earBaseY),
      tipX: r1(tipX),
      tipY: r1(tipY),
      w: widthPx,
      side,
    };
  };
  const ears = {
    near: mkEar(dir, dir >= 0 ? 48 : 41),
    far: mkEar(-dir, dir >= 0 ? 41 : 48),
  };

  return {
    cx: r1(cx),
    cy: r1(cy),
    headYaw,
    w,
    h,
    rx: r1(rx),
    ry: r1(ry),
    theta: r3(theta),
    dir,
    snoutCx: r1(snoutCx),
    snoutDepth: r1(snoutDepth),
    eyeNear,
    eyeFar,
    ears,
    view: Math.abs(headYaw) < 0.25 ? "front" : Math.abs(headYaw) < 0.75 ? "three-quarter" : "profile",
  };
}

// Profile skull anchors, in units of U, from part.mjs (probe B2):
// one bezier outline with the snout bump built in. x span 1.39U,
// y span 1.688U (= 216 px at U 128). skullPathD rescales them so
// the outline spans exactly the width-curve width and 216 height.
const PROFILE_HEAD_ANCHORS = Object.freeze([
  [0, -0.844],
  [0.484, -0.688],
  [0.656, -0.234],
  [0.672, -0.039],
  [0.719, 0.062],
  [0.734, 0.297],
  [0.672, 0.508],
  [0.43, 0.742],
  [0, 0.844],
  [-0.43, 0.742],
  [-0.656, 0.312],
  [-0.656, -0.312],
  [-0.484, -0.688],
]);

function bezierEllipsePath(cx, cy, rx, ry) {
  const k = 0.5522847498;
  const kx = r1(rx * k);
  const ky = r1(ry * k);
  const x0 = r1(cx - rx);
  const x1 = r1(cx + rx);
  const y0 = r1(cy - ry);
  const y1 = r1(cy + ry);
  return (
    `M ${r1(cx)},${y0}` +
    ` C ${r1(cx + kx)},${y0} ${x1},${r1(cy - ky)} ${x1},${r1(cy)}` +
    ` C ${x1},${r1(cy + ky)} ${r1(cx + kx)},${y1} ${r1(cx)},${y1}` +
    ` C ${r1(cx - kx)},${y1} ${x0},${r1(cy + ky)} ${x0},${r1(cy)}` +
    ` C ${x0},${r1(cy - ky)} ${r1(cx - kx)},${y0} ${r1(cx)},${y0} Z`
  );
}

function smoothClosedPath(pts) {
  const p = pts.map(([x, y]) => [r1(x), r1(y)]);
  const n = p.length;
  const get = (i) => p[((i % n) + n) % n];
  let d = `M ${p[0][0]},${p[0][1]}`;
  for (let s = 0; s < n; s++) {
    const p0 = get(s - 1);
    const p1 = get(s);
    const p2 = get(s + 1);
    const p3 = get(s + 2);
    d += ` C ${r1(p1[0] + (p2[0] - p0[0]) / 6)},${r1(p1[1] + (p2[1] - p0[1]) / 6)} ${r1(p2[0] - (p3[0] - p1[0]) / 6)},${r1(p2[1] - (p3[1] - p1[1]) / 6)} ${p2[0]},${p2[1]}`;
  }
  return d + " Z";
}

/**
 * Skull outline path for a head centre and yaw. Front and
 * three-quarter are superellipse heads (exponent 3, full cheeks):
 * a bezier ellipse narrows 2 px by the eye row, but the model
 * sheet's longest head span sits ON the eye row (M4: 217 at y 256,
 * 14 px above the head centre), so the head must stay full at the
 * cheeks. Profile is the anchored outline with the snout bump,
 * rescaled to the same width and to 216 height. The path is the
 * FILL outline: the renderer paints the stroke under the fill
 * (paint-order), so the fill width reads exactly the width-curve
 * width.
 */
export function skullPathD(opts = {}) {
  const cx = opts.cx ?? 0;
  const cy = opts.cy ?? 0;
  const headYaw = opts.headYaw ?? 0;
  const g = headGeometry({ cx, cy, headYaw });
  if (g.view === "profile") {
    const xScale = g.w / (1.39 * 128);
    const yScale = g.h / (1.688 * 128);
    const pts = PROFILE_HEAD_ANCHORS.map(([ax, ay]) => [
      cx + ax * 128 * xScale * g.dir,
      cy + ay * 128 * yScale,
    ]);
    return { d: smoothClosedPath(pts), ...g };
  }
  // Superellipse, exponent 3: |x/rx|^3 + |y/ry|^3 = 1, sampled at
  // 16 angles and closed with Catmull-Rom (C1, no corners).
  const n = 3;
  const N = 16;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * 2 * Math.PI;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = g.rx * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const y = g.ry * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    pts.push([cx + x, cy + y]);
  }
  return { d: smoothClosedPath(pts), ...g };
}

/**
 * One ear as a curved triangle with a rounded tip, tilted outward,
 * from headGeometry ear data. Drawn BEHIND the skull: the caller
 * emits both ears before the skull path, so the skull fill covers
 * the ear bases and no line sits where an ear meets the head (M73).
 */
export function earPathD(ear) {
  const hw = ear.w / 2;
  const baseX = ear.baseX;
  const baseY = ear.baseY;
  const tipX = ear.tipX;
  const tipY = ear.tipY;
  const d =
    `M ${r1(baseX - hw)},${r1(baseY)}` +
    ` Q ${r1(baseX - hw * 0.9)},${r1(baseY - (baseY - tipY) * 0.55)} ${r1(tipX)},${r1(tipY)}` +
    ` Q ${r1(baseX + hw * 0.95)},${r1(baseY - (baseY - tipY) * 0.5)} ${r1(baseX + hw)},${r1(baseY)}` +
    ` Q ${r1(baseX)},${r1(baseY + (baseY - tipY) * 0.28)} ${r1(baseX - hw)},${r1(baseY)} Z`;
  return d;
}
