// Compile tests: no browser, fast.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileScene } from "../../src/renderer/compile.mjs";
import { loadScene, validateScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "scene-min.json");

test("compile scene-min: page holds nodes, font-face, __hme, no network", () => {
  const scene = loadScene(FIXTURE);
  assert.deepEqual(validateScene(scene).errors, []);
  const { html, errors } = compileScene(scene, dirname(FIXTURE));
  assert.deepEqual(errors, []);
  assert.match(html, /data-node="title"/);
  assert.match(html, /data-node="bar"/);
  assert.match(html, /@font-face/);
  assert.match(html, /window\.__hme/);
  assert.match(html, /Headless motion engine/);
  assert.doesNotMatch(html, /https:\/\/cdn/);
  assert.doesNotMatch(html, /src="https:/);
});

test("compile: missing font file is FONT_MISSING", () => {
  const scene = loadScene(FIXTURE);
  scene.fonts = [{ family: "Nope", weight: 700, src: "fonts/does-not-exist.ttf" }];
  scene.nodes[0].props.font.family = "Nope";
  const { errors } = compileScene(scene, dirname(FIXTURE));
  assert.equal(errors[0].code, "FONT_MISSING");
});

test("compile: text-sample module script parses, no duplicate declarations", async () => {
  // The strip-imports bundling concatenates several modules into one
  // <script type="module">. Two files once declared the same top-level
  // name (clamp01, scene), which failed the whole page silently.
  const { execFileSync } = await import("node:child_process");
  const scene = loadScene(resolve(HERE, "..", "fixtures", "text-sample.json"));
  assert.deepEqual(validateScene(scene).errors, []);
  const { html, errors } = compileScene(scene, resolve(HERE, "..", "fixtures"));
  assert.deepEqual(errors, []);
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, "module script present");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(resolve(tmpdir(), "hme-module-"));
  const file = resolve(dir, "module.mjs");
  writeFileSync(file, m[1]);
  execFileSync(process.execPath, ["--check", file]);
});

test("compile: missing image file is ASSET_MISSING", () => {
  const scene = loadScene(FIXTURE);
  scene.nodes.push({
    id: "pic", type: "image", parent: null, z: 0,
    box: { x: 0, y: 0, w: 10, h: 10 },
    props: { src: "nope.png", fit: "cover" },
  });
  const { errors } = compileScene(scene, dirname(FIXTURE));
  assert.equal(errors[0].code, "ASSET_MISSING");
});
