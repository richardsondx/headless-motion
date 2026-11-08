// Named easing curves and the cubic-bezier solver. Pure, fixed iteration counts.

/** Name to [x1, y1, x2, y2]. `hold` is handled separately (it is a step). */
export const CURVES = Object.freeze({
  linear: [0, 0, 1, 1],
  easeInSine: [0.12, 0, 0.39, 0],
  easeOutSine: [0.61, 1, 0.88, 1],
  easeInOutSine: [0.37, 0, 0.63, 1],
  easeInQuad: [0.11, 0, 0.5, 0],
  easeOutQuad: [0.5, 1, 0.89, 1],
  easeInOutQuad: [0.45, 0, 0.55, 1],
  easeInCubic: [0.32, 0, 0.67, 0],
  easeOutCubic: [0.33, 1, 0.68, 1],
  easeInOutCubic: [0.65, 0, 0.35, 1],
  easeInQuart: [0.5, 0, 0.75, 0],
  easeOutQuart: [0.25, 1, 0.5, 1],
  easeInOutQuart: [0.76, 0, 0.24, 1],
  easeInQuint: [0.64, 0, 0.78, 0],
  easeOutQuint: [0.22, 1, 0.36, 1],
  easeInOutQuint: [0.83, 0, 0.17, 1],
  easeOutBack: [0.34, 1.56, 0.64, 1],
  easeInOutBack: [0.68, -0.6, 0.32, 1.6],
});

export const EASE_NAMES = Object.freeze(["hold", ...Object.keys(CURVES)]);

const NEWTON_STEPS = 8;
const BISECTION_STEPS = 40;
const TOLERANCE = 1e-7;

/** @param {number[]} p [x1,y1,x2,y2] @returns {boolean} */
export function isValidBezier(p) {
  return (
    Array.isArray(p) &&
    p.length === 4 &&
    p.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    p[0] >= 0 && p[0] <= 1 && p[2] >= 0 && p[2] <= 1
  );
}

/** @param {unknown} spec name or {bezier:[...]} @returns {boolean} */
export function isKnownEase(spec) {
  if (typeof spec === "string") return EASE_NAMES.includes(spec);
  return Boolean(spec) && typeof spec === "object" && isValidBezier(spec.bezier);
}

const axis = (a, b, t) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
const axisSlope = (a, b, t) => 3 * (1 - 3 * b + 3 * a) * t * t + 2 * (3 * b - 6 * a) * t + 3 * a;

/** Cubic-bezier easing: solve x(s) = x for s, return y(s). */
export function cubicBezier(x1, y1, x2, y2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let s = x;
  for (let i = 0; i < NEWTON_STEPS; i++) {
    const err = axis(x1, x2, s) - x;
    if (Math.abs(err) < TOLERANCE) return axis(y1, y2, s);
    const slope = axisSlope(x1, x2, s);
    if (Math.abs(slope) < 1e-6) break;
    s -= err / slope;
  }
  let lo = 0;
  let hi = 1;
  s = x;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const err = axis(x1, x2, s) - x;
    if (Math.abs(err) < TOLERANCE) break;
    if (err > 0) hi = s;
    else lo = s;
    s = (lo + hi) / 2;
  }
  return axis(y1, y2, s);
}

/**
 * Eased progress for t in [0,1].
 * @param {string | {bezier:number[]}} spec
 * @param {number} t
 */
export function ease(spec, t) {
  if (spec === "hold") return t >= 1 ? 1 : 0;
  const p = typeof spec === "string" ? CURVES[spec] : spec && spec.bezier;
  if (!p) throw new Error(`UNKNOWN_EASE ${JSON.stringify(spec)}`);
  if (typeof spec === "string" && spec === "linear") return t;
  return cubicBezier(p[0], p[1], p[2], p[3], t);
}
