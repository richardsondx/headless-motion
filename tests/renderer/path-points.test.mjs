// U1 path format: points compile to d, points win over d, d stays as fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileScene, pointsToD } from "../../src/renderer/compile.mjs";
import { loadScene, validateScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");
const HAND_D = "M 0 0 L 200 0 C 200 60 200 100 200 150 C 140 150 60 150 0 150 Z";

/** Numbers in a d string, in order. */
const nums = (d) => (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

/** Max absolute difference between two d strings, number by number. */
const dDiff = (a, b) => {
  const x = nums(a);
  const y = nums(b);
  assert.equal(x.length, y.length, `number counts differ: ${x.length} vs ${y.length}`);
  return Math.max(...x.map((v, i) => Math.abs(v - y[i])));
};

/** The d attribute of one node's compiled <path>. */
function pathD(html, id) {
  const m = html.match(new RegExp(`data-node="${id}"[\\s\\S]{0,600}?<path d="([^"]+)"`));
  assert.ok(m, `no compiled path found for node ${id}`);
  return m[1];
}

function compiledFixture() {
  const scene = loadScene(resolve(FIXTURES, "path-points.json"));
  assert.deepEqual(validateScene(scene).errors, []);
  const { html, errors } = compileScene(scene, FIXTURES);
  assert.deepEqual(errors, []);
  return html;
}

test("compiled d from points matches the hand-written d within 0.001", () => {
  const html = compiledFixture();
  const got = pathD(html, "outline");
  assert.equal(dDiff(got, HAND_D), 0);
});

test("points win over d when both are present", () => {
  const html = compiledFixture();
  assert.equal(pathD(html, "both"), "M 0 0 L 100 0 L 0 100 Z");
});

test("d-only nodes keep their verbatim d as a fallback", () => {
  const html = compiledFixture();
  assert.equal(pathD(html, "traced"), "M 0 0 L 50 0 L 50 50 Z");
});

test("pointsToD covers line, cubic, smooth, open, and empty", () => {
  const line = [{ id: "a", anchor: [0, 0], command: "line", in: null, out: null }];
  assert.equal(pointsToD(line, false), "M 0 0");
  const cubic = [
    { id: "a", anchor: [0, 0], command: "line", in: null, out: [10, 0] },
    { id: "b", anchor: [30, 0], command: "cubic", in: [20, 0], out: null },
  ];
  assert.equal(pointsToD(cubic, false), "M 0 0 C 10 0 20 0 30 0");
  const smooth = [
    { id: "a", anchor: [0, 0], command: "line", in: null, out: null },
    { id: "b", anchor: [30, 0], command: "smooth", in: [20, 0], out: null },
  ];
  assert.equal(pointsToD(smooth, false), "M 0 0 S 20 0 30 0");
  // A null handle reads as its own anchor.
  const nullHandle = [
    { id: "a", anchor: [0, 0], command: "line", in: null, out: null },
    { id: "b", anchor: [30, 0], command: "cubic", in: null, out: null },
  ];
  assert.equal(pointsToD(nullHandle, false), "M 0 0 C 0 0 30 0 30 0");
  assert.equal(pointsToD(cubic, true), "M 0 0 C 10 0 20 0 30 0 Z");
  assert.equal(pointsToD([], false), "");
});

test("compiling the points fixture twice gives identical html", () => {
  const scene = loadScene(resolve(FIXTURES, "path-points.json"));
  const first = compileScene(scene, FIXTURES).html;
  const second = compileScene(scene, FIXTURES).html;
  assert.equal(first, second);
});
