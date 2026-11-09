// Position translator for `hme fix`.
//
// Applies a position correction from a measurement report's shift_px
// to a scene: only the named node's box moves, by (dx, dy) in scene
// px. Values come from the correction's shift_px only; the prose fix
// string is never parsed.
//
// Why only the box: the renderer computes rendered position as box
// plus transform (src/renderer/runtime.mjs: x = box.x + transform.x,
// y = box.y + transform.y), so shifting the transform keys as well
// would double-count. Transform keys, timeline keys, visible, props,
// and every other node stay untouched.
//
// Why only the named node: a position correction is measured on one
// element; moving its companions would be guessing, since their
// measured positions were not given. (Contrast the timing translator,
// whose rigid motion group shifts together because the warp was
// measured on the shared path.)
//
// Design: ~/workspace/handover-motion-fixer/design-first-principles.md
// (C2, rebuilt design, position translator).
//
// Pure: returns a new scene object, never mutates its input, never
// touches the disk. Throws on an unknown element, a node with no
// numeric box, or a shift that is not finite {dx, dy} numbers.

/**
 * Apply a position shift to a scene.
 *
 * Only the named node's box moves: box.x += dx, box.y += dy.
 *
 * @param {object} scene - the scene object (not mutated)
 * @param {string} elementId - the named element, e.g. "badge-rsf"
 * @param {{ dx: number, dy: number }} shift - shift_px, real minus
 *   ours, in scene px
 * @returns {object} a new scene object with the box shifted
 */
export function applyPositionFix(scene, elementId, shift) {
  if (!scene || typeof scene !== "object") {
    throw new Error("position fix refused: scene is missing");
  }
  if (
    !shift ||
    typeof shift !== "object" ||
    typeof shift.dx !== "number" ||
    typeof shift.dy !== "number" ||
    !Number.isFinite(shift.dx) ||
    !Number.isFinite(shift.dy)
  ) {
    throw new Error("position fix refused: shift must be finite {dx, dy} numbers");
  }
  const nodes = scene.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("position fix refused: scene has no nodes array");
  }
  const node = nodes.find((n) => n.id === elementId);
  if (!node) {
    throw new Error(`position fix refused: element ${elementId} not found`);
  }
  if (
    !node.box ||
    typeof node.box.x !== "number" ||
    typeof node.box.y !== "number" ||
    !Number.isFinite(node.box.x) ||
    !Number.isFinite(node.box.y)
  ) {
    throw new Error(`position fix refused: element ${elementId} has no numeric box`);
  }

  const next = structuredClone(scene);
  const target = next.nodes.find((n) => n.id === elementId);
  target.box.x += shift.dx;
  target.box.y += shift.dy;
  return next;
}
