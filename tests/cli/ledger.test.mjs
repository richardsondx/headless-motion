// Tests for `hme ledger`. Pure pieces run without video; the
// measured path runs on three tiny synthetic frames, so it stays
// fast. The full 120-frame reference build is checked by the
// VERIFY run, not here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseLedgerArgs,
  parseFramesRange,
  makeRow,
  computedGeometry,
  cameraAtFrame,
  buildComputedLedger,
  buildMeasuredLedger,
  buildDiff,
  validateLedger,
  validateAliasTable,
  elementIdForLayer,
  elementIdForTrack,
  summarizeLedger,
} from "../../src/cli/ledger.mjs";
import { loadScene } from "../../src/scene/validate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const VENV_PYTHON = join(ROOT, ".venv", "bin", "python");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });

const ROW_KEYS = ["frame", "time_s", "element_id", "centre_px", "centre_ratio", "bbox_px",
  "bbox_ratio", "area_ratio", "border_gaps_px", "border_gaps_ratio", "z", "visible", "camera", "provenance"];

const CAMERA = { zoom_ratio: 1, centre_lon: null, centre_lat: null, subject: null };
const PROV = { kind: "computed", source_frame: 0, tolerance: 0, sampling: "every frame", method: "test" };

test("ledger --help prints usage, options, and one example, and exits 0", () => {
  const r = run(["ledger", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme ledger"));
  assert.ok(r.stdout.includes("Usage:"));
  assert.ok(r.stdout.includes("--scene"));
  assert.ok(r.stdout.includes("--video"));
  assert.ok(r.stdout.includes("--alias"));
  assert.ok(r.stdout.includes("Example:"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("ledger with no subcommand is a usage error", () => {
  const r = run(["ledger"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs a subcommand"));
});

test("ledger build with no source is a usage error", () => {
  const r = run(["ledger", "build", "--out", "out.json"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("exactly one of --scene, --video, or --frames-dir"));
});

test("ledger build from a scene with --alias is a usage error", () => {
  const r = run(["ledger", "build", "--scene", "s.json", "--alias", "a.json", "--out", "o.json"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs no alias table"));
});

test("ledger build from a video without --alias is a usage error", () => {
  const r = run(["ledger", "build", "--video", "v.mp4", "--out", "o.json"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("needs --alias"));
});

test("ledger diff without --ours is a usage error", () => {
  const r = run(["ledger", "diff", "--ref", "a.json"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("diff needs --ours"));
});

test("parseFramesRange accepts a:b and rejects bad ranges", () => {
  assert.deepEqual(parseFramesRange("0:120"), { start: 0, end: 120, error: null });
  assert.ok(parseFramesRange("120:0").error);
  assert.ok(parseFramesRange("x").error);
  assert.deepEqual(parseFramesRange(null), { start: null, end: null, error: null });
});

test("makeRow holds every required field in px and ratios", () => {
  const row = makeRow(
    { centre: [100, 50], bbox: [80, 40, 120, 60], pixels: 800, z: 2, visible: true },
    { frame: 0, time_s: 0, element_id: "bar", width: 1920, height: 1080, camera: CAMERA, provenance: PROV },
  );
  for (const k of ROW_KEYS) assert.ok(k in row, `row is missing ${k}`);
  assert.deepEqual(row.centre_px, [100, 50]);
  assert.deepEqual(row.centre_ratio, [0.0521, 0.0463]);
  assert.deepEqual(row.bbox_px, [80, 40, 120, 60]);
  assert.deepEqual(row.bbox_ratio, [0.0417, 0.037, 0.0208, 0.0185]);
  assert.equal(row.area_ratio, 0.0004);
  assert.deepEqual(row.border_gaps_px, { left: 80, right: 1800, top: 40, bottom: 1020 });
});

test("makeRow with an absent element keeps the keys and nulls the geometry", () => {
  const row = makeRow(
    { centre: null, bbox: null, pixels: null, z: 2, visible: false },
    { frame: 5, time_s: 0.208, element_id: "bar", width: 1920, height: 1080, camera: CAMERA, provenance: PROV },
  );
  for (const k of ROW_KEYS) assert.ok(k in row, `row is missing ${k}`);
  assert.equal(row.centre_px, null);
  assert.equal(row.bbox_px, null);
  assert.equal(row.area_ratio, null);
  assert.equal(row.visible, false);
});

test("computedGeometry scales about the centre and rotates to an AABB", () => {
  const state = { "box.x": 100, "box.y": 100, "box.w": 200, "box.h": 100, "transform.x": 10, "transform.y": 20, "transform.scale": 2, "transform.rotation": 0, visible: true };
  const g = computedGeometry(state, { z: 1 });
  assert.deepEqual(g.centre, [210, 170]);
  assert.deepEqual(g.bbox, [10, 70, 410, 270]);
  const rot = computedGeometry({ ...state, "transform.rotation": 90 }, { z: 1 });
  assert.deepEqual(rot.bbox, [110, -30, 310, 370]);
});

test("cameraAtFrame is zoom 1 without a map node", () => {
  const scene = loadScene(join(ROOT, "tests", "fixtures", "scene-min.json"));
  assert.deepEqual(cameraAtFrame(scene, 60), { zoom_ratio: 1, centre_lon: null, centre_lat: null, subject: null });
});

test("cameraAtFrame interpolates map knots between event frames", () => {
  const scene = loadScene(join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json"));
  const open = cameraAtFrame(scene, 0);
  assert.equal(open.zoom_ratio, 0.255);
  assert.deepEqual([open.centre_lon, open.centre_lat], [22.16, 30.63]);
  const held = cameraAtFrame(scene, 180);
  assert.equal(held.zoom_ratio, 2.37);
  const mid = cameraAtFrame(scene, 60);
  assert.ok(mid.zoom_ratio > 0.84 && mid.zoom_ratio < 1.498, `mid zoom ${mid.zoom_ratio} must sit between knots`);
});

test("cameraAtFrame fails loudly on a knot with no event frame", () => {
  const scene = loadScene(join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json"));
  const bad = JSON.parse(JSON.stringify(scene));
  bad.nodes.find((n) => n.type === "map").props.camera[0].event = "no-such-event";
  assert.throws(() => cameraAtFrame(bad, 0), /LEDGER_CAMERA_EVENT_MISSING/);
});

test("buildComputedLedger covers every named element at every frame of the window", () => {
  const scene = loadScene(join(ROOT, "tests", "fixtures", "scene-min.json"));
  const ledger = buildComputedLedger(scene, 0, 120);
  assert.equal(ledger.schema, "hme.ledger/1.0");
  assert.equal(ledger.rows.length, 240);
  const perFrame = {};
  for (const r of ledger.rows) perFrame[r.frame] = (perFrame[r.frame] || 0) + 1;
  assert.equal(Object.keys(perFrame).length, 120);
  for (const n of Object.values(perFrame)) assert.equal(n, 2);
  const check = validateLedger(ledger);
  assert.deepEqual(check.errors, []);
  assert.equal(check.valid, true);
  const s = summarizeLedger(ledger);
  assert.equal(s.visible_row_count, 240);
});

test("validateLedger fails on a row with a missing field", () => {
  const scene = loadScene(join(ROOT, "tests", "fixtures", "scene-min.json"));
  const ledger = buildComputedLedger(scene, 0, 2);
  delete ledger.rows[0].centre_px;
  const check = validateLedger(ledger);
  assert.equal(check.valid, false);
  assert.ok(check.errors[0].includes("centre_px"));
});

test("validateAliasTable accepts the proof alias table", () => {
  const alias = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "seg4-alias.json"), "utf8"));
  const check = validateAliasTable(alias);
  assert.deepEqual(check.errors, []);
  assert.equal(check.valid, true);
});

test("validateAliasTable rejects a duplicate id and a bad kind", () => {
  const bad = { schema: "hme.alias/1.0", entries: [
    { id: "a", kind: "colour-layer", layer: "sudan", basis: "x" },
    { id: "a", kind: "colour-layer", layer: "base", basis: "x" },
  ] };
  assert.equal(validateAliasTable(bad).valid, false);
  const badKind = { schema: "hme.alias/1.0", entries: [{ id: "a", kind: "word", basis: "x" }] };
  assert.equal(validateAliasTable(badKind).valid, false);
  const noNear = { schema: "hme.alias/1.0", entries: [{ id: "a", kind: "label-cluster", basis: "x", window_px: 150 }] };
  assert.equal(validateAliasTable(noNear).valid, false);
});

test("elementIdForLayer honours a frames window", () => {
  const alias = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "seg4-alias.json"), "utf8"));
  assert.equal(elementIdForLayer("october", 0, alias), "title-october");
  assert.equal(elementIdForLayer("october", 71, alias), "title-october");
  assert.equal(elementIdForLayer("october", 72, alias), "unnamed:october");
  assert.equal(elementIdForLayer("white_text", 0, alias), "unnamed:white_text");
});

test("elementIdForTrack is single-use and honours position and frames", () => {
  const alias = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "seg4-alias.json"), "utf8"));
  const used = new Set();
  const early = { id: "label-01", firstFrame: 0, firstCentroid: [813, 527] };
  assert.equal(elementIdForTrack(early, alias, used), "unnamed:label-01");
  const rsf = { id: "label-02", firstFrame: 96, firstCentroid: [968, 620] };
  assert.equal(elementIdForTrack(rsf, alias, used), "badge-rsf-text");
  const rsfAgain = { id: "label-03", firstFrame: 108, firstCentroid: [960, 615] };
  assert.equal(elementIdForTrack(rsfAgain, alias, used), "unnamed:label-03");
  const fasher = { id: "label-04", firstFrame: 144, firstCentroid: [870, 607] };
  assert.equal(elementIdForTrack(fasher, alias, used), "label-fasher");
});

test("buildMeasuredLedger lists unnamed layers and states the 0.5 s label sampling", () => {
  const alias = { schema: "hme.alias/1.0", entries: [
    { id: "sudan", kind: "colour-layer", layer: "sudan", colour: "#143C34", tolerance: 15, basis: "test", z: null },
    { id: "badge-rsf", kind: "colour-layer", layer: "rsf", colour: "#CC4726", tolerance: 12, basis: "test", z: 3 },
  ] };
  const measured = {
    frames: [
      { frame: 0, layers: { sudan: { centroid: [50, 25], bbox: [40, 20, 60, 30], pixels: 200 }, base: null, rsf: null, october: null, white_text: null } },
      { frame: 1, layers: { sudan: { centroid: [51, 25], bbox: [41, 20, 61, 30], pixels: 200 }, base: { centroid: [48, 27], bbox: [0, 0, 96, 54], pixels: 4000 }, rsf: null, october: null, white_text: null } },
      { frame: 2, layers: { sudan: { centroid: [50, 25], bbox: [49, 24, 51, 26], pixels: 10 }, base: null, rsf: null, october: null, white_text: null } },
    ],
    tracks: [
      { id: "label-01", firstFrame: 0, firstCentroid: [10, 10], samples: [{ frame: 0, centroid: [10, 10], bbox: [8, 8, 12, 12], pixels: 16 }] },
    ],
  };
  const ledger = buildMeasuredLedger(measured, {
    alias, aliasPath: "alias.json",
    source: { kind: "frames", file: "frames/", scene_id: null, fps: 24 },
    width: 96, height: 54, fps: 24, startFrame: 0, endFrame: 3,
  });
  assert.equal(ledger.sampling.labels, "0.5 s");
  assert.equal(ledger.sampling.colour, "every frame");
  assert.equal(ledger.rows.length, 16);
  const sudanRow = ledger.rows.find((r) => r.frame === 0 && r.element_id === "sudan");
  assert.equal(sudanRow.visible, true);
  assert.deepEqual(sudanRow.centre_px, [50, 25]);
  assert.equal(sudanRow.camera.subject, "sudan");
  // A 10 px detection is a speck, not the element: the row stays,
  // but visible is false and the geometry is null.
  const speck = ledger.rows.find((r) => r.frame === 2 && r.element_id === "sudan");
  assert.equal(speck.visible, false);
  assert.equal(speck.centre_px, null);
  const unnamedKeys = ledger.unnamed.map((u) => u.key).sort();
  assert.ok(unnamedKeys.includes("unnamed:base"));
  assert.ok(unnamedKeys.includes("unnamed:october"));
  assert.ok(unnamedKeys.includes("unnamed:white_text"));
  assert.ok(unnamedKeys.includes("unnamed:label-01"));
  const check = validateLedger(ledger);
  assert.deepEqual(check.errors, []);
});

test("buildDiff lists per-element per-frame deltas plus the worst element", () => {
  const scene = loadScene(join(ROOT, "tests", "fixtures", "scene-min.json"));
  const ref = buildComputedLedger(scene, 0, 4);
  const ours = buildComputedLedger(scene, 0, 4);
  const moved = ours.rows.find((r) => r.frame === 2 && r.element_id === "bar");
  moved.centre_px = [moved.centre_px[0] + 10, moved.centre_px[1]];
  moved.centre_ratio = [moved.centre_ratio[0] + 0.0052, moved.centre_ratio[1]];
  const diff = buildDiff(ref, ours);
  assert.equal(diff.schema, "hme.ledger-diff/1.0");
  assert.deepEqual(diff.shared_elements, ["bar", "title"]);
  assert.equal(diff.summary.row_count, 8);
  const row = diff.per_frame.find((f) => f.frame === 2).elements.find((e) => e.element_id === "bar");
  assert.equal(row.status, "both-visible");
  assert.equal(row.delta.centre_dx_px, 10);
  assert.equal(diff.worst.element_id, "bar");
  assert.equal(diff.worst.frame, 2);
  assert.equal(diff.worst.centre_dist_px, 10);
  const same = buildDiff(ref, ref);
  assert.equal(same.worst.centre_dist_px, 0);
});

test("buildDiff marks a row absent when one side hides the element", () => {
  const scene = loadScene(join(ROOT, "tests", "fixtures", "scene-min.json"));
  const ref = buildComputedLedger(scene, 0, 2);
  const ours = buildComputedLedger(scene, 0, 2);
  const target = ours.rows.find((r) => r.frame === 1 && r.element_id === "bar");
  target.visible = false;
  target.centre_px = null;
  target.centre_ratio = null;
  target.bbox_px = null;
  const diff = buildDiff(ref, ours);
  const row = diff.per_frame.find((f) => f.frame === 1).elements.find((e) => e.element_id === "bar");
  assert.equal(row.status, "absent-ours");
  assert.equal(row.delta, null);
});

test("hme ledger build from a scene covers 100 percent of named elements", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-ledger-"));
  try {
    const out = join(dir, "ledger.json");
    const r = run(["ledger", "build", "--scene", join(ROOT, "tests", "fixtures", "scene-min.json"), "--frames", "0:120", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const ledger = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(ledger.rows.length, 240);
    const check = validateLedger(ledger);
    assert.equal(check.valid, true, check.errors.join("; "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hme ledger diff on two computed ledgers reports zero deltas", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-ledger-"));
  try {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    const out = join(dir, "diff.json");
    assert.equal(run(["ledger", "build", "--scene", join(ROOT, "tests", "fixtures", "scene-min.json"), "--frames", "0:12", "--out", a]).status, 0);
    assert.equal(run(["ledger", "build", "--scene", join(ROOT, "tests", "fixtures", "scene-min.json"), "--frames", "0:12", "--out", b]).status, 0);
    const r = run(["ledger", "diff", "--ref", a, "--ours", b, "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const diff = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(diff.summary.max_centre_dist_px, 0);
    assert.equal(diff.summary.row_count, 24);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Three tiny synthetic frames: a teal rect (Sudan) and an orange
// rect (RSF badge) on a dark ground. The measured path runs the real
// Python driver on them.
test("hme ledger build from a frames dir measures the colour layers", { timeout: 120000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-ledger-frames-"));
  try {
    const framesDir = join(dir, "frames");
    mkdirSync(framesDir);
    const gen = spawnSync(VENV_PYTHON, ["-c", `
from PIL import Image
for i, dx in enumerate((0, 4, 8)):
    im = Image.new("RGB", (192, 108), (28, 43, 40))
    px = im.load()
    for x in range(60 + dx, 120 + dx):
        for y in range(30, 80):
            px[x, y] = (20, 60, 52)
    for x in range(140, 160):
        for y in range(60, 80):
            px[x, y] = (204, 71, 38)
    im.save("FRAME%02d.png" % i)
`.replaceAll("FRAME", join(framesDir, "frame"))], { encoding: "utf8" });
    assert.equal(gen.status, 0, gen.stderr);
    const aliasPath = join(dir, "alias.json");
    writeFileSync(aliasPath, JSON.stringify({
      schema: "hme.alias/1.0",
      entries: [
        { id: "sudan", kind: "colour-layer", layer: "sudan", colour: "#143C34", tolerance: 15, basis: "test", z: null },
        { id: "badge-rsf", kind: "colour-layer", layer: "rsf", colour: "#CC4726", tolerance: 12, basis: "test", z: 3 },
      ],
    }));
    const out = join(dir, "ledger.json");
    const r = run(["ledger", "build", "--frames-dir", framesDir, "--alias", aliasPath, "--fps", "24", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const ledger = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(ledger.frame_width, 192);
    assert.equal(ledger.frame_height, 108);
    assert.equal(ledger.frame_count, 3);
    assert.equal(ledger.sampling.labels, "0.5 s");
    const sudan = ledger.rows.filter((row) => row.element_id === "sudan");
    assert.equal(sudan.length, 3);
    assert.ok(sudan.every((row) => row.visible), "Sudan must be visible in every synthetic frame");
    assert.ok(Math.abs(sudan[0].centre_px[0] - 90) <= 2, `Sudan centre x ${sudan[0].centre_px[0]} must be near 90`);
    assert.ok(sudan[2].centre_px[0] > sudan[0].centre_px[0], "Sudan centre must move right across frames");
    const unnamedKeys = ledger.unnamed.map((u) => u.key);
    assert.ok(unnamedKeys.includes("unnamed:base"));
    assert.ok(unnamedKeys.includes("unnamed:october"));
    const check = validateLedger(ledger);
    assert.equal(check.valid, true, check.errors.join("; "));
    assert.ok(existsSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
