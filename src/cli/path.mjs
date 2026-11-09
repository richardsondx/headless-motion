// hme path: edit a points list by node id, one command per run.
//
// Each command names node ids and point ids, never edits in place, and
// writes a new versioned scene file. An edit with an unknown node id
// or point id fails loudly with a named error and writes nothing.
// The edit applies to the base points list and to every keyframe
// points list of a props.points track for the same node, so a morph
// keeps its topology and the render shows the edit.
//
// Determinism: no Math.random, no Date, no locale. Numbers round
// through fmt (3 decimals), the same rounding the evaluator uses.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadScene, validateScene } from "../scene/validate.mjs";
import { fmt } from "../scene/evaluate.mjs";

export const USAGE = [
  "hme path: Edit a vector path by node id. Each command writes a new versioned scene file. No command edits in place.",
  "",
  "Usage: hme path <command> --scene <scene.json> --node <node-id> [options] --out <new-scene.json>",
  "       hme path move --scene <scene.json> --node outline --point p2 --dx 12 --dy 0 --out out/scene-v2.json",
  "       hme path handle --scene <scene.json> --node outline --point p3 --handle out --dx 0 --dy -8 --out out/scene-v2.json",
  "       hme path insert --scene <scene.json> --node outline --after p2 --id p2b --x 212 --y 75 --out out/scene-v2.json",
  "       hme path delete --scene <scene.json> --node outline --point p4 --out out/scene-v2.json",
  "       hme path convert --scene <scene.json> --node outline --point p3 --to line --out out/scene-v2.json",
  "       hme path smooth --scene <scene.json> --node outline --from p2 --to p4 --out out/scene-v2.json",
  "       hme path simplify --scene <scene.json> --node outline --from p1 --to p4 --tolerance 5 --out out/scene-v2.json",
  "",
  "Commands:",
  "  move      Move one named node by dx, dy px. Its handles move with it.",
  "  handle    Pull one named handle (in or out) of one node by dx, dy px.",
  "  insert    Insert a new node after a named node, at x, y px.",
  "  delete    Delete one named node. At least one node stays.",
  "  convert   Convert one named node between line, cubic, and smooth.",
  "  smooth    Smooth a run of nodes from one id to another id.",
  "  simplify  Drop run nodes within a px tolerance of the chord (Ramer-Douglas-Peucker).",
  "",
  "Options:",
  "  --scene <file>  Scene file to edit. Required.",
  "  --node <id>  Shape node id that holds the points list. Required.",
  "  --point <id>  Point id to move, pull, delete, or convert. Required for move, handle, delete, convert.",
  "  --after <id>  Point id to insert after. Required for insert.",
  "  --id <id>  Id for the inserted point. Required for insert.",
  "  --x <n>  X in box-local px for the inserted point. Required for insert.",
  "  --y <n>  Y in box-local px for the inserted point. Required for insert.",
  "  --command <line|cubic|smooth>  Command for the inserted point. Default line.",
  "  --in <x,y>  In-handle for the inserted point. Default null (on the anchor).",
  "  --outh <x,y>  Out-handle for the inserted point. Default null (on the anchor).",
  "  --handle <in|out>  Which handle to pull. Required for handle.",
  "  --dx <n>  Move in x, px. Required for move and handle.",
  "  --dy <n>  Move in y, px. Required for move and handle.",
  "  --to <line|cubic|smooth>  Target command. Required for convert.",
  "  --from <id>  First point id of a run. Required for smooth and simplify.",
  "  --to <id>  Last point id of a run. Required for smooth and simplify.",
  "  --tolerance <n>  Max px a dropped node may sit from the chord. Required for simplify.",
  "  --out <file>  Where to write the new scene file. Required. Never overwrites an existing file.",
  "",
  "Example: hme path move --scene tests/fixtures/path-points.json --node outline --point p2 --dx 12 --dy 0 --out /tmp/path-points-v2.json",
  "",
  "Exit codes: 0 ok, 2 usage or run error.",
].join("\n") + "\n";

const COMMANDS = ["move", "handle", "insert", "delete", "convert", "smooth", "simplify"];
const POINT_COMMANDS = ["line", "cubic", "smooth"];

/** Named error: code travels on err.code, message names the id. */
function named(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Parse "x,y" into [x, y], or null when the text is not two numbers. */
export function parsePair(value) {
  if (value === null || value === undefined) return null;
  const parts = String(value).split(",");
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** Parse path argv. Returns options plus error (null on success). Pure. */
export function parsePathArgs(argv) {
  const out = {
    command: null, scene: null, node: null, point: null, after: null, id: null,
    x: null, y: null, cmd: null, inPair: null, outPair: null, handle: null,
    dx: null, dy: null, to: null, from: null, tolerance: null, out: null, error: null,
  };
  const positionals = [];
  const opts = ["--scene", "--node", "--point", "--after", "--id", "--x", "--y",
    "--command", "--in", "--outh", "--out", "--handle", "--dx", "--dy", "--to", "--from", "--tolerance"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (opts.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        out.error = `option "${a}" needs a value`;
        return out;
      }
      i++;
      if (a === "--scene") out.scene = v;
      else if (a === "--node") out.node = v;
      else if (a === "--point") out.point = v;
      else if (a === "--after") out.after = v;
      else if (a === "--id") out.id = v;
      else if (a === "--x") out.x = Number(v);
      else if (a === "--y") out.y = Number(v);
      else if (a === "--command") out.cmd = v;
      else if (a === "--in") out.inPair = parsePair(v);
      else if (a === "--outh") out.outPair = parsePair(v);
      else if (a === "--out") out.out = v;
      else if (a === "--handle") out.handle = v;
      else if (a === "--dx") out.dx = Number(v);
      else if (a === "--dy") out.dy = Number(v);
      else if (a === "--to") out.to = v;
      else if (a === "--from") out.from = v;
      else if (a === "--tolerance") out.tolerance = Number(v);
      else if (a === "--out") out.out = v;
    } else if (a.startsWith("--")) {
      out.error = `unknown option "${a}"`;
      return out;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length === 0) {
    out.error = "needs a subcommand: move, handle, insert, delete, convert, smooth, or simplify";
    return out;
  }
  if (positionals.length > 1) {
    out.error = `takes one subcommand, got ${positionals.length}`;
    return out;
  }
  out.command = positionals[0];
  if (!COMMANDS.includes(out.command)) {
    out.error = `unknown subcommand "${out.command}": use ${COMMANDS.join(", ")}`;
    return out;
  }
  if (!out.scene) {
    out.error = "needs --scene <scene.json>";
    return out;
  }
  if (!out.node) {
    out.error = "needs --node <node-id>";
    return out;
  }
  if (!out.out) {
    out.error = "needs --out <new-scene.json>";
    return out;
  }
  const needNum = (v, name) => {
    if (!isNum(v)) {
      out.error = `${name} must be a number`;
      return false;
    }
    return true;
  };
  if (out.command === "move" || out.command === "handle") {
    if (!out.point) {
      out.error = `${out.command} needs --point <point-id>`;
      return out;
    }
    if (out.command === "handle" && out.handle !== "in" && out.handle !== "out") {
      out.error = 'handle needs --handle in or --handle out';
      return out;
    }
    if (!needNum(out.dx, "--dx") || !needNum(out.dy, "--dy")) return out;
  }
  if (out.command === "delete" || out.command === "convert") {
    if (!out.point) {
      out.error = `${out.command} needs --point <point-id>`;
      return out;
    }
    if (out.command === "convert" && !POINT_COMMANDS.includes(out.to)) {
      out.error = "--to must be line, cubic, or smooth";
      return out;
    }
  }
  if (out.command === "insert") {
    if (!out.after) {
      out.error = "insert needs --after <point-id>";
      return out;
    }
    if (!out.id) {
      out.error = "insert needs --id <new-point-id>";
      return out;
    }
    if (!needNum(out.x, "--x") || !needNum(out.y, "--y")) return out;
    if (out.cmd !== null && out.cmd !== undefined && !POINT_COMMANDS.includes(out.cmd)) {
      out.error = "--command must be line, cubic, or smooth";
      return out;
    }
  }
  if (out.command === "smooth" || out.command === "simplify") {
    if (!out.from || !out.to) {
      out.error = `${out.command} needs --from <point-id> and --to <point-id>`;
      return out;
    }
    if (out.command === "simplify" && (!isNum(out.tolerance) || out.tolerance < 0)) {
      out.error = "--tolerance must be a number at or above 0";
      return out;
    }
  }
  return out;
}

/** Find the shape node and its points list. Throws named errors. */
function findPoints(scene, nodeId) {
  const node = (scene.nodes || []).find((n) => n.id === nodeId);
  if (!node) throw named("PATH_UNKNOWN_NODE", `PATH_UNKNOWN_NODE no node with id "${nodeId}"`);
  const points = node.props && node.props.points;
  if (!Array.isArray(points) || points.length === 0) {
    throw named("PATH_NO_POINTS", `PATH_NO_POINTS node "${nodeId}" has no points list to edit`);
  }
  return { node, points };
}

/** Index of a point id in a list. Throws PATH_UNKNOWN_POINT. */
function pointIndex(points, pointId, nodeId) {
  const i = points.findIndex((p) => p.id === pointId);
  if (i < 0) throw named("PATH_UNKNOWN_POINT", `PATH_UNKNOWN_POINT no point with id "${pointId}" on node "${nodeId}"`);
  return i;
}

const shift = (pt, dx, dy) => (pt ? [fmt(pt[0] + dx), fmt(pt[1] + dy)] : null);
const mid = (a, b) => [fmt((a[0] + b[0]) / 2), fmt((a[1] + b[1]) / 2)];

/**
 * Edit one points list. Returns a new list. Throws named errors.
 * opts: {command, point, after, id, x, y, cmd, inPair, outPair,
 *   handle, dx, dy, to, from, tolerance}
 */
export function editPoints(points, opts, nodeId) {
  const list = points.map((p) => ({
    id: p.id,
    anchor: [...p.anchor],
    in: p.in ? [...p.in] : null,
    out: p.out ? [...p.out] : null,
    command: p.command,
  }));
  switch (opts.command) {
    case "move": {
      const i = pointIndex(list, opts.point, nodeId);
      const p = list[i];
      p.anchor = shift(p.anchor, opts.dx, opts.dy);
      p.in = shift(p.in, opts.dx, opts.dy);
      p.out = shift(p.out, opts.dx, opts.dy);
      return list;
    }
    case "handle": {
      const i = pointIndex(list, opts.point, nodeId);
      const p = list[i];
      if (opts.handle === "in") p.in = shift(p.in || p.anchor, opts.dx, opts.dy);
      else p.out = shift(p.out || p.anchor, opts.dx, opts.dy);
      return list;
    }
    case "insert": {
      const i = pointIndex(list, opts.after, nodeId);
      if (list.some((p) => p.id === opts.id)) {
        throw named("PATH_DUPLICATE_POINT", `PATH_DUPLICATE_POINT point id "${opts.id}" already exists on node "${nodeId}"`);
      }
      const added = {
        id: opts.id,
        anchor: [fmt(opts.x), fmt(opts.y)],
        in: opts.inPair ? [fmt(opts.inPair[0]), fmt(opts.inPair[1])] : null,
        out: opts.outPair ? [fmt(opts.outPair[0]), fmt(opts.outPair[1])] : null,
        command: opts.cmd || "line",
      };
      list.splice(i + 1, 0, added);
      return list;
    }
    case "delete": {
      const i = pointIndex(list, opts.point, nodeId);
      if (list.length <= 1) {
        throw named("PATH_DELETE_LAST", `PATH_DELETE_LAST cannot delete the last point of node "${nodeId}"`);
      }
      list.splice(i, 1);
      return list;
    }
    case "convert": {
      const i = pointIndex(list, opts.point, nodeId);
      const p = list[i];
      const prev = i > 0 ? list[i - 1] : null;
      if (opts.to === "line") {
        p.command = "line";
        p.in = null;
        if (prev) prev.out = null;
      } else if (opts.to === "cubic") {
        p.command = "cubic";
        if (prev && !prev.out) prev.out = mid(prev.anchor, p.anchor);
        if (!p.in) p.in = prev ? mid(prev.anchor, p.anchor) : [...p.anchor];
      } else {
        p.command = "smooth";
        if (!p.in) p.in = prev ? mid(prev.anchor, p.anchor) : [...p.anchor];
      }
      return list;
    }
    case "smooth": {
      const a = pointIndex(list, opts.from, nodeId);
      const b = pointIndex(list, opts.to, nodeId);
      if (b < a) throw named("PATH_BAD_RANGE", `PATH_BAD_RANGE --from "${opts.from}" comes after --to "${opts.to}" on node "${nodeId}"`);
      for (let i = a; i <= b; i++) {
        const p = list[i];
        const prev = i > 0 ? list[i - 1] : null;
        const next = i + 1 < list.length ? list[i + 1] : null;
        if (i > 0) p.command = "smooth";
        p.in = prev ? mid(prev.anchor, p.anchor) : null;
        p.out = next ? mid(p.anchor, next.anchor) : null;
      }
      return list;
    }
    case "simplify": {
      const a = pointIndex(list, opts.from, nodeId);
      const b = pointIndex(list, opts.to, nodeId);
      if (b < a) throw named("PATH_BAD_RANGE", `PATH_BAD_RANGE --from "${opts.from}" comes after --to "${opts.to}" on node "${nodeId}"`);
      const run = list.slice(a, b + 1);
      const keep = rdpKeep(run, opts.tolerance);
      const kept = run.filter((_, i) => keep.has(i));
      return [...list.slice(0, a), ...kept, ...list.slice(b + 1)];
    }
    default:
      throw named("PATH_UNKNOWN_COMMAND", `PATH_UNKNOWN_COMMAND unknown path command "${opts.command}"`);
  }
}

/** Perpendicular distance from point p to the line through a and b. */
function perpDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

/**
 * Ramer-Douglas-Peucker keep set for a run of points, by anchor.
 * Endpoints always stay. A point stays when its distance from the
 * chord exceeds the tolerance. Deterministic, no randomness.
 */
export function rdpKeep(run, tolerance) {
  const keep = new Set([0, run.length - 1]);
  const stack = [[0, run.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let worst = -1;
    let worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(run[i].anchor, run[a].anchor, run[b].anchor);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep.add(worst);
    stack.push([a, worst], [worst, b]);
  }
  return keep;
}

/**
 * Apply one path edit to a scene object. Returns a new scene object.
 * The base points list and every keyframe points list of a
 * props.points track for the node change together, so the morph
 * topology stays shared. The input scene is not mutated.
 */
export function applyPathEdit(scene, opts) {
  const { node, points } = findPoints(scene, opts.node);
  const edited = editPoints(points, opts, opts.node);
  const next = JSON.parse(JSON.stringify(scene));
  const nextNode = next.nodes.find((n) => n.id === opts.node);
  nextNode.props.points = edited;
  for (const track of next.timeline || []) {
    if (track.node !== opts.node || track.prop !== "props.points") continue;
    for (const key of track.keys) {
      if (!Array.isArray(key.v) || key.v.length === 0 || !Array.isArray(key.v[0].anchor)) continue;
      // The keyframe list must share the base topology before the
      // edit, or the morph guard would already fail on it.
      key.v = editPoints(key.v, opts, opts.node);
    }
  }
  return next;
}

function writeJson(path, obj) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), JSON.stringify(obj, null, 2) + "\n");
}

/** Run `hme path ...`. Returns the process exit code: 0 ok, 2 error. */
export async function runPath(argv) {
  const parsed = parsePathArgs(argv);
  if (parsed.error) {
    console.error(`hme path: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const scenePath = resolve(parsed.scene);
  if (!existsSync(scenePath)) {
    console.error(`hme path: no such file: ${parsed.scene}`);
    return 2;
  }
  const outPath = resolve(parsed.out);
  if (existsSync(outPath)) {
    console.error(`hme path: refusing to overwrite existing file: ${parsed.out}`);
    return 2;
  }
  let scene;
  try {
    scene = loadScene(scenePath);
  } catch (err) {
    console.error(`hme path: cannot read scene ${parsed.scene}: ${err.message}`);
    return 2;
  }
  const before = validateScene(scene);
  if (before.errors.length > 0) {
    console.error(`hme path: scene ${parsed.scene} fails validation: ${before.errors[0].code} ${before.errors[0].path} ${before.errors[0].message}`);
    return 2;
  }
  let next;
  try {
    next = applyPathEdit(scene, parsed);
  } catch (err) {
    console.error(`hme path: ${err.message}`);
    return 2;
  }
  const after = validateScene(next);
  if (after.errors.length > 0) {
    console.error(`hme path: edited scene fails validation: ${after.errors[0].code} ${after.errors[0].path} ${after.errors[0].message}`);
    return 2;
  }
  writeJson(outPath, next);
  const pts = next.nodes.find((n) => n.id === parsed.node).props.points;
  process.stderr.write(`wrote ${parsed.out} (${parsed.command} ${parsed.node}: ${pts.length} points)\n`);
  return 0;
}
