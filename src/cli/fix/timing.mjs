// Timing translator for `hme fix`.
//
// Applies a per-keyframe warp from a timing report's warp table to a
// scene: each timeline key of the named element (and its rigid motion
// group) is shifted later by the measured delay dt at that key's time.
// Values come from the warp table plus the scene only; the prose fix
// string is never parsed. A constant median delay is wrong here: dt
// varies across the warp window, so every key gets its own dt.
//
// Design: ~/workspace/handover-motion-fixer/design-first-principles.md
// (C1, rebuilt design, timing translator). Deviation D1 in
// ~/workspace/handover-motion-fixer/execution-record.md: the named
// element's rigid motion group -- every node whose timeline keyframe
// frame set is identical to the named element's, detected from the
// scene, never hardcoded -- shifts with it, because the renderer
// evaluates each node independently (position is box plus transform
// per node) and shifting one node would detach the rest.
//
// Pure: returns a new scene object, never mutates its input, never
// touches the disk. Throws on a missing/empty warp table or an
// element with no timeline tracks.

/**
 * Interpolate dt (seconds) at time t (seconds) from a warp table.
 * Linear between samples; 0 outside the measured window (D5, fix
 * cycle 4): the table measures dt only inside its time range, and
 * the edge dt is not the dt outside it. Proof 2 clamped 0.987 s
 * onto the first key at 3.75 s, where the true dt is about +0.17 s
 * (the reference reaches the start pose at 3.92 s); the 24-frame
 * hold that created failed the re-measurement at median dt -0.62 s.
 * No measurement, no shift. The table is [{ t_s, dt_s, ... }] and
 * is not mutated.
 */
export function interpolateDt(warpTable, t) {
  if (!Array.isArray(warpTable) || warpTable.length === 0) {
    throw new Error("timing fix refused: warp_table is missing or empty");
  }
  const samples = [...warpTable]
    .map((s) => ({ t: s.t_s, dt: s.dt_s }))
    .sort((a, b) => a.t - b.t);
  for (const s of samples) {
    if (typeof s.t !== "number" || typeof s.dt !== "number") {
      throw new Error("timing fix refused: warp_table sample lacks numeric t_s/dt_s");
    }
  }
  if (t < samples[0].t) return 0;
  const last = samples[samples.length - 1];
  if (t > last.t) return 0;
  for (let i = 1; i < samples.length; i++) {
    if (t <= samples[i].t) {
      const a = samples[i - 1];
      const b = samples[i];
      const frac = (t - a.t) / (b.t - a.t);
      return a.dt + frac * (b.dt - a.dt);
    }
  }
  return last.dt;
}

/** Frame set of a node: the union of key frames across its tracks. */
function frameSet(scene, nodeId) {
  const frames = new Set();
  for (const track of scene.timeline ?? []) {
    if (track.node !== nodeId) continue;
    for (const key of track.keys ?? []) frames.add(key.f);
  }
  return frames;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const f of a) if (!b.has(f)) return false;
  return true;
}

/**
 * The rigid motion group of the named element: the named element plus
 * every other node whose timeline keyframe frame set is identical to
 * its own. Detected from the scene, never hardcoded. Order follows
 * first appearance in the scene timeline.
 */
export function rigidMotionGroup(scene, elementId) {
  const target = frameSet(scene, elementId);
  if (target.size === 0) {
    throw new Error(`timing fix refused: element ${elementId} has no timeline tracks`);
  }
  const group = [];
  const seen = new Set();
  for (const track of scene.timeline ?? []) {
    if (seen.has(track.node)) continue;
    seen.add(track.node);
    if (sameSet(frameSet(scene, track.node), target)) group.push(track.node);
  }
  if (!group.includes(elementId)) group.unshift(elementId);
  return group;
}

/**
 * Apply the per-keyframe timing warp to a scene.
 *
 * For each timeline track of the named element and its rigid motion
 * group, every key frame f shifts by Math.round(dt * fps), where dt
 * is the warp-table delay interpolated at the key's time (f / fps);
 * outside the measured window dt is 0, so a key the table never
 * measured does not move (D5, fix cycle 4). visible.in and visible.out
 * are NEVER shifted (D3, fix cycle 2): the path dt measures path
 * lag, not appearance lag, and the appearance was already correct
 * (real first seen 3.712 s, v5 first seen 3.75 s, 0.04 s apart), so
 * shifting visible.in by the path dt delayed an appearance that
 * needed no delay and failed the re-measurement (median dt -0.79 s).
 * The renderer holds the first key's value before the first key, so
 * with in at 90 and the first key at 114 the badge sits at its start
 * pose for 24 frames, then moves along the corrected path. Key
 * values are untouched; keys stay in ascending frame order for the
 * measured warp (asserted by the test).
 *
 * @param {object} scene - the scene object (not mutated)
 * @param {Array} warpTable - numbers.warp_table, [{ t_s, dt_s, ... }]
 * @param {string} elementId - the named element, e.g. "badge-rsf"
 * @returns {object} a new scene object with the warp applied
 */
export function applyTimingFix(scene, warpTable, elementId) {
  if (!scene || typeof scene !== "object") {
    throw new Error("timing fix refused: scene is missing");
  }
  if (!Array.isArray(warpTable) || warpTable.length === 0) {
    throw new Error("timing fix refused: warp_table is missing or empty");
  }
  const fps = scene.meta?.fps ?? 24;
  if (typeof fps !== "number" || fps <= 0) {
    throw new Error("timing fix refused: scene meta.fps is missing or invalid");
  }

  const group = rigidMotionGroup(scene, elementId);
  const inGroup = new Set(group);

  const next = structuredClone(scene);

  for (const track of next.timeline ?? []) {
    if (!inGroup.has(track.node)) continue;
    for (const key of track.keys ?? []) {
      const dt = interpolateDt(warpTable, key.f / fps);
      key.f += Math.round(dt * fps);
    }
  }

  // D3: visible.in and visible.out are never shifted. The path dt
  // measures path lag, not appearance lag; shifting in/out by it
  // delayed an already-correct appearance (proof 1, median dt
  // -0.79 s). Keys only.

  return next;
}
