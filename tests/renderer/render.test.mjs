// Render tests: browser, short frame ranges to stay fast. Full 240-frame
// renders are run once by hand (see the run report), not in this suite.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { compileScene } from "../../src/renderer/compile.mjs";
import { findChrome } from "../../src/renderer/render.mjs";
import { loadScene, validateScene } from "../../src/scene/validate.mjs";
import { sampleScene } from "../../src/scene/evaluate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const FIXTURE = resolve(HERE, "..", "fixtures", "scene-min.json");
const CLI = resolve(ROOT, "src", "renderer", "cli.mjs");

function runCli(args, env = {}) {
  return new Promise((resolveP) => {
    execFile("node", [CLI, ...args], { cwd: ROOT, env: { ...process.env, ...env }, timeout: 300000 }, (err, stdout, stderr) => {
      resolveP({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test("previs 24 frames renders, probe matches, frame hashes exist", async () => {
  const out = resolve(ROOT, ".tmp", "test-previs-24");
  const r = await runCli(["render", FIXTURE, "--profile", "previs", "--out", out, "--frames", "0:24"]);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(readFileSync(resolve(out, "render-report.json"), "utf8"));
  assert.equal(report.status, "ok");
  assert.equal(report.frames_captured, 24);
  const hashes = JSON.parse(readFileSync(resolve(out, "frame-hashes.json"), "utf8"));
  assert.equal(Object.keys(hashes).length, 24);
  assert.ok(existsSync(resolve(out, "video.mp4")));
  assert.ok(existsSync(resolve(out, "page.html")));
});

test("seek order: frames 20,5,12 then 5,12,20 give identical hashes", async () => {
  const a = resolve(ROOT, ".tmp", "test-order-a");
  const b = resolve(ROOT, ".tmp", "test-order-b");
  const ra = await runCli(["render", FIXTURE, "--profile", "previs", "--out", a, "--order", "20,5,12"]);
  const rb = await runCli(["render", FIXTURE, "--profile", "previs", "--out", b, "--order", "5,12,20"]);
  assert.equal(ra.code, 0, ra.stderr);
  assert.equal(rb.code, 0, rb.stderr);
  const ha = JSON.parse(readFileSync(resolve(a, "frame-hashes.json"), "utf8"));
  const hb = JSON.parse(readFileSync(resolve(b, "frame-hashes.json"), "utf8"));
  for (const f of ["5", "12", "20"]) assert.equal(ha[f], hb[f], `frame ${f} differs by seek order`);
});

test("page equals evaluator at frames 0, 1, 119, 239", async () => {
  const scene = loadScene(FIXTURE);
  assert.deepEqual(validateScene(scene).errors, []);
  const { html } = compileScene(scene, dirname(FIXTURE));
  const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => window.__hme.ready);
    for (const f of [0, 1, 119, 239]) {
      const dom = await page.evaluate((frame) => window.__hme.seek(frame).then((s) => s), f);
      const expected = sampleScene(scene, f);
      for (const nodeId of Object.keys(expected)) {
        for (const key of Object.keys(expected[nodeId])) {
          const a = dom[nodeId][key];
          const b = expected[nodeId][key];
          if (typeof a === "number" && typeof b === "number") assert.ok(Math.abs(a - b) < 1e-6, `${nodeId}.${key} frame ${f}: ${a} vs ${b}`);
          else assert.deepEqual(a, b, `${nodeId}.${key} frame ${f}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
});

test("determinism on previs, 12 frames, two runs match", async () => {
  const out = resolve(ROOT, ".tmp", "test-det");
  const r = await runCli(["render", FIXTURE, "--profile", "previs", "--out", out, "--frames", "0:12", "--verify-determinism"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK deterministic/);
});
