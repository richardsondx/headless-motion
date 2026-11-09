// Vertical profile renders: 1080x1920 at 24 fps, deterministic, and the
// aspect guard fails loudly on a size mismatch. Short frame ranges only;
// the full 48-frame render is run once by hand (see the run report).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const VERTICAL = resolve(HERE, "..", "fixtures", "scene-vertical-min.json");
const LANDSCAPE = resolve(HERE, "..", "fixtures", "scene-min.json");
const CLI = resolve(ROOT, "src", "renderer", "cli.mjs");

function runCli(args, env = {}) {
  return new Promise((resolveP) => {
    execFile("node", [CLI, ...args], { cwd: ROOT, env: { ...process.env, ...env }, timeout: 300000 }, (err, stdout, stderr) => {
      resolveP({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

function ffprobe(file) {
  return new Promise((resolveP, rejectP) => {
    execFile("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", file], { timeout: 60000 }, (err, stdout) => {
      if (err) return rejectP(err);
      resolveP(JSON.parse(stdout));
    });
  });
}

test("vertical 24 frames renders 1080x1920 h264 at 24 fps", async () => {
  const out = resolve(ROOT, ".tmp", "test-vertical-24");
  const r = await runCli(["render", VERTICAL, "--profile", "vertical", "--out", out, "--frames", "0:24"]);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(readFileSync(resolve(out, "render-report.json"), "utf8"));
  assert.equal(report.status, "ok");
  assert.equal(report.frames_captured, 24);
  assert.ok(existsSync(resolve(out, "video.mp4")));
  const probe = await ffprobe(resolve(out, "video.mp4"));
  const stream = probe.streams.find((s) => s.codec_type === "video");
  assert.equal(stream.codec_name, "h264");
  assert.equal(stream.width, 1080);
  assert.equal(stream.height, 1920);
  assert.equal(stream.r_frame_rate, "24/1");
  assert.equal(Number(stream.nb_frames), 24);
});

test("determinism on vertical, 12 frames, two runs match", async () => {
  const out = resolve(ROOT, ".tmp", "test-vertical-det");
  const r = await runCli(["render", VERTICAL, "--profile", "vertical", "--out", out, "--frames", "0:12", "--verify-determinism"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK deterministic vertical/);
});

test("landscape scene under vertical fails loudly with SCENE_INVALID", async () => {
  const out = resolve(ROOT, ".tmp", "test-vertical-bad-land");
  const r = await runCli(["render", LANDSCAPE, "--profile", "vertical", "--out", out, "--frames", "0:4"]);
  assert.notEqual(r.code, 0);
  const report = JSON.parse(readFileSync(resolve(out, "render-report.json"), "utf8"));
  assert.equal(report.status, "failed");
  assert.equal(report.code, "SCENE_INVALID");
  assert.match(report.message, /aspect mismatch/);
});

test("vertical scene under final fails loudly with SCENE_INVALID", async () => {
  const out = resolve(ROOT, ".tmp", "test-vertical-bad-vert");
  const r = await runCli(["render", VERTICAL, "--profile", "final", "--out", out, "--frames", "0:4"]);
  assert.notEqual(r.code, 0);
  const report = JSON.parse(readFileSync(resolve(out, "render-report.json"), "utf8"));
  assert.equal(report.status, "failed");
  assert.equal(report.code, "SCENE_INVALID");
  assert.match(report.message, /aspect mismatch/);
});
