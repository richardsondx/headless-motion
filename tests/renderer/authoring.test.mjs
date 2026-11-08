// Authoring tests: --set flags and compact scene files change one label or
// number without editing the base scene, and render-report.md records real
// wall time while render-report.json stays deterministic (elapsed_s 0).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const TEXT = resolve(HERE, "..", "fixtures", "text-sample.json");
const COMPACT = resolve(HERE, "..", "fixtures", "text-sample.compact.json");
const CLI = resolve(ROOT, "src", "renderer", "cli.mjs");

function runCli(args, env = {}) {
  return new Promise((resolveP) => {
    execFile("node", [CLI, ...args], { cwd: ROOT, env: { ...process.env, ...env }, timeout: 300000 }, (err, stdout, stderr) => {
      resolveP({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

function reportOf(out) {
  return JSON.parse(readFileSync(resolve(out, "render-report.json"), "utf8"));
}

function reportMdOf(out) {
  return readFileSync(resolve(out, "render-report.md"), "utf8");
}

test("--set changes the title and records the override", async () => {
  const base = resolve(ROOT, ".tmp", "test-set-base");
  const edited = resolve(ROOT, ".tmp", "test-set-edited");
  const rb = await runCli(["render", TEXT, "--profile", "previs", "--out", base, "--frames", "0:12"]);
  assert.equal(rb.code, 0, rb.stderr);
  const re = await runCli(["render", TEXT, "--profile", "previs", "--out", edited, "--frames", "0:12", "--set", 'nodes.title.props.text="VIEWS"']);
  assert.equal(re.code, 0, re.stderr);
  const rep = reportOf(edited);
  assert.equal(rep.status, "ok");
  assert.equal(rep.elapsed_s, 0, "JSON report must stay free of wall time");
  assert.deepEqual(rep.overrides, ['nodes.title.props.text="VIEWS"']);
  const md = reportMdOf(edited);
  assert.match(md, /wall_s: \d+(\.\d+)?/);
  assert.match(md, /overrides: nodes\.title\.props\.text="VIEWS"/);
  const hb = JSON.parse(readFileSync(resolve(base, "frame-hashes.json"), "utf8"));
  const he = JSON.parse(readFileSync(resolve(edited, "frame-hashes.json"), "utf8"));
  assert.ok(Object.keys(hb).some((f) => hb[f] !== he[f]), "changed title must change at least one frame");
});

test("compact scene file renders its base with its set", async () => {
  const out = resolve(ROOT, ".tmp", "test-compact");
  const r = await runCli(["render", COMPACT, "--profile", "previs", "--out", out, "--frames", "0:12"]);
  assert.equal(r.code, 0, r.stderr);
  const rep = reportOf(out);
  assert.equal(rep.status, "ok");
  assert.ok(rep.overrides.some((o) => o.includes("nodes.title.props.text")));
  assert.ok(rep.overrides.some((o) => o.includes("nodes.views.props.to")));
  assert.ok(existsSync(resolve(out, "video.mp4")));
  assert.match(reportMdOf(out), /wall_s: \d+(\.\d+)?/);
});

test("--set with an unknown node exits 2", async () => {
  const out = resolve(ROOT, ".tmp", "test-set-bad");
  const r = await runCli(["render", TEXT, "--profile", "previs", "--out", out, "--frames", "0:12", "--set", "nodes.nope.props.text=X"]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /no node nope/);
});

test("--set with an unsupported path exits 2", async () => {
  const out = resolve(ROOT, ".tmp", "test-set-badpath");
  const r = await runCli(["render", TEXT, "--profile", "previs", "--out", out, "--frames", "0:12", "--set", "duration=10"]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /unsupported path duration/);
});
