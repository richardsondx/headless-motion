import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sampleScene } from "../../src/scene/evaluate.mjs";
import { rand } from "../../src/scene/random.mjs";
import { validateScene } from "../../src/scene/validate.mjs";

const scene = JSON.parse(readFileSync(new URL("../fixtures/scene-min.json", import.meta.url), "utf8"));
// Richer than the fixture so every value kind is exercised: colour, string, hold, bezier.
scene.timeline.push(
  { node: "bar", prop: "props.fill", keys: [{ f: 0, v: "accent" }, { f: 100, v: "ink", ease: { bezier: [0.2, 0, 0.1, 1] } }, { f: 200, v: "ground", ease: "easeInOutBack" }] },
  { node: "title", prop: "props.text", keys: [{ f: 0, v: "a" }, { f: 50, v: "b", ease: "linear" }] },
  { node: "title", prop: "transform.opacity", keys: [{ f: 0, v: 0 }, { f: 60, v: 1, ease: "easeOutBack" }, { f: 61, v: 1, ease: "hold" }] },
);
assert.deepEqual(validateScene(scene).errors, []);

const hashFrame = (f) => createHash("sha256").update(JSON.stringify(sampleScene(scene, f))).digest("hex");

function shuffled(n, seed) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand(seed, "shuffle", i) * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function hashesIn(order) {
  const out = new Array(order.length);
  for (const f of order) out[f] = hashFrame(f);
  return out;
}

test("frame order cannot change any frame: forward, reversed, seeded shuffle", () => {
  const frames = scene.meta.duration;
  const forward = hashesIn(Array.from({ length: frames }, (_, i) => i));
  const reversed = hashesIn(Array.from({ length: frames }, (_, i) => frames - 1 - i));
  const shuffle = hashesIn(shuffled(frames, scene.meta.seed));
  assert.equal(frames, 240);
  assert.deepEqual(reversed, forward);
  assert.deepEqual(shuffle, forward);
});

test("frames actually differ from each other", () => {
  assert.notEqual(hashFrame(0), hashFrame(120));
  assert.notEqual(hashFrame(60), hashFrame(61));
});
