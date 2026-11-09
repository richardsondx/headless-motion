import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, renameSync } from "node:fs";
import { validateScene } from "../../src/scene/validate.mjs";

const CLI = new URL("../../src/scene/validate.mjs", import.meta.url).pathname;
const BAD = new URL("../fixtures/bad/", import.meta.url);
const FIXTURE = new URL("../fixtures/scene-min.json", import.meta.url);
const CODES = ["SCHEMA_VERSION", "DUP_ID", "BAD_PARENT", "PARENT_CYCLE", "UNKNOWN_EASE", "KEY_ORDER", "KEY_RANGE", "UNKNOWN_FONT", "PROP_TYPE", "UNKNOWN_FIELD"];
const run = (file) => spawnSync(process.execPath, [CLI, file], { encoding: "utf8" });
const clone = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

test("scene-min prints OK and exits 0", () => {
  const r = run(FIXTURE.pathname);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "OK scene-min 240 frames 24 fps\n");
});

test("there is one bad fixture per error code", () => {
  assert.deepEqual(readdirSync(BAD).map((f) => f.replace(".json", "")).sort(), [...CODES].sort());
});

for (const code of CODES) {
  test(`bad/${code}.json exits 1 with ${code} on line 1 and a JSON pointer`, () => {
    const r = run(new URL(`${code}.json`, BAD).pathname);
    assert.equal(r.status, 1);
    const [line1] = r.stdout.split("\n");
    const [got, path] = line1.split(" ");
    assert.equal(got, code);
    assert.match(path, /^\/[A-Za-z0-9/~_.-]*$/, "path is a JSON pointer");
  });
}

test("an unreadable file exits 2, not 1", () => {
  assert.equal(run("/nonexistent/scene.json").status, 2);
});

test("errors stop after 20", () => {
  const s = clone();
  s.timeline[0].keys = Array.from({ length: 60 }, (_, i) => ({ f: 300 + i, v: i }));
  const { errors } = validateScene(s);
  assert.equal(errors.length, 20);
});

test("negative frame is KEY_RANGE, fractional frame is PROP_TYPE", () => {
  const a = clone();
  a.timeline[0].keys[0].f = -1;
  assert.equal(validateScene(a).errors[0].code, "KEY_RANGE");
  const b = clone();
  b.timeline[0].keys[1].f = 60.5;
  assert.equal(validateScene(b).errors[0].code, "PROP_TYPE");
});

test("bezier x outside [0,1] is UNKNOWN_EASE", () => {
  const s = clone();
  s.timeline[0].keys[1].ease = { bezier: [1.5, 0, 0.5, 1] };
  assert.equal(validateScene(s).errors[0].code, "UNKNOWN_EASE");
});

test("self parent is a cycle", () => {
  const s = clone();
  s.nodes[0].parent = "title";
  assert.equal(validateScene(s).errors[0].code, "PARENT_CYCLE");
});

test("timeline mistakes are caught", () => {
  const typo = clone();
  typo.timeline[0].prop = "transform.xx";
  assert.equal(validateScene(typo).errors[0].code, "UNKNOWN_FIELD");
  const mixed = clone();
  mixed.timeline[0].keys[1].v = "far";
  assert.equal(validateScene(mixed).errors[0].code, "PROP_TYPE");
  const firstEase = clone();
  firstEase.timeline[0].keys[0].ease = "linear";
  assert.equal(validateScene(firstEase).errors[0].code, "PROP_TYPE");
  const ghost = clone();
  ghost.timeline[0].node = "ghost";
  assert.equal(validateScene(ghost).errors[0].code, "PROP_TYPE");
});

test("unknown palette colour and URL font src are rejected", () => {
  const color = clone();
  color.nodes[1].props.fill = "nope";
  assert.equal(validateScene(color).errors[0].code, "PROP_TYPE");
  const font = clone();
  font.fonts[0].src = "https://example.com/a.ttf";
  assert.equal(validateScene(font).errors[0].code, "PROP_TYPE");
});

test("map and chart nodes with a companion schema are checked, not warned", () => {
  const s = clone();
  s.nodes.push({ id: "m", type: "map", parent: null, z: 0, box: { x: 0, y: 0, w: 10, h: 10 }, props: { anything: 1 } });
  const { errors, warnings } = validateScene(s);
  assert.ok(errors.some((e) => e.code === "UNKNOWN_FIELD"), "map props are checked against map.schema.json");
  assert.deepEqual(warnings, []);
});

test("particle-sample prints OK and exits 0", () => {
  const r = run(new URL("../fixtures/particle-sample.json", import.meta.url).pathname);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "OK particle-sample 120 frames 24 fps\n");
});

test("particle props are required and shape is an enum", () => {
  const s = JSON.parse(readFileSync(new URL("../fixtures/particle-sample.json", import.meta.url), "utf8"));
  const missing = JSON.parse(JSON.stringify(s));
  delete missing.nodes[0].props.count;
  const e1 = validateScene(missing).errors;
  assert.equal(e1[0].code, "PROP_TYPE");
  assert.match(e1[0].message, /missing required field "count"/);
  const badShape = JSON.parse(JSON.stringify(s));
  badShape.nodes[1].props.shape = "diamond";
  const e2 = validateScene(badShape).errors;
  assert.equal(e2[0].code, "PROP_TYPE");
  assert.equal(e2[0].path, "/nodes/1/props/shape");
  assert.match(e2[0].message, /diamond/);
});

test("a timeline track on a particle node prop validates", () => {
  const s = JSON.parse(readFileSync(new URL("../fixtures/particle-sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateScene(s).errors, []);
  const typo = JSON.parse(JSON.stringify(s));
  typo.timeline[0].prop = "props.nope";
  assert.equal(validateScene(typo).errors[0].code, "UNKNOWN_FIELD");
});

test("map and chart nodes with no companion schema warn UNCHECKED_PROPS", () => {
  // Move both companion schemas aside, validate, restore in finally.
  const mapSchema = new URL("../../src/map/map.schema.json", import.meta.url).pathname;
  const chartSchema = new URL("../../src/chart/chart.schema.json", import.meta.url).pathname;
  renameSync(mapSchema, mapSchema + ".bak");
  renameSync(chartSchema, chartSchema + ".bak");
  try {
    const s = clone();
    s.nodes.push({ id: "m", type: "map", parent: null, z: 0, box: { x: 0, y: 0, w: 10, h: 10 }, props: { anything: 1 } });
    const { errors, warnings } = validateScene(s);
    assert.deepEqual(errors, []);
    assert.equal(warnings[0].code, "UNCHECKED_PROPS");
  } finally {
    renameSync(mapSchema + ".bak", mapSchema);
    renameSync(chartSchema + ".bak", chartSchema);
  }
});
