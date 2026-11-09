// Refuse rules for `hme fix`.
//
// Decides, per correction kind, whether the fixer can compute the
// corrected value from the report plus the scene, or must refuse
// rather than guess. Values come from numbers plus scene only; the
// prose fix string is never parsed.
//
// Design: ~/workspace/handover-motion-fixer/design-first-principles.md
// (C4 FAILED, C6 FAILED as stated, rebuilt design, refuse rules v1).
// The layering halo correction is the case that forces this module:
// kind "size", element "halo-fasher", whose fix is prose ("Shrink
// halo-fasher and lower its opacity...") with ink counts only
// (ours 2194 px against ref 489 px). The 51 px / 0.10 opacity ground
// truth came from human judgment when v6 was built by hand, not
// from any report field, so no rule maps halo falloff to box size
// plus opacity. The fixer refuses it, never guesses a value.
//
// v1 scope: a translator exists for timing, position, and text only.
// Every other kind is refused with a named reason that says WHY the
// value cannot be computed: the reason names the missing value, not
// just "unsupported".
//
// Pure: no disk access, no mutation, no prose parsing. Returns
// { applicable: true } or { applicable: false, reason }.

/** Kinds with a translator in v1, per the rebuilt design. */
export const APPLICABLE_KINDS = new Set(["timing", "position", "text"]);

/**
 * Named refuse reason per refused kind. Each names the missing
 * value whose absence makes the correction uncomputable.
 * `kind` is any kind with no translator; its reason names the
 * missing value source for that kind.
 */
const REFUSE_REASONS = {
  size: "no target size or opacity exists in any report field; the layering correction names ink counts only (ours 2194 px against ref 489 px), so the target box size and opacity would have to be guessed",
  colour: "no target colour value exists in any report field; the correction names no palette colour or hex value to set, so the target colour would have to be guessed",
  color: "no target colour value exists in any report field; the correction names no palette colour or hex value to set, so the target colour would have to be guessed",
  shape: "no target shape geometry exists in any report field; the correction names no path, point, or dimension to set, so the target shape would have to be guessed",
  "motion-blur": "no target motion-blur value exists in any report field; the correction names no blur amount or shutter value to set, so the target blur would have to be guessed",
  "live-grain": "no target grain value exists in any report field; the correction names no grain amount or seed value to set, so the target grain would have to be guessed",
  "missing element": "no scene element exists to correct; the correction names an element that is absent from the scene, so there is no node whose values could be changed",
  "missing-element": "no scene element exists to correct; the correction names an element that is absent from the scene, so there is no node whose values could be changed",
  stroke: "no target stroke value exists in any report field; the correction names no stroke width or colour to set, so the target stroke would have to be guessed",
  borders: "no target border value exists in any report field; the correction names no border width or colour to set, so the target border would have to be guessed",
};

/**
 * Decide whether a correction can be applied.
 *
 * @param {object} correction - one report correction
 *   ({ element, kind, ... }); only `kind` (and, for the halo case,
 *   `element`) is read. The prose `fix` string is never parsed.
 * @returns {{ applicable: true } | { applicable: false, reason: string }}
 */
export function refuseCorrection(correction) {
  if (!correction || typeof correction !== "object") {
    return { applicable: false, reason: "no correction was supplied, so there is no kind and no target value to compute" };
  }
  const kind = correction.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    return { applicable: false, reason: "the correction names no kind, so no translator can be picked and no target value can be computed" };
  }
  if (APPLICABLE_KINDS.has(kind)) {
    return { applicable: true };
  }
  const known = REFUSE_REASONS[kind];
  if (known) {
    return { applicable: false, reason: `kind "${kind}" refused: ${known}` };
  }
  return {
    applicable: false,
    reason: `kind "${kind}" refused: no translator exists for this kind, so no value source is defined and the target value cannot be computed`,
  };
}
