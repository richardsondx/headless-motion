// Kinetic type: per-unit transform and opacity, pure function of frame.
// Layout is measured once after fonts load; animation changes only
// transform and opacity, so text never reflows during motion.
import { ease } from "../scene/easing.mjs";

export function splitText(text, split) {
  if (split === "word") {
    const out = [];
    let current = "";
    for (const ch of text) {
      if (ch === " ") {
        if (current) out.push(current);
        out.push(" ");
        current = "";
      } else current += ch;
    }
    if (current) out.push(current);
    return out;
  }
  if (split === "line") return text.split("\n");
  return [...text];
}

const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** State of unit i at a frame. `from` is the starting transform. */
export function kineticUnit(kinetic, frame, i) {
  const start = kinetic.start + i * (kinetic.stagger ?? 0);
  const p = clamp01((frame - start) / kinetic.duration);
  const e = ease(kinetic.ease || "easeOutCubic", p);
  const from = kinetic.from || { y: 0, opacity: 0, scale: 1 };
  return {
    y: (from.y ?? 0) * (1 - e),
    opacity: (from.opacity ?? 0) + (1 - (from.opacity ?? 0)) * e,
    scale: (from.scale ?? 1) + (1 - (from.scale ?? 1)) * e,
    done: p >= 1,
  };
}

/** All units of a kinetic text node at a frame. */
export function kineticState(kinetic, text, frame) {
  const units = splitText(text, kinetic.split || "char");
  return units.map((unit, i) => ({ unit, ...kineticUnit(kinetic, frame, i) }));
}
