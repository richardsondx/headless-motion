// Image filter tests: schema, compile output, runtime per-frame values,
// and determinism. No browser for the schema and compile checks; the
// runtime check drives the compiled page in Chromium like render.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { compileScene } from "../../src/renderer/compile.mjs";
import { findChrome } from "../../src/renderer/render.mjs";
import { loadScene, validateScene } from "../../src/scene/validate.mjs";
import { sampleScene } from "../../src/scene/evaluate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SHOWCASE = resolve(HERE, "..", "fixtures", "showcase");
const CLI = resolve(ROOT, "src", "renderer", "cli.mjs");

// One image node over the tracked showcase fixture. The scene carries
// no fonts, so compile needs no font files in the scene directory.
function sceneWith(filter, extraTimeline = []) {
  return {
    schema: "hme.scene/1.0",
    meta: { id: "image-filters", fps: 24, width: 1920, height: 1080, duration: 25, seed: 7, register: "dark" },
    fonts: [],
    palette: { ground: "#101820", ink: "#f4f1ea" },
    nodes: [
      {
        id: "pic", type: "image", parent: null, z: 0,
        box: { x: 0, y: 0, w: 912, h: 560 },
        props: { src: "assets/content-top-v2.png", fit: "cover", ...(filter ? { filter } : {}) },
      },
    ],
    timeline: extraTimeline,
    events: [],
  };
}

function imgTag(html) {
  const m = html.match(/<img[^>]*>/);
  assert.ok(m, "img tag present");
  return m[0];
}

test("schema accepts in-range filter values", () => {
  for (const filter of [{ grayscale: 0 }, { grayscale: 1 }, { blur: 0 }, { blur: 12 }, { grayscale: 1, blur: 12 }, { grayscale: 0.5, blur: 2.5 }]) {
    const { errors } = validateScene(sceneWith(filter));
    assert.deepEqual(errors, [], `filter ${JSON.stringify(filter)} must validate`);
  }
  assert.deepEqual(validateScene(sceneWith(undefined)).errors, []);
});

test("schema rejects out-of-range filter values", () => {
  for (const filter of [{ grayscale: 1.5 }, { grayscale: -0.1 }, { blur: -1 }, { grayscale: 2, blur: -3 }]) {
    const { errors } = validateScene(sceneWith(filter));
    assert.ok(errors.length > 0, `filter ${JSON.stringify(filter)} must fail`);
  }
});

test("filter tracks are animatable and sample per frame", () => {
  const scene = sceneWith({ blur: 12 }, [
    { node: "pic", prop: "props.filter.blur", keys: [{ f: 0, v: 12 }, { f: 24, v: 0 }] },
  ]);
  assert.deepEqual(validateScene(scene).errors, []);
  assert.equal(sampleScene(scene, 0)["pic"]["props.filter.blur"], 12);
  assert.equal(sampleScene(scene, 12)["pic"]["props.filter.blur"], 6);
  assert.equal(sampleScene(scene, 24)["pic"]["props.filter.blur"], 0);
  const gray = sceneWith({ grayscale: 0 }, [
    { node: "pic", prop: "props.filter.grayscale", keys: [{ f: 0, v: 0 }, { f: 24, v: 1 }] },
  ]);
  assert.deepEqual(validateScene(gray).errors, []);
  assert.equal(sampleScene(gray, 24)["pic"]["props.filter.grayscale"], 1);
});

test("compile writes the exact filter string on the img", () => {
  const cases = [
    [{ grayscale: 1 }, "grayscale(1)"],
    [{ blur: 12 }, "blur(12px)"],
    [{ grayscale: 1, blur: 12 }, "grayscale(1) blur(12px)"],
  ];
  for (const [filter, want] of cases) {
    const scene = sceneWith(filter);
    assert.deepEqual(validateScene(scene).errors, []);
    const { html, errors } = compileScene(scene, SHOWCASE);
    assert.deepEqual(errors, []);
    assert.ok(imgTag(html).includes(`;filter:${want}"`), `img must hold filter:${want}, got ${imgTag(html)}`);
  }
});

test("compile writes no filter when the node has none", () => {
  const { html, errors } = compileScene(sceneWith(undefined), SHOWCASE);
  assert.deepEqual(errors, []);
  assert.doesNotMatch(imgTag(html), /filter:/);
});

test("runtime applies sampled filter values per frame", async () => {
  const scene = sceneWith({ grayscale: 1, blur: 12 }, [
    { node: "pic", prop: "props.filter.blur", keys: [{ f: 0, v: 12 }, { f: 24, v: 0 }] },
  ]);
  assert.deepEqual(validateScene(scene).errors, []);
  const { html, errors } = compileScene(scene, SHOWCASE);
  assert.deepEqual(errors, []);
  const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => window.__hme.ready);
    const filterAt = (f) => page.evaluate((frame) => window.__hme.seek(frame).then(() => document.querySelector("img").style.filter), f);
    assert.equal(await filterAt(0), "grayscale(1) blur(12px)");
    assert.equal(await filterAt(12), "grayscale(1) blur(6px)");
    assert.equal(await filterAt(24), "grayscale(1) blur(0px)");
  } finally {
    await browser.close();
  }
});

test("runtime applies a filter that only a track adds", async () => {
  const scene = sceneWith(undefined, [
    { node: "pic", prop: "props.filter.blur", keys: [{ f: 0, v: 8 }, { f: 24, v: 0 }] },
  ]);
  assert.deepEqual(validateScene(scene).errors, []);
  const { html, errors } = compileScene(scene, SHOWCASE);
  assert.deepEqual(errors, []);
  const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => window.__hme.ready);
    const filterAt = (f) => page.evaluate((frame) => window.__hme.seek(frame).then(() => document.querySelector("img").style.filter), f);
    assert.equal(await filterAt(0), "blur(8px)");
    assert.equal(await filterAt(24), "blur(0px)");
  } finally {
    await browser.close();
  }
});

test("determinism: filter scene renders twice with identical frames", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "hme-image-filters-"));
  const sceneFile = resolve(dir, "scene.json");
  copyFileSync(resolve(SHOWCASE, "assets", "content-top-v2.png"), resolve(dir, "photo.png"));
  const scene = sceneWith({ grayscale: 1, blur: 12 }, [
    { node: "pic", prop: "props.filter.blur", keys: [{ f: 0, v: 12 }, { f: 24, v: 0 }] },
  ]);
  scene.nodes[0].props.src = "photo.png";
  writeFileSync(sceneFile, JSON.stringify(scene));
  assert.deepEqual(validateScene(loadScene(sceneFile)).errors, []);
  const out = resolve(dir, "render");
  const r = await new Promise((resolveP) => {
    execFile("node", [CLI, "render", sceneFile, "--profile", "previs", "--out", out, "--frames", "0:3", "--verify-determinism"], { cwd: ROOT, timeout: 300000 }, (err, stdout, stderr) => resolveP({ code: err ? err.code : 0, stdout, stderr }));
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK deterministic/);
});
