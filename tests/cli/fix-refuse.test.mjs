// Tests for the `hme fix` refuse rules (src/cli/fix/refuse.mjs).
//
// Sources, read not guessed:
// - Real layering correction: verify-seg4/evidence/work/layering/
//   layering-seg4.json, corrections[0]: element halo-fasher, kind
//   size, fix "Shrink halo-fasher and lower its opacity...", ours
//   ink 2194 px against ref 489 px. No target size or opacity
//   exists in any field of that correction or its report numbers:
//   the value would have to be guessed, so the fixer refuses it.
//   (The layering run folder names this report as its U5 output:
//   ~/workspace/handover-headless-motion-layering/stage1-package.md.)
// - Design: ~/workspace/handover-motion-fixer/design-first-principles.md
//   (C4 FAILED, refuse rules v1).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { refuseCorrection, APPLICABLE_KINDS } from "../../src/cli/fix/refuse.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAYERING = join(ROOT, "verify-seg4", "evidence", "work", "layering", "layering-seg4.json");

const report = JSON.parse(readFileSync(LAYERING, "utf8"));
const halo = report.corrections[0];

test("the real layering report names the halo-size correction", () => {
  assert.equal(report.corrections.length, 1);
  assert.equal(halo.element, "halo-fasher");
  assert.equal(halo.kind, "size");
  assert.equal(halo.ours.px, 2194);
  assert.equal(halo.real.px, 489);
  // No target size or opacity anywhere in the correction: only ink
  // counts and a prose fix. The fixer must not parse the prose.
  assert.equal(halo.targetSize, undefined);
  assert.equal(halo.targetOpacity, undefined);
  assert.match(halo.fix, /Shrink halo-fasher and lower its opacity/);
});

test("the real halo-size correction is refused with a named reason", () => {
  const result = refuseCorrection(halo);
  assert.equal(result.applicable, false);
  // The reason names the missing value, not just "unsupported".
  assert.match(result.reason, /target size/);
  assert.match(result.reason, /opacity/);
  assert.match(result.reason, /guessed/);
  assert.match(result.reason, /ink counts only/);
});

test("timing, position, and text corrections are applicable", () => {
  assert.deepEqual(APPLICABLE_KINDS, new Set(["timing", "position", "text"]));
  for (const kind of ["timing", "position", "text"]) {
    assert.deepEqual(refuseCorrection({ element: "badge-rsf", kind }), { applicable: true }, kind);
  }
});

test("every other v1 kind is refused with a reason naming the missing value", () => {
  const cases = [
    ["colour", /target colour/],
    ["shape", /target shape/],
    ["motion-blur", /target motion-blur/],
    ["live-grain", /target grain/],
    ["missing element", /no scene element exists/],
    ["stroke", /target stroke/],
    ["borders", /target border/],
  ];
  for (const [kind, pattern] of cases) {
    const result = refuseCorrection({ element: "halo-fasher", kind });
    assert.equal(result.applicable, false, kind);
    assert.match(result.reason, pattern, kind);
    assert.match(result.reason, /guessed|no scene element exists/, kind);
  }
});

test("a kind with no translator is refused, and a missing kind too", () => {
  const unknown = refuseCorrection({ element: "badge-rsf", kind: "glow" });
  assert.equal(unknown.applicable, false);
  assert.match(unknown.reason, /no translator exists for this kind/);
  assert.match(unknown.reason, /target value cannot be computed/);
  assert.equal(refuseCorrection({ element: "badge-rsf" }).applicable, false);
  assert.equal(refuseCorrection(null).applicable, false);
});

test("refuseCorrection does not mutate its input", () => {
  const before = JSON.stringify(halo);
  refuseCorrection(halo);
  assert.equal(JSON.stringify(halo), before);
});
