import test from "node:test";
import assert from "node:assert/strict";
import { CURVES, ease, isKnownEase, cubicBezier } from "../../src/scene/easing.mjs";

const OVERSHOOT = new Set(["easeOutBack", "easeInOutBack"]);
const names = Object.keys(CURVES);

test("every curve returns 0 at 0 and 1 at 1", () => {
  for (const name of [...names, "hold"]) {
    assert.ok(Math.abs(ease(name, 0)) < 1e-6, `${name}(0)`);
    assert.ok(Math.abs(ease(name, 1) - 1) < 1e-6, `${name}(1)`);
  }
});

test("non-overshoot curves are monotonic over 1000 samples", () => {
  for (const name of names.filter((n) => !OVERSHOOT.has(n))) {
    let prev = ease(name, 0);
    for (let i = 1; i <= 1000; i++) {
      const v = ease(name, i / 1000);
      assert.ok(v >= prev - 1e-9, `${name} drops at ${i / 1000}: ${prev} -> ${v}`);
      assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `${name} leaves [0,1] at ${i / 1000}: ${v}`);
      prev = v;
    }
  }
});

test("overshoot curves do overshoot", () => {
  let max = 0;
  for (let i = 0; i <= 1000; i++) max = Math.max(max, ease("easeOutBack", i / 1000));
  assert.ok(max > 1.05);
  let min = 0;
  for (let i = 0; i <= 1000; i++) min = Math.min(min, ease("easeInOutBack", i / 1000));
  assert.ok(min < -0.01);
});

test("easeInOutCubic(0.5) is 0.5", () => {
  assert.ok(Math.abs(ease("easeInOutCubic", 0.5) - 0.5) < 1e-6);
});

test("a custom bezier equal to a named curve gives the same values", () => {
  for (const name of names) {
    const custom = { bezier: [...CURVES[name]] };
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      assert.ok(Math.abs(ease(custom, t) - ease(name, t)) < 1e-6, `${name} at ${t}`);
    }
  }
});

test("solver matches a hand-solved point", () => {
  // x(s)=y(s)=s for the linear bezier, so any x maps to itself.
  assert.ok(Math.abs(cubicBezier(0, 0, 1, 1, 0.3) - 0.3) < 1e-6);
});

test("hold steps at the key", () => {
  assert.equal(ease("hold", 0.999), 0);
  assert.equal(ease("hold", 1), 1);
});

test("unknown eases are rejected", () => {
  assert.equal(isKnownEase("easeWobble"), false);
  assert.equal(isKnownEase({ bezier: [1.2, 0, 0.5, 1] }), false);
  assert.equal(isKnownEase({ bezier: [0.2, 0, 0.5, 1] }), true);
  assert.throws(() => ease("easeWobble", 0.5), /UNKNOWN_EASE/);
});
