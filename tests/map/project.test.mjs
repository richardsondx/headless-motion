// Prompt 04 check 8: a geo-anchored label's screen position at three camera
// positions equals projectToScreen within 0.5 px.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMapState } from "../../src/map/compile.mjs";
import { projectToScreen } from "../../src/map/project.mjs";
import { loadScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const TOKENS = JSON.parse(readFileSync(resolve(ROOT, "src", "map", "tokens.json"), "utf8"));
const GEO = JSON.parse(readFileSync(resolve(ROOT, "assets", "natural-earth", "ne_10m_admin_0_countries.geojson"), "utf8"));

test("projectToScreen matches label placement at three camera positions", () => {
  const scene = loadScene(resolve(HERE, "..", "fixtures", "map-sample.json"));
  const props = scene.nodes.find((n) => n.type === "map").props;
  const features = GEO.features.filter((f) => props.geometry.include.includes(f.properties.ISO_A3));
  for (const frame of [0, 120, 200]) {
    const state = computeMapState(props, frame, scene.meta.fps, TOKENS, features, scene.events);
    for (const label of state.labels) {
      if (!label.visible) continue;
      const def = props.labels.find((l) => l.id === label.id);
      const target = typeof def.target === "string"
        ? state.countries.find((c) => c.iso === def.target).centroid
        : def.target;
      const [x, y] = projectToScreen(state, target);
      assert.ok(Math.abs(x - label.screen[0]) < 0.5, `${label.id} x at f${frame}: ${x} vs ${label.screen[0]}`);
      assert.ok(Math.abs(y - label.screen[1]) < 0.5, `${label.id} y at f${frame}: ${y} vs ${label.screen[1]}`);
    }
  }
});
