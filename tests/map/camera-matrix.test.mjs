// Layer cache check: cameraMatrix maps screen coords under one camera to
// screen coords under another, exactly (projection is affine in lng/lat).
import test from "node:test";
import assert from "node:assert/strict";
import { projectPoint, cameraMatrix } from "../../src/map/project.mjs";

function applyMatrix(m, [x, y]) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

test("cameraMatrix maps reference screen coords to frame screen coords", () => {
  const from = { center: [29.5, 15.5], zoom: 2, bearing: 0, pitch: 0 };
  const to = { center: [25.35, 13.63], zoom: 4, bearing: 0, pitch: 0 };
  const m = cameraMatrix(from, to);
  assert.ok(m, "matrix must exist");
  for (const [lng, lat] of [[0, 0], [30, 16], [25.35, 13.63], [-50, 60], [120, -30]]) {
    const got = applyMatrix(m, projectPoint(lng, lat, from));
    const want = projectPoint(lng, lat, to);
    assert.ok(Math.abs(got[0] - want[0]) < 1e-6, `x ${lng},${lat}: ${got[0]} vs ${want[0]}`);
    assert.ok(Math.abs(got[1] - want[1]) < 1e-6, `y ${lng},${lat}: ${got[1]} vs ${want[1]}`);
  }
});

test("cameraMatrix is exact for random cameras with bearing and pitch", () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 50; i++) {
    const from = { center: [rnd() * 360 - 180, rnd() * 160 - 80], zoom: rnd() * 5, bearing: rnd() * 360, pitch: rnd() * 80 };
    const to = { center: [rnd() * 360 - 180, rnd() * 160 - 80], zoom: rnd() * 5, bearing: rnd() * 360, pitch: rnd() * 80 };
    const m = cameraMatrix(from, to);
    assert.ok(m, `matrix must exist for pair ${i}`);
    for (let j = 0; j < 5; j++) {
      const lng = rnd() * 360 - 180, lat = rnd() * 170 - 85;
      const got = applyMatrix(m, projectPoint(lng, lat, from));
      const want = projectPoint(lng, lat, to);
      assert.ok(Math.abs(got[0] - want[0]) < 1e-6, `pair ${i} x ${lng},${lat}`);
      assert.ok(Math.abs(got[1] - want[1]) < 1e-6, `pair ${i} y ${lng},${lat}`);
    }
  }
});

test("cameraMatrix is identity for the same camera and null when singular", () => {
  const cam = { center: [10, 20], zoom: 3, bearing: 30, pitch: 20 };
  const m = cameraMatrix(cam, cam);
  assert.ok(m);
  assert.ok(Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9);
  assert.ok(Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9);
  const flat = { center: [0, 0], zoom: 2, bearing: 0, pitch: 90 };
  assert.equal(cameraMatrix(cam, flat), null);
});
