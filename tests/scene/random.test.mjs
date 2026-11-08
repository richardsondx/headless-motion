import test from "node:test";
import assert from "node:assert/strict";
import { rand } from "../../src/scene/random.mjs";

test("same inputs give the same value, in any call order", () => {
  const a = [rand(7, "n", "particle", 1), rand(7, "n", "particle", 2)];
  const b = [rand(7, "n", "particle", 2), rand(7, "n", "particle", 1)].reverse();
  assert.deepEqual(a, b);
});

test("values lie in [0,1) and are spread", () => {
  let sum = 0;
  for (let i = 0; i < 5000; i++) {
    const v = rand(1, "k", i);
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  assert.ok(Math.abs(sum / 5000 - 0.5) < 0.02);
});

test("seed and every key change the value, and key boundaries are unambiguous", () => {
  assert.notEqual(rand(1, "a"), rand(2, "a"));
  assert.notEqual(rand(1, "a"), rand(1, "b"));
  assert.notEqual(rand(1, "a", "bc"), rand(1, "ab", "c"));
  assert.notEqual(rand(1, 1), rand(1, "1"));
});
