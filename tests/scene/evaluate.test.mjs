import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sampleScene, fmt, framesFromSeconds, resolveColor } from "../../src/scene/evaluate.mjs";
import { validateScene } from "../../src/scene/validate.mjs";

const load = () => JSON.parse(readFileSync(new URL("../fixtures/scene-min.json", import.meta.url), "utf8"));

function withTracks(tracks) {
  const s = load();
  s.timeline = tracks;
  const { errors } = validateScene(s);
  assert.deepEqual(errors, []);
  return s;
}

test("fmt rounds to 3 decimals and never returns -0", () => {
  assert.equal(fmt(1.23456), 1.235);
  assert.ok(Object.is(fmt(-0.0001), 0));
});

test("framesFromSeconds rounds up", () => {
  assert.equal(framesFromSeconds(10, 24), 240);
  assert.equal(framesFromSeconds(0.01, 24), 1);
});

test("before the first key and after the last key the value holds", () => {
  const s = withTracks([{ node: "bar", prop: "transform.x", keys: [{ f: 10, v: 5 }, { f: 20, v: 15, ease: "linear" }] }]);
  assert.equal(sampleScene(s, 0).bar["transform.x"], 5);
  assert.equal(sampleScene(s, 10).bar["transform.x"], 5);
  assert.equal(sampleScene(s, 15).bar["transform.x"], 10);
  assert.equal(sampleScene(s, 20).bar["transform.x"], 15);
  assert.equal(sampleScene(s, 200).bar["transform.x"], 15);
});

test("ease on key k shapes the segment from k-1 to k", () => {
  const s = withTracks([{ node: "bar", prop: "transform.x", keys: [{ f: 0, v: 0 }, { f: 10, v: 100, ease: "easeInQuad" }] }]);
  const mid = sampleScene(s, 5).bar["transform.x"];
  assert.ok(mid < 40, `easeInQuad halfway should be well under 50, got ${mid}`);
});

test("colours interpolate in sRGB and round per channel", () => {
  const s = withTracks([{ node: "bar", prop: "props.fill", keys: [{ f: 0, v: "#000000" }, { f: 10, v: "#ffffff", ease: "linear" }] }]);
  assert.equal(sampleScene(s, 5).bar["props.fill"], "#808080");
  const named = withTracks([{ node: "bar", prop: "props.fill", keys: [{ f: 0, v: "ground" }, { f: 10, v: "ink", ease: "linear" }] }]);
  assert.equal(sampleScene(named, 0).bar["props.fill"], "#101820");
  assert.equal(sampleScene(named, 10).bar["props.fill"], "#f4f1ea");
});

test("points interpolate per component, strings and booleans step", () => {
  const s = withTracks([
    { node: "title", prop: "props.text", keys: [{ f: 0, v: "one" }, { f: 10, v: "two", ease: "linear" }] },
    { node: "bar", prop: "transform.opacity", keys: [{ f: 0, v: 0 }, { f: 10, v: 1, ease: "hold" }] },
  ]);
  assert.equal(sampleScene(s, 9).title["props.text"], "one");
  assert.equal(sampleScene(s, 10).title["props.text"], "two");
  assert.equal(sampleScene(s, 9).bar["transform.opacity"], 0);
  assert.equal(sampleScene(s, 10).bar["transform.opacity"], 1);
});

test("static state carries defaults, resolved colours and visibility", () => {
  const s = load();
  const at0 = sampleScene(s, 0);
  assert.equal(at0.title["props.color"], "#f4f1ea");
  assert.equal(at0.title["transform.scale"], 1);
  assert.equal(at0.bar["props.fill"], "#e8a33d");
  assert.equal(at0.bar.visible, true);
  s.nodes[1].visible = { in: 10, out: 20 };
  assert.equal(sampleScene(s, 9).bar.visible, false);
  assert.equal(sampleScene(s, 10).bar.visible, true);
  assert.equal(sampleScene(s, 20).bar.visible, false);
});

test("sampleScene does not mutate the scene and rejects fractional frames", () => {
  const s = load();
  const before = JSON.stringify(s);
  sampleScene(s, 7);
  assert.equal(JSON.stringify(s), before);
  assert.throws(() => sampleScene(s, 1.5), /integer/);
});

test("resolveColor handles names, hex and non-colours", () => {
  const pal = load().palette;
  assert.equal(resolveColor("accent", pal), "#e8a33d");
  assert.equal(resolveColor("#ABCDEF", pal), "#abcdef");
  assert.equal(resolveColor("none", pal), null);
  assert.equal(resolveColor("constructor", pal), null);
});
