// Failure tests: each exits with the stated code and writes a report
// with the right code and stage.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScene } from "../../src/scene/validate.mjs";

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

function writeScene(name, mutate) {
  const scene = loadScene(FIXTURE);
  // Scenes are written to .tmp/fail-scenes, so point the font at the real
  // fixture file by absolute path; only the mutated part should fail.
  // scene-min's title uses Montserrat Bold since the v2 font wiring
  // (2026-11-07), so the helper must declare Montserrat, not FixtureSans.
  scene.fonts = [{ family: "Montserrat", weight: 700, src: resolve(HERE, "..", "fixtures", "fonts", "Montserrat-Bold.ttf") }];
  mutate(scene);
  const dir = resolve(ROOT, ".tmp", "fail-scenes");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(scene, null, 2));
  return file;
}

function reportOf(out) {
  return JSON.parse(readFileSync(resolve(out, "render-report.json"), "utf8"));
}

test("font file missing exits 2 with FONT_MISSING", async () => {
  const scene = writeScene("font-missing", (s) => {
    s.fonts = [{ family: "Nope", weight: 700, src: "fonts/does-not-exist.ttf" }];
    s.nodes[0].props.font.family = "Nope";
  });
  const out = resolve(ROOT, ".tmp", "fail-font");
  const r = await runCli(["render", scene, "--profile", "previs", "--out", out, "--frames", "0:2"]);
  assert.equal(r.code, 2, r.stderr);
  const rep = reportOf(out);
  assert.equal(rep.code, "FONT_MISSING");
  assert.equal(rep.status, "failed");
});

test("scene referencing an https image exits 4 with NETWORK_BLOCKED", async () => {
  const scene = writeScene("https-image", (s) => {
    s.nodes.push({ id: "pic", type: "image", parent: null, z: 0, box: { x: 0, y: 0, w: 100, h: 100 }, props: { src: "https://example.com/x.png", fit: "cover" } });
  });
  const out = resolve(ROOT, ".tmp", "fail-net");
  const r = await runCli(["render", scene, "--profile", "previs", "--out", out, "--frames", "0:2"]);
  assert.equal(r.code, 4, r.stderr);
  assert.equal(reportOf(out).code, "NETWORK_BLOCKED");
});

test("module waiter that never resolves exits 4 with MODULE_WAIT_TIMEOUT", async () => {
  const out = resolve(ROOT, ".tmp", "fail-wait");
  const r = await runCli(["render", FIXTURE, "--profile", "previs", "--out", out, "--frames", "0:2"], { HME_TEST_HANG_WAITER: "1" });
  assert.equal(r.code, 4, r.stderr);
  assert.equal(reportOf(out).code, "MODULE_WAIT_TIMEOUT");
});

test("bad CRF flag exits 5 with ENCODE_FAIL", async () => {
  const out = resolve(ROOT, ".tmp", "fail-crf");
  const r = await runCli(["render", FIXTURE, "--profile", "previs", "--out", out, "--frames", "0:2"], { HME_CRF: "abc" });
  assert.equal(r.code, 5, r.stderr);
  assert.equal(reportOf(out).code, "ENCODE_FAIL");
});

test("CHROME_PATH set to a missing file exits 3 with BROWSER_LAUNCH", async () => {
  const out = resolve(ROOT, ".tmp", "fail-chrome");
  const r = await runCli(["render", FIXTURE, "--profile", "previs", "--out", out, "--frames", "0:2"], { CHROME_PATH: "/no/such/chrome" });
  assert.equal(r.code, 3, r.stderr);
  assert.equal(reportOf(out).code, "BROWSER_LAUNCH");
});
