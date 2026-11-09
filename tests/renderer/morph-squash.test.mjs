// U3 morph plus squash, render side: the real compiled page updates
// d per frame, the morph has no jump over 4 px, the mid-frame node
// matches interpolation within 0.001, squash bbox factors match
// within 1 percent, and deform moves one named node only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { compileScene } from "../../src/renderer/compile.mjs";
import { findChrome } from "../../src/renderer/render.mjs";
import { loadScene, validateScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");

async function openPage(t, fixtureName) {
  const scene = loadScene(resolve(FIXTURES, fixtureName));
  assert.deepEqual(validateScene(scene).errors, []);
  const { html, errors } = compileScene(scene, FIXTURES);
  assert.deepEqual(errors, []);
  const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-sandbox", "--disable-gpu"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => window.__hme.ready);
  return { page, scene };
}

/** Numbers in a d string, in order. */
const nums = (d) => (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

test("morph renders 24 frames: max jump 1 px, mid-frame x is 212", async (t) => {
  const { page } = await openPage(t, "path-points.json");
  const xs = [];
  for (let f = 0; f < 24; f++) {
    const d = await page.evaluate((frame) => window.__hme.seek(frame).then(() =>
      document.querySelector('[data-node="outline"] path').getAttribute("d")), f);
    // Compiled d: M 0 0 L <p2x> 0 C ... The L pair is numbers 2 and 3.
    const n = nums(d);
    xs.push(n[2]);
    assert.equal(n[3], 0, `frame ${f}: p2 y moved`);
  }
  assert.deepEqual(xs[0], 200);
  assert.deepEqual(xs[12], 212);
  assert.deepEqual(xs[23], 223);
  let maxJump = 0;
  for (let i = 1; i < xs.length; i++) maxJump = Math.max(maxJump, Math.abs(xs[i] - xs[i - 1]));
  assert.equal(maxJump, 1, `max frame-to-frame jump is ${maxJump} px`);
  assert.ok(Math.abs(xs[12] - 212) < 0.001, `mid-frame x is ${xs[12]}, expected 212`);
});

test("squash bbox factors match 1.5 and 0.5 within 1 percent", async (t) => {
  const { page } = await openPage(t, "path-squash.json");
  const box = await page.evaluate(() => window.__hme.seek(0).then(() => {
    const path = document.querySelector('[data-node="squash"] path');
    const b = path.getBBox();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }));
  // Base outline spans 200 x 150. Anchor (100, 75) keeps the centre:
  // x -50..250, y 37.5..112.5.
  assert.ok(Math.abs(box.width / 200 - 1.5) < 0.01, `width factor is ${box.width / 200}`);
  assert.ok(Math.abs(box.height / 150 - 0.5) < 0.01, `height factor is ${box.height / 150}`);
  assert.ok(Math.abs(box.x - -50) < 0.001, `bbox x is ${box.x}, expected -50`);
  assert.ok(Math.abs(box.y - 37.5) < 0.001, `bbox y is ${box.y}, expected 37.5`);
});

test("vertex deform renders the moved node only", async (t) => {
  const { page } = await openPage(t, "path-squash.json");
  const d = await page.evaluate(() => window.__hme.seek(0).then(() =>
    document.querySelector('[data-node="deform"] path').getAttribute("d")));
  // p2 anchor moved 200 -> 210, so the L pair reads 210 0. The rest
  // of the outline is unchanged.
  assert.equal(d, "M 0 0 L 210 0 C 210 60 200 100 200 150 C 140 150 60 150 0 150 Z");
});

test("frame 0 d from the page matches the compiled static d", async (t) => {
  const { page } = await openPage(t, "path-points.json");
  const d = await page.evaluate(() => window.__hme.seek(0).then(() =>
    document.querySelector('[data-node="outline"] path').getAttribute("d")));
  assert.equal(d, "M 0 0 L 200 0 C 200 60 200 100 200 150 C 140 150 60 150 0 150 Z");
});
