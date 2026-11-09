// Deterministic particle evaluator: pure function of (seed, node id, particle index, frame).
// No running sequence, no frame-to-frame state. All randomness comes from the
// keyed-hash RNG in random.mjs, so the same inputs give the same particles in
// any call order. Closed-form motion only (Stage 1 A3):
//   bubble: rise along direction plus a sideways wobble, fade in and out.
//   star:   fixed spot, opacity oscillates (twinkle).
//   circle: linear drift along direction, fade in and out (cloud drift).
// Drift follows absolute frame time, not per-particle age: a cloud mass then
// shifts right by speed times elapsed time, which is what the proof measures.
// Opacity still cycles on per-particle age, so a particle fades in and out
// over its lifetime. Boundary rule, per shape: bubbles and stars wrap inside
// the emitter area, so their count in the area stays equal to props.count;
// clouds (circle) do not wrap, they drift on across the sky and leave the
// area, because wrapping a uniform spread keeps its centroid fixed and the
// proof needs the cloud centroid to move right. The renderer clips at the
// scene edge.
// Star renders as a computed polygon downstream (D4); this module returns a
// rotation for the polygon, not a new shape kind.

import { rand } from "./random.mjs";
import { fmt } from "./evaluate.mjs";

const SHAPES = ["circle", "star", "bubble"];
const TAU = Math.PI * 2;

/** Positive remainder, so a particle that leaves one edge re-enters at the other. */
const mod = (n, m) => ((n % m) + m) % m;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fail(message) {
  throw new Error(`particle props: ${message}`);
}

/**
 * Check one particle props object (the frozen U2 shape). Throws on bad props.
 * @param {object} props node.props for a particle node
 */
export function validateParticleProps(props) {
  if (props === null || typeof props !== "object" || Array.isArray(props)) fail("props must be an object");
  if (typeof props.count !== "number" || !Number.isFinite(props.count)) fail("count must be a finite number");
  if (props.count < 1) fail("count must be at least 1");
  if (typeof props.size !== "number" || !(props.size > 0)) fail("size must be a number above 0");
  if (typeof props.speed !== "number" || props.speed < 0) fail("speed must be a number at least 0");
  if (typeof props.direction !== "number" || props.direction < 0 || props.direction > 360) {
    fail("direction must be a number from 0 to 360");
  }
  if (typeof props.lifetime !== "number" || !(props.lifetime > 0)) fail("lifetime must be a number above 0");
  if (!SHAPES.includes(props.shape)) fail(`shape must be one of ${SHAPES.join(", ")}`);
  const area = props.area;
  if (area === null || typeof area !== "object" || Array.isArray(area)) fail("area must be an object");
  for (const k of ["x", "y", "w", "h"]) {
    if (typeof area[k] !== "number" || !Number.isFinite(area[k])) fail(`area.${k} must be a finite number`);
  }
  if (area.x < 0 || area.y < 0) fail("area.x and area.y must be at least 0");
  if (!(area.w > 0) || !(area.h > 0)) fail("area.w and area.h must be above 0");
}

/**
 * State of one particle at one frame.
 * @param {number} seed scene meta.seed
 * @param {string} nodeId particle node id
 * @param {number} index particle index, 0-based, below props.count
 * @param {object} props particle node props (count already read for this frame)
 * @param {number} frame integer scene frame, at least 0
 * @param {number} fps scene frames per second, default 24
 * @returns {{index:number,x:number,y:number,size:number,opacity:number,shape:string,rotation:number,age:number}}
 *   x/y in scene px, size in px diameter, opacity 0..1, rotation in degrees,
 *   age in frames since this particle last looped to its start.
 */
export function particleState(seed, nodeId, index, props, frame, fps = 24) {
  if (!Number.isInteger(index) || index < 0) throw new Error(`particle index must be an integer at least 0, got ${index}`);
  if (!Number.isInteger(frame) || frame < 0) throw new Error(`frame must be an integer at least 0, got ${frame}`);
  if (typeof fps !== "number" || !(fps > 0)) throw new Error(`fps must be a number above 0, got ${fps}`);
  validateParticleProps(props);

  const { area, lifetime } = props;
  const key = (name) => rand(seed, nodeId, "particle", index, name);

  // Per-particle constants, each hashed once from (seed, node, index, name).
  const x0 = area.x + key("x") * area.w;
  const y0 = area.y + key("y") * area.h;
  const sizeFactor = 0.7 + 0.6 * key("size");
  const speedFactor = 0.8 + 0.4 * key("speed");
  const birth = Math.floor(key("birth") * lifetime);
  const phase = key("phase") * TAU;
  const wobbleCycles = 1 + Math.floor(key("wobbleCycles") * 2);
  const wobbleAmp = props.size * (0.15 + 0.35 * key("wobbleAmp"));
  const rotationBase = key("rotation") * 360;

  // Age loops over the lifetime: at frame + lifetime the particle is back
  // to the same opacity and size, with no stored state. Position is separate:
  // it drifts with absolute frame time so a whole cloud mass moves together.
  const age = mod(frame + birth, lifetime);
  const ageFrac = age / lifetime;

  const rad = (props.direction * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const travel = props.speed * speedFactor * (frame / fps);

  let x;
  let y;
  if (props.shape === "circle") {
    // Cloud drift: no wrap, so the whole mass translates with time.
    x = x0 + ux * travel;
    y = y0 + uy * travel;
  } else {
    x = area.x + mod(x0 - area.x + ux * travel, area.w);
    y = area.y + mod(y0 - area.y + uy * travel, area.h);
  }

  if (props.shape === "bubble") {
    // Sideways wobble, perpendicular to the rise direction.
    const wobble = wobbleAmp * Math.sin(TAU * ageFrac * wobbleCycles + phase);
    x = clamp(x - uy * wobble, area.x, area.x + area.w);
    y = clamp(y + ux * wobble, area.y, area.y + area.h);
  }

  let opacity;
  if (props.shape === "star") {
    // Twinkle: opacity oscillates with age, never fully off.
    opacity = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(TAU * ageFrac + phase));
  } else {
    // Fade in over the first 15 percent of life, out over the last 15 percent.
    opacity = Math.min(1, ageFrac / 0.15, (1 - ageFrac) / 0.15);
  }

  return {
    index,
    x: fmt(x),
    y: fmt(y),
    size: fmt(props.size * sizeFactor),
    opacity: fmt(clamp(opacity, 0, 1)),
    shape: props.shape,
    rotation: fmt(props.shape === "star" ? mod(rotationBase, 360) : 0),
    age: fmt(age),
  };
}

/**
 * All particles of one node at one frame. props.count is read on every call,
 * so an animated count track (for example 8 -> 14 across frames) is honoured
 * per frame. A fractional count from a track sample is floored.
 * @param {number} seed scene meta.seed
 * @param {string} nodeId particle node id
 * @param {object} props particle node props for this frame
 * @param {number} frame integer scene frame, at least 0
 * @param {number} fps scene frames per second, default 24
 * @returns {Array<ReturnType<particleState>>} one entry per particle, in index order
 */
export function evaluateParticles(seed, nodeId, props, frame, fps = 24) {
  validateParticleProps(props);
  const count = Math.floor(props.count);
  if (count < 1) throw new Error(`particle props: count resolves to ${count}, must be at least 1`);
  const out = [];
  for (let i = 0; i < count; i++) out.push(particleState(seed, nodeId, i, props, frame, fps));
  return out;
}

/**
 * Convenience wrapper over a scene node: reads node.props for this frame.
 * @param {number} seed scene meta.seed
 * @param {{id:string,type:string,props:object}} node a particle node
 * @param {number} frame integer scene frame, at least 0
 * @param {number} fps scene frames per second, default 24
 */
export function particlesForNode(seed, node, frame, fps = 24) {
  if (node === null || typeof node !== "object") throw new Error("node must be an object");
  if (node.type !== undefined && node.type !== "particle") {
    throw new Error(`node "${node.id}" is type "${node.type}", not particle`);
  }
  return evaluateParticles(seed, node.id, node.props, frame, fps);
}
