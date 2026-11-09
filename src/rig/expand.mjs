// Rig expansion: turn rig poses into flat node and timeline tracks.
//
// `expandRig(rig, keyframes, scene)` validates the rig and the keyframes,
// checks every pose state against the target scene, and writes flat track
// keys for every pose value. It never mutates its inputs: it returns a new
// scene object.
//
// How rotation works (Unit C). The evaluator (src/scene/evaluate.mjs)
// samples flat transform values per node; the renderer
// (src/renderer/runtime.mjs, read-only) places the element at
//   left = box.x + transform.x, top = box.y + transform.y
// and styles it with
//   transform: scale(s) rotate(r deg)
// with the CSS default transform-origin, the centre of the element box.
// So a rotation is always about the element's own centre, and scale is
// about that same centre (it never moves the centre). A rotation about a
// joint pivot P is therefore expressed by moving the centre: the flat
// tracks carry the rotation angle AND the x/y translation that puts the
// element's centre where rotation about P puts it.
//
// Pivot math (single joint). Let C0 be the element's rest centre,
//   C0 = (box.x + baseX + w/2, box.y + baseY + h/2)
// where baseX/baseY are the node's base transform.x/y (0 when absent;
// rotation and scale about the centre never move the centre, so they do
// not enter C0). For a joint angle of theta degrees about pivot P, the
// rotated centre is
//   C1 = P + R(theta) . (C0 - P)
// where R(theta) is the screen-coordinate rotation (CSS rotate, positive
// angles clockwise because y grows downwards):
//   R(theta) = [[cos, -sin], [sin, cos]].
// The flat tracks are then
//   rotation = theta
//   transform.x = C1.x - w/2 - box.x
//   transform.y = C1.y - h/2 - box.y
// Computed values are rounded to 3 decimals, the evaluator's rounding
// (fmt), so the sampled value at the key frame equals the written value
// exactly. A pose state's own x/y, when present, is a scene-space offset
// added to the pivot-computed translation after the rotation.
//
// Parent-chain composition. Joints form chains through `parent`
// (elbow under shoulder). A chain is applied root to leaf: each joint
// rotates about its pivot *after* its ancestors have moved that pivot,
// and the joint's own rotation applies on top. Concretely, with the
// chain [shoulder (angle a), elbow (angle b)], the elbow pivot moves to
//   Pe' = Ps + R(a) . (Pe - Ps)
// the part centre moves to
//   C1 = Pe' + R(b) . (Ps + R(a) . (C0 - Ps) - Pe')
// and the flat rotation track is the sum a + b.
//
// Angle assignment. A pose state carries one rotation per part, not one
// per joint, so one rule decides which joint in a chain takes it: the
// pose rotation for a part applies at the root-most rotate joint that
// moves that part; deeper rotate joints moving the same part take 0 and
// ride along (their pivots still move with the parent). A joint moving a
// *different* part takes that part's pose rotation for the same pose (0
// when the pose sets no rotation on that part). That is what makes a
// two-part chain observable: the forearm's rotation composes with the
// upper arm's rotation, because the elbow's pivot moves with the
// shoulder. The proof rig has one arm node per arm, so both shoulder and
// elbow move the same part: the shoulder takes the pose angle and the
// elbow rides along, and the flat rotation is the pose angle itself.
//
// What this leaves alone:
//   - Parts moved by no rotate joint (eyes, brows, mouth, body) keep
//     Unit B's direct writes: scale, y, x, opacity are written verbatim.
//   - A rotation of exactly 0 is the identity of the pivot math above,
//     so it writes x = 0, y = 0, rotation = 0 like any other angle.
//   - Translate joints never enter a rotation chain: no pose value
//     describes a joint translation, so they stay pivot-independent
//     direct writes.
//   - Between key frames the evaluator interpolates x, y, and rotation
//     linearly, so a large swing follows the chord, not the arc, between
//     keys. At each key frame the sampled picture is exact; add
//     intermediate keys if a long swing must follow the arc.
//
// Keyframes file shape (chosen by Unit B, `hme.rig-keyframes/1.0`):
//   {
//     "schema": "hme.rig-keyframes/1.0",
//     "rig": "<rig meta.id>",
//     "keys": [{ "frame": 0, "pose": "eyes-closed" }, ...]
//   }
// Keys are kept sorted by frame. One key applies one named pose at one
// frame; later keys win when two keys set the same node/prop at the same
// frame. The keyframes file never edits the rig file.
import { readFileSync } from "node:fs";
import { validateRig } from "./validate.mjs";

export const KEYFRAMES_VERSION = "hme.rig-keyframes/1.0";
const VALUE_FIELDS = ["x", "y", "scale", "rotation", "opacity"];

/** Round like the evaluator's fmt(): 3 decimals, -0 normalised to 0. */
const fmt3 = (n) => Number(n.toFixed(3)) + 0;
const DEG = Math.PI / 180;

/**
 * Rotate point (x, y) about pivot (px, py) by angleDeg degrees.
 * Positive angles are clockwise in screen coordinates (y grows down),
 * matching CSS rotate(). Full precision: callers round the final value.
 */
export function rotateAbout(px, py, angleDeg, x, y) {
  const r = angleDeg * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = x - px;
  const dy = y - py;
  return { x: px + cos * dx - sin * dy, y: py + sin * dx + cos * dy };
}

/**
 * Compose a joint chain, root to leaf, over a rest centre.
 * @param {{joint:{id:string,pivot:{x:number,y:number}},angle:number}[]} chain
 * @param {{x:number,y:number}} restCentre
 * @returns {{centre:{x:number,y:number}, totalRotation:number}}
 */
export function composeJointChain(chain, restCentre) {
  let centre = { x: restCentre.x, y: restCentre.y };
  const applied = []; // {pivot, angle} already in current coordinates
  let totalRotation = 0;
  for (const { joint, angle } of chain) {
    let pivot = { x: joint.pivot.x, y: joint.pivot.y };
    for (const t of applied) pivot = rotateAbout(t.pivot.x, t.pivot.y, t.angle, pivot.x, pivot.y);
    centre = rotateAbout(pivot.x, pivot.y, angle, centre.x, centre.y);
    applied.push({ pivot, angle });
    totalRotation += angle;
  }
  return { centre, totalRotation };
}

/** Read and parse a keyframes file. Throws on unreadable or bad JSON. */
export function loadKeyframesFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Validate a parsed keyframes object against its rig.
 * @param {any} kf parsed keyframes JSON
 * @param {any} rig parsed rig JSON (already validated by the caller)
 * @returns {{errors:{code:string,path:string,message:string}[], warnings:{code:string,path:string,message:string}[]}}
 */
export function validateKeyframes(kf, rig) {
  const errors = [];
  const warnings = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  if (kf === null || typeof kf !== "object" || Array.isArray(kf)) {
    add("KEYFRAMES_TYPE", "/", "keyframes file must be a JSON object");
    return { errors, warnings };
  }
  if (kf.schema !== KEYFRAMES_VERSION) {
    add("SCHEMA_VERSION", "/schema", `expected "${KEYFRAMES_VERSION}", got ${JSON.stringify(kf.schema)}`);
    return { errors, warnings };
  }
  if (rig && kf.rig !== rig.meta?.id) {
    add("RIG_MISMATCH", "/rig", `keyframes file is for rig "${kf.rig}", not rig "${rig.meta?.id}"`);
  }
  if (!Array.isArray(kf.keys)) {
    add("KEYFRAMES_TYPE", "/keys", "keys must be an array of {frame, pose}");
    return { errors, warnings };
  }
  const poseIds = new Set((rig?.poses ?? []).map((p) => p.id));
  const seen = new Set();
  kf.keys.forEach((k, i) => {
    const at = `/keys/${i}`;
    if (k === null || typeof k !== "object" || Array.isArray(k)) {
      add("KEYFRAMES_TYPE", at, "each key must be an object {frame, pose}");
      return;
    }
    if (!Number.isInteger(k.frame) || k.frame < 0) {
      add("KEY_RANGE", `${at}/frame`, `frame must be a non-negative integer, got ${JSON.stringify(k.frame)}`);
    } else if (rig && Number.isInteger(rig.meta?.duration) && k.frame > rig.meta.duration) {
      add("KEY_RANGE", `${at}/frame`, `frame ${k.frame} is past the rig duration of ${rig.meta.duration} frames`);
    }
    if (typeof k.pose !== "string" || k.pose.length === 0) {
      add("KEYFRAMES_TYPE", `${at}/pose`, "pose must be a non-empty string");
    } else if (poseIds.size && !poseIds.has(k.pose)) {
      add("UNKNOWN_POSE", `${at}/pose`, `pose "${k.pose}" does not exist in rig "${rig.meta?.id}"`);
    }
    const dup = `${k.frame}:${k.pose}`;
    if (seen.has(dup)) add("DUP_KEY", at, `duplicate key: pose "${k.pose}" at frame ${k.frame} is already recorded`);
    seen.add(dup);
  });
  return { errors, warnings };
}

function fail(message) {
  throw new Error(message);
}

/**
 * Expand rig poses into flat node and timeline tracks in a scene.
 *
 * @param {any} rig parsed rig JSON
 * @param {any} keyframes parsed keyframes JSON (`hme.rig-keyframes/1.0`)
 * @param {any} scene parsed scene JSON (`hme.scene/1.0`)
 * @returns {{scene:any, summary:{posesApplied:number, keysWritten:number, tracksTouched:number, keysReplaced:number, unimplemented:string[]}}}
 * @throws {Error} with a code prefix when the rig or keyframes are
 *   invalid, or a pose references a part whose node is missing from the
 *   target scene (MISSING_NODE). Nothing is written on failure: the
 *   caller writes the returned scene only on success.
 */
export function expandRig(rig, keyframes, scene) {
  const rigResult = validateRig(rig);
  if (rigResult.errors.length) {
    fail(
      `RIG_INVALID: rig "${rig?.meta?.id ?? "?"}": ` +
        rigResult.errors.map((e) => `${e.code} ${e.path} ${e.message}`).join("; "),
    );
  }
  const kfResult = validateKeyframes(keyframes, rig);
  if (kfResult.errors.length) {
    fail(
      `KEYFRAMES_INVALID: ` +
        kfResult.errors.map((e) => `${e.code} ${e.path} ${e.message}`).join("; "),
    );
  }
  if (scene === null || typeof scene !== "object" || !Array.isArray(scene.nodes)) {
    fail("SCENE_INVALID: target scene has no nodes array");
  }
  if (!Array.isArray(scene.timeline)) {
    fail("SCENE_INVALID: target scene has no timeline array");
  }

  const nodeById = new Map(scene.nodes.map((n) => [n.id, n]));
  const partById = new Map(rig.parts.map((p) => [p.id, p]));
  const poseById = new Map(rig.poses.map((p) => [p.id, p]));
  const jointById = new Map(rig.joints.map((j) => [j.id, j]));

  // Depth of a joint in its parent chain (root = 0). validateRig has
  // already rejected cycles, so this walk terminates.
  const depthOf = (joint) => {
    let d = 0;
    let cur = joint;
    while (cur.parent !== null && cur.parent !== undefined) {
      d += 1;
      cur = jointById.get(cur.parent);
    }
    return d;
  };

  // Rotate-joint chain for a part, root to leaf: the rotate joints that
  // move the part, plus their rotate ancestors (which move other parts).
  // A part moved by no rotate joint has an empty chain.
  const chainForPart = (partId) => {
    const chain = new Map();
    for (const mover of rig.joints) {
      if (mover.mode !== "rotate" || mover.part !== partId) continue;
      let cur = mover;
      while (cur) {
        if (cur.mode === "rotate") chain.set(cur.id, cur);
        cur = cur.parent ? jointById.get(cur.parent) : null;
      }
    }
    return [...chain.values()].sort((a, b) => depthOf(a) - depthOf(b));
  };

  // Per-pose angle assignment (see the header note). Returns the chain
  // for partId with each joint's angle for this pose: the pose rotation
  // for a part applies at the root-most rotate joint moving that part;
  // a joint moving another part takes that part's pose rotation (0 when
  // the pose sets none); deeper joints moving the same part take 0.
  const chainAnglesForPose = (pose, partId) => {
    const poseRotation = new Map();
    for (const s of pose.states) {
      if (s.rotation !== undefined) poseRotation.set(s.part, s.rotation);
    }
    const chain = chainForPart(partId);
    const rootMover = chain.find((j) => j.part === partId);
    return chain.map((joint) => ({
      joint,
      angle:
        joint.part === partId
          ? joint === rootMover
            ? poseRotation.get(partId) ?? 0
            : 0
          : poseRotation.get(joint.part) ?? 0,
    }));
  };

  const out = structuredClone(scene);
  const trackByKey = new Map();
  for (const t of out.timeline) trackByKey.set(`${t.node}\0${t.prop}`, t);

  const counters = { keysWritten: 0, keysReplaced: 0, tracksTouched: new Set() };
  const writeKey = (nodeId, prop, frame, value) => {
    const trackKey = `${nodeId}\0${prop}`;
    let track = trackByKey.get(trackKey);
    if (!track) {
      track = { node: nodeId, prop, keys: [] };
      out.timeline.push(track);
      trackByKey.set(trackKey, track);
    }
    const existing = track.keys.find((k) => k.f === frame);
    if (existing) {
      existing.v = value;
      counters.keysReplaced += 1;
    } else {
      track.keys.push({ f: frame, v: value });
      counters.keysWritten += 1;
    }
    counters.tracksTouched.add(trackKey);
  };

  const sortedKeys = [...keyframes.keys].sort((a, b) => a.frame - b.frame);
  const posesApplied = [];

  for (const key of sortedKeys) {
    const pose = poseById.get(key.pose);
    posesApplied.push({ frame: key.frame, pose: key.pose });
    for (const state of pose.states) {
      const part = partById.get(state.part);
      const nodeId = part.node;
      const node = nodeById.get(nodeId);
      if (!node) {
        fail(
          `MISSING_NODE: pose "${pose.id}" at frame ${key.frame} references part ` +
            `"${state.part}" whose node "${nodeId}" is missing from the target scene. ` +
            `Add a node with id "${nodeId}" to the scene, or fix the rig part mapping. ` +
            `Nothing was expanded.`,
        );
      }
      const chain = chainForPart(state.part);
      const needsPivot =
        chain.length > 0 &&
        (state.rotation !== undefined || state.x !== undefined || state.y !== undefined);
      if (needsPivot) {
        // Rest centre of the element (box plus base transform; rotation
        // and scale about the centre never move the centre).
        const box = node.box;
        const baseX = node.transform?.x ?? 0;
        const baseY = node.transform?.y ?? 0;
        const restCentre = { x: box.x + baseX + box.w / 2, y: box.y + baseY + box.h / 2 };
        const { centre, totalRotation } = composeJointChain(
          chainAnglesForPose(pose, state.part),
          restCentre,
        );
        const tx = fmt3(centre.x - box.w / 2 - box.x);
        const ty = fmt3(centre.y - box.h / 2 - box.y);
        const rot = fmt3(totalRotation);
        // The pivot rotation moves the element, so a rotation state
        // writes x and y as well as rotation; a pose x/y is a scene-space
        // offset added after the rotation.
        if (state.rotation !== undefined || state.x !== undefined) {
          writeKey(nodeId, "transform.x", key.frame, fmt3(tx + (state.x ?? 0)));
        }
        if (state.rotation !== undefined || state.y !== undefined) {
          writeKey(nodeId, "transform.y", key.frame, fmt3(ty + (state.y ?? 0)));
        }
        if (state.rotation !== undefined) {
          writeKey(nodeId, "transform.rotation", key.frame, rot);
        }
      }
      for (const field of VALUE_FIELDS) {
        if (state[field] === undefined) continue;
        if (needsPivot && (field === "x" || field === "y" || field === "rotation")) continue;
        writeKey(nodeId, `transform.${field}`, key.frame, state[field]);
      }
    }
  }
  for (const trackKey of counters.tracksTouched) {
    trackByKey.get(trackKey).keys.sort((a, b) => a.f - b.f);
  }

  return {
    scene: out,
    summary: {
      posesApplied: posesApplied.length,
      keysWritten: counters.keysWritten,
      tracksTouched: counters.tracksTouched.size,
      keysReplaced: counters.keysReplaced,
      unimplemented: [],
    },
  };
}
