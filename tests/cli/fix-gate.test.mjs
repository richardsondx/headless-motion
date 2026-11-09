// Tests for the `hme fix` validation gate (src/cli/fix/gate.mjs):
// diff old vs new (only intended paths may change) plus in-memory
// validate (schema + cross-reference checks, determinism lint over
// the serialized scene text), both before any write.
//
// Sources, read not guessed:
// - Real v5 scene: tests/fixtures/seg4-scene-clone-v5.json, fps 24,
//   duration 192 frames. Valid fix: the unit A timing translator's
//   output (applyTimingFix, badge-rsf warp), which shifts keys to
//   114/120/137/165/179 and leaves visible.in at 90 and visible.out
//   at 192 (D3, fix cycle 2: keys only, never in/out).
// - Broken scene: the same v5 scene with badge-rsf visible.out 216
//   against duration 192, which the validator flags as KEY_RANGE
//   (the unit A visible.out problem the gate must catch).
// - Design: ~/workspace/handover-motion-fixer/design-first-principles.md
//   (C5, gate).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { applyTimingFix } from "../../src/cli/fix/timing.mjs";
import {
  diffScenes, checkDiff, validateNewScene, lintSceneText, runGate,
} from "../../src/cli/fix/gate.mjs";
import { validateScene } from "../../src/scene/validate.mjs";
import { lintDir } from "../../src/scene/lint-determinism.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "..", "handover-motion-timing", "work", "t1", "seg4-report-final.json");
const SCENE = join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json");

const scene = JSON.parse(readFileSync(SCENE, "utf8"));
const warpTable = JSON.parse(readFileSync(REPORT, "utf8")).numbers.warp_table;
const fixed = applyTimingFix(scene, warpTable, "badge-rsf");

const tmp = () => mkdtempSync(join(tmpdir(), "hme-fix-gate-"));

test("the real v5 scene validates clean and lints clean, both ways", () => {
  assert.deepEqual(validateScene(scene).errors, []);
  assert.deepEqual(lintDir(SCENE), []);
  // The in-memory lint over the serialized scene agrees with the
  // file lint: 0 hits on the real scene.
  assert.deepEqual(lintSceneText(JSON.stringify(scene, null, 2)), []);
});

test("diffScenes names exactly the timing fix's changed paths", () => {
  const changed = diffScenes(scene, fixed);
  // Only key frames on the badge group's tracks change (D3: keys
  // only, visible.in/out never shift). Paths are structural
  // (nodes[3] is badge-rsf, [4] rifle-rsf, [5] badge-rsf-text);
  // no node ids appear in them.
  assert.ok(changed.length > 0);
  assert.ok(changed.every((p) => /^timeline\[/.test(p)));
  assert.ok(changed.some((p) => p.includes("keys")));
  assert.ok(!changed.some((p) => p.includes("visible.in")));
  assert.ok(!changed.some((p) => p.includes("visible.out")));
  assert.deepEqual(diffScenes(scene, scene), []);
  assert.deepEqual(diffScenes(scene, structuredClone(scene)), []);
});

test("checkDiff passes the intended set and fails an extra path", () => {
  const allowed = new Set(diffScenes(scene, fixed));
  const ok = checkDiff(scene, fixed, allowed);
  assert.equal(ok.pass, true);
  assert.deepEqual(ok.unexpectedPaths, []);
  assert.deepEqual(ok.changedPaths, [...allowed]);

  const tampered = structuredClone(fixed);
  tampered.nodes.find((n) => n.id === "label-sudan").box.x += 1;
  const bad = checkDiff(scene, tampered, allowed);
  assert.equal(bad.pass, false);
  // label-sudan is nodes[2]; its box.x is the unexpected path.
  assert.deepEqual(bad.unexpectedPaths, ["nodes[2].box.x"]);
  // A path predicate works the same way as a set.
  assert.equal(checkDiff(scene, fixed, (p) => allowed.has(p)).pass, true);
  assert.equal(checkDiff(scene, tampered, (p) => allowed.has(p)).pass, false);
});

test("validateNewScene passes the timing-fixed scene", () => {
  const result = validateNewScene(fixed);
  assert.equal(result.pass, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.determinismHits, []);
});

test("validateNewScene fails visible.out 216 past duration 192 (KEY_RANGE)", () => {
  const broken = structuredClone(scene);
  broken.nodes.find((n) => n.id === "badge-rsf").visible.out = 216;
  const result = validateNewScene(broken);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.code === "KEY_RANGE" && e.path === "/nodes/3/visible/out"));
  assert.match(result.errors[0].message, /beyond duration 192/);
});

test("validateNewScene fails a timeline track pointing at a missing node", () => {
  const broken = structuredClone(scene);
  broken.timeline[0].node = "no-such-node";
  const result = validateNewScene(broken);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.message.includes('no node with id "no-such-node"')));
});

test("the in-memory lint flags a banned construct in scene text", () => {
  const tainted = structuredClone(scene);
  tainted.nodes.find((n) => n.id === "label-fasher").props.text = "Math.random";
  const hits = lintSceneText(JSON.stringify(tainted, null, 2));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, "Math.random");
  assert.equal(validateNewScene(tainted).pass, false);
});

test("a valid fix passes both checks and the file is written", () => {
  const dir = tmp();
  const outPath = join(dir, "seg4-scene-v6.json");
  const beforeOld = JSON.stringify(scene);
  const beforeNew = JSON.stringify(fixed);
  const result = runGate({
    oldScene: scene,
    newScene: fixed,
    allowed: new Set(diffScenes(scene, fixed)),
    outPath,
  });
  assert.equal(result.pass, true);
  assert.equal(result.written, true);
  assert.equal(result.outPath, outPath);
  assert.deepEqual(JSON.parse(readFileSync(outPath, "utf8")), fixed);
  // Inputs are not mutated.
  assert.equal(JSON.stringify(scene), beforeOld);
  assert.equal(JSON.stringify(fixed), beforeNew);
});

test("a broken scene fails the gate and no file is written", () => {
  const dir = tmp();
  const outPath = join(dir, "seg4-scene-v6.json");
  const broken = structuredClone(scene);
  broken.nodes.find((n) => n.id === "badge-rsf").visible.out = 216;
  const result = runGate({
    oldScene: scene,
    newScene: broken,
    allowed: new Set(diffScenes(scene, broken)),
    outPath,
  });
  assert.equal(result.pass, false);
  assert.equal(result.written, false);
  assert.match(result.reason, /KEY_RANGE/);
  assert.equal(existsSync(outPath), false);
});

test("a diff with an unexpected path fails the gate and no file is written", () => {
  const dir = tmp();
  const outPath = join(dir, "seg4-scene-v6.json");
  const tampered = structuredClone(fixed);
  tampered.nodes.find((n) => n.id === "label-sudan").box.x += 1;
  const result = runGate({
    oldScene: scene,
    newScene: tampered,
    allowed: new Set(diffScenes(scene, fixed)),
    outPath,
  });
  assert.equal(result.pass, false);
  assert.equal(result.written, false);
  assert.match(result.reason, /unexpected changed paths/);
  assert.match(result.reason, /nodes\[2\]\.box\.x/);
  assert.equal(existsSync(outPath), false);
});

test("the gate refuses to overwrite an existing file", () => {
  const dir = tmp();
  const outPath = join(dir, "seg4-scene-v6.json");
  const first = runGate({
    oldScene: scene, newScene: fixed,
    allowed: new Set(diffScenes(scene, fixed)), outPath,
  });
  assert.equal(first.written, true);
  const before = readFileSync(outPath, "utf8");
  const second = runGate({
    oldScene: scene, newScene: fixed,
    allowed: new Set(diffScenes(scene, fixed)), outPath,
  });
  assert.equal(second.pass, false);
  assert.equal(second.written, false);
  assert.match(second.reason, /already exists/);
  assert.equal(readFileSync(outPath, "utf8"), before);
});
