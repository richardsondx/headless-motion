// torso-frenet.mjs — V5 law 2: C1 spine-deformed plush torso.
//
// A torso is a closed C1 Catmull-Rom path in curved-spine Frenet
// space, never an explicit multi-anchor polygon: polygons leak C0
// square shoulder corners under rotation and lean (V4 lesson).
//
// Spine: quadratic Bezier S(t), t in [0,1], neck top to pelvis
// bottom, through a mid control shifted by spineCurveX. Frenet
// frame: tangent T(t) down the spine, right-normal N(t) =
// (T.y, -T.x), toWorld(t, lateral) = S(t) + N(t) * lateral.
//
// Half-widths: smooth superellipse pear profile with strictly
// horizontal tangents at t=0 and t=1 (zero C0 corners), normalised
// so the widest row reads exactly the spec trunk width (M8: 128 px
// at U 128). turnScale narrows the torso with |torsoYaw|; the
// facing side puffs out with the turn.
//
// Milo numbers stay Milo: trunk 128 x 194 (M8, M10), belly 92 x 112
// (M12, M13), belly foreshortens 92 / 60 / 29 across front /
// three-quarter / profile (M39-M41). No Bluey or panda numbers.
//
// Pure and deterministic: no Math.random, no Date, no mutable state.
// Seeded FNV-1a detRand is provided for hand-drawn micro-wobble only.

const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
/** smoothstep in [0,1], 0 below 0, 1 above 1. */
export function smoothstep(x) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Seeded FNV-1a deterministic pseudo-random in [0,1). */
export function detRand(seed, ...keys) {
  let h = 0x811c9dc5;
  const mix = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(String(seed));
  for (const k of keys) mix(String(k));
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Quadratic Bezier spine point and tangent.
 * @param {number} t 0 neck, 1 pelvis
 * @param {{x:number,y:number}} p0 neck top
 * @param {{x:number,y:number}} p1 control (mid, shifted by spineCurveX)
 * @param {{x:number,y:number}} p2 pelvis bottom
 */
export function spinePoint(t, p0, p1, p2) {
  const u = 1 - t;
  const x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
  const y = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
  // Derivative: 2(1-t)(p1-p0) + 2t(p2-p1).
  const tx = 2 * u * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
  const ty = 2 * u * (p1.y - p0.y) + 2 * t * (p2.y - p1.y);
  const len = Math.hypot(tx, ty) || 1;
  return { x, y, tx: tx / len, ty: ty / len };
}

/**
 * Pear half-width profile, before normalisation.
 * baseEgg is 0 at both ends with horizontal tangents (C1 at the
 * poles); pearMod fattens the lower half. Both are smooth in t.
 */
export function pearRaw(t) {
  const baseEgg = Math.pow(1 - Math.pow(2 * t - 1, 2), 0.44);
  const pearMod = lerp(0.84, 1.1, smoothstep(t));
  return baseEgg * pearMod;
}

/** Widest raw pear value, sampled finely; the normaliser. */
export function pearMax() {
  let m = 0;
  for (let i = 0; i <= 200; i++) m = Math.max(m, pearRaw(i / 200));
  return m;
}

const PEAR_MAX = pearMax();

/**
 * Stadium half-width profile, for characters whose measured trunk
 * is straight-sided (Milo M60: "sides nearly straight", 128 px
 * across the y 456-480 band, M8). Flat 1.0 while |2t-1| stays
 * inside the flat region, then a circular cap to the pole. The
 * bottom cap is shallower (flat to 0.95) so the trunk ends nearly
 * flat at the hip split instead of dipping a point between the
 * legs; the top cap (flat to 0.82) hides behind the head. The
 * blueprint pear tapers the lower trunk to ~90 px at the hips,
 * which reads as a wasp waist on Milo; the stadium keeps the
 * measured 128 px across the whole visible band. The junction is
 * C1: the cap's slope is 0 where it meets the flat.
 */
export function stadiumRaw(t, flatUntilTop = 0.82, flatUntilBottom = 0.95) {
  const a = Math.abs(2 * t - 1);
  const flatUntil = t < 0.5 ? flatUntilTop : flatUntilBottom;
  if (a <= flatUntil) return 1;
  const u = (a - flatUntil) / (1 - flatUntil);
  return Math.sqrt(Math.max(0, 1 - u * u));
}

/**
 * Build the C1 torso outline.
 *
 * @param {object} opts
 * @param {number} opts.cx trunk centre x, figure px
 * @param {number} opts.topY neck-top y (trunk top, hidden behind head)
 * @param {number} opts.bottomY pelvis-bottom y (hip split)
 * @param {number} [opts.halfW=64] widest half-width, px (M8: 64)
 * @param {number} [opts.torsoYaw=0] in [-1,1]
 * @param {number} [opts.spineCurveX=0] mid-spine lateral shift, px
 * @param {number} [opts.spineLeanDeg=0] lean, deg, + tips the neck forward (+x)
 * @param {number} [opts.samples=13] spine samples per side
 * @param {string} [opts.profile="pear"] "pear" (blueprint) or
 *   "stadium" (straight-sided trunks: Milo M60). Stadium keeps the
 *   measured width across the visible band and rounds only into the
 *   hips; pear tapers toward both poles.
 * @returns {{d:string, points:Array<[number,number]>, spine:Function, halfWidth:Function, sockets:object, tailVisible:boolean, tailBase:{x:number,y:number}, turnScale:number, maxWidth:number}}
 *   d is a closed Catmull-Rom to cubic Bezier path. sockets are
 *   near/far shoulder (t=0.24) and hip (t=0.84) points in figure px.
 *   turnScale is the yaw narrowing applied; maxWidth is the widest
 *   row of the emitted outline, px.
 */
export function torsoFrenet(opts = {}) {
  const cx = opts.cx ?? 0;
  const topY = opts.topY ?? -280;
  const bottomY = opts.bottomY ?? -86;
  const halfW = opts.halfW ?? 64;
  const torsoYaw = opts.torsoYaw ?? 0;
  if (typeof torsoYaw !== "number" || torsoYaw < -1 || torsoYaw > 1) {
    throw new Error(`TORSO_FRENENT: torsoYaw must be -1 to 1, got ${torsoYaw}`);
  }
  const spineCurveX = opts.spineCurveX ?? 0;
  const spineLeanDeg = opts.spineLeanDeg ?? 0;
  const samples = opts.samples ?? 13;

  const h = bottomY - topY;
  const leanShift = Math.tan((spineLeanDeg * Math.PI) / 180) * (h / 2);
  const p0 = { x: cx + leanShift, y: topY };
  const p1 = { x: cx + spineCurveX, y: (topY + bottomY) / 2 };
  const p2 = { x: cx - leanShift * 0.3, y: bottomY };

  const turn = smoothstep(Math.abs(torsoYaw));
  const turnScale = lerp(1.0, 0.76, turn);
  // Facing-side puff: shifts the centre toward the facing side.
  const dir = torsoYaw >= 0 ? 1 : -1;
  const puffAmp = dir * turn * halfW * 0.14;

  const profile = opts.profile ?? "pear";
  if (profile !== "pear" && profile !== "stadium") {
    throw new Error(`TORSO_FRENENT: profile must be "pear" or "stadium", got "${profile}"`);
  }
  const rawWidth = profile === "stadium" ? (t) => stadiumRaw(t) : pearRaw;
  const rawMax = profile === "stadium" ? 1 : PEAR_MAX;
  const halfWidth = (t) => (halfW * turnScale * rawWidth(t)) / rawMax;
  const puff = (t) => puffAmp * Math.sin(Math.PI * t) * lerp(0.5, 1.2, t);

  /** Spine-space to figure-space: S(t) + N(t) * lateral. */
  const toWorld = (t, lateral) => {
    const s = spinePoint(t, p0, p1, p2);
    // Right-normal N = (T.y, -T.x) in screen coords (y down).
    const nx = s.ty;
    const ny = -s.tx;
    return { x: s.x + nx * lateral + puff(t), y: s.y + ny * lateral };
  };

  // Right side neck -> pelvis, then left side pelvis -> neck.
  const pts = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const w = toWorld(t, halfWidth(t));
    pts.push([r1(w.x), r1(w.y)]);
  }
  for (let i = samples - 1; i >= 0; i--) {
    const t = i / (samples - 1);
    const w = toWorld(t, -halfWidth(t));
    pts.push([r1(w.x), r1(w.y)]);
  }

  const d = smoothClosedPath(pts);

  // Sockets: shoulders at t=0.24, hips at t=0.84. Lateral inset
  // migrates toward the centreline as the torso turns.
  const socketLateral = (t) => halfWidth(t) * lerp(0.8, 0.14, turn);
  const near = dir >= 0 ? 1 : -1;
  const sockets = {
    nearShoulder: pt(toWorld(0.24, near * socketLateral(0.24))),
    farShoulder: pt(toWorld(0.24, -near * socketLateral(0.24))),
    nearHip: pt(toWorld(0.84, near * socketLateral(0.84))),
    farHip: pt(toWorld(0.84, -near * socketLateral(0.84))),
  };

  // Tail emerges from the back side once the turn passes 0.22.
  const tailVisible = Math.abs(torsoYaw) > 0.22;
  const tailBase = pt(toWorld(0.9, -near * halfWidth(0.9) * 0.9));

  // Widest row of the emitted outline.
  let maxWidth = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    maxWidth = Math.max(maxWidth, 2 * halfWidth(t));
  }

  return {
    d,
    points: pts,
    spine: (t) => spinePoint(t, p0, p1, p2),
    halfWidth,
    toWorld,
    sockets,
    tailVisible,
    tailBase,
    turnScale: r3(turnScale),
    maxWidth: r1(maxWidth),
  };
}

function pt(p) {
  return { x: r1(p.x), y: r1(p.y) };
}

/**
 * Closed C1 Catmull-Rom through points, emitted as cubic Beziers
 * (tension 1/6). Every join shares its tangent by construction, so
 * the C0 corner audit reads 0 on this path.
 */
export function smoothClosedPath(pts) {
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
 * Belly in spine space: an ellipse centred on the spine at spineT,
 * foreshortened by the torso turn from measured widths (M39-M41:
 * 92 front, 60 three-quarter, 29 profile). Height 112 front to 104
 * profile (M12-M13, M41). Default spineT 0.72 puts the belly centre
 * at figure y -145.5 (LAYOUT belly cy -1.137U, M12-M13). Returns an
 * SVG ellipse descriptor in figure px; the caller clips it inside
 * the torso clipPath.
 */
export function bellyInSpineSpace(torso, opts = {}) {
  const torsoYaw = opts.torsoYaw ?? 0;
  const spineT = opts.spineT ?? 0.72;
  const ay = Math.abs(torsoYaw);
  let wFrac;
  if (ay <= 0.55) wFrac = lerp(1, 60 / 92, smoothstep(ay / 0.55));
  else wFrac = lerp(60 / 92, 29 / 92, smoothstep((ay - 0.55) / 0.45));
  let hFrac;
  if (ay <= 0.55) hFrac = lerp(1, 106 / 112, smoothstep(ay / 0.55));
  else hFrac = lerp(106 / 112, 104 / 112, smoothstep((ay - 0.55) / 0.45));
  const c = torso.toWorld(spineT, 0);
  return {
    cx: r1(c.x),
    cy: r1(c.y),
    rx: r1((92 / 2) * wFrac),
    ry: r1((112 / 2) * hFrac),
    w: r1(92 * wFrac),
    h: r1(112 * hFrac),
  };
}
