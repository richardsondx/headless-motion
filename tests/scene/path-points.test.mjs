// U1 path format: points lists validate, interpolate, and guard topology.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleScene, interpolatePoints } from "../../src/scene/evaluate.mjs";
import { loadScene, validateScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");
const load = (name) => JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8"));

test("points fixture validates with zero errors", () => {
  const { errors } = validateScene(load("path-points.json"));
  assert.deepEqual(errors, []);
});

test("old d-only fixtures still validate", () => {
  // seg4-scene-clone-v6 is left out on purpose: on HEAD it fails
  // validation for a map-schema reason (borderStroke and subjectStroke
  // are unknown fields), not for any path reason. That gap belongs to
  // the map work, not to U1.
  for (const name of ["scene-min.json", "seg3-scene.json", "seg4-scene-clone-v4.json"]) {
    const { errors } = validateScene(load(name));
    assert.deepEqual(errors, [], `${name} should still validate`);
  }
});

test("a bad point command fails validation", () => {
  const scene = load("path-points.json");
  scene.nodes[1].props.points[0].command = "arc";
  const { errors } = validateScene(scene);
  assert.ok(errors.length > 0, "expected a schema error for command arc");
});

test("points morph interpolates the mid frame exactly", () => {
  const scene = load("path-points.json");
  const at0 = sampleScene(scene, 0).outline["props.points"];
  const at12 = sampleScene(scene, 12).outline["props.points"];
  const at24 = sampleScene(scene, 24).outline["props.points"];
  assert.deepEqual(at0[1].anchor, [200, 0]);
  assert.deepEqual(at12[1].anchor, [212, 0]);
  assert.deepEqual(at12[1].out, [212, 60]);
  assert.deepEqual(at24[1].anchor, [224, 0]);
  // Untouched nodes do not move.
  assert.deepEqual(at12[2], at0[2]);
  assert.deepEqual(at12[3], at0[3]);
  // Null handles stay null through the morph.
  assert.equal(at12[1].in, null);
});

test("points morph with hold ease steps, it never blends", () => {
  const scene = load("path-points.json");
  scene.timeline[0].keys[1].ease = "hold";
  assert.deepEqual(sampleScene(scene, 12).outline["props.points"][1].anchor, [200, 0]);
  assert.deepEqual(sampleScene(scene, 24).outline["props.points"][1].anchor, [224, 0]);
});

test("mismatched topology fails loudly with PATH_TOPOLOGY_MISMATCH", () => {
  const scene = load("path-points.json");
  const base = scene.timeline[0].keys[0].v;
  const cases = {
    "fewer nodes": base.slice(0, 3),
    "different id": base.map((p, i) => (i === 1 ? { ...p, id: "renamed" } : p)),
    "different command": base.map((p, i) => (i === 2 ? { ...p, command: "line" } : p)),
    "different handle presence": base.map((p, i) => (i === 1 ? { ...p, out: null } : p)),
  };
  for (const [name, bad] of Object.entries(cases)) {
    const s = load("path-points.json");
    s.timeline[0].keys[1].v = bad;
    assert.throws(() => sampleScene(s, 12), /PATH_TOPOLOGY_MISMATCH/, name);
  }
  // interpolatePoints throws the same named error directly.
  assert.throws(() => interpolatePoints(base, base.slice(0, 3), 0.5), /PATH_TOPOLOGY_MISMATCH/);
});

test("points sampling does not mutate the scene", () => {
  const scene = load("path-points.json");
  const before = JSON.stringify(scene);
  sampleScene(scene, 12);
  assert.equal(JSON.stringify(scene), before);
});
