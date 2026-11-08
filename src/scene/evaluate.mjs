// Pure scene evaluator: the picture at frame N is a function of (scene, N) only.
// Output is flat dotted-path state per node, numbers already rounded with fmt().
import { ease } from "./easing.mjs";

export const TRANSFORM_DEFAULTS = Object.freeze({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
export const COLOR_PATHS = Object.freeze(["props.color", "props.fill", "props.stroke.color", "props.stroke.casing.color"]);

/** @param {number} n */
export const fmt = (n) => Number(n.toFixed(3)) + 0;

/** Seconds only for docs and helpers. */
export const framesFromSeconds = (s, fps) => Math.ceil(s * fps);

const HEX = /^#[0-9a-fA-F]{6}$/;

/** @returns {string|null} lowercase #rrggbb, or null when v is not a colour */
export function resolveColor(v, palette) {
  if (typeof v !== "string") return null;
  if (HEX.test(v)) return v.toLowerCase();
  const entry = Object.prototype.hasOwnProperty.call(palette, v) ? palette[v] : undefined;
  const hex = typeof entry === "string" ? entry : entry && entry.color;
  return hex ? hex.toLowerCase() : null;
}

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => "#" + rgb.map((c) => Math.min(255, Math.max(0, c)).toString(16).padStart(2, "0")).join("");

/** Flatten plain objects to dotted keys. Arrays are leaf values. */
export function flatten(obj, prefix, out = {}) {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Raw (unrounded) value of one track at a frame.
 * @param {{keys:{f:number,v:any,ease?:any}[]}} track
 * @param {number} frame
 * @param {boolean} isColor
 * @param {Record<string, any>} palette
 */
export function sampleTrack(track, frame, isColor, palette) {
  const keys = track.keys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  const read = (v) => (isColor ? channels(resolveColor(v, palette) ?? "#000000") : v);
  if (frame <= first.f) return read(first.v);
  if (frame >= last.f) return read(last.v);
  let k = 1;
  while (keys[k].f <= frame) k++;
  const a = keys[k - 1];
  const b = keys[k];
  const va = read(a.v);
  const vb = read(b.v);
  const stepsOnly = !isColor && typeof va !== "number" && !Array.isArray(va);
  if (stepsOnly || b.ease === "hold") return va;
  const e = ease(b.ease ?? "linear", (frame - a.f) / (b.f - a.f));
  if (Array.isArray(va)) return va.map((x, i) => lerp(x, vb[i], e));
  return lerp(va, vb, e);
}

function finish(raw) {
  if (typeof raw === "number") return fmt(raw);
  if (Array.isArray(raw)) return raw.map((x) => (typeof x === "number" ? fmt(x) : x));
  return raw;
}

/**
 * @param {object} scene a validated scene
 * @param {number} frame integer frame
 * @returns {Record<string, Record<string, any>>} {nodeId: {dottedProp: value}}
 */
export function sampleScene(scene, frame) {
  if (!Number.isInteger(frame)) throw new Error(`frame must be an integer, got ${frame}`);
  const palette = scene.palette;
  const tracksByNode = {};
  for (const track of scene.timeline) (tracksByNode[track.node] ||= []).push(track);

  const result = {};
  for (const node of scene.nodes) {
    const state = {
      z: node.z,
      ...flatten(node.box, "box"),
      ...flatten({ ...TRANSFORM_DEFAULTS, ...(node.transform || {}) }, "transform"),
      "visible.in": node.visible ? node.visible.in : 0,
      "visible.out": node.visible ? node.visible.out : scene.meta.duration,
      ...flatten(node.props, "props"),
    };
    const colorKeys = new Set();
    for (const path of COLOR_PATHS) if (path in state) colorKeys.add(path);
    for (const track of tracksByNode[node.id] || []) {
      const isColor = COLOR_PATHS.includes(track.prop);
      if (isColor) colorKeys.add(track.prop);
      const raw = sampleTrack(track, frame, isColor, palette);
      state[track.prop] = isColor ? toHex(raw.map(Math.round)) : raw;
    }
    const out = { visible: frame >= state["visible.in"] && frame < state["visible.out"] };
    for (const key of Object.keys(state)) {
      if (key === "visible.in" || key === "visible.out") continue;
      const v = state[key];
      out[key] = colorKeys.has(key) && typeof v === "string" ? resolveColor(v, palette) ?? v : finish(v);
    }
    result[node.id] = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return result;
}
