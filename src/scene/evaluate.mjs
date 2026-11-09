// Pure scene evaluator: the picture at frame N is a function of (scene, N) only.
// Output is flat dotted-path state per node, numbers already rounded with fmt().
import { ease } from "./easing.mjs";

export const TRANSFORM_DEFAULTS = Object.freeze({ x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 });
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
 * A points list is an array of point objects. Each point carries an id,
 * an anchor [x, y], in/out handles ([x, y] or null), and a command.
 */
const isPointsList = (v) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v[0] !== null &&
  typeof v[0] === "object" &&
  Array.isArray(v[0].anchor);

/**
 * Topology of a points list: node count, ids in order, commands, and
 * which handles exist. Two keyframes must share it, or the morph fails
 * loudly instead of silently jumping.
 */
function pointsSignature(points) {
  return points.map((p) => `${p.id}:${p.command}:${p.in ? 1 : 0}:${p.out ? 1 : 0}`).join("|");
}

function topologyError(a, b) {
  const sig = (v) => (isPointsList(v) ? pointsSignature(v) : `not a points list: ${String(JSON.stringify(v)).slice(0, 60)}`);
  const err = new Error(`PATH_TOPOLOGY_MISMATCH points lists differ: ${sig(a)} vs ${sig(b)}`);
  err.code = "PATH_TOPOLOGY_MISMATCH";
  return err;
}

/**
 * Interpolate two points lists with the same topology. Each coordinate
 * lerps as a number and rounds through fmt. A null handle stays null.
 * Throws PATH_TOPOLOGY_MISMATCH when the lists differ in count, ids,
 * commands, or handle presence.
 */
export function interpolatePoints(a, b, t) {
  if (!isPointsList(a) || !isPointsList(b) || a.length !== b.length || pointsSignature(a) !== pointsSignature(b)) {
    throw topologyError(a, b);
  }
  const lerpPt = (qa, qb) => [fmt(lerp(qa[0], qb[0], t)), fmt(lerp(qa[1], qb[1], t))];
  return a.map((pa, i) => {
    const pb = b[i];
    return {
      id: pa.id,
      anchor: lerpPt(pa.anchor, pb.anchor),
      in: pa.in ? lerpPt(pa.in, pb.in) : null,
      out: pa.out ? lerpPt(pa.out, pb.out) : null,
      command: pa.command,
    };
  });
}

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
  if (isPointsList(va) || isPointsList(vb)) return interpolatePoints(va, vb, e);
  // An array of objects (for example props.deform) has no numeric
  // lerp: it steps, it never blends into NaN.
  if (Array.isArray(va) && va.length > 0 && typeof va[0] === "object" && va[0] !== null) return va;
  if (Array.isArray(va)) return va.map((x, i) => lerp(x, vb[i], e));
  return lerp(va, vb, e);
}

/**
 * Vertex deform: move a named subset of points by dx, dy px. The
 * offset adds to the named point's anchor and to its in/out handles,
 * so the curve moves with the point. Points not named stay
 * unchanged. Throws PATH_UNKNOWN_POINT for an unknown deform id.
 * Returns a new list; the input is not mutated.
 */
export function applyDeform(points, moves) {
  const next = points.map((p) => ({
    id: p.id,
    anchor: [...p.anchor],
    in: p.in ? [...p.in] : null,
    out: p.out ? [...p.out] : null,
    command: p.command,
  }));
  for (const move of moves) {
    const i = next.findIndex((p) => p.id === move.id);
    if (i < 0) {
      const err = new Error(`PATH_UNKNOWN_POINT deform names unknown point "${move.id}"`);
      err.code = "PATH_UNKNOWN_POINT";
      throw err;
    }
    const p = next[i];
    const shift = (pt) => (pt ? [fmt(pt[0] + move.dx), fmt(pt[1] + move.dy)] : null);
    p.anchor = shift(p.anchor);
    p.in = shift(p.in);
    p.out = shift(p.out);
  }
  return next;
}

/**
 * Scale a points list about an anchor by scaleX and scaleY. Every
 * coordinate (anchor, in-handle, out-handle) scales the same way.
 * Returns a new list; the input is not mutated.
 */
export function scalePoints(points, scaleX, scaleY, anchorX, anchorY) {
  const at = (pt) => (pt ? [fmt(anchorX + (pt[0] - anchorX) * scaleX), fmt(anchorY + (pt[1] - anchorY) * scaleY)] : null);
  return points.map((p) => ({
    id: p.id,
    anchor: at(p.anchor),
    in: at(p.in),
    out: at(p.out),
    command: p.command,
  }));
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
    // Vertex deform applies after tracks, so it moves the sampled
    // (possibly morphed) points. A deform id with no point fails
    // loudly instead of moving nothing.
    if (node.type === "shape" && isPointsList(state["props.points"]) && Array.isArray(state["props.deform"])) {
      state["props.points"] = applyDeform(state["props.points"], state["props.deform"]);
    }
    // scaleX and scaleY fall back to the uniform scale when neither
    // the node nor a track sets them. Without this, the default 1
    // would shadow a uniform scale of 2.
    const nodeTracks = tracksByNode[node.id] || [];
    if (!nodeTracks.some((t) => t.prop === "transform.scaleX") && !(node.transform && node.transform.scaleX !== undefined)) {
      state["transform.scaleX"] = state["transform.scale"] ?? 1;
    }
    if (!nodeTracks.some((t) => t.prop === "transform.scaleY") && !(node.transform && node.transform.scaleY !== undefined)) {
      state["transform.scaleY"] = state["transform.scale"] ?? 1;
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
