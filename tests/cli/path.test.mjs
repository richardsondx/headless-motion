// U2 path edit commands: help, move touches one node only, unknown
// ids fail loudly and write nothing, every command edits base plus
// keyframes together.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { applyPathEdit, editPoints, parsePathArgs, rdpKeep } from "../../src/cli/path.mjs";
import { validateScene } from "../../src/scene/validate.mjs";
import { sampleScene } from "../../src/scene/evaluate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const FIXTURE = join(ROOT, "tests", "fixtures", "path-points.json");

const load = () => JSON.parse(readFileSync(FIXTURE, "utf8"));
const run = (args) => spawnSync("node", [HME, ...args], { encoding: "utf8" });
const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hme-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const outline = (scene) => scene.nodes.find((n) => n.id === "outline").props.points;
const trackV = (scene, k) => scene.timeline[0].keys[k].v;

test("hme path --help prints usage, options, and one example, exits clean", () => {
  const r = run(["path", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hme path/);
  assert.match(r.stdout, /--scene/);
  assert.match(r.stdout, /--node/);
  assert.match(r.stdout, /Example: hme path move/);
});

test("move moves one named node by the stated px, and nothing else", (t) => {
  const dir = tmp(t);
  const out = join(dir, "path-points-v2.json");
  const r = run(["path", "move", "--scene", FIXTURE, "--node", "outline", "--point", "p2", "--dx", "12", "--dy", "0", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(out), "output file was not written");
  const before = load();
  const after = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(validateScene(after).errors, []);
  // The diff touches only p2, in the base list and in both keyframes.
  const bPts = outline(before);
  const aPts = outline(after);
  assert.equal(aPts.length, bPts.length);
  for (let i = 0; i < bPts.length; i++) {
    if (bPts[i].id === "p2") {
      assert.deepEqual(aPts[i].anchor, [212, 0]);
      assert.deepEqual(aPts[i].out, [212, 60]);
      assert.equal(aPts[i].in, null);
    } else {
      assert.deepEqual(aPts[i], bPts[i], `point ${bPts[i].id} changed`);
    }
  }
  assert.deepEqual(trackV(after, 0)[1].anchor, [212, 0]);
  assert.deepEqual(trackV(after, 1)[1].anchor, [236, 0]);
  // No other node changes: the whole scene except outline points is identical.
  const strip = (s) => {
    const c = JSON.parse(JSON.stringify(s));
    c.nodes.find((n) => n.id === "outline").props.points = [];
    c.timeline[0].keys.forEach((k) => { k.v = []; });
    return c;
  };
  assert.deepEqual(strip(after), strip(before));
  // The moved node renders moved at frame 0.
  assert.deepEqual(sampleScene(after, 0).outline["props.points"][1].anchor, [212, 0]);
});

test("unknown node id fails loudly with a named error and writes no file", (t) => {
  const dir = tmp(t);
  const out = join(dir, "nope.json");
  const r = run(["path", "move", "--scene", FIXTURE, "--node", "missing-node", "--point", "p2", "--dx", "1", "--dy", "0", "--out", out]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /PATH_UNKNOWN_NODE/);
  assert.equal(existsSync(out), false, "output file was written on a failed edit");
});

test("unknown point id fails loudly with a named error and writes no file", (t) => {
  const dir = tmp(t);
  const out = join(dir, "nope.json");
  const r = run(["path", "move", "--scene", FIXTURE, "--node", "outline", "--point", "p99", "--dx", "1", "--dy", "0", "--out", out]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /PATH_UNKNOWN_POINT/);
  assert.equal(existsSync(out), false, "output file was written on a failed edit");
});

test("handle pulls one handle and leaves the anchor alone", () => {
  const next = applyPathEdit(load(), {
    command: "handle", node: "outline", point: "p3", handle: "out", dx: 0, dy: -8,
  });
  const p3 = outline(next).find((p) => p.id === "p3");
  assert.deepEqual(p3.anchor, [200, 150]);
  assert.deepEqual(p3.out, [140, 142]);
  assert.deepEqual(outline(next).find((p) => p.id === "p2"), outline(load())[1]);
});

test("insert adds one node after the named node, in base and keyframes", () => {
  const next = applyPathEdit(load(), {
    command: "insert", node: "outline", after: "p2", id: "p2b", x: 212, y: 75, cmd: "line",
  });
  const pts = outline(next);
  assert.equal(pts.length, 5);
  assert.equal(pts[2].id, "p2b");
  assert.deepEqual(pts[2].anchor, [212, 75]);
  assert.equal(trackV(next, 0).length, 5);
  assert.equal(trackV(next, 1).length, 5);
  assert.deepEqual(validateScene(next).errors, []);
});

test("delete removes one node, and a duplicate insert id fails loudly", () => {
  const next = applyPathEdit(load(), {
    command: "delete", node: "outline", point: "p4",
  });
  assert.deepEqual(outline(next).map((p) => p.id), ["p1", "p2", "p3"]);
  assert.equal(trackV(next, 0).length, 3);
  assert.throws(
    () => applyPathEdit(load(), { command: "insert", node: "outline", after: "p2", id: "p3", x: 1, y: 1 }),
    /PATH_DUPLICATE_POINT/,
  );
});

test("convert line to cubic sets handles at the midpoint, back to line clears them", () => {
  const curved = applyPathEdit(load(), {
    command: "convert", node: "outline", point: "p2", to: "cubic",
  });
  const p2 = outline(curved).find((p) => p.id === "p2");
  assert.equal(p2.command, "cubic");
  assert.deepEqual(p2.in, [100, 0]);
  // The existing out-handle of p1 stays: convert never moves geometry it did not need to set.
  assert.deepEqual(outline(curved).find((p) => p.id === "p1").out, [60, 0]);
  const flat = applyPathEdit(curved, {
    command: "convert", node: "outline", point: "p2", to: "line",
  });
  assert.equal(outline(flat).find((p) => p.id === "p2").command, "line");
  assert.equal(outline(flat).find((p) => p.id === "p2").in, null);
  assert.equal(outline(flat).find((p) => p.id === "p1").out, null);
});

test("smooth sets a run to smooth with midpoint handles", () => {
  const next = applyPathEdit(load(), {
    command: "smooth", node: "outline", from: "p2", to: "p4",
  });
  const pts = outline(next);
  assert.equal(pts[1].command, "smooth");
  assert.deepEqual(pts[1].in, [100, 0]);
  assert.deepEqual(pts[1].out, [200, 75]);
  assert.deepEqual(pts[2].in, [200, 75]);
  // The first point of the path keeps its command: it is the moveto.
  assert.equal(pts[0].command, "line");
});

test("simplify drops a near-chord node within tolerance and keeps it above tolerance", () => {
  const scene = load();
  // Add a near-chord point between p1 and p2: anchor (100, 2) sits
  // 2 px off the p1-p2 chord, so tolerance 5 drops it, tolerance 1 keeps it.
  const withExtra = applyPathEdit(scene, {
    command: "insert", node: "outline", after: "p1", id: "px", x: 100, y: 2, cmd: "line",
  });
  const dropped = applyPathEdit(withExtra, {
    command: "simplify", node: "outline", from: "p1", to: "p2", tolerance: 5,
  });
  assert.deepEqual(outline(dropped).map((p) => p.id), ["p1", "p2", "p3", "p4"]);
  const kept = applyPathEdit(withExtra, {
    command: "simplify", node: "outline", from: "p1", to: "p2", tolerance: 1,
  });
  assert.deepEqual(outline(kept).map((p) => p.id), ["p1", "px", "p2", "p3", "p4"]);
});

test("rdpKeep keeps endpoints and drops only near-chord points", () => {
  const run = [
    { id: "a", anchor: [0, 0] },
    { id: "b", anchor: [50, 1] },
    { id: "c", anchor: [100, 0] },
  ];
  assert.deepEqual([...rdpKeep(run, 5)].sort(), [0, 2]);
  assert.deepEqual([...rdpKeep(run, 0.5)].sort(), [0, 1, 2]);
});

test("parsePathArgs rejects a missing value and an unknown option", () => {
  assert.match(parsePathArgs(["move", "--scene", FIXTURE]).error, /--node/);
  assert.match(parsePathArgs(["move", "--scene", FIXTURE, "--node", "outline", "--bogus", "1"]).error, /unknown option/);
});

test("edit does not mutate the input scene", () => {
  const scene = load();
  const before = JSON.stringify(scene);
  applyPathEdit(scene, { command: "move", node: "outline", point: "p2", dx: 12, dy: 0 });
  assert.equal(JSON.stringify(scene), before);
});

test("refusing to overwrite an existing output file writes nothing new", (t) => {
  const dir = tmp(t);
  const out = join(dir, "exists.json");
  const first = run(["path", "move", "--scene", FIXTURE, "--node", "outline", "--point", "p2", "--dx", "1", "--dy", "0", "--out", out]);
  assert.equal(first.status, 0, first.stderr);
  const text = readFileSync(out, "utf8");
  const second = run(["path", "move", "--scene", FIXTURE, "--node", "outline", "--point", "p2", "--dx", "2", "--dy", "0", "--out", out]);
  assert.equal(second.status, 2);
  assert.match(second.stderr, /refusing to overwrite/);
  assert.equal(readFileSync(out, "utf8"), text);
});
