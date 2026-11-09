// Text translators for `hme fix`.
//
// Apply a text correction from a measurement report's numbers plus
// the scene's current font values: font size from the cap-height
// ratio, letterSpacing from the median letter-gap delta. Values
// come from the report numbers only; the prose fix string is never
// parsed.
//
// Formulas, from src/cli/type.mjs buildCorrections:
// - Font size: ratio = capOurs / capRef (cap heights in px);
//   newSize = Math.round(currentSize / ratio).
// - LetterSpacing: delta = Math.round(refGap - oursGap) in px
//   (median letter gaps); new letterSpacing = old + delta.
//
// Why recompute here: the type tool names the correction from the
// same numbers, but the fixer must not trust the prose ("from 35
// to 22") — the numbers are the source, and the scene's current
// font values are the base the correction applies to.
//
// Design: ~/workspace/handover-motion-fixer/design-first-principles.md
// (C3, rebuilt design, text translator).
//
// Pure: each function returns a new scene object, never mutates its
// input, never touches the disk. Throws, applying nothing, when a
// needed number is absent (null or undefined), when the ratio
// denominator is zero or non-finite, when the target element is
// unknown, or when the scene node has no numeric font value to
// correct. It never guesses a value.

function requireFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`text fix refused: ${name} must be a finite number`);
  }
}

function findTextNode(scene, elementId) {
  if (!scene || typeof scene !== "object") {
    throw new Error("text fix refused: scene is missing");
  }
  if (!Array.isArray(scene.nodes)) {
    throw new Error("text fix refused: scene has no nodes array");
  }
  const node = scene.nodes.find((n) => n.id === elementId);
  if (!node) {
    throw new Error(`text fix refused: element ${elementId} not found`);
  }
  return node;
}

function fontOf(node, elementId) {
  if (!node.props || !node.props.font || typeof node.props.font !== "object") {
    throw new Error(`text fix refused: element ${elementId} has no props.font`);
  }
  return node.props.font;
}

/**
 * Apply a font-size correction to a scene.
 *
 * Sets only the named node's props.font.size to
 * Math.round(currentSize / ratio), where ratio = capOurs / capRef.
 *
 * @param {object} scene - the scene object (not mutated)
 * @param {string} elementId - the named element, e.g. "label-fasher"
 * @param {number} capRef - ref cap height in px
 * @param {number} capOurs - ours cap height in px
 * @returns {object} a new scene object with the font size corrected
 */
export function applyTextSizeFix(scene, elementId, capRef, capOurs) {
  requireFiniteNumber(capRef, "cap height ref");
  requireFiniteNumber(capOurs, "cap height ours");
  if (capRef === 0) {
    throw new Error("text fix refused: cap height ref is zero, so the ratio has no denominator");
  }
  const ratio = capOurs / capRef;
  if (!Number.isFinite(ratio) || ratio === 0) {
    throw new Error("text fix refused: cap height ratio is zero or non-finite");
  }
  const node = findTextNode(scene, elementId);
  const font = fontOf(node, elementId);
  requireFiniteNumber(font.size, `font size of ${elementId}`);
  const newSize = Math.round(font.size / ratio);
  if (!Number.isFinite(newSize)) {
    throw new Error("text fix refused: corrected font size is non-finite");
  }

  const next = structuredClone(scene);
  const target = next.nodes.find((n) => n.id === elementId);
  target.props.font.size = newSize;
  return next;
}

/**
 * Apply a letterSpacing correction to a scene.
 *
 * Sets only the named node's props.font.letterSpacing to
 * old + Math.round(refGap - oursGap), where the gaps are the median
 * letter gaps in px.
 *
 * @param {object} scene - the scene object (not mutated)
 * @param {string} elementId - the named element, e.g. "title-october"
 * @param {number} refGap - ref median letter gap in px
 * @param {number} oursGap - ours median letter gap in px
 * @returns {object} a new scene object with the letterSpacing corrected
 */
export function applyLetterSpacingFix(scene, elementId, refGap, oursGap) {
  requireFiniteNumber(refGap, "letter gap ref");
  requireFiniteNumber(oursGap, "letter gap ours");
  const node = findTextNode(scene, elementId);
  const font = fontOf(node, elementId);
  requireFiniteNumber(font.letterSpacing, `letterSpacing of ${elementId}`);
  const delta = Math.round(refGap - oursGap);
  const newSpacing = font.letterSpacing + delta;
  if (!Number.isFinite(newSpacing)) {
    throw new Error("text fix refused: corrected letterSpacing is non-finite");
  }

  const next = structuredClone(scene);
  const target = next.nodes.find((n) => n.id === elementId);
  target.props.font.letterSpacing = newSpacing;
  return next;
}
