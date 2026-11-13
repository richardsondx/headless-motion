// hme ledger: one JSON file per video or render, schema hme.ledger/1.0.
//
// An agent reads one ledger file and learns every position, in px and
// ratios, with no guessing. Rows are per frame times per named element.
// Each row holds centre px, centre ratio, bbox px, bbox ratio, area
// ratio, four border gaps in px and ratios, z, visible, camera state,
// and provenance. Both px and ratios appear in every row.
//
// Two builders, one schema:
// - build from a scene: computed, exact, from sampleScene, no render.
//   The camera comes from the map node's camera knots when the scene
//   has a map node, else zoom ratio 1.
// - build from a video or a frames dir: measured, with checker.layout
//   segment_frame per frame for colour layers, and bright-text clusters
//   at 0.5 s sampling for labels. An alias table maps a reference
//   colour, layer, or cluster to an element id. A cluster with no
//   alias entry is listed as unnamed, never silently named. No OCR
//   exists in the toolchain, so clusters are matched by position only.
// - diff: per shared element per frame, the delta in px and ratios,
//   plus the worst element.
//
// Determinism: no Math.random, no Date, no locale. Frame order,
// element order, and row order are fixed. The same inputs give the
// same bytes.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleScene } from "../scene/evaluate.mjs";
import { ease } from "../scene/easing.mjs";
import { loadScene, validateScene } from "../scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

export const LEDGER_SCHEMA = "hme.ledger/1.0";
export const ALIAS_SCHEMA = "hme.alias/1.0";
export const DIFF_SCHEMA = "hme.ledger-diff/1.0";
export const LABEL_SAMPLE_EVERY_S = 0.5;
export const LABEL_TRACK_WINDOW_PX = 150;
// A colour detection under this many pixels counts as absent. It is
// the checker's own speck floor (checker.layout LABEL_MIN_N): a
// 2 px sliver is not the element, so its centroid is not the
// element's position.
export const MIN_MEASURED_PIXELS = 50;

export const LAYER_ORDER = ["sudan", "base", "rsf", "october", "white_text"];
export const LAYER_TOLERANCE = { sudan: 15, base: 15, rsf: 12, october: 15, white_text: 200 };
export const LAYER_METHOD = {
  sudan: "checker.layout.segment_frame stride 2: largest connected component of the colour mask; under 50 px counts as absent",
  base: "checker.layout.segment_frame stride 2: union of all mask pixels; under 50 px counts as absent",
  rsf: "checker.layout.segment_frame stride 2: badge discriminator, compact components only; under 50 px counts as absent",
  october: "checker.layout.segment_frame stride 2: union of all mask pixels; under 50 px counts as absent",
  white_text: "checker.layout.segment_frame stride 2: union of bright components (luma >= 200); under 50 px counts as absent",
};

export const USAGE = [
  "hme ledger: Build and diff coordinate ledgers, schema hme.ledger/1.0. One JSON file per video or render; one row per frame per named element, in px and ratios.",
  "",
  "Usage: hme ledger build --scene <scene.json> --frames <a:b> --out <ledger.json>",
  "       hme ledger build --video video.mp4 --alias <alias.json> [--frames <a:b>] --out <ledger.json>",
  "       hme ledger build --frames-dir <dir> --alias <alias.json> [--fps <n>] [--frames <a:b>] --out <ledger.json>",
  "       hme ledger diff --ref <ledger.json> --ours <ledger.json> [--out <diff.json>]",
  "",
  "Arguments:",
  "  build  Write a ledger file. Exactly one of --scene, --video, or --frames-dir.",
  "  diff  Compare two ledgers and write the per-element per-frame deltas plus the worst element.",
  "",
  "Options:",
  "  --scene <file>  Scene file for a computed build. No render is needed. No alias table is used.",
  "  --video <file>  Video file for a measured build. Frames are extracted with ffmpeg at native fps.",
  "  --frames-dir <dir>  Directory of frame PNGs for a measured build, in sorted order. Use for reference frames.",
  "  --alias <file>  Alias table file (schema hme.alias/1.0). Required for a measured build. Maps a colour, layer, or cluster to an element id. A cluster with no entry is listed as unnamed.",
  "  --frames <a:b>  Frame window, a up to but not including b. Default for a scene is 0 up to its duration; for a video, all frames; for a frames dir, all files.",
  "  --fps <n>  Frames per second of a frames dir. Default 24. A video reads its fps from ffprobe.",
  "  --ref <file>  Reference ledger for diff. Required.",
  "  --ours <file>  Our ledger for diff. Required.",
  "  --out <file>  Write the ledger or diff JSON here. Required for build; diff writes to stdout without it.",
  "",
  "Example: hme ledger build --scene tests/fixtures/seg4-scene-clone-v5.json --frames 0:120 --out out/seg4-computed.json",
  "",
  "Exit codes: 0 ok, 2 usage or run error.",
].join("\n") + "\n";

const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;

// Parse "a:b" into {start, end}. Pure function, tested.
export function parseFramesRange(value) {
  if (value === null || value === undefined) return { start: null, end: null, error: null };
  const m = /^(\d+):(\d+)$/.exec(String(value).trim());
  if (!m) return { start: null, end: null, error: `--frames must be "a:b", got "${value}"` };
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end <= start) return { start: null, end: null, error: `--frames end must be greater than start, got "${value}"` };
  return { start, end, error: null };
}

// Parse ledger argv. Returns the options plus error (null on success).
// Pure function, tested without touching the disk.
export function parseLedgerArgs(argv) {
  const out = {
    command: null, scene: null, video: null, framesDir: null, alias: null,
    frames: null, fps: null, ref: null, ours: null, out: null, error: null,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scene" || a === "--video" || a === "--frames-dir" || a === "--alias"
      || a === "--frames" || a === "--fps" || a === "--ref" || a === "--ours" || a === "--out") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        out.error = `option "${a}" needs a value`;
        return out;
      }
      i++;
      if (a === "--scene") out.scene = v;
      else if (a === "--video") out.video = v;
      else if (a === "--frames-dir") out.framesDir = v;
      else if (a === "--alias") out.alias = v;
      else if (a === "--frames") out.frames = v;
      else if (a === "--fps") out.fps = Number(v);
      else if (a === "--ref") out.ref = v;
      else if (a === "--ours") out.ours = v;
      else if (a === "--out") out.out = v;
    } else if (a.startsWith("--")) {
      out.error = `unknown option "${a}"`;
      return out;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length === 0) {
    out.error = "needs a subcommand: hme ledger build ... or hme ledger diff ...";
    return out;
  }
  if (positionals.length > 1) {
    out.error = `takes one subcommand, got ${positionals.length}`;
    return out;
  }
  out.command = positionals[0];
  if (out.command !== "build" && out.command !== "diff") {
    out.error = `unknown subcommand "${out.command}": use build or diff`;
    return out;
  }
  if (out.command === "build") {
    const sources = [out.scene, out.video, out.framesDir].filter(Boolean).length;
    if (sources === 0) {
      out.error = "build needs exactly one of --scene, --video, or --frames-dir";
      return out;
    }
    if (sources > 1) {
      out.error = "build takes exactly one of --scene, --video, or --frames-dir";
      return out;
    }
    if (out.scene && out.alias) {
      out.error = "a computed build from a scene needs no alias table: drop --alias";
      return out;
    }
    if (!out.scene && !out.alias) {
      out.error = "a measured build needs --alias <alias.json>";
      return out;
    }
    if (!out.out) {
      out.error = "build needs --out <ledger.json>";
      return out;
    }
    if (out.ref || out.ours) {
      out.error = "--ref and --ours belong to diff, not build";
      return out;
    }
    if (out.fps !== null && out.video) {
      out.error = "--fps is for --frames-dir only; a video reads its fps from ffprobe";
      return out;
    }
    if (out.fps !== null && !Number.isFinite(out.fps)) {
      out.error = "--fps must be a number";
      return out;
    }
    if (out.fps !== null && out.fps <= 0) {
      out.error = "--fps must be greater than 0";
      return out;
    }
  } else {
    if (!out.ref) {
      out.error = "diff needs --ref <ledger.json>";
      return out;
    }
    if (!out.ours) {
      out.error = "diff needs --ours <ledger.json>";
      return out;
    }
    if (out.scene || out.video || out.framesDir || out.alias || out.frames || out.fps !== null) {
      out.error = "diff takes only --ref, --ours, and --out";
      return out;
    }
  }
  const range = parseFramesRange(out.frames);
  if (range.error) {
    out.error = range.error;
    return out;
  }
  out.frames = range.start === null ? null : { start: range.start, end: range.end };
  return out;
}

// One ledger row from measured or computed geometry. Pure function.
// geom: {centre: [x, y] | null, bbox: [x0, y0, x1, y1] | null,
//   pixels: number | null, z: number | null, visible: boolean}
// meta: {frame, time_s, element_id, width, height, camera, provenance}
export function makeRow(geom, meta) {
  const { width, height } = meta;
  const centre = geom.centre;
  const bbox = geom.bbox;
  const area = geom.pixels === null || geom.pixels === undefined
    ? (bbox ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) / (width * height) : null)
    : geom.pixels / (width * height);
  return {
    frame: meta.frame,
    time_s: r3(meta.time_s),
    element_id: meta.element_id,
    centre_px: centre ? [r1(centre[0]), r1(centre[1])] : null,
    centre_ratio: centre ? [r4(centre[0] / width), r4(centre[1] / height)] : null,
    bbox_px: bbox ? [Math.round(bbox[0]), Math.round(bbox[1]), Math.round(bbox[2]), Math.round(bbox[3])] : null,
    bbox_ratio: bbox
      ? [r4(bbox[0] / width), r4(bbox[1] / height), r4((bbox[2] - bbox[0]) / width), r4((bbox[3] - bbox[1]) / height)]
      : null,
    area_ratio: area === null || area === undefined ? null : r4(area),
    border_gaps_px: bbox
      ? { left: r1(bbox[0]), right: r1(width - bbox[2]), top: r1(bbox[1]), bottom: r1(height - bbox[3]) }
      : null,
    border_gaps_ratio: bbox
      ? { left: r4(bbox[0] / width), right: r4((width - bbox[2]) / width), top: r4(bbox[1] / height), bottom: r4((height - bbox[3]) / height) }
      : null,
    z: geom.z === undefined ? null : geom.z,
    visible: geom.visible,
    camera: meta.camera,
    provenance: meta.provenance,
  };
}

// Geometry of one node from its sampled state. The renderer puts the
// element at box plus transform offset, and scales and rotates about
// the anchor when one is set, else the element centre (the CSS
// default transform origin). scaleX and scaleY fall back to the
// uniform scale, matching the evaluator and the runtime. The bbox is
// the axis-aligned box of the four mapped corners, where each corner
// p maps to origin + R x S x (p - origin): scale first, then rotate,
// both about the same origin. Pure function.
export function computedGeometry(state, node) {
  const w0 = state["box.w"];
  const h0 = state["box.h"];
  const tx = state["transform.x"] || 0;
  const ty = state["transform.y"] || 0;
  const sx = state["transform.scaleX"] ?? state["transform.scale"] ?? 1;
  const sy = state["transform.scaleY"] ?? state["transform.scale"] ?? 1;
  const rot = state["transform.rotation"] || 0;
  const x0 = (state["box.x"] || 0) + tx;
  const y0 = (state["box.y"] || 0) + ty;
  // Anchor in px relative to the box top-left; each axis falls back
  // to the box centre, matching the runtime. With no anchor set the
  // origin is the box centre, as before.
  const ox = x0 + (state["transform.anchorX"] ?? w0 / 2);
  const oy = y0 + (state["transform.anchorY"] ?? h0 / 2);
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const map = (px, py) => {
    const dx = (px - ox) * sx;
    const dy = (py - oy) * sy;
    return [ox + dx * cos - dy * sin, oy + dx * sin + dy * cos];
  };
  const corners = [
    map(x0, y0),
    map(x0 + w0, y0),
    map(x0 + w0, y0 + h0),
    map(x0, y0 + h0),
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const centre = map(x0 + w0 / 2, y0 + h0 / 2);
  return {
    centre: [r3(centre[0]), r3(centre[1])],
    bbox: [r3(Math.min(...xs)), r3(Math.min(...ys)), r3(Math.max(...xs)), r3(Math.max(...ys))],
    pixels: null,
    z: node.z,
    visible: state.visible,
    boxArea: w0 * sx * h0 * sy,
  };
}

// Camera state at one frame. A map scene interpolates the map node's
// camera knots between event frames, with the arriving knot's ease.
// Any other scene has no camera, so zoom ratio is 1. Pure function.
// Throws LEDGER_CAMERA_EVENT_MISSING when a knot names an event the
// scene does not list, and LEDGER_CAMERA_MISSING when a map node has
// no camera list.
export function cameraAtFrame(scene, frame) {
  const map = scene.nodes.find((n) => n.type === "map");
  if (!map) return { zoom_ratio: 1, centre_lon: null, centre_lat: null, subject: null };
  const knots = map.props && Array.isArray(map.props.camera) ? map.props.camera : null;
  if (!knots || knots.length === 0) {
    const err = new Error("LEDGER_CAMERA_MISSING map node has no camera list");
    err.code = "LEDGER_CAMERA_MISSING";
    throw err;
  }
  const eventFrame = new Map((scene.events || []).map((e) => [e.id, e.f]));
  const timed = knots.map((k) => {
    if (!eventFrame.has(k.event)) {
      const err = new Error(`LEDGER_CAMERA_EVENT_MISSING camera knot names event "${k.event}" with no frame in scene.events`);
      err.code = "LEDGER_CAMERA_EVENT_MISSING";
      throw err;
    }
    return { f: eventFrame.get(k.event), zoom: k.zoom, center: k.center, ease: k.ease ?? "linear" };
  });
  timed.sort((a, b) => a.f - b.f);
  const at = (k) => ({ zoom_ratio: r3(k.zoom), centre_lon: k.center[0], centre_lat: k.center[1], subject: null });
  if (frame <= timed[0].f) return at(timed[0]);
  if (frame >= timed[timed.length - 1].f) return at(timed[timed.length - 1]);
  let i = 1;
  while (timed[i].f <= frame) i++;
  const a = timed[i - 1];
  const b = timed[i];
  const t = (frame - a.f) / (b.f - a.f);
  const e = ease(b.ease, t);
  const lerp = (u, v) => u + (v - u) * e;
  return {
    zoom_ratio: r3(lerp(a.zoom, b.zoom)),
    centre_lon: r3(lerp(a.center[0], b.center[0])),
    centre_lat: r3(lerp(a.center[1], b.center[1])),
    subject: null,
  };
}

// Build a computed ledger from a validated scene. Pure function.
// Rows cover every node at every frame of [startFrame, endFrame).
// A node with a parent fails loudly: parent chains are not composed
// here, so a row would misplace it.
export function buildComputedLedger(scene, startFrame, endFrame) {
  const width = scene.meta.width;
  const height = scene.meta.height;
  const fps = scene.meta.fps;
  const rows = [];
  for (const node of scene.nodes) {
    if (node.parent !== null && node.parent !== undefined) {
      const err = new Error(`LEDGER_PARENT_UNSUPPORTED node "${node.id}" has parent "${node.parent}"; parent chains are not composed`);
      err.code = "LEDGER_PARENT_UNSUPPORTED";
      throw err;
    }
  }
  for (let frame = startFrame; frame < endFrame; frame++) {
    const state = sampleScene(scene, frame);
    const camera = cameraAtFrame(scene, frame);
    for (const node of scene.nodes) {
      const s = state[node.id];
      const g = computedGeometry(s, node);
      const geom = s.visible
        ? { centre: g.centre, bbox: g.bbox, pixels: null, z: node.z, visible: true }
        : { centre: null, bbox: null, pixels: null, z: node.z, visible: false };
      // Computed area ratio is the scaled box area over the frame area.
      const row = makeRow(geom, {
        frame,
        time_s: frame / fps,
        element_id: node.id,
        width,
        height,
        camera,
        provenance: {
          kind: "computed",
          source_frame: frame,
          tolerance: 0,
          sampling: "every frame",
          method: "sampleScene(scene, frame); box centre plus transform offset; scale and rotation about the element centre; area ratio is the scaled box area over the frame area",
        },
      });
      if (s.visible) row.area_ratio = r4(g.boxArea / (width * height));
      rows.push(row);
    }
  }
  return {
    schema: LEDGER_SCHEMA,
    source: { kind: "scene", file: scene.meta.id, scene_id: scene.meta.id, fps },
    frame_width: width,
    frame_height: height,
    fps,
    frame_start: startFrame,
    frame_end: endFrame,
    frame_count: endFrame - startFrame,
    sampling: { colour: "every frame", labels: "not applicable: a scene has no label clusters" },
    elements: scene.nodes.map((n) => ({ id: n.id, kind: n.type, source: null, z: n.z })),
    alias: { file: null, entries: [] },
    unnamed: [],
    rows,
  };
}

// Validate an alias table object. Returns {valid, errors}. Pure.
export function validateAliasTable(alias) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  if (alias === null || typeof alias !== "object" || Array.isArray(alias)) {
    return { valid: false, errors: ["alias table must be an object"] };
  }
  need(alias.schema === ALIAS_SCHEMA, `alias table schema must be ${ALIAS_SCHEMA}`);
  need(Array.isArray(alias.entries), "alias table entries must be an array");
  if (Array.isArray(alias.entries)) {
    const ids = new Set();
    alias.entries.forEach((e, i) => {
      const at = `entries[${i}]`;
      if (!e || typeof e !== "object") { errors.push(`${at} must be an object`); return; }
      need(typeof e.id === "string" && e.id.length > 0, `${at}.id must be a non-empty string`);
      need(typeof e.basis === "string" && e.basis.length > 0, `${at}.basis must be a non-empty string`);
      need(["colour", "colour-layer", "label-cluster"].includes(e.kind), `${at}.kind must be colour, colour-layer, or label-cluster`);
      if (e.id) {
        need(!ids.has(e.id), `${at}.id "${e.id}" is used twice`);
        ids.add(e.id);
      }
      if (e.kind === "colour-layer") {
        need(typeof e.layer === "string" && LAYER_ORDER.includes(e.layer), `${at}.layer must be one of ${LAYER_ORDER.join(", ")}`);
      }
      if (e.kind === "colour") {
        need(typeof e.colour === "string" && /^#[0-9a-fA-F]{6}$/.test(e.colour), `${at}.colour must be a hex colour`);
      }
      if (e.kind === "label-cluster") {
        need(Array.isArray(e.near_xy) && e.near_xy.length === 2 && e.near_xy.every(Number.isFinite), `${at}.near_xy must be [x, y]`);
        need(typeof e.window_px === "number" && e.window_px > 0, `${at}.window_px must be a positive number`);
      }
      if (e.frames !== undefined && e.frames !== null) {
        need(Array.isArray(e.frames) && e.frames.length === 2 && e.frames.every(Number.isInteger) && e.frames[1] > e.frames[0],
          `${at}.frames must be [start, end] with end greater than start`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

// Element id for one colour layer at one frame, or "unnamed:<layer>".
// An entry with a frames window applies only inside that window.
// Pure function.
export function elementIdForLayer(layer, frame, alias) {
  const entry = (alias.entries || []).find((e) => e.kind === "colour-layer" && e.layer === layer
    && (!e.frames || (frame >= e.frames[0] && frame < e.frames[1])));
  return entry ? entry.id : `unnamed:${layer}`;
}

// Element id for one label track, or "unnamed:<track id>". Entries are
// single-use: usedIds holds the ids already taken, in first-seen
// order, so the earliest track claims its entry. An entry applies
// only when the track first appears inside its frames window (when
// the entry has one) and within window_px of near_xy. Pure function.
export function elementIdForTrack(track, alias, usedIds) {
  const inWindow = (e) => !e.frames || (track.firstFrame >= e.frames[0] && track.firstFrame < e.frames[1]);
  const dist = (e) => Math.hypot(track.firstCentroid[0] - e.near_xy[0], track.firstCentroid[1] - e.near_xy[1]);
  const entry = (alias.entries || [])
    .filter((e) => e.kind === "label-cluster" && !usedIds.has(e.id) && inWindow(e))
    .map((e) => ({ e, d: dist(e) }))
    .filter(({ e, d }) => d <= e.window_px)
    .sort((a, b) => a.d - b.d)[0];
  if (!entry) return `unnamed:${track.id}`;
  usedIds.add(entry.e.id);
  return entry.e.id;
}

const ROW_KEYS = ["frame", "time_s", "element_id", "centre_px", "centre_ratio", "bbox_px",
  "bbox_ratio", "area_ratio", "border_gaps_px", "border_gaps_ratio", "z", "visible", "camera", "provenance"];

// Validate a ledger object: required keys on every row, and the
// header fields the schema names. Returns {valid, errors}. Pure.
// A key present with a null value is not a missing field: null means
// the element is not visible or not found in that frame.
export function validateLedger(ledger) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  if (ledger === null || typeof ledger !== "object" || Array.isArray(ledger)) {
    return { valid: false, errors: ["ledger must be an object"] };
  }
  need(ledger.schema === LEDGER_SCHEMA, `ledger schema must be ${LEDGER_SCHEMA}`);
  for (const k of ["source", "frame_width", "frame_height", "fps", "frame_start", "frame_end",
    "frame_count", "sampling", "elements", "alias", "unnamed", "rows"]) {
    need(k in ledger, `ledger is missing ${k}`);
  }
  need(Array.isArray(ledger.rows), "ledger rows must be an array");
  if (Array.isArray(ledger.rows)) {
    ledger.rows.forEach((row, i) => {
      const at = `rows[${i}]`;
      if (!row || typeof row !== "object") { errors.push(`${at} must be an object`); return; }
      for (const k of ROW_KEYS) need(k in row, `${at} is missing ${k}`);
      if ("camera" in row) {
        need(row.camera !== null && typeof row.camera === "object", `${at}.camera must be an object`);
        if (row.camera && typeof row.camera === "object") need("zoom_ratio" in row.camera, `${at}.camera is missing zoom_ratio`);
      }
      if ("provenance" in row) {
        need(row.provenance !== null && typeof row.provenance === "object", `${at}.provenance must be an object`);
        if (row.provenance && typeof row.provenance === "object") {
          for (const k of ["kind", "source_frame", "tolerance", "sampling", "method"]) {
            need(k in row.provenance, `${at}.provenance is missing ${k}`);
          }
        }
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

// Count rows, visible rows, and rows per element. Pure function.
export function summarizeLedger(ledger) {
  const perElement = {};
  let visibleRows = 0;
  for (const row of ledger.rows) {
    const slot = perElement[row.element_id] || (perElement[row.element_id] = { rows: 0, visible: 0 });
    slot.rows++;
    if (row.visible) { slot.visible++; visibleRows++; }
  }
  return {
    frame_count: ledger.frame_count,
    row_count: ledger.rows.length,
    visible_row_count: visibleRows,
    element_count: Object.keys(perElement).length,
    elements: Object.keys(perElement).sort(),
    per_element: perElement,
    unnamed: ledger.unnamed.map((u) => u.key),
  };
}

// Build a measured ledger from driver output. Pure function.
// measured: {frames: [{frame, layers: {key: {centroid, bbox, pixels} | null}}],
//   tracks: [{id, firstFrame, firstCentroid, samples: [{frame, centroid, bbox, pixels}]}]}
// The alias table maps layers and tracks to element ids; anything
// with no entry is listed as unnamed.
export function buildMeasuredLedger(measured, opts) {
  const { alias, aliasPath, source, width, height, fps, startFrame, endFrame } = opts;
  const rows = [];
  const usedIds = new Set();
  const trackIdById = new Map();
  const sortedTracks = [...(measured.tracks || [])].sort((a, b) => a.firstFrame - b.firstFrame || (a.id < b.id ? -1 : 1));
  for (const track of sortedTracks) {
    trackIdById.set(track.id, elementIdForTrack(track, alias, usedIds));
  }
  const aliasEntryById = new Map((alias.entries || []).map((e) => [e.id, e]));
  const elementInfo = new Map();
  const noteElement = (id, kind, sourceKey, z) => {
    if (!elementInfo.has(id)) elementInfo.set(id, { id, kind, source: sourceKey, z: z === undefined ? null : z });
  };
  const unnamed = [];
  const noteUnnamed = (key, reason, firstFrame) => {
    if (!unnamed.some((u) => u.key === key)) unnamed.push({ key, reason, first_frame: firstFrame });
  };
  const framesByNumber = new Map(measured.frames.map((f) => [f.frame, f]));
  for (let frame = startFrame; frame < endFrame; frame++) {
    const measuredFrame = framesByNumber.get(frame);
    if (!measuredFrame) {
      const err = new Error(`LEDGER_FRAME_MISSING measured data has no frame ${frame}`);
      err.code = "LEDGER_FRAME_MISSING";
      throw err;
    }
    const sudan = measuredFrame.layers.sudan;
    const camera = {
      zoom_ratio: sudan && sudan.bbox ? r4((sudan.bbox[2] - sudan.bbox[0]) / width) : null,
      centre_lon: null,
      centre_lat: null,
      subject: "sudan",
    };
    for (const layer of LAYER_ORDER) {
      const g = measuredFrame.layers[layer] || null;
      const id = elementIdForLayer(layer, frame, alias);
      const entry = aliasEntryById.get(id);
      noteElement(id, "colour-layer", layer, entry ? entry.z : null);
      if (id.startsWith("unnamed:")) {
        noteUnnamed(id, `no alias entry maps layer "${layer}" at frame ${frame}`, frame);
      }
      rows.push(makeRow(
        g && g.pixels >= MIN_MEASURED_PIXELS
          ? { centre: g.centroid, bbox: g.bbox, pixels: g.pixels, z: entry ? entry.z : null, visible: true }
          : { centre: null, bbox: null, pixels: null, z: entry ? entry.z : null, visible: false },
        {
          frame,
          time_s: frame / fps,
          element_id: id,
          width,
          height,
          camera,
          provenance: {
            kind: "measured",
            source_frame: frame,
            tolerance: LAYER_TOLERANCE[layer],
            sampling: "every frame",
            method: LAYER_METHOD[layer],
          },
        },
      ));
    }
  }
  for (const track of sortedTracks) {
    const id = trackIdById.get(track.id);
    const entry = aliasEntryById.get(id);
    noteElement(id, "label-cluster", track.id, entry ? entry.z : null);
    if (id.startsWith("unnamed:")) {
      noteUnnamed(id, `no alias entry matches cluster "${track.id}" by position`, track.firstFrame);
    }
    for (const sample of track.samples) {
      const measuredFrame = framesByNumber.get(sample.frame);
      const sudan = measuredFrame ? measuredFrame.layers.sudan : null;
      const camera = {
        zoom_ratio: sudan && sudan.bbox ? r4((sudan.bbox[2] - sudan.bbox[0]) / width) : null,
        centre_lon: null,
        centre_lat: null,
        subject: "sudan",
      };
      rows.push(makeRow(
        { centre: sample.centroid, bbox: sample.bbox, pixels: sample.pixels, z: entry ? entry.z : null, visible: true },
        {
          frame: sample.frame,
          time_s: sample.frame / fps,
          element_id: id,
          width,
          height,
          camera,
          provenance: {
            kind: "measured",
            source_frame: sample.frame,
            tolerance: 200,
            sampling: `${LABEL_SAMPLE_EVERY_S} s`,
            method: "bright-component clusters (luma >= 200) grouped by checker.layout.text_clusters, tracked across consecutive samples by nearest centre within 150 px; a missed sample closes the track",
          },
        },
      ));
    }
  }
  rows.sort((a, b) => a.frame - b.frame || (a.element_id < b.element_id ? -1 : a.element_id > b.element_id ? 1 : 0));
  return {
    schema: LEDGER_SCHEMA,
    source,
    frame_width: width,
    frame_height: height,
    fps,
    frame_start: startFrame,
    frame_end: endFrame,
    frame_count: endFrame - startFrame,
    sampling: { colour: "every frame", labels: `${LABEL_SAMPLE_EVERY_S} s` },
    elements: [...elementInfo.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    alias: { file: aliasPath, entries: alias.entries || [] },
    unnamed,
    rows,
  };
}

// Diff two ledgers. Pure function. Shared elements are the element
// ids present in both ledgers, excluding unnamed ids. Per shared
// element per common frame, the delta in px and ratios. The worst
// element is the one with the largest centre distance in px.
export function buildDiff(refLedger, oursLedger) {
  const named = (ids) => ids.filter((id) => !id.startsWith("unnamed:"));
  const refIds = new Set(named(refLedger.elements.map((e) => e.id)));
  const oursIds = new Set(named(oursLedger.elements.map((e) => e.id)));
  const shared = [...refIds].filter((id) => oursIds.has(id)).sort();
  const refOnly = [...refIds].filter((id) => !oursIds.has(id)).sort();
  const oursOnly = [...oursIds].filter((id) => !refIds.has(id)).sort();
  const refRows = new Map(refLedger.rows.map((r) => [`${r.frame}:${r.element_id}`, r]));
  const oursRows = new Map(oursLedger.rows.map((r) => [`${r.frame}:${r.element_id}`, r]));
  const refFrames = new Set(refLedger.rows.map((r) => r.frame));
  const oursFrames = new Set(oursLedger.rows.map((r) => r.frame));
  const frames = [...refFrames].filter((f) => oursFrames.has(f)).sort((a, b) => a - b);
  const perFrame = [];
  const perElement = {};
  for (const id of shared) perElement[id] = { element_id: id, frames_compared: 0, frames_both_visible: 0, max_centre_dist_px: 0, sum_centre_dist_px: 0 };
  let worst = null;
  let comparedRows = 0;
  for (const frame of frames) {
    const entries = [];
    for (const id of shared) {
      const ref = refRows.get(`${frame}:${id}`);
      const ours = oursRows.get(`${frame}:${id}`);
      if (!ref || !ours) continue;
      comparedRows++;
      const slot = perElement[id];
      slot.frames_compared++;
      let status = "both-visible";
      let delta = null;
      if (!ref.visible && !ours.visible) status = "absent-both";
      else if (!ref.visible) status = "absent-ref";
      else if (!ours.visible) status = "absent-ours";
      if (status === "both-visible" && ref.centre_px && ours.centre_px) {
        const dx = r1(ours.centre_px[0] - ref.centre_px[0]);
        const dy = r1(ours.centre_px[1] - ref.centre_px[1]);
        const dist = r1(Math.hypot(dx, dy));
        const rdx = r4(ours.centre_ratio[0] - ref.centre_ratio[0]);
        const rdy = r4(ours.centre_ratio[1] - ref.centre_ratio[1]);
        const rdist = r4(Math.hypot(rdx, rdy));
        delta = {
          centre_dx_px: dx,
          centre_dy_px: dy,
          centre_dist_px: dist,
          centre_dx_ratio: rdx,
          centre_dy_ratio: rdy,
          centre_dist_ratio: rdist,
          bbox_w_dx_px: r1((ours.bbox_px[2] - ours.bbox_px[0]) - (ref.bbox_px[2] - ref.bbox_px[0])),
          bbox_h_dy_px: r1((ours.bbox_px[3] - ours.bbox_px[1]) - (ref.bbox_px[3] - ref.bbox_px[1])),
          area_ratio_delta: r4(ours.area_ratio - ref.area_ratio),
        };
        slot.frames_both_visible++;
        if (dist > slot.max_centre_dist_px) slot.max_centre_dist_px = dist;
        slot.sum_centre_dist_px += dist;
        if (!worst || dist > worst.centre_dist_px) {
          worst = { element_id: id, frame, time_s: r3(frame / refLedger.fps), centre_dist_px: dist, centre_dx_px: dx, centre_dy_px: dy };
        }
      }
      entries.push({ element_id: id, status, delta });
    }
    perFrame.push({ frame, time_s: r3(frame / refLedger.fps), elements: entries });
  }
  const perElementRows = shared.map((id) => {
    const s = perElement[id];
    return {
      element_id: id,
      frames_compared: s.frames_compared,
      frames_both_visible: s.frames_both_visible,
      max_centre_dist_px: s.max_centre_dist_px,
      mean_centre_dist_px: s.frames_both_visible ? r1(s.sum_centre_dist_px / s.frames_both_visible) : 0,
    };
  });
  const bothVisible = perElementRows.reduce((n, s) => n + s.frames_both_visible, 0);
  const maxDist = perElementRows.reduce((m, s) => Math.max(m, s.max_centre_dist_px), 0);
  return {
    schema: DIFF_SCHEMA,
    ref: { file: refLedger.source.file, frame_width: refLedger.frame_width, frame_height: refLedger.frame_height, fps: refLedger.fps },
    ours: { file: oursLedger.source.file, frame_width: oursLedger.frame_width, frame_height: oursLedger.frame_height, fps: oursLedger.fps },
    frames: frames.length ? [frames[0], frames[frames.length - 1] + 1] : [0, 0],
    shared_elements: shared,
    ref_only_elements: refOnly,
    ours_only_elements: oursOnly,
    per_frame: perFrame,
    per_element: perElementRows,
    worst,
    summary: {
      shared_element_count: shared.length,
      frame_count: frames.length,
      row_count: comparedRows,
      rows_both_visible: bothVisible,
      max_centre_dist_px: maxDist,
    },
  };
}

// --- runners (impure: disk, ffmpeg, python) ---

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const e = new Error(`LEDGER_UNREADABLE cannot read ${label} ${path}: ${err.message}`);
    e.code = "LEDGER_UNREADABLE";
    throw e;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), JSON.stringify(obj, null, 2) + "\n");
}

function runCommand(cmd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).trim().split("\n").slice(-5).join("\n");
        rejectPromise(new Error(`${cmd} failed: ${tail}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function ffprobeVideo(videoPath) {
  const out = await runCommand("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames",
    "-show_entries", "format=duration", "-of", "json", videoPath]);
  const probe = JSON.parse(out);
  const stream = probe.streams && probe.streams[0];
  if (!stream) throw new Error(`LEDGER_NO_VIDEO_STREAM no video stream in ${videoPath}`);
  const rate = stream.avg_frame_rate || stream.r_frame_rate;
  const [num, den] = rate.split("/").map(Number);
  const fps = num / den;
  return { width: stream.width, height: stream.height, fps, nbFrames: stream.nb_frames ? Number(stream.nb_frames) : null };
}

async function extractFrames(videoPath, dir, startFrame, endFrame, fps) {
  const startS = startFrame / fps;
  const count = endFrame - startFrame;
  await runCommand("ffmpeg", ["-v", "error", "-y", "-ss", String(startS), "-i", videoPath,
    "-frames:v", String(count), join(dir, "frame-%06d.png")]);
  const files = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  if (files.length !== count) {
    throw new Error(`LEDGER_EXTRACT ffmpeg wrote ${files.length} frames, expected ${count}`);
  }
  return files.map((f, i) => ({ frame: startFrame + i, path: join(dir, f) }));
}

function listFramesDir(dir, startFrame, endFrame) {
  const files = readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
  const window = endFrame === null ? files : files.slice(startFrame, endFrame);
  const base = endFrame === null ? 0 : startFrame;
  return window.map((f, i) => ({ frame: base + i, path: join(dir, f) }));
}

// The Python driver. It reads a manifest of {frame, path} rows, runs
// checker.layout.segment_frame on each frame, clusters bright text
// at 0.5 s sampling, tracks clusters by nearest centre, and writes
// one JSON object to the output path. Progress goes to stderr.
const DRIVER = `
import json
import sys

MANIFEST = sys.argv[1]
OUT_PATH = sys.argv[2]
FPS = float(sys.argv[3])
STEP = int(sys.argv[4])
START_FRAME = int(sys.argv[5])

sys.path.insert(0, sys.argv[6] if len(sys.argv) > 6 else "src")

import numpy as np
from PIL import Image
from checker import layout

with open(MANIFEST) as fh:
    manifest = json.load(fh)

frames_out = []
tracks = []

def track_clusters(frame, clusters):
    # A cluster joins a track only at the next consecutive sample:
    # after a missed sample the old track is closed, so a new label
    # that appears later (for example RSF text after the October
    # title faded) never inherits the old track.
    used = set()
    for c in clusters:
        cx, cy = c["centroid"]
        best = None
        bestd = 150.0
        for ti, tr in enumerate(tracks):
            if ti in used:
                continue
            last = tr["samples"][-1]
            if last["frame"] != frame - STEP:
                continue
            d = ((last["centroid"][0] - cx) ** 2 + (last["centroid"][1] - cy) ** 2) ** 0.5
            if d < bestd:
                bestd = d
                best = ti
        sample = {"frame": int(frame), "centroid": [round(float(cx), 1), round(float(cy), 1)],
                  "bbox": [int(v) for v in c["bbox"]],
                  # Cluster pixels are strided (stride 2), so scale by 4 to full-res pixels.
                  "pixels": int(c["pixels"]) * 4,
                  "n_components": int(c["n_components"])}
        if best is None:
            tracks.append({"id": "label-%02d" % (len(tracks) + 1),
                           "firstFrame": int(frame),
                           "firstCentroid": [round(float(cx), 1), round(float(cy), 1)],
                           "samples": [sample]})
            used.add(len(tracks) - 1)
        else:
            tracks[best]["samples"].append(sample)
            used.add(best)

for entry in manifest:
    frame = int(entry["frame"])
    img = np.array(Image.open(entry["path"]).convert("RGB"))
    seg = layout.segment_frame(img)
    layers = {}
    for key in ("sudan", "base", "rsf", "october", "white_text"):
        g = seg[key]
        if g.get("present"):
            layers[key] = {"centroid": [round(float(g["centroid"][0]), 1), round(float(g["centroid"][1]), 1)],
                           "bbox": [int(v) for v in g["bbox"]],
                           "pixels": int(g["pixels"])}
        else:
            layers[key] = None
    frames_out.append({"frame": frame, "layers": layers})
    if (frame - START_FRAME) % STEP == 0:
        wt = seg["white_text"]
        comps = wt.get("components", []) if wt.get("present") else []
        clusters = layout.text_clusters(comps)
        track_clusters(frame, clusters)
    print("ledger frame %d: sudan %s rsf %s" % (frame, bool(layers["sudan"]), bool(layers["rsf"])), file=sys.stderr, flush=True)

with open(OUT_PATH, "w") as fh:
    json.dump({"frames": frames_out, "tracks": tracks}, fh)
`;

async function runBuild(parsed) {
  const range = parsed.frames;
  if (parsed.scene) {
    const scenePath = resolve(parsed.scene);
    if (!existsSync(scenePath)) {
      console.error(`hme ledger: no such file: ${parsed.scene}`);
      return 2;
    }
    let scene;
    try {
      scene = loadScene(scenePath);
    } catch (err) {
      console.error(`hme ledger: cannot read scene ${parsed.scene}: ${err.message}`);
      return 2;
    }
    const result = validateScene(scene);
    if (result.errors.length > 0) {
      console.error(`hme ledger: scene ${parsed.scene} fails validation: ${result.errors[0].code} ${result.errors[0].path} ${result.errors[0].message}`);
      return 2;
    }
    const startFrame = range ? range.start : 0;
    const endFrame = range ? range.end : scene.meta.duration;
    if (endFrame > scene.meta.duration) {
      console.error(`hme ledger: --frames end ${endFrame} is past the scene duration ${scene.meta.duration}`);
      return 2;
    }
    let ledger;
    try {
      ledger = buildComputedLedger(scene, startFrame, endFrame);
    } catch (err) {
      console.error(`hme ledger: ${err.message}`);
      return 2;
    }
    ledger.source.file = parsed.scene;
    const check = validateLedger(ledger);
    if (!check.valid) {
      console.error(`hme ledger: built ledger fails validation: ${check.errors[0]}`);
      return 2;
    }
    writeJson(parsed.out, ledger);
    const s = summarizeLedger(ledger);
    process.stderr.write(`wrote ${parsed.out} (${s.row_count} rows, ${s.element_count} elements, ${s.frame_count} frames, ${s.visible_row_count} visible rows)\n`);
    return 0;
  }

  // Measured build: video or frames dir, plus an alias table.
  const aliasPath = resolve(parsed.alias);
  if (!existsSync(aliasPath)) {
    console.error(`hme ledger: no such file: ${parsed.alias}`);
    return 2;
  }
  let alias;
  try {
    alias = readJson(aliasPath, "alias table");
  } catch (err) {
    console.error(`hme ledger: ${err.message}`);
    return 2;
  }
  const aliasCheck = validateAliasTable(alias);
  if (!aliasCheck.valid) {
    console.error(`hme ledger: alias table ${parsed.alias} is invalid: ${aliasCheck.errors[0]}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme ledger: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  let frameList;
  let width;
  let height;
  let fps;
  let sourceKind;
  let sourceFile;
  let tmpDir = null;
  try {
    if (parsed.video) {
      const videoPath = resolve(parsed.video);
      if (!existsSync(videoPath)) {
        console.error(`hme ledger: no such file: ${parsed.video}`);
        return 2;
      }
      const probe = await ffprobeVideo(videoPath);
      width = probe.width;
      height = probe.height;
      fps = parsed.fps || probe.fps;
      const total = probe.nbFrames || 0;
      const startFrame = range ? range.start : 0;
      const endFrame = range ? range.end : total;
      if (total && endFrame > total) {
        console.error(`hme ledger: --frames end ${endFrame} is past the video frame count ${total}`);
        return 2;
      }
      tmpDir = mkdtempSync(join(tmpdir(), "hme-ledger-"));
      frameList = await extractFrames(videoPath, tmpDir, startFrame, endFrame, probe.fps);
      sourceKind = "video";
      sourceFile = parsed.video;
    } else {
      const dir = resolve(parsed.framesDir);
      if (!existsSync(dir)) {
        console.error(`hme ledger: no such directory: ${parsed.framesDir}`);
        return 2;
      }
      const probeFrame = readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort()[0];
      if (!probeFrame) {
        console.error(`hme ledger: no PNG frames in ${parsed.framesDir}`);
        return 2;
      }
      const size = await readPngSize(join(dir, probeFrame));
      width = size.width;
      height = size.height;
      fps = parsed.fps || 24;
      const startFrame = range ? range.start : 0;
      const endFrame = range ? range.end : null;
      frameList = listFramesDir(dir, startFrame, endFrame);
      if (frameList.length === 0) {
        console.error(`hme ledger: no frames in the requested window in ${parsed.framesDir}`);
        return 2;
      }
      if (range && frameList.length !== range.end - range.start) {
        console.error(`hme ledger: --frames ${range.start}:${range.end} needs ${range.end - range.start} frames, but ${parsed.framesDir} holds ${frameList.length} in that window`);
        return 2;
      }
      sourceKind = "frames";
      sourceFile = parsed.framesDir;
    }
  } catch (err) {
    console.error(`hme ledger: ${err.message}`);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    return 2;
  }
  const startFrame = frameList[0].frame;
  const endFrame = frameList[frameList.length - 1].frame + 1;
  const workDir = tmpDir || mkdtempSync(join(tmpdir(), "hme-ledger-"));
  const manifestPath = join(workDir, "manifest.json");
  const measuredPath = join(workDir, "measured.json");
  writeFileSync(manifestPath, JSON.stringify(frameList));
  let measured;
  try {
    await runMeasureDriverWithSrc(manifestPath, measuredPath, fps, startFrame);
    measured = readJson(measuredPath, "measured output");
  } catch (err) {
    console.error(`hme ledger: ${err.message}`);
    rmSync(workDir, { recursive: true, force: true });
    return 2;
  }
  rmSync(workDir, { recursive: true, force: true });
  let ledger;
  try {
    ledger = buildMeasuredLedger(measured, {
      alias,
      aliasPath: parsed.alias,
      source: { kind: sourceKind, file: sourceFile, scene_id: null, fps },
      width,
      height,
      fps,
      startFrame,
      endFrame,
    });
  } catch (err) {
    console.error(`hme ledger: ${err.message}`);
    return 2;
  }
  const check = validateLedger(ledger);
  if (!check.valid) {
    console.error(`hme ledger: built ledger fails validation: ${check.errors[0]}`);
    return 2;
  }
  writeJson(parsed.out, ledger);
  const s = summarizeLedger(ledger);
  process.stderr.write(`wrote ${parsed.out} (${s.row_count} rows, ${s.element_count} elements, ${s.frame_count} frames, ${s.visible_row_count} visible rows, unnamed: ${s.unnamed.join(", ") || "none"})\n`);
  return 0;
}

// Read a PNG size from its IHDR chunk. Pure file read, no decoder.
export async function readPngSize(path) {
  const buf = readFileSync(path);
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`LEDGER_NOT_PNG ${basename(path)} is not a PNG file`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function runMeasureDriverWithSrc(manifestPath, outPath, fps, startFrame) {
  return new Promise((resolvePromise, rejectPromise) => {
    const step = Math.max(1, Math.round(fps * LABEL_SAMPLE_EVERY_S));
    const srcDir = join(REPO_ROOT, "src");
    const child = spawn(VENV_PYTHON, ["-", manifestPath, outPath, String(fps), String(step), String(startFrame), srcDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => rejectPromise(new Error(`could not start ${VENV_PYTHON}: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        rejectPromise(new Error(`ledger measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      resolvePromise(null);
    });
    child.stdin.end(DRIVER);
  });
}

async function runDiff(parsed) {
  let refLedger;
  let oursLedger;
  try {
    refLedger = readJson(resolve(parsed.ref), "reference ledger");
    oursLedger = readJson(resolve(parsed.ours), "ours ledger");
  } catch (err) {
    console.error(`hme ledger: ${err.message}`);
    return 2;
  }
  for (const [ledger, name] of [[refLedger, "reference"], [oursLedger, "ours"]]) {
    const check = validateLedger(ledger);
    if (!check.valid) {
      console.error(`hme ledger: ${name} ledger is invalid: ${check.errors[0]}`);
      return 2;
    }
  }
  const diff = buildDiff(refLedger, oursLedger);
  const text = JSON.stringify(diff, null, 2) + "\n";
  if (parsed.out) {
    writeJson(parsed.out, diff);
  } else {
    process.stdout.write(text);
  }
  const w = diff.worst;
  process.stderr.write(
    `diff: ${diff.summary.shared_element_count} shared elements, ${diff.summary.frame_count} frames, `
    + `${diff.summary.row_count} rows, ${diff.summary.rows_both_visible} both visible, `
    + `worst ${w ? `${w.element_id} at frame ${w.frame} (${w.centre_dist_px} px)` : "none"}\n`,
  );
  return 0;
}

// Run `hme ledger ...`. Returns the process exit code: 0 ok, 2 usage
// or run error. Never prints a stack trace.
export async function runLedger(argv) {
  const parsed = parseLedgerArgs(argv);
  if (parsed.error) {
    console.error(`hme ledger: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  try {
    if (parsed.command === "build") return await runBuild(parsed);
    return await runDiff(parsed);
  } catch (err) {
    console.error(`hme ledger: ${err.message}`);
    return 2;
  }
}
