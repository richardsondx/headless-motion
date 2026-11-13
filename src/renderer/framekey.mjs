// Frame dedup key: the visual state of one frame, as a string. The picture
// at frame N is a pure function of (scene, N) (see evaluate.mjs), so two
// frames with equal keys render identical pixels and the second screenshot
// can reuse the first PNG. The key covers every input the in-page runtimes
// read: the evaluator state (DOM nodes), the map state (camera, fills,
// routes, labels, badges), and the chart/kinetic outputs, which are pure
// functions of (props, frame). Static inputs (props, tokens, geometry,
// fonts) are the same for every frame and are not in the key. Raw floats
// are used (no rounding): equal keys mean exactly equal inputs.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleScene } from "../scene/evaluate.mjs";
import { computeMapState } from "../map/compile.mjs";
import { countupText } from "../chart/countup.mjs";
import { barraceState } from "../chart/barrace.mjs";
import { barState } from "../chart/bar.mjs";
import { kineticState } from "../text/kinetic.mjs";
import { evaluateParticles } from "../scene/particles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

/** Load the map inputs (filtered GeoJSON features + tokens) for a scene, or
 * null when the scene has no map node. Same files compile.mjs uses. */
export function loadMapContext(scene) {
  const mapNode = scene.nodes.find((n) => n.type === "map");
  if (!mapNode) return null;
  const geoRel = (mapNode.props.geometry && mapNode.props.geometry.countries) || "assets/natural-earth/ne_10m_admin_0_countries.geojson";
  const geoKey = (mapNode.props.geometry && mapNode.props.geometry.key) || "ISO_A3";
  const geo = JSON.parse(readFileSync(resolve(ROOT, geoRel), "utf8"));
  const tokens = JSON.parse(readFileSync(resolve(ROOT, "src", "map", "tokens.json"), "utf8"));
  const include = [...new Set(mapNode.props.geometry.include || [])];
  return { features: geo.features.filter((f) => include.includes(f.properties[geoKey])), tokens, props: mapNode.props };
}

export function visualKey(scene, frame, mapCtx) {
  const sampled = sampleScene(scene, frame);
  const parts = [JSON.stringify(sampled)];
  if (mapCtx) {
    const st = computeMapState(mapCtx.props, frame, scene.meta.fps, mapCtx.tokens, mapCtx.features, scene.events);
    parts.push(JSON.stringify({
      cam: st.camera,
      focus: st.focus,
      countries: st.countries.map((c) => [c.iso, c.displayFill]),
      routes: st.routes.map((r) => [r.id, r.progress, r.active, r.head]),
      labels: st.labels.map((l) => [l.id, l.visible, l.screen]),
      badges: st.badges.map((b) => [b.id, b.visible, b.screen]),
    }));
  }
  for (const n of scene.nodes) {
    if (n.type === "particle") {
      // Particle positions change every frame even when no timeline track
      // moves, so the key must cover the evaluator output itself. The
      // sampled props come from sampleScene, which flattens area to dotted
      // keys, so the area object is rebuilt here, the same way the U3 test
      // does. The node is covered whether or not it is visible this frame:
      // a key that merges two different particle states would reuse a
      // stale frame.
      const s = sampled[n.id];
      const props = {
        count: s["props.count"],
        size: s["props.size"],
        speed: s["props.speed"],
        direction: s["props.direction"],
        lifetime: s["props.lifetime"],
        shape: s["props.shape"],
        area: {
          x: s["props.area.x"],
          y: s["props.area.y"],
          w: s["props.area.w"],
          h: s["props.area.h"],
        },
      };
      parts.push(JSON.stringify(["particle", n.id, evaluateParticles(scene.meta.seed, n.id, props, frame, scene.meta.fps)]));
    } else if (n.type === "chart") {
      if (n.props.kind === "countup") parts.push(JSON.stringify(["chart", n.id, countupText(n.props, frame)]));
      else if (n.props.kind === "barrace") parts.push(JSON.stringify(["chart", n.id, barraceState(n.props, frame)]));
      else if (n.props.kind === "bar") parts.push(JSON.stringify(["chart", n.id, barState(n.props.values)]));
    } else if (n.type === "text" && n.props.kinetic) {
      parts.push(JSON.stringify(["kinetic", n.id, kineticState(n.props.kinetic, n.props.text, frame)]));
    }
  }
  return parts.join("|");
}
