// Frame dedup key check: the minimal visualKey must agree with the full
// visual state (sampleScene + full map state + chart/kinetic outputs).
// Two things must hold for every fixture: the unique-frame counts match
// the measured values, and minimal-key equality implies full-key equality
// (a minimal key must never merge two frames that look different).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleScene } from "../../src/scene/evaluate.mjs";
import { computeMapState } from "../../src/map/compile.mjs";
import { countupText } from "../../src/chart/countup.mjs";
import { barraceState } from "../../src/chart/barrace.mjs";
import { barState } from "../../src/chart/bar.mjs";
import { kineticState } from "../../src/text/kinetic.mjs";
import { loadMapContext, visualKey } from "../../src/renderer/framekey.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const GEO = JSON.parse(readFileSync(resolve(ROOT, "assets", "natural-earth", "ne_10m_admin_0_countries.geojson"), "utf8"));
const TOKENS = JSON.parse(readFileSync(resolve(ROOT, "src", "map", "tokens.json"), "utf8"));

function fullKey(scene, f, mapCtx) {
  const key = { dom: sampleScene(scene, f) };
  if (mapCtx) {
    const ms = computeMapState(mapCtx.props, f, scene.meta.fps, TOKENS, mapCtx.features, scene.events);
    delete ms.frame;
    key.map = ms;
  }
  const charts = {};
  for (const n of scene.nodes.filter((x) => x.type === "chart")) {
    if (n.props.kind === "countup") charts[n.id] = countupText(n.props, f);
    else if (n.props.kind === "barrace") charts[n.id] = barraceState(n.props, f);
    else if (n.props.kind === "bar") charts[n.id] = barState(n.props.values);
  }
  if (Object.keys(charts).length) key.charts = charts;
  const kin = {};
  for (const n of scene.nodes.filter((x) => x.type === "text" && x.props.kinetic)) {
    kin[n.id] = kineticState(n.props.kinetic, n.props.text, f);
  }
  if (Object.keys(kin).length) key.kinetic = kin;
  return JSON.stringify(key);
}

const EXPECTED_UNIQUE = { "map-sample": 149, "text-sample": 130, "scene-min": 238 };

for (const file of ["map-sample.json", "text-sample.json", "scene-min.json"]) {
  test(`visualKey agrees with full state for ${file}`, () => {
    const scene = JSON.parse(readFileSync(resolve(HERE, "..", "fixtures", file), "utf8"));
    const mapCtx = loadMapContext(scene);
    const minKeys = [];
    const fullKeys = [];
    for (let f = 0; f < scene.meta.duration; f++) {
      minKeys.push(visualKey(scene, f, mapCtx));
      fullKeys.push(fullKey(scene, f, mapCtx));
    }
    assert.equal(new Set(minKeys).size, EXPECTED_UNIQUE[scene.meta.id], `${scene.meta.id} unique minimal keys`);
    assert.equal(new Set(fullKeys).size, EXPECTED_UNIQUE[scene.meta.id], `${scene.meta.id} unique full keys`);
    const byMin = new Map();
    minKeys.forEach((k, i) => { if (!byMin.has(k)) byMin.set(k, []); byMin.get(k).push(i); });
    for (const [k, frames] of byMin) {
      const first = fullKeys[frames[0]];
      for (const i of frames) assert.equal(fullKeys[i], first, `frames ${frames} share a minimal key but differ in full state`);
    }
  });
}
