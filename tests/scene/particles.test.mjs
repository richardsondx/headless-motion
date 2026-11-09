import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateParticles, particleState, particlesForNode, validateParticleProps } from "../../src/scene/particles.mjs";
import { sampleScene } from "../../src/scene/evaluate.mjs";
import { rand } from "../../src/scene/random.mjs";

const SEED = 42;
const BUBBLES = {
  count: 14,
  size: 18,
  speed: 40,
  direction: 270,
  lifetime: 48,
  shape: "bubble",
  area: { x: 900, y: 500, w: 300, h: 400 },
};
const SPARKLES = {
  count: 12,
  size: 10,
  speed: 0,
  direction: 0,
  lifetime: 24,
  shape: "star",
  area: { x: 700, y: 200, w: 400, h: 300 },
};
const CLOUDS = {
  count: 12,
  size: 120,
  speed: 53,
  direction: 0,
  lifetime: 120,
  shape: "circle",
  area: { x: 0, y: 0, w: 1920, h: 630 },
};

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

test("same inputs give the same outputs, in any call order", () => {
  const a = [evaluateParticles(SEED, "bubbles", BUBBLES, 24), evaluateParticles(SEED, "bubbles", BUBBLES, 36)];
  const b = [evaluateParticles(SEED, "bubbles", BUBBLES, 36), evaluateParticles(SEED, "bubbles", BUBBLES, 24)].reverse();
  assert.deepEqual(a, b);
  // Single-particle calls interleaved in different orders agree too.
  const c = [particleState(SEED, "n", 1, BUBBLES, 30), particleState(SEED, "n", 2, BUBBLES, 30)];
  const d = [particleState(SEED, "n", 2, BUBBLES, 30), particleState(SEED, "n", 1, BUBBLES, 30)].reverse();
  assert.deepEqual(c, d);
  assert.equal(
    JSON.stringify(evaluateParticles(SEED, "bubbles", BUBBLES, 24)),
    JSON.stringify(evaluateParticles(SEED, "bubbles", BUBBLES, 24)),
  );
});

test("seed, node, index, and frame each change the output", () => {
  const base = particleState(SEED, "bubbles", 0, BUBBLES, 24);
  assert.notDeepEqual(base, particleState(43, "bubbles", 0, BUBBLES, 24));
  assert.notDeepEqual(base, particleState(SEED, "sparkles", 0, BUBBLES, 24));
  assert.notDeepEqual(base, particleState(SEED, "bubbles", 1, BUBBLES, 24));
  assert.notDeepEqual(base, particleState(SEED, "bubbles", 0, BUBBLES, 25));
});

test("count is read per frame: fixture track 8 -> 14, fractional counts floor", () => {
  assert.equal(evaluateParticles(SEED, "bubbles", { ...BUBBLES, count: 8 }, 24).length, 8);
  assert.equal(evaluateParticles(SEED, "bubbles", { ...BUBBLES, count: 14 }, 48).length, 14);
  assert.equal(evaluateParticles(SEED, "bubbles", { ...BUBBLES, count: 8.9 }, 24).length, 8);
  assert.equal(evaluateParticles(SEED, "bubbles", { ...BUBBLES, count: 11.5 }, 36).length, 11);
});

test("fixture animated count track is honoured through sampleScene", () => {
  const scene = JSON.parse(readFileSync(new URL("../../tests/fixtures/particle-sample.json", import.meta.url), "utf8"));
  const propsAt = (frame) => {
    const s = sampleScene(scene, frame);
    return {
      count: s.bubbles["props.count"],
      size: s.bubbles["props.size"],
      speed: s.bubbles["props.speed"],
      direction: s.bubbles["props.direction"],
      lifetime: s.bubbles["props.lifetime"],
      shape: s.bubbles["props.shape"],
      // sampleScene flattens objects to dotted keys, so rebuild the area.
      area: {
        x: s.bubbles["props.area.x"],
        y: s.bubbles["props.area.y"],
        w: s.bubbles["props.area.w"],
        h: s.bubbles["props.area.h"],
      },
    };
  };
  assert.equal(evaluateParticles(scene.meta.seed, "bubbles", propsAt(24), 24).length, 8);
  assert.equal(evaluateParticles(scene.meta.seed, "bubbles", propsAt(36), 36).length, 11);
  assert.equal(evaluateParticles(scene.meta.seed, "bubbles", propsAt(48), 48).length, 14);
  // The node wrapper reads the same props from the fixture node.
  const node = scene.nodes.find((n) => n.id === "bubbles");
  assert.equal(particlesForNode(scene.meta.seed, { ...node, props: propsAt(24) }, 24).length, 8);
});

test("bubbles and stars stay inside the emitter area, sizes positive, opacity in range", () => {
  for (const [props, frame] of [[BUBBLES, 24], [BUBBLES, 36], [SPARKLES, 30]]) {
    for (const p of evaluateParticles(SEED, "n", props, frame)) {
      assert.ok(p.x >= props.area.x - 0.001 && p.x <= props.area.x + props.area.w + 0.001, `x ${p.x} in area`);
      assert.ok(p.y >= props.area.y - 0.001 && p.y <= props.area.y + props.area.h + 0.001, `y ${p.y} in area`);
      assert.ok(p.size > 0);
      assert.ok(p.opacity >= 0 && p.opacity <= 1);
      assert.equal(p.shape, props.shape);
    }
  }
  // Clouds may drift out of the emitter area; their sizes and opacity still hold.
  for (const p of evaluateParticles(SEED, "clouds", CLOUDS, 96)) {
    assert.ok(p.size > 0);
    assert.ok(p.opacity >= 0 && p.opacity <= 1);
  }
});

test("bubbles rise: one particle moves up by speed times elapsed time, no wrap", () => {
  // Wide area and a particle whose hashed start sits clear of the top edge.
  const props = { ...BUBBLES, area: { x: 0, y: 0, w: 1920, h: 100000 } };
  const i = 3;
  const y0 = props.area.y + rand(SEED, "bubbles", "particle", i, "y") * props.area.h;
  const speedFactor = 0.8 + 0.4 * rand(SEED, "bubbles", "particle", i, "speed");
  const before = particleState(SEED, "bubbles", i, props, 0);
  const after = particleState(SEED, "bubbles", i, props, 24);
  assert.ok(y0 - 40 * speedFactor * 1 > props.area.y, "test setup: no wrap in this window");
  assert.ok(Math.abs((before.y - after.y) - 40 * speedFactor) < 1, `rose ${before.y - after.y}, expected ${40 * speedFactor}`);
});

test("bubbles wobble sideways off the straight rise line", () => {
  const straight = (i, frame) => {
    const x0 = BUBBLES.area.x + rand(SEED, "bubbles", "particle", i, "x") * BUBBLES.area.w;
    return x0; // direction 270 is straight up, so a wobble-free rise keeps x fixed
  };
  const moved = evaluateParticles(SEED, "bubbles", BUBBLES, 30)
    .some((p, i) => Math.abs(p.x - straight(i, 30)) > 0.01);
  assert.ok(moved, "at least one bubble is pushed sideways by the wobble");
});

test("sparkles stay put (speed 0) and twinkle: opacity changes across frames", () => {
  const a = evaluateParticles(SEED, "sparkles", SPARKLES, 24);
  const b = evaluateParticles(SEED, "sparkles", SPARKLES, 30);
  assert.deepEqual(a.map((p) => [p.x, p.y]), b.map((p) => [p.x, p.y]));
  assert.ok(a.some((p, i) => p.opacity !== b[i].opacity), "opacity oscillates");
  assert.ok(a.every((p) => p.rotation >= 0 && p.rotation < 360), "star carries a rotation");
});

test("clouds drift right by about speed times elapsed time", () => {
  const a = evaluateParticles(SEED, "clouds", CLOUDS, 96);
  const b = evaluateParticles(SEED, "clouds", CLOUDS, 120);
  const dx = mean(b.map((p, i) => p.x - a[i].x));
  assert.ok(Math.abs(dx - 53) < 8, `mean drift ${dx}, expected about 53 px in 1 s`);
});

test("opacity and size repeat after one lifetime, while drift keeps moving", () => {
  // Age cycles, so opacity, size, rotation, and age repeat; position drifts
  // with absolute frame time, so it does not repeat. A speed-0 star repeats
  // in full because it never moves.
  const a = particleState(SEED, "bubbles", 0, BUBBLES, 24);
  const b = particleState(SEED, "bubbles", 0, BUBBLES, 24 + BUBBLES.lifetime);
  assert.equal(a.opacity, b.opacity);
  assert.equal(a.size, b.size);
  assert.equal(a.age, b.age);
  assert.notEqual(a.y, b.y);
  assert.deepEqual(
    particleState(SEED, "sparkles", 0, SPARKLES, 24),
    particleState(SEED, "sparkles", 0, SPARKLES, 24 + SPARKLES.lifetime),
  );
});

test("evaluator can produce the reference counts (7 bubbles, 9 bubbles, 2 stars)", () => {
  assert.equal(evaluateParticles(SEED, "bubbles", { ...BUBBLES, count: 7 }, 36).length, 7);
  assert.equal(evaluateParticles(SEED, "bubbles", { ...BUBBLES, count: 9 }, 48).length, 9);
  assert.equal(evaluateParticles(SEED, "sparkles", { ...SPARKLES, count: 2 }, 36).length, 2);
  // With count 7, most bubbles are lit, not faded out at the loop ends.
  const lit = evaluateParticles(SEED, "bubbles", { ...BUBBLES, count: 7 }, 36).filter((p) => p.opacity > 0.5).length;
  assert.ok(lit >= 5, `${lit} of 7 bubbles lit at 1.5 s`);
});

test("bad props, bad index, and bad frame throw", () => {
  assert.throws(() => validateParticleProps({ ...BUBBLES, count: 0 }), /count/);
  assert.throws(() => validateParticleProps({ ...BUBBLES, size: 0 }), /size/);
  assert.throws(() => validateParticleProps({ ...BUBBLES, speed: -1 }), /speed/);
  assert.throws(() => validateParticleProps({ ...BUBBLES, direction: 361 }), /direction/);
  assert.throws(() => validateParticleProps({ ...BUBBLES, lifetime: 0 }), /lifetime/);
  assert.throws(() => validateParticleProps({ ...BUBBLES, shape: "square" }), /shape/);
  assert.throws(() => validateParticleProps({ ...BUBBLES, area: { x: 0, y: 0, w: 0, h: 10 } }), /area/);
  assert.throws(() => evaluateParticles(SEED, "n", { ...BUBBLES, count: 0.5 }, 24), /count/);
  assert.throws(() => particleState(SEED, "n", -1, BUBBLES, 24), /index/);
  assert.throws(() => particleState(SEED, "n", 0, BUBBLES, 1.5), /frame/);
  assert.throws(() => particleState(SEED, "n", 0, BUBBLES, -1), /frame/);
  assert.throws(() => particlesForNode(SEED, { id: "x", type: "shape", props: BUBBLES }, 24), /not particle/);
});
