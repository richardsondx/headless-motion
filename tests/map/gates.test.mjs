// Map gates: contrast ratios from the Harris skill, G8/G9 on the sample,
// the dim rule, and the negative fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { contrastRatio, dimColor, rgbToHsv, hsvToRgb, hexToRgb } from "../../src/shared/color.mjs";
import { computeMapState } from "../../src/map/compile.mjs";
import { checkG8 } from "../../src/map/g8.mjs";
import { checkG9 } from "../../src/map/g9.mjs";
import { loadScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const TOKENS = JSON.parse(readFileSync(resolve(ROOT, "src", "map", "tokens.json"), "utf8"));
const FIXTURE = resolve(HERE, "..", "fixtures", "map-sample.json");
const GEO = JSON.parse(readFileSync(resolve(ROOT, "assets", "natural-earth", "ne_10m_admin_0_countries.geojson"), "utf8"));

function sampleStates() {
  const scene = loadScene(FIXTURE);
  const props = scene.nodes.find((n) => n.type === "map").props;
  const features = GEO.features.filter((f) => props.geometry.include.includes(f.properties.ISO_A3));
  const states = [];
  for (let f = 0; f < scene.meta.duration; f++) states.push(computeMapState(props, f, scene.meta.fps, TOKENS, features, scene.events));
  return { scene, props, states };
}

test("Harris ratios: red on tan is 1.92, red on paper is 3.7", () => {
  const onTan = contrastRatio("#E63946", "#C6AD7A");
  assert.ok(Math.abs(onTan - 1.92) < 0.02, `red on tan ${onTan}`);
  const onPaper = contrastRatio("#E63946", "#F4F1EA");
  assert.ok(Math.abs(onPaper - 3.7) < 0.1, `red on paper ${onPaper}`);
});

test("white on navy pill clears 7:1", () => {
  assert.ok(contrastRatio("#FFFFFF", "#14213D") >= 7);
});

test("dim rule: tan land at full dim is s x 0.75, v x 0.88 within one 8-bit step", () => {
  const dimmed = dimColor("#C6AD7A", 0.75, 0.88);
  const before = rgbToHsv(hexToRgb("#C6AD7A"));
  const after = rgbToHsv(hexToRgb(dimmed));
  assert.ok(Math.abs(after.s - before.s * 0.75) < 1 / 255 + 0.01, `s ${after.s} vs ${before.s * 0.75}`);
  assert.ok(Math.abs(after.v - before.v * 0.88) < 1 / 255 + 0.01, `v ${after.v} vs ${before.v * 0.88}`);
});

test("map-sample cli passes G8 and G9", async () => {
  const { scene, props, states } = sampleStates();
  const sampled = [67, 72, 115, 120, 132, 179].map((f) => states[f]);
  assert.deepEqual(checkG8(sampled, TOKENS).failures, []);
  assert.deepEqual(checkG9(states, props, scene.meta.fps, scene.events).failures, []);
});

test("negative fixtures each fail with the right code", () => {
  const { scene, props, states } = sampleStates();
  const bad = (mutate) => {
    const s2 = JSON.parse(JSON.stringify(states));
    mutate(s2);
    return s2;
  };
  // CAMERA_LATE: move the landing state off target at frame 115.
  const late = bad((all) => { all[115].camera.center = [20, 10]; });
  assert.ok(checkG9(late, props, scene.meta.fps, scene.events).failures.some((f) => f.code === "CAMERA_LATE"));
  // FOCUS_OVERLAP: un-dim a second country after the ramp settles.
  const overlap = bad((all) => { for (const s of all) if (s.frame >= 130) { s.countries[1].dimmed = false; s.countries[1].dimFactor = 1; } });
  assert.ok(checkG9(overlap, props, scene.meta.fps, scene.events).failures.some((f) => f.code === "FOCUS_OVERLAP"));
  // G8_LINE_NO_CASING: a mid-grey route line fails against both the tan
  // land and the dark casing. (#C6AD7A would pass on the casing, so the
  // colour has to fail both, as #556575 does.)
  const lineBad = bad((all) => { for (const s of all) for (const r of s.routes) r.lineColor = "#556575"; });
  const sampled = [132].map((f) => lineBad[f]);
  assert.ok(checkG8(sampled, TOKENS).failures.some((f) => f.code === "G8_LINE_NO_CASING"));
});

test("bare label: navy on water passes G8, on blue flood fails, no ground fails", () => {
  const base = { frame: 0, labels: [], routes: [], countries: [], baseFill: "#C6AD7A" };
  const onWater = { ...base, labels: [{ id: "l1", mode: "bare", ground: "#C7D8E2", visible: true }] };
  assert.deepEqual(checkG8([onWater], TOKENS).failures, []);
  const onFlood = { ...base, labels: [{ id: "l1", mode: "bare", ground: "#4E7FA6", visible: true }] };
  assert.ok(checkG8([onFlood], TOKENS).failures.some((f) => f.code === "G8_TEXT"));
  const naked = { ...base, labels: [{ id: "l1", mode: "bare", ground: null, visible: true }] };
  assert.ok(checkG8([naked], TOKENS).failures.some((f) => f.code === "NAKED_LABEL"));
});

test("dashed route: state carries the dashed flag", () => {
  const { scene, props } = sampleStates();
  const dashed = { ...props, routes: [{ id: "r1", coords: [[-77, 39], [-80, 36]], start: 0, draw: 1, color: "#14213D", dashed: true }] };
  const s = computeMapState(dashed, 12, scene.meta.fps, TOKENS, [], scene.events);
  assert.equal(s.routes[0].dashed, true);
  const solid = { ...props, routes: [{ id: "r1", coords: [[-77, 39], [-80, 36]], start: 0, draw: 1 }] };
  assert.equal(computeMapState(solid, 12, scene.meta.fps, TOKENS, [], scene.events).routes[0].dashed, false);
});

test("G9 hold rule ignores bare labels, still holds pill labels", () => {
  const { scene, props, states } = sampleStates();
  const moving = JSON.parse(JSON.stringify(states));
  moving[72].camera.moving = true;
  const bareProps = { ...props, labels: [{ id: "t", at: 72, mode: "bare" }] };
  assert.ok(!checkG9(moving, bareProps, scene.meta.fps, scene.events).failures.some((f) => f.code === "HOLD_SHORT"));
  const pillProps = { ...props, labels: [{ id: "t", at: 72, mode: "pill" }] };
  assert.ok(checkG9(moving, pillProps, scene.meta.fps, scene.events).failures.some((f) => f.code === "HOLD_SHORT"));
});

// Negative fixtures in tests/fixtures/map-bad/ each exit 1 with their code.
// CAMERA_DRIFT and FOCUS_OVERLAP are not reachable from scene props (the
// state builder only moves the camera inside travel windows and only ever
// holds one focus), so they stay covered by the in-memory test above.
test("map-bad fixtures each exit 1 with the right code", async () => {
  const cases = ["CAMERA_LATE", "HOLD_SHORT", "CAMERA_DRIFT", "FOCUS_OVERLAP", "G9_HEAD_OUT", "G8_TEXT", "G8_LINE_NO_CASING", "NAKED_LABEL"];
  for (const name of cases) {
    const file = resolve(HERE, "..", "fixtures", "map-bad", `${name}.json`);
    const code = await new Promise((resolveP) => {
      execFile("node", [resolve(ROOT, "src", "map", "cli.mjs"), "check", file], { cwd: ROOT }, (err) => resolveP(err ? err.code : 0));
    });
    assert.equal(code, 1, `${name} should exit 1`);
    const report = JSON.parse(readFileSync(resolve(ROOT, "out", "map-sample", "g8-g9-report.json"), "utf8"));
    const codes = [...report.g8Failures, ...report.g9Failures].map((f) => f.code);
    assert.ok(codes.includes(name), `${name} report should contain ${name}, got ${codes.join(",")}`);
  }
  // Restore the good report for later tests.
  await new Promise((resolveP) => {
    execFile("node", [resolve(ROOT, "src", "map", "cli.mjs"), "check", FIXTURE], { cwd: ROOT }, () => resolveP());
  });
});

test("map-sample cli exits 0 and writes the report", async () => {
  const code = await new Promise((resolveP) => {
    execFile("node", [resolve(ROOT, "src", "map", "cli.mjs"), "check", FIXTURE], { cwd: ROOT }, (err) => resolveP(err ? err.code : 0));
  });
  assert.equal(code, 0);
  const report = JSON.parse(readFileSync(resolve(ROOT, "out", "map-sample", "g8-g9-report.json"), "utf8"));
  assert.equal(report.g8, "pass");
  assert.equal(report.g9, "pass");
});
