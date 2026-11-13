// Box-size tests: a box.w / box.h track changes the rendered rect and
// ellipse size, a static rect renders exactly as before, and a points
// shape div is never resized. The runtime check drives the compiled
// page in Chromium like render.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { compileScene } from "../../src/renderer/compile.mjs";
import { findChrome } from "../../src/renderer/render.mjs";
import { loadScene, validateScene } from "../../src/scene/validate.mjs";
import { sampleScene } from "../../src/scene/evaluate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "box-size.json");

test("box.w and box.h tracks validate and sample per frame", () => {
  const scene = loadScene(FIXTURE);
  assert.deepEqual(validateScene(scene).errors, []);
  assert.equal(sampleScene(scene, 0).bar["box.w"], 0);
  assert.equal(sampleScene(scene, 0).bar["box.h"], 30);
  assert.equal(sampleScene(scene, 24).bar["box.w"], 325);
  assert.equal(sampleScene(scene, 24).bar["box.h"], 60);
  assert.equal(sampleScene(scene, 48).bar["box.w"], 650);
  assert.equal(sampleScene(scene, 48).bar["box.h"], 90);
  assert.equal(sampleScene(scene, 24).dot["box.w"], 150);
  assert.equal(sampleScene(scene, 24).dot["box.h"], 100);
  assert.equal(sampleScene(scene, 24).static["box.w"], 200);
});

test("runtime writes sampled box size to rect and ellipse divs", async () => {
  const scene = loadScene(FIXTURE);
  assert.deepEqual(validateScene(scene).errors, []);
  const { html } = compileScene(scene, dirname(FIXTURE));
  const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => window.__hme.ready);
    const measure = (frame) =>
      page.evaluate(async (f) => {
        await window.__hme.seek(f);
        const out = {};
        for (const id of ["bar", "static", "dot", "arrow"]) {
          const el = document.querySelector(`[data-node="${id}"]`);
          const r = el.getBoundingClientRect();
          out[id] = { styleW: el.style.width, styleH: el.style.height, w: r.width, h: r.height };
        }
        const path = document.querySelector('[data-node="arrow"] path');
        out.arrow.d = path ? path.getAttribute("d") : null;
        return out;
      }, frame);
    const at0 = await measure(0);
    assert.equal(at0.bar.w, 0);
    assert.equal(at0.bar.h, 30);
    assert.equal(at0.dot.w, 100);
    const at24 = await measure(24);
    assert.equal(at24.bar.styleW, "325px");
    assert.equal(at24.bar.styleH, "60px");
    assert.equal(at24.bar.w, 325);
    assert.equal(at24.bar.h, 60);
    assert.equal(at24.dot.styleW, "150px");
    assert.equal(at24.dot.styleH, "100px");
    assert.equal(at24.dot.w, 150);
    assert.equal(at24.dot.h, 100);
    const at48 = await measure(48);
    assert.equal(at48.bar.w, 650);
    assert.equal(at48.bar.h, 90);
    assert.equal(at48.dot.w, 200);
    // Static rect: exactly its compiled size at every frame.
    for (const m of [at0, at24, at48]) {
      assert.equal(m.static.styleW, "200px");
      assert.equal(m.static.styleH, "50px");
      assert.equal(m.static.w, 200);
      assert.equal(m.static.h, 50);
    }
    // Points shape: div size never touched, path d unchanged.
    for (const m of [at0, at24, at48]) {
      assert.equal(m.arrow.styleW, "240px");
      assert.equal(m.arrow.styleH, "240px");
      assert.equal(m.arrow.w, 240);
      assert.equal(m.arrow.h, 240);
    }
    assert.equal(at24.arrow.d, at0.arrow.d);
  } finally {
    await browser.close();
  }
});

test("compile writes the static rect size into the div", () => {
  const scene = loadScene(FIXTURE);
  const { html } = compileScene(scene, dirname(FIXTURE));
  assert.match(html, /data-node="static"[^>]*width:200px;height:50px/);
  assert.match(html, /data-node="bar"[^>]*width:0px;height:30px/);
});
