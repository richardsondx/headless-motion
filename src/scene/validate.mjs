// Scene validator: schema walk first, then cross-reference checks. Library and CLI.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkSchema, pointer } from "./schema-walk.mjs";
import { flatten, resolveColor, COLOR_PATHS, TRANSFORM_DEFAULTS } from "./evaluate.mjs";

const SCHEMA_PATH = new URL("./scene.schema.json", import.meta.url);
export const sceneSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
export const SCENE_VERSION = sceneSchema.properties.schema.const;
const MAX_ERRORS = 20;
const COMPANIONS = { map: "../map/map.schema.json", chart: "../chart/chart.schema.json" };

/** fps is a scene field; the only default lives in the schema. */
export const sceneFps = (scene) => scene.meta.fps ?? sceneSchema.properties.meta.properties.fps.default;

/** Dotted paths the schema names for a node type's props, as {path: leafSchema}. */
function schemaLeaves(def, prefix = "props", out = {}) {
  const resolved = def.$ref ? def.$ref.slice(2).split("/").reduce((o, k) => o[k], sceneSchema) : def;
  if (resolved.properties) {
    for (const [k, sub] of Object.entries(resolved.properties)) schemaLeaves(sub, `${prefix}.${k}`, out);
  } else out[prefix] = resolved;
  return out;
}
const PROPS_DEFS = { text: "textProps", shape: "shapeProps", image: "imageProps" };
const FIXED_PATHS = new Set([
  "z", "visible.in", "visible.out", "box.x", "box.y", "box.w", "box.h",
  ...Object.keys(TRANSFORM_DEFAULTS).map((k) => `transform.${k}`),
]);

const kindOf = (v, isColor) => {
  if (isColor) return "color";
  if (Array.isArray(v)) return `point${v.length}`;
  return typeof v;
};

/**
 * @param {any} scene parsed JSON
 * @returns {{errors:{code:string,path:string,message:string}[], warnings:{code:string,path:string,message:string}[]}}
 */
export function validateScene(scene) {
  const errors = [];
  const warnings = [];
  const add = (code, path, message) => {
    if (errors.length < MAX_ERRORS) errors.push({ code, path: typeof path === "string" ? path : pointer(path), message });
  };

  if (scene === null || typeof scene !== "object" || scene.schema !== SCENE_VERSION) {
    const got = scene && typeof scene === "object" ? scene.schema : scene;
    add("SCHEMA_VERSION", ["schema"], `expected "${SCENE_VERSION}", got ${JSON.stringify(got)}`);
    return { errors, warnings };
  }
  errors.push(...checkSchema(sceneSchema, scene, { limit: MAX_ERRORS }));
  if (errors.length) return { errors, warnings };

  const { nodes, timeline, events, fonts, palette, meta } = scene;
  const byId = new Map();
  nodes.forEach((n, i) => {
    if (byId.has(n.id)) add("DUP_ID", ["nodes", i, "id"], `node id "${n.id}" already used at /nodes/${byId.get(n.id).index}`);
    else byId.set(n.id, { node: n, index: i });
  });
  const seenEvents = new Set();
  events.forEach((e, i) => {
    if (seenEvents.has(e.id)) add("DUP_ID", ["events", i, "id"], `event id "${e.id}" already used`);
    seenEvents.add(e.id);
    if (e.f > meta.duration) add("KEY_RANGE", ["events", i, "f"], `frame ${e.f} beyond duration ${meta.duration}`);
  });

  checkParents(nodes, byId, add);
  const baseStates = new Map();
  nodes.forEach((n, i) => {
    const base = {
      z: n.z,
      ...flatten(n.box, "box"),
      ...flatten({ ...TRANSFORM_DEFAULTS, ...(n.transform || {}) }, "transform"),
      "visible.in": n.visible ? n.visible.in : 0,
      "visible.out": n.visible ? n.visible.out : meta.duration,
      ...flatten(n.props, "props"),
    };
    baseStates.set(n.id, base);
    if (n.visible && n.visible.out <= n.visible.in) add("KEY_RANGE", ["nodes", i, "visible"], "out must be greater than in");
    if (n.visible && n.visible.out > meta.duration) add("KEY_RANGE", ["nodes", i, "visible", "out"], `frame ${n.visible.out} beyond duration ${meta.duration}`);
    for (const p of COLOR_PATHS) {
      if (p in base && base[p] !== "none" && resolveColor(base[p], palette) === null) {
        add("PROP_TYPE", ["nodes", i, ...p.split(".")], `"${base[p]}" is not a palette name or #rrggbb`);
      }
    }
    if (n.type === "text") checkText(n, i, fonts, byId, add);
    if (n.type === "map" || n.type === "chart") checkCompanion(n, i, add, warnings);
  });
  const seenTracks = new Set();
  timeline.forEach((track, i) => {
    const id = `${track.node}\u0000${track.prop}`;
    if (seenTracks.has(id)) add("PROP_TYPE", ["timeline", i], `second track for ${track.node} ${track.prop}`);
    seenTracks.add(id);
    checkTrack(track, i, byId, baseStates, palette, meta.duration, add);
  });
  return { errors, warnings };
}

function checkParents(nodes, byId, add) {
  const inReportedCycle = new Set();
  nodes.forEach((n, i) => {
    if (n.parent === null) return;
    if (!byId.has(n.parent)) return add("BAD_PARENT", ["nodes", i, "parent"], `parent "${n.parent}" does not exist`);
    const chain = [];
    let cur = n.id;
    while (cur !== null && !chain.includes(cur) && byId.has(cur)) {
      chain.push(cur);
      cur = byId.get(cur).node.parent;
    }
    if (cur !== null && byId.has(cur) && chain.includes(cur) && !inReportedCycle.has(n.id)) {
      const cycle = chain.slice(chain.indexOf(cur));
      cycle.forEach((id) => inReportedCycle.add(id));
      if (cycle.includes(n.id)) add("PARENT_CYCLE", ["nodes", i, "parent"], `parent chain loops: ${[...cycle, cur].join(" > ")}`);
    }
  });
}

function checkText(n, i, fonts, byId, add) {
  const { family, weight } = n.props.font;
  if (!fonts.some((f) => f.family === family && f.weight === weight)) {
    add("UNKNOWN_FONT", ["nodes", i, "props", "font"], `font "${family}" weight ${weight} is not declared in fonts`);
  }
  const ground = n.props.ground;
  if (ground !== undefined && byId.get(ground)?.node.type !== "shape") {
    add("PROP_TYPE", ["nodes", i, "props", "ground"], `ground "${ground}" must be the id of a shape node`);
  }
  if (n.props.kinetic !== undefined) {
    const file = new URL("../text/text.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(file, "utf8"));
    for (const e of checkSchema(schema, n.props.kinetic, { path: ["nodes", i, "props", "kinetic"] })) add(e.code, e.path, e.message);
  }
}

function checkCompanion(n, i, add, warnings) {
  const file = new URL(COMPANIONS[n.type], import.meta.url);
  if (!existsSync(fileURLToPath(file))) {
    warnings.push({ code: "UNCHECKED_PROPS", path: pointer(["nodes", i, "props"]), message: `no ${COMPANIONS[n.type].slice(3)} yet, ${n.type} props not checked` });
    return;
  }
  const schema = JSON.parse(readFileSync(file, "utf8"));
  for (const e of checkSchema(schema, n.props, { path: ["nodes", i, "props"] })) add(e.code, e.path, e.message);
}

function checkTrack(track, i, byId, baseStates, palette, duration, add) {
  const at = (...rest) => ["timeline", i, ...rest];
  const entry = byId.get(track.node);
  if (!entry) return add("PROP_TYPE", at("node"), `no node with id "${track.node}"`);
  const base = baseStates.get(track.node);
  const opaque = entry.node.type === "map" || entry.node.type === "chart";
  const allowed = opaque ? null : schemaLeaves({ $ref: `#/$defs/${PROPS_DEFS[entry.node.type]}` });
  const known = FIXED_PATHS.has(track.prop) || track.prop in base || (opaque && track.prop.startsWith("props.")) || (allowed && track.prop in allowed);
  if (!known) return add("UNKNOWN_FIELD", at("prop"), `node "${track.node}" (${entry.node.type}) has no animatable prop "${track.prop}"`);

  const isColor = COLOR_PATHS.includes(track.prop);
  const baseKind = track.prop in base ? kindOf(base[track.prop], isColor) : null;
  let trackKind = baseKind;
  track.keys.forEach((k, j) => {
    if (j === 0 && k.ease !== undefined) add("PROP_TYPE", at("keys", j, "ease"), "first key must not carry ease");
    if (j > 0 && k.f <= track.keys[j - 1].f) add("KEY_ORDER", at("keys", j, "f"), `frame ${k.f} does not exceed previous key ${track.keys[j - 1].f}`);
    if (k.f > duration) add("KEY_RANGE", at("keys", j, "f"), `frame ${k.f} beyond duration ${duration}`);
    if (isColor && resolveColor(k.v, palette) === null) return add("PROP_TYPE", at("keys", j, "v"), `"${k.v}" is not a palette name or #rrggbb`);
    const kind = kindOf(k.v, isColor);
    trackKind ??= kind;
    if (kind !== trackKind) add("PROP_TYPE", at("keys", j, "v"), `value is ${kind}, track is ${trackKind}`);
  });
}

/** @param {string} file @returns {any} */
export const loadScene = (file) => JSON.parse(readFileSync(file, "utf8"));

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error("usage: node src/scene/validate.mjs <scene.json>");
    return 2;
  }
  let scene;
  try {
    scene = loadScene(file);
  } catch (err) {
    console.error(`SCENE_UNREADABLE ${file} ${err.message}`);
    return 2;
  }
  const { errors, warnings } = validateScene(scene);
  for (const w of warnings) console.error(`WARN ${w.code} ${w.path} ${w.message}`);
  if (errors.length) {
    for (const e of errors) console.log(`${e.code} ${e.path || "/"} ${e.message}`);
    if (errors.length >= MAX_ERRORS) console.log(`stopped after ${MAX_ERRORS} errors`);
    return 1;
  }
  console.log(`OK ${scene.meta.id} ${scene.meta.duration} frames ${sceneFps(scene)} fps`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv);
