// Map CLI: node src/map/cli.mjs check <scene.json>
// Loads the scene, validates it (map props are checked against
// map.schema.json by the scene validator), computes every frame state,
// runs G8 on sampled frames and G9 on all frames, writes
// out/map-sample/g8-g9-report.json. Exit 0 pass, 1 fail.
import { readFileSync, existsSync } from "node:fs";
import { writeFileRetry, mkdirRetry } from "../renderer/retry.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScene, validateScene } from "../scene/validate.mjs";
import { computeMapState } from "./compile.mjs";
import { checkG8 } from "./g8.mjs";
import { checkG9 } from "./g9.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const TOKENS = JSON.parse(readFileSync(resolve(HERE, "tokens.json"), "utf8"));

function sampledFrames(props, events, fps, duration) {
  const evFrames = {};
  for (const e of events || []) evFrames[e.id] = e.f;
  const set = new Set();
  const lead = Math.ceil(0.2 * fps);
  const hold = Math.ceil(1.2 * fps);
  for (const e of events || []) {
    set.add(e.f);
    const landF = e.f - lead;
    if (landF >= 0) set.add(landF);
  }
  const lastLabel = Math.max(-1, ...(props.labels || []).map((l) => l.at));
  if (lastLabel >= 0) set.add(Math.min(duration - 1, lastLabel + hold));
  for (const r of props.routes || []) {
    const startF = Math.ceil(r.start * fps);
    const drawF = Math.max(1, Math.ceil(r.draw * fps));
    for (let f = startF; f <= startF + drawF; f += 12) set.add(Math.min(duration - 1, f));
  }
  return [...set].filter((f) => f >= 0 && f < duration).sort((a, b) => a - b);
}

function main(argv) {
  if (argv[0] !== "check" || !argv[1]) {
    console.error("usage: node src/map/cli.mjs check <scene.json>");
    return 2;
  }
  const file = resolve(argv[1]);
  const scene = loadScene(file);
  const { errors } = validateScene(scene);
  if (errors.length) {
    for (const e of errors) console.log(`${e.code} ${e.path} ${e.message}`);
    return 1;
  }
  const node = scene.nodes.find((n) => n.type === "map");
  if (!node) {
    console.error("NE_MISSING no map node in scene");
    return 1;
  }
  const props = node.props;
  const geoPath = resolve(ROOT, props.geometry.countries);
  if (!existsSync(geoPath)) {
    console.error(`NE_MISSING ${props.geometry.countries}`);
    return 1;
  }
  const geo = JSON.parse(readFileSync(geoPath, "utf8"));
  const features = geo.features.filter((f) => props.geometry.include.includes(f.properties.ISO_A3));
  const missing = props.geometry.include.filter((iso) => !features.some((f) => f.properties.ISO_A3 === iso));
  if (missing.length) {
    console.error(`NE_MISSING countries not in file: ${missing.join(",")}`);
    return 1;
  }
  const fps = scene.meta.fps;
  const duration = scene.meta.duration;
  const allStates = [];
  for (let f = 0; f < duration; f++) allStates.push(computeMapState(props, f, fps, TOKENS, features, scene.events));
  const sampled = sampledFrames(props, scene.events, fps, duration).map((f) => allStates[f]);
  const g8 = checkG8(sampled, TOKENS);
  const g9 = checkG9(allStates, props, fps, scene.events);
  const report = { g8: g8.pass ? "pass" : "fail", g9: g9.pass ? "pass" : "fail", sampledFrames: sampledFrames(props, scene.events, fps, duration), g8Failures: g8.failures, g9Failures: g9.failures };
  const outDir = resolve(ROOT, "out", "map-sample");
  mkdirRetry(outDir, { recursive: true });
  writeFileRetry(resolve(outDir, "g8-g9-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`G8 ${report.g8} (${g8.failures.length} failures) G9 ${report.g9} (${g9.failures.length} failures)`);
  for (const f of [...g8.failures, ...g9.failures]) console.log(`${f.code} frame ${f.frame} ${f.detail}`);
  return g8.pass && g9.pass ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
