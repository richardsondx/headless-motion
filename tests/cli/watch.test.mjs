// Tests for `hme render --watch`. The page and the server are
// covered without a render; the end-to-end test runs a real 11-frame
// previs render of scene-min, watches the page while it runs, then
// stops the server with SIGINT.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWatchPage, startWatchServer, DEFAULT_WATCH_PORT } from "../../src/cli/watch.mjs";
import { writeWatchState, readWatchState } from "../../src/renderer/watch-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });
const MIN = join(ROOT, "tests", "fixtures", "scene-min.json");

const get = (url) => new Promise((resolvePromise, rejectPromise) => {
  const req = fetch(url);
  req.then(resolvePromise, rejectPromise);
});

test("render --help names --watch and --port", () => {
  const r = run(["render", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("--watch"));
  assert.ok(r.stdout.includes("--port"));
});

test("render --watch with --verify-determinism exits 2", () => {
  const r = run(["render", MIN, "--profile", "previs", "--watch", "--verify-determinism"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--watch does not apply with --verify-determinism"));
});

test("render --watch with preview-rt exits 2", () => {
  const r = run(["render", MIN, "--profile", "preview-rt", "--watch"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--watch does not apply with preview-rt"));
});

test("render --port without --watch exits 2", () => {
  const r = run(["render", MIN, "--profile", "previs", "--port", "8123"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--port needs --watch"));
});

test("render --watch with a bad --port exits 2", () => {
  const r = run(["render", MIN, "--profile", "previs", "--watch", "--port", "99999"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--port needs a whole number"));
});

test("buildWatchPage shows the latest frame while rendering, no timeline controls", () => {
  const page = buildWatchPage({
    scene: "scene-min.json", profile: "previs",
    state: { status: "rendering", frame: 5, frames_total: 11, frames_captured: 6 },
    videoFile: "video.mp4", videoReady: false,
  });
  assert.ok(page.includes("/latest.png?v=5"));
  assert.ok(page.includes("Rendering frame 5 of 11"));
  assert.ok(page.includes('http-equiv="refresh"'), "rendering page refreshes itself");
  assert.ok(!page.includes("<input"), "no controls on the watch page");
  assert.ok(!page.includes("seek"), "no seeking on the watch page");
  assert.ok(!page.includes("timeline"), "no timeline on the watch page");
});

test("buildWatchPage shows the finished video when done", () => {
  const page = buildWatchPage({
    scene: "scene-min.json", profile: "previs",
    state: { status: "done", frame: 11, frames_total: 11, frames_captured: 11 },
    videoFile: "video.mp4", videoReady: true,
  });
  assert.ok(page.includes("video.mp4"));
  assert.ok(page.includes("Done."));
  assert.ok(page.includes("controls"), "done video has play, pause, and seek controls");
  assert.ok(!page.includes("autoplay"), "done video must not autoplay: a short clip finishes before the user sees it");
  assert.ok(!page.includes("loop"), "done video must not loop: it stops at the end and offers replay");
  assert.ok(page.includes('id="watch-play"'), "done page has its own large play button over the first frame");
  assert.ok(page.includes("onended"), "play button comes back when the video ends, so replay is one click");
  assert.ok(!page.includes('http-equiv="refresh"'), "done page must not reload and restart the video");
});

test("buildWatchPage names the failure when the render fails", () => {
  const page = buildWatchPage({
    scene: "scene-min.json", profile: "previs",
    state: { status: "failed", frame: 0, frames_total: null, frames_captured: 0 },
    videoFile: "video.mp4", videoReady: false,
  });
  assert.ok(page.includes("Render failed"));
});

test("watch state round-trips through files, missing state means starting", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-watch-state-"));
  try {
    assert.equal(readWatchState(dir).status, "starting");
    writeWatchState(dir, { status: "rendering", frame: 3, frames_total: 11, frames_captured: 4 });
    assert.deepEqual(readWatchState(dir), { status: "rendering", frame: 3, frames_total: 11, frames_captured: 4 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startWatchServer serves the page, state, frame, and video on localhost only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-watch-server-"));
  let server;
  try {
    writeFileSync(join(dir, "latest.png"), Buffer.from("fake-png"));
    writeWatchState(dir, { status: "rendering", frame: 2, frames_total: 11, frames_captured: 3 });
    server = await startWatchServer({ renderOut: dir, videoFile: "video.mp4", scene: "scene-min.json", profile: "previs", port: DEFAULT_WATCH_PORT });
    assert.ok(server.url.startsWith("http://127.0.0.1:"));
    const page = await get(server.url);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("Rendering frame 2 of 11"));
    const state = await get(`${server.url}watch.json`);
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { status: "rendering", frame: 2, frames_total: 11, frames_captured: 3 });
    const frame = await get(`${server.url}latest.png`);
    assert.equal(frame.status, 200);
    assert.equal((await frame.arrayBuffer()).byteLength, 8);
    const missing = await get(`${server.url}video.mp4`);
    assert.equal(missing.status, 404);
    const unknown = await get(`${server.url}nope`);
    assert.equal(unknown.status, 404);
  } finally {
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render --watch runs a real previs render, shows the frame, then the video", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-watch-e2e-"));
  const renderOut = join(dir, "scene-min-render");
  const out = join(dir, "render.json");
  const child = spawn(process.execPath, [HME, "render", MIN, "--profile", "previs", "--frames", "0:11", "--render-out", renderOut, "--out", out, "--watch", "--port", "0"], { encoding: "utf8" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  try {
    // Wait for the server URL on stderr, then for the done state.
    const url = await new Promise((resolvePromise, rejectPromise) => {
      const deadline = setTimeout(() => rejectPromise(new Error(`no watch URL in stderr: ${stderr}`)), 30000);
      const timer = setInterval(() => {
        const m = stderr.match(/Watch: (http:\/\/127\.0\.0\.1:\d+\/)/);
        if (m) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolvePromise(m[1]);
        }
      }, 200);
    });
    let state = null;
    for (let i = 0; i < 600; i++) {
      try {
        const res = await get(`${url}watch.json`);
        if (res.status === 200) {
          state = await res.json();
          if (state.status === "done") break;
        }
      } catch {
        // Server not up yet, or the render is still starting.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(state, "watch.json never answered");
    assert.equal(state.status, "done", JSON.stringify(state));
    assert.equal(state.frames_captured, 11);
    const frame = await get(`${url}latest.png`);
    assert.equal(frame.status, 200);
    assert.ok((await frame.arrayBuffer()).byteLength > 0, "latest frame must not be empty");
    const page = await get(url);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("Done."));
    const video = await get(`${url}video.mp4`);
    assert.equal(video.status, 200);
    assert.ok((await video.arrayBuffer()).byteLength > 0, "finished video must not be empty");
  } finally {
    child.kill("SIGINT");
    const code = await new Promise((resolvePromise) => child.on("close", resolvePromise));
    assert.equal(code, 0, `stdout: ${stdout} stderr: ${stderr}`);
    assert.ok(existsSync(join(renderOut, "video.mp4")));
    assert.ok(statSync(join(renderOut, "video.mp4")).size > 0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict.status, "PASS");
    assert.ok(report.numbers.watch_url.startsWith("http://127.0.0.1:"));
    rmSync(dir, { recursive: true, force: true });
  }
});
