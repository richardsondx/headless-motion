// Camera renders: marker geometry under static zoom, push-in, and zoom
// toward a point, plus CLI determinism on the camera fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { compileScene } from "../../src/renderer/compile.mjs";
import { findChrome } from "../../src/renderer/render.mjs";
import { loadScene, validateScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const FIXTURE = resolve(HERE, "..", "fixtures", "camera-sample.json");
const CLI = resolve(ROOT, "src", "renderer", "cli.mjs");

function runCli(args, env = {}) {
  return new Promise((resolveP) => {
    execFile("node", [CLI, ...args], { cwd: ROOT, env: { ...process.env, ...env }, timeout: 300000 }, (err, stdout, stderr) => {
      resolveP({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

const clone = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

/** Centre of a marker div on screen, after seek. */
async function markerCentres(page, scene, frame) {
  await page.evaluate((f) => window.__hme.seek(f), frame);
  return page.evaluate(() => {
    const centre = (id) => {
      const r = document.querySelector(`[data-node="${id}"]`).getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    return { center: centre("dot-center"), far: centre("dot-far") };
  });
}

async function openScene(scene) {
  assert.deepEqual(validateScene(scene).errors, []);
  const { html, errors } = compileScene(scene, dirname(FIXTURE));
  assert.deepEqual(errors, []);
  const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => window.__hme.ready);
  return { browser, page };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test("static zoom 2 about the frame center doubles the far marker distance", async () => {
  const s = clone();
  s.timeline = [];
  s.camera = { center: [960, 540], zoom: 2 };
  const { browser, page } = await openScene(s);
  try {
    const at0 = await markerCentres(page, s, 0);
    const plain = clone();
    plain.timeline = [];
    const { browser: b2, page: p2 } = await openScene(plain);
    try {
      const base = await markerCentres(p2, plain, 0);
      assert.ok(dist(at0.center, [960, 540]) < 2, `center marker moved: ${at0.center}`);
      assert.ok(Math.abs(dist(at0.center, base.center)) < 2, "center marker stays put");
      assert.ok(Math.abs(dist(at0.far, [960, 540]) - 800) < 2, `far marker at ${dist(at0.far, [960, 540])}, want 800`);
    } finally {
      await b2.close();
    }
  } finally {
    await browser.close();
  }
});

test("animated push-in grows the far marker distance by 5 percent", async () => {
  const s = clone();
  const { browser, page } = await openScene(s);
  try {
    const first = await markerCentres(page, s, 0);
    const last = await markerCentres(page, s, 108);
    const d0 = dist(first.far, [960, 540]);
    const d1 = dist(last.far, [960, 540]);
    const growth = (d1 - d0) / d0;
    assert.ok(Math.abs(d0 - 400) < 2, `frame 0 distance ${d0}, want 400`);
    assert.ok(Math.abs(growth - 0.05) < 0.005, `growth ${growth}, want 0.05 within 0.005`);
  } finally {
    await browser.close();
  }
});

test("zoom toward a point keeps that point fixed", async () => {
  const s = clone();
  s.timeline = [];
  s.camera = { center: [1360, 540], zoom: 1.5 };
  const { browser, page } = await openScene(s);
  try {
    const at0 = await markerCentres(page, s, 0);
    const plain = clone();
    plain.timeline = [];
    const { browser: b2, page: p2 } = await openScene(plain);
    try {
      const base = await markerCentres(p2, plain, 0);
      assert.ok(dist(at0.far, base.far) < 2, `fixed point moved: ${at0.far} vs ${base.far}`);
      assert.ok(Math.abs(dist(at0.center, [1360, 540]) - 600) < 2, `center marker at ${dist(at0.center, [1360, 540])} from point, want 600`);
    } finally {
      await b2.close();
    }
  } finally {
    await browser.close();
  }
});

test("camera scene renders deterministically through the CLI", async () => {
  const out = resolve(ROOT, ".tmp", "test-camera-det");
  const r = await runCli(["render", FIXTURE, "--profile", "previs", "--out", out, "--frames", "0:12", "--verify-determinism"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK deterministic/);
});
