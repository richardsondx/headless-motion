// Vertical profile: schema allows 1080x1920, and only the two real sizes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateScene } from "../../src/scene/validate.mjs";
import profiles from "../../src/scene/profiles.json" with { type: "json" };

const CLI = new URL("../../src/scene/validate.mjs", import.meta.url).pathname;
const FIXTURE = new URL("../fixtures/scene-vertical-min.json", import.meta.url);
const LANDSCAPE = new URL("../fixtures/scene-min.json", import.meta.url);
const run = (file) => spawnSync(process.execPath, [CLI, file], { encoding: "utf8" });
const cloneVertical = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

test("vertical fixture validates with no errors", () => {
  assert.deepEqual(validateScene(cloneVertical()).errors, []);
});

test("vertical fixture prints OK and exits 0", () => {
  const r = run(FIXTURE.pathname);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "OK scene-vertical-min 48 frames 24 fps\n");
});

test("landscape fixture still validates with no errors", () => {
  const s = JSON.parse(readFileSync(LANDSCAPE, "utf8"));
  assert.deepEqual(validateScene(s).errors, []);
});

test("square and swapped sizes fail validation at /meta", () => {
  for (const [w, h] of [[1080, 1080], [1920, 1920]]) {
    const s = cloneVertical();
    s.meta.width = w;
    s.meta.height = h;
    const { errors } = validateScene(s);
    assert.ok(errors.length > 0, `${w}x${h} must fail`);
    assert.equal(errors[0].code, "PROP_TYPE");
    assert.equal(errors[0].path, "/meta");
  }
});

test("vertical profile mirrors final at 1080x1920", () => {
  assert.equal(profiles.vertical.output.width, 1080);
  assert.equal(profiles.vertical.output.height, 1920);
  assert.equal(profiles.vertical.crf, profiles.final.crf);
  assert.equal(profiles.vertical.preset, profiles.final.preset);
  assert.equal(profiles.vertical.supersample, profiles.final.supersample);
});

test("landscape profile outputs are unchanged", () => {
  assert.deepEqual(profiles.draft.output, { height: 1080, width: 1920 });
  assert.deepEqual(profiles.final.output, { height: 1080, width: 1920 });
  assert.deepEqual(profiles["final-max"].output, { height: 1080, width: 1920 });
  assert.deepEqual(profiles.previs.output, { height: 480, width: 854 });
  assert.deepEqual(profiles["preview-rt"].output, { height: 1080, width: 1920 });
});
