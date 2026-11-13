// hme export: write a scene as an EffectCraft .ecproj file plus a loss report.
//
// The .ecproj format is versioned JSON. Every field below comes from a
// file the EffectCraft CLI wrote (see workspace/handover-motion-export/
// units/U1/ecproj-format.md), or from the EffectCraft source in
// workspace/tmp-work/effectcraft-check/. The exporter invents no field
// and no default: it copies the demo file values for settings, switches,
// material options, shutter, and global light.
//
// The mapping from HME props to .ecproj props is in
// workspace/handover-motion-export/units/U2/mapping.md. The loss codes
// L1 to L20 come from that file. Every prop with no EffectCraft match
// gets a loss entry. Nothing is left silent.
//
// The exporter reads values through src/scene/evaluate.mjs (sampleScene),
// so the exported key values match the HME evaluation exactly. The ease
// on a segment belongs to the destination key (sampleTrack rule), so a
// segment writes the out side of its start key and the in side of its
// end key.
//
// Usage: hme export <scene.json> --to ecproj --out <file.ecproj>
//   [--report <report.json>]
// Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, basename, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadScene, validateScene, sceneFps } from "../scene/validate.mjs";
import { CURVES, isKnownEase } from "../scene/easing.mjs";
import { sampleScene, resolveColor } from "../scene/evaluate.mjs";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export const USAGE = [
  "hme export: Export a scene to an EffectCraft .ecproj file.",
  "",
  "Usage: hme export <scene.json> --to ecproj --out <file.ecproj> [--report <report.json>]",
  "       hme export <input.mp4> --to ecproj --out <file.ecproj> [--report <report.json>]",
  "",
  "Arguments:",
  "  <scene.json>  Path to the scene file.",
  "  <input.mp4>  Path to a video file. Frames are extracted with ffmpeg",
  "                to a frames folder next to the .ecproj file, and the",
  "                .ecproj file holds one Sequence footage item plus one",
  "                comp that plays the full sequence at the video rate.",
  "",
  "Options:",
  "  --to <format>  Export format. Only ecproj is supported. Required.",
  "  --out <file>  Write the .ecproj file here. Required.",
  "  --report <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// Video extensions the video-input path accepts. PNG is the only frame
// format written: JPEG q2 measured mean SSIM 0.9894 on the side-by-side
// video, below the 0.99 bar, so no JPEG option exists in this run.
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);

export function isVideoPath(inputPath) {
  return VIDEO_EXTENSIONS.has(extname(inputPath).toLowerCase());
}

// Ticks per second in .ecproj files. Source: crates/time/src/lib.rs:17
// in the EffectCraft clone.
export const TICKS_PER_SECOND = 254016000000;
// The app version the file targets. Source: v0.3.1 tag, crates/project/src/lib.rs:29.
export const ECPROJ_SAVED_BY = "0.3.1";
// Schema version. Source: crates/project/src/lib.rs:29 in the v0.3.1 tag.
export const ECPROJ_SCHEMA = 1;

export const frameToTicks = (frame, fps) => Math.round((frame * TICKS_PER_SECOND) / fps);
export const secondsToTicks = (seconds) => Math.round(seconds * TICKS_PER_SECOND);

const fmt = (n) => Number(n.toFixed(3)) + 0;

/** Hex #rrggbb to 3 or 4 floats, 0 to 1. Full precision, like the demo file. */
export function hexToFloats(hex, withAlpha) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return withAlpha ? [r, g, b, 1] : [r, g, b];
}

/** Resolve a colour value (hex or palette name) to a lowercase hex string. */
export function resolveHex(value, palette) {
  if (typeof value !== "string") return null;
  return resolveColor(value, palette);
}

// ---------------------------------------------------------------------------
// Font ascent: read the ascender from a TTF file, so the text baseline
// matches the HME render. Chrome uses sTypoAscender when the OS/2
// useTypoMetrics flag is set, else the hhea ascender. Both proof fonts
// set the flag and both values agree. Returns the ascent as a fraction
// of the font size, or null when the file cannot be read.
export function readFontAscent(fontPath) {
  try {
    const d = readFileSync(fontPath);
    if (d.length < 12) return null;
    const n = d.readUInt16BE(4);
    const tables = {};
    for (let i = 0; i < n; i++) {
      const off = 12 + i * 16;
      if (off + 16 > d.length) return null;
      tables[d.toString("latin1", off, off + 4)] = d.readUInt32BE(off + 8);
    }
    if (!tables.head || !tables.hhea || !tables["OS/2"]) return null;
    const upm = d.readUInt16BE(tables.head + 18);
    if (!upm) return null;
    const hheaAsc = d.readInt16BE(tables.hhea + 4);
    const fsSelection = d.readUInt16BE(tables["OS/2"] + 62);
    const typoAsc = d.readInt16BE(tables["OS/2"] + 68);
    const asc = fsSelection & 0x80 ? typoAsc : hheaAsc;
    return asc / upm;
  } catch {
    return null;
  }
}

function resolveFontPath(src, sceneDir) {
  const candidates = [
    resolve(REPO_ROOT, "assets", src),
    resolve(REPO_ROOT, src),
    resolve(sceneDir, src),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ---------------------------------------------------------------------------
// Image size: PNG IHDR and JPEG SOF markers. No dependency.
export function readImageSize(filePath) {
  try {
    const d = readFileSync(filePath);
    if (d.length > 24 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) {
      return { width: d.readUInt32BE(16), height: d.readUInt32BE(20) };
    }
    if (d.length > 4 && d[0] === 0xff && d[1] === 0xd8) {
      let off = 2;
      while (off + 9 < d.length) {
        if (d[off] !== 0xff) break;
        const marker = d[off + 1];
        const len = d.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: d.readUInt16BE(off + 7), height: d.readUInt16BE(off + 5) };
        }
        off += 2 + len;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ease conversion. One HME segment writes two EffectCraft sides: the out
// side of its start key and the in side of its end key. Speed is the
// bezier slope times |delta| over the segment duration. Influence is the
// bezier x handle as a fraction. This matches the cubic bezier control
// points exactly when EffectCraft builds its bezier from speed and
// influence the way After Effects does.
//
// Returns { outInterp, outEase, inInterp, inEase, losses: [reason] }.
// losses holds plain strings; the caller turns them into loss entries.
export function segmentEase(spec, delta, durationSec) {
  const absDelta = Math.abs(delta);
  if (spec === undefined || spec === null || spec === "linear") {
    return { outInterp: "Linear", outEase: [], inInterp: "Linear", inEase: [], losses: [] };
  }
  if (spec === "hold") {
    return { outInterp: "Hold", outEase: [], inInterp: "Linear", inEase: [], losses: [] };
  }
  let bezier = null;
  if (typeof spec === "string") bezier = CURVES[spec];
  else if (spec && Array.isArray(spec.bezier)) bezier = spec.bezier;
  if (!bezier) throw new Error(`UNKNOWN_EASE ${JSON.stringify(spec)}`);
  const [x1, y1, x2, y2] = bezier;
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) {
    return { outInterp: "Linear", outEase: [], inInterp: "Linear", inEase: [], losses: [] };
  }
  if (durationSec <= 0 || x1 === 0 || x2 === 1) {
    return {
      outInterp: "Linear", outEase: [],
      inInterp: "Linear", inEase: [],
      losses: ["bezier edge (x1 0 or x2 1 or zero length), fell back to linear"],
    };
  }
  const losses = [];
  let outSlope = y1 / x1;
  let inSlope = (1 - y2) / (1 - x2);
  if (outSlope < 0) {
    losses.push("out slope is negative, overshoot direction is not kept, speed uses the magnitude");
    outSlope = Math.abs(outSlope);
  }
  if (inSlope < 0) {
    losses.push("in slope is negative, overshoot direction is not kept, speed uses the magnitude");
    inSlope = Math.abs(inSlope);
  }
  return {
    outInterp: "Bezier",
    outEase: [{ speed: fmt(outSlope * absDelta / durationSec), influence: fmt(x1) }],
    inInterp: "Bezier",
    inEase: [{ speed: fmt(inSlope * absDelta / durationSec), influence: fmt(1 - x2) }],
    losses,
  };
}

// Parse a plain polygon d string ("x,y x,y ...") into a points list.
// Returns null when the string is not in that form. Full SVG path data
// (M/L/C/Z commands) is not parsed here; it is a loss, not a guess.
export function parsePolygonD(d) {
  if (typeof d !== "string") return null;
  const parts = d.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const points = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    points.push({
      id: `p${i}`,
      anchor: [Number(m[1]), Number(m[2])],
      in: null,
      out: null,
      command: i === 0 ? "move" : "line",
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Points list to an EffectCraft shape path. HME points are box-local.
// The commands are line, cubic, smooth (schema enum; the first point is
// M and its command is ignored). Tangents are RELATIVE offsets from
// their vertex (ShapePath model). Handle ownership follows pointsToD
// in src/renderer/compile.mjs exactly:
// - A cubic segment arriving at point i is C prev.out cur.in anchor.
//   The out handle belongs to the previous point, the in handle to
//   the current point.
// - A smooth segment arriving at point i is S cur.in anchor. Its first
//   control point is the reflection of the previous segment second
//   control point across the previous anchor, so the previous point
//   out tangent is the negative of its in tangent.
// - A line segment is straight. Handles on a line are ignored.
// - The closing segment is straight (Z in HME), so the last point out
//   tangent is [0, 0]. `closed` comes from props.closed, not from a
//   point command.
// HME points are box-local with (0, 0) at the box top-left. EffectCraft
// path vertices are relative to the layer position, which the exporter
// puts at the box centre, so each vertex is shifted by minus the centre.
// Handles are already relative offsets and need no shift.
export function pointsToShapePath(points, closed = false, centre = [0, 0]) {
  const rel = (p, handle) => (handle ? [fmt(handle[0] - p.anchor[0]), fmt(handle[1] - p.anchor[1])] : [0, 0]);
  const vertices = points.map((p) => [fmt(p.anchor[0] - centre[0]), fmt(p.anchor[1] - centre[1])]);
  const inTangents = points.map((p, i) => {
    if (i === 0) return [0, 0];
    if (p.command === "cubic" || p.command === "smooth") return rel(p, p.in);
    return [0, 0];
  });
  const outTangents = points.map((p, i) => {
    const next = points[i + 1];
    if (!next) return [0, 0];
    if (next.command === "cubic") return rel(p, p.out);
    if (next.command === "smooth") {
      return p.in ? [fmt(p.anchor[0] - p.in[0]), fmt(p.anchor[1] - p.in[1])] : [0, 0];
    }
    return [0, 0];
  });
  return { vertices, in_tangents: inTangents, out_tangents: outTangents, closed: Boolean(closed) };
}

// ---------------------------------------------------------------------------
// .ecproj builders. Every default below is copied from the demo file the
// CLI wrote (units/U1/demo.ecproj, units/U1/shape.ecproj,
// units/U1/path.ecproj, units/U1/stroke.ecproj). Nothing is invented.

function makeIds() {
  let next = 1;
  let uid = 1;
  return {
    item() { return next++; },
    uid() { return uid++; },
    nextId() { return next; },
  };
}

const SWITCHES = Object.freeze({
  video: true, audio: true, solo: false, locked: false, shy: false,
  collapse: false, quality: "Best", sampling: "Bilinear", effects: true,
  frame_blend: "Off", motion_blur: false, adjustment: false, three_d: false, guide: false,
});

const SETTINGS = Object.freeze({
  bit_depth: "Bpc8", linearize: false, working_space: null, blend_linear: false,
  time_display: "Timecode", frame_start: 0, audio_sample_rate: 48000,
  gpu_acceleration: true, color_engine: "Adobe", hdr: "Clip",
  output_space: null,
});

const SLIDER_100 = Object.freeze({ kind: "Slider", min: 0.0, max: 100.0, slider_min: 0.0, slider_max: 100.0, decimals: 0 });
const SLIDER_100_1 = Object.freeze({ kind: "Slider", min: 0.0, max: 100.0, slider_min: 0.0, slider_max: 100.0, decimals: 1 });

function group(ids, match, name, kind, children) {
  return { node: "Group", uid: ids.uid(), match, name, kind: { kind }, enabled: true, children };
}

function leaf(ids, match, name, value, ui, extra = {}) {
  return {
    node: "Prop", uid: ids.uid(), match, name, value, ui,
    spatial: false, hold_only: false, three_d_only: false,
    two_d_only: false, shown_dims: 0, static_only: false, ...extra,
  };
}

function keyframe(time, value, inInterp, outInterp, inEase, outEase) {
  return {
    time, value, in_interp: inInterp, out_interp: outInterp,
    in_ease: inEase, out_ease: outEase, continuous: false, auto_bezier: false,
    spatial_in: [0.0, 0.0, 0.0], spatial_out: [0.0, 0.0, 0.0],
    // spatial_auto must be false. With true, EffectCraft builds Catmull-Rom
    // tangents from the neighbour keys (a sixth of the prev-to-next chord),
    // which bends a straight 3-key path and changes the arc-length map,
    // so the midpoint lands off the HME value (fix cycle 2: 909.117 vs
    // 903.17 at 7.5 s). Zero stored tangents give the exact chord.
    spatial_auto: false, spatial_continuous: false, roving: false,
  };
}

function materialOptions(ids) {
  return group(ids, "materialOptions", "Material Options", "Plain", [
    leaf(ids, "castsShadows", "Casts Shadows", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Off", "On", "Only"] }, { hold_only: true }),
    leaf(ids, "lightTransmission", "Light Transmission", { t: "Scalar", v: 0.0 }, { kind: "Percent" }),
    leaf(ids, "acceptsShadows", "Accepts Shadows", { t: "Enum", v: 1 }, { kind: "Popup", options: ["Off", "On", "Only"] }, { hold_only: true }),
    leaf(ids, "acceptsLights", "Accepts Lights", { t: "Bool", v: true }, { kind: "Checkbox" }, { hold_only: true }),
    leaf(ids, "ambient", "Ambient", { t: "Scalar", v: 100.0 }, { kind: "Percent" }),
    leaf(ids, "diffuse", "Diffuse", { t: "Scalar", v: 50.0 }, { kind: "Percent" }),
    leaf(ids, "specularIntensity", "Specular Intensity", { t: "Scalar", v: 50.0 }, { kind: "Percent" }),
    leaf(ids, "specularShininess", "Specular Shininess", { t: "Scalar", v: 5.0 }, { kind: "Percent" }),
    leaf(ids, "metal", "Metal", { t: "Scalar", v: 100.0 }, { kind: "Percent" }),
  ]);
}

// The comp global light: two Property structs, uid 0, exactly as the
// demo file writes them (demo.ecproj global_light). Not plain numbers.
function globalLight() {
  const prop = (match, name, value) => ({
    node: "Prop", uid: 0, match, name,
    value: { t: "Scalar", v: value },
    ui: { kind: "Angle" },
    spatial: false, hold_only: false, three_d_only: false,
    two_d_only: false, shown_dims: 0, static_only: false,
  });
  return {
    angle: prop("globalLightAngle", "Global Light Angle", 120.0),
    altitude: prop("globalLightAltitude", "Global Light Altitude", 30.0),
  };
}

function emptyGroup(ids, match, name) {
  return group(ids, match, name, "Plain", []);
}

// Build one transform group. values holds the evaluated value at frame 0
// for each prop. keyed holds, per prop, { frames, valueAt, segmentEase }.
function transformGroup(ids, values, keyed, fps) {
  const prop = (match, name, type, value, ui, extra = {}) => {
    const k = keyed[match];
    const node = leaf(ids, match, name, { t: type, v: value }, ui, extra);
    if (k && k.frames.length > 1) node.keys = buildKeys({ ...k, fps });
    return node;
  };
  return group(ids, "transform", "Transform", "Plain", [
    prop("anchor", "Anchor Point", "Vec3", values.anchor, { kind: "Point" }, { spatial: true, shown_dims: 2 }),
    prop("position", "Position", "Vec3", values.position, { kind: "Point" }, { spatial: true, shown_dims: 2 }),
    prop("scale", "Scale", "Vec3", values.scale, { kind: "Percent" }, { shown_dims: 2 }),
    prop("orientation", "Orientation", "Vec3", values.orientation, { kind: "Angle" }, { three_d_only: true }),
    prop("rotationX", "X Rotation", "Scalar", values.rotationX, { kind: "Angle" }, { three_d_only: true }),
    prop("rotationY", "Y Rotation", "Scalar", values.rotationY, { kind: "Angle" }, { three_d_only: true }),
    prop("rotation", "Rotation", "Scalar", values.rotation, { kind: "Angle" }),
    prop("opacity", "Opacity", "Scalar", values.opacity, SLIDER_100),
  ]);
}

// Build the key list for one prop from frames, a value function, and a
// segment ease function. frames are sorted unique key frames. The value
// field is the evaluated value at frame 0. Each segment uses the ease
// of its destination key (sampleTrack rule).
function buildKeys({ frames, valueAtFrame, segmentEaseAt, fps }) {
  const keys = [];
  const n = frames.length;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const value = valueAtFrame(f);
    let inInterp = "Linear";
    let outInterp = "Linear";
    let inEase = [];
    let outEase = [];
    if (i > 0) {
      const prev = segmentEaseAt(i - 1);
      inInterp = prev.inInterp;
      inEase = prev.inEase;
    }
    if (i < n - 1) {
      const next = segmentEaseAt(i);
      outInterp = next.outInterp;
      outEase = next.outEase;
    }
    keys.push(keyframe(frameToTicks(f, fps), { t: value.t, v: value.v }, inInterp, outInterp, inEase, outEase));
  }
  return keys;
}

function baseLayer(ids, node, state0, durationTicks) {
  return {
    id: ids.item(),
    name: node.id,
    source: null,
    label: "Red",
    comment: "",
    start_time: 0,
    in_point: 0,
    out_point: durationTicks,
    stretch: 100.0,
    switches: { ...SWITCHES },
    blend_mode: "Normal",
    preserve_transparency: false,
    track_matte: null,
    parent: null,
    markers: [],
    auto_orient: "Off",
    props: null,
  };
}

function fillGroup(ids, colorFloats) {
  return group(ids, "fill", "Fill 1", "Indexed", [
    leaf(ids, "blend", "Blend Mode", { t: "Enum", v: 0 }, { kind: "Hidden" }, { hold_only: true }),
    leaf(ids, "composite", "Composite", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Below Previous in Same Group", "Above Previous in Same Group"] }, { hold_only: true }),
    leaf(ids, "rule", "Fill Rule", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Non-Zero Winding", "Even-Odd"] }, { hold_only: true }),
    leaf(ids, "color", "Color", { t: "Color", v: colorFloats }, { kind: "Color" }),
    leaf(ids, "opacity", "Opacity", { t: "Scalar", v: 100.0 }, SLIDER_100),
  ]);
}

function strokeGroup(ids, colorFloats, width) {
  return group(ids, "stroke", "Stroke 1", "Indexed", [
    leaf(ids, "blend", "Blend Mode", { t: "Enum", v: 0 }, { kind: "Hidden" }, { hold_only: true }),
    leaf(ids, "composite", "Composite", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Below Previous in Same Group", "Above Previous in Same Group"] }, { hold_only: true }),
    leaf(ids, "color", "Color", { t: "Color", v: colorFloats }, { kind: "Color" }),
    leaf(ids, "opacity", "Opacity", { t: "Scalar", v: 100.0 }, SLIDER_100),
    leaf(ids, "width", "Stroke Width", { t: "Scalar", v: width }, { kind: "Pixels" }),
    leaf(ids, "cap", "Line Cap", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Butt Cap", "Round Cap", "Projecting Cap"] }, { hold_only: true }),
    leaf(ids, "join", "Line Join", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Miter Join", "Round Join", "Bevel Join"] }, { hold_only: true }),
    leaf(ids, "miter", "Miter Limit", { t: "Scalar", v: 4.0 }, { kind: "Number" }),
    group(ids, "dashes", "Dashes", "Plain", [
      leaf(ids, "dash", "Dash", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
      leaf(ids, "gap", "Gap", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
      leaf(ids, "offset", "Offset", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
    ]),
    group(ids, "taper", "Taper", "Plain", [
      leaf(ids, "units", "Length Units", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Pixels", "Percent"] }, { hold_only: true }),
      leaf(ids, "startLength", "Start Length", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
      leaf(ids, "endLength", "End Length", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
      leaf(ids, "startWidth", "Start Width", { t: "Scalar", v: 100.0 }, SLIDER_100_1),
      leaf(ids, "endWidth", "End Width", { t: "Scalar", v: 100.0 }, SLIDER_100_1),
      leaf(ids, "startEase", "Start Ease", { t: "Scalar", v: 0.0 }, SLIDER_100_1),
      leaf(ids, "endEase", "End Ease", { t: "Scalar", v: 0.0 }, SLIDER_100_1),
    ]),
    group(ids, "wave", "Wave", "Plain", [
      leaf(ids, "amount", "Amount", { t: "Scalar", v: 0.0 }, SLIDER_100_1),
      leaf(ids, "units", "Units", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Pixels", "Cycles"] }, { hold_only: true }),
      leaf(ids, "wavelength", "Wavelength", { t: "Scalar", v: 20.0 }, { kind: "Pixels" }),
      leaf(ids, "cycles", "Cycles", { t: "Scalar", v: 10.0 }, { kind: "Slider", min: 0.0, max: 1000.0, slider_min: 0.0, slider_max: 50.0, decimals: 1 }),
      leaf(ids, "phase", "Phase", { t: "Scalar", v: 0.0 }, { kind: "Angle" }),
    ]),
  ]);
}

function shapeGroupTransform(ids) {
  return group(ids, "transform", "Transform", "Plain", [
    leaf(ids, "anchor", "Anchor Point", { t: "Vec2", v: [0.0, 0.0] }, { kind: "Point" }),
    leaf(ids, "position", "Position", { t: "Vec2", v: [0.0, 0.0] }, { kind: "Point" }),
    leaf(ids, "scale", "Scale", { t: "Vec2", v: [100.0, 100.0] }, { kind: "Percent" }),
    leaf(ids, "skew", "Skew", { t: "Scalar", v: 0.0 }, { kind: "Slider", min: -85.0, max: 85.0, slider_min: -85.0, slider_max: 85.0, decimals: 1 }),
    leaf(ids, "skewAxis", "Skew Axis", { t: "Scalar", v: 0.0 }, { kind: "Angle" }),
    leaf(ids, "rotation", "Rotation", { t: "Scalar", v: 0.0 }, { kind: "Angle" }),
    leaf(ids, "opacity", "Opacity", { t: "Scalar", v: 100.0 }, SLIDER_100),
  ]);
}

// ---------------------------------------------------------------------------
// Track helpers. All values come from sampleScene, so they match the HME
// evaluation exactly.

function tracksForNode(scene, nodeId) {
  return (scene.timeline || []).filter((t) => t.node === nodeId);
}

function trackByProp(tracks, prop) {
  return tracks.find((t) => t.prop === prop) || null;
}

// Safe sample: a points topology mismatch or an unknown deform id throws
// in sampleScene. The exporter writes the frame 0 state for that frame
// and records the loss, instead of crashing.
function safeSample(scene, frame, state0, losses, nodeId, code, reason) {
  try {
    return sampleScene(scene, frame)[nodeId];
  } catch (err) {
    losses.push({ code, node: nodeId, prop: "props.points", reason: `${reason}: ${err.message}` });
    return state0;
  }
}

// One key-frame list for a prop fed by a single HME track. deltaOf
// measures the change over a segment in the prop units, for the ease.
function singleTrackKeys({ track, fps, valueAtFrame, deltaOf, losses, nodeId, prop }) {
  const frames = track.keys.map((k) => k.f);
  const segmentEaseAt = (i) => {
    const dest = track.keys[i + 1];
    const delta = deltaOf(frames[i], frames[i + 1]);
    const out = segmentEase(dest.ease, delta, (frames[i + 1] - frames[i]) / fps);
    for (const reason of out.losses) {
      losses.push({ code: "L11", node: nodeId, prop, reason: `ease ${JSON.stringify(dest.ease)} at frame ${dest.f}: ${reason}` });
    }
    return out;
  };
  return { frames, valueAtFrame, segmentEaseAt };
}

// One key-frame list for a prop fed by several HME tracks (position from
// transform.x and transform.y, scale from scale, scaleX, scaleY). Each
// feed names the dims it moves and how to measure its delta. The feed
// with the largest delta over a segment governs the ease. A feed whose
// ease differs from the governing ease is a loss note.
function mergedTrackKeys({ feeds, fps, valueAtFrame, deltaOf, losses, nodeId, prop }) {
  const frames = [...new Set(feeds.flatMap((f) => f.track.keys.map((k) => k.f)))].sort((a, b) => a - b);
  const segmentEaseAt = (i) => {
    const f0 = frames[i];
    const f1 = frames[i + 1];
    let best = null;
    let bestDelta = -1;
    let bestSpec = null;
    for (const feed of feeds) {
      const dest = feed.track.keys.find((k) => k.f === f1);
      if (!dest) continue;
      const delta = deltaOf(feed, f0, f1);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = feed;
        bestSpec = dest.ease;
      }
    }
    if (!best) return { outInterp: "Linear", outEase: [], inInterp: "Linear", inEase: [], losses: [] };
    for (const feed of feeds) {
      const dest = feed.track.keys.find((k) => k.f === f1);
      if (!dest || feed === best) continue;
      if (JSON.stringify(dest.ease) !== JSON.stringify(bestSpec)) {
        losses.push({ code: "L11", node: nodeId, prop, reason: `frame ${f1}: ${feed.prop} ease ${JSON.stringify(dest.ease)} differs from the governing ease ${JSON.stringify(bestSpec)}, the other ease is dropped` });
      }
    }
    const out = segmentEase(bestSpec, bestDelta, (f1 - f0) / fps);
    for (const reason of out.losses) {
      losses.push({ code: "L11", node: nodeId, prop, reason: `ease ${JSON.stringify(bestSpec)} at frame ${f1}: ${reason}` });
    }
    return out;
  };
  return { frames, valueAtFrame, segmentEaseAt };
}

// ---------------------------------------------------------------------------
// Layer builders.

function buildTextLayer(ctx, node) {
  const { ids, scene, fps, losses, notes, durationTicks, fontAscents } = ctx;
  const box = node.box;
  const props = node.props || {};
  const font = props.font || {};
  const size = font.size ?? 96;
  const lineHeight = font.lineHeight ?? 1.2;
  const letterSpacing = font.letterSpacing ?? 0;
  const align = props.align || "left";
  const colorHex = resolveHex(props.color, scene.palette) || "#000000";
  const ascentRatio = fontAscents[font.family] ?? null;
  if (ascentRatio === null) {
    notes.push({ code: "L15", node: node.id, prop: "props.font", reason: `no ascent for font ${font.family}, baseline uses ratio 0.8` });
  }
  const ascent = size * (ascentRatio ?? 0.8);
  const halfLeading = (lineHeight * size - size) / 2;
  const baselineY = box.y + halfLeading + ascent;
  const hasBreak = typeof props.text === "string" && props.text.includes("\n");
  const weight = font.weight ?? 400;
  const style = weight >= 700 ? "Bold" : "Regular";
  if (weight !== 400 && weight !== 700) {
    notes.push({ code: "L15", node: node.id, prop: "props.font.weight", reason: `weight ${weight} maps to style ${style}` });
  }
  const justify = align === "center" ? "Center" : align === "right" ? "Right" : "Left";

  const tracks = tracksForNode(scene, node.id);
  const xTrack = trackByProp(tracks, "transform.x");
  const yTrack = trackByProp(tracks, "transform.y");
  const scaleTrack = trackByProp(tracks, "transform.scale");
  const scaleXTrack = trackByProp(tracks, "transform.scaleX");
  const scaleYTrack = trackByProp(tracks, "transform.scaleY");
  const rotTrack = trackByProp(tracks, "transform.rotation");
  const opTrack = trackByProp(tracks, "transform.opacity");

  const state0 = ctx.stateAt(0, node.id);
  const hasScaleOrRot =
    (state0["transform.scale"] ?? 1) !== 1 ||
    (state0["transform.scaleX"] ?? 1) !== 1 ||
    (state0["transform.scaleY"] ?? 1) !== 1 ||
    (state0["transform.rotation"] ?? 0) !== 0 ||
    scaleTrack || scaleXTrack || scaleYTrack || rotTrack;
  if (hasScaleOrRot && !hasBreak) {
    notes.push({ code: "L20", node: node.id, prop: "transform", reason: "text scale or rotation turns about the box centre, centre-anchor form is used, unproven by render" });
  }
  if (hasScaleOrRot && hasBreak) {
    notes.push({ code: "L20", node: node.id, prop: "transform", reason: "paragraph text scale or rotation turns about the box top-left, not the box centre" });
  }

  // Line origin (the point the glyphs start from) and box centre.
  const originX = align === "center" ? box.x + box.w / 2 : align === "right" ? box.x + box.w : box.x;
  const origin = [originX, baselineY];
  const centre = [box.x + box.w / 2, box.y + box.h / 2];
  // Paragraph text positions the box top-left, not the baseline.
  const anchor = hasBreak
    ? [0.0, 0.0, 0.0]
    : hasScaleOrRot
      ? [fmt(centre[0] - origin[0]), fmt(centre[1] - origin[1]), 0.0]
      : [0.0, 0.0, 0.0];
  const posBase = hasBreak ? [box.x, box.y] : hasScaleOrRot ? centre : origin;

  const positionAt = (f) => {
    const s = ctx.stateAt(f, node.id);
    return { t: "Vec3", v: [fmt(posBase[0] + (s["transform.x"] ?? 0)), fmt(posBase[1] + (s["transform.y"] ?? 0)), 0.0] };
  };
  const scaleAt = (f) => {
    const s = ctx.stateAt(f, node.id);
    return { t: "Vec3", v: [fmt((s["transform.scaleX"] ?? 1) * 100), fmt((s["transform.scaleY"] ?? 1) * 100), 100.0] };
  };
  const rotationAt = (f) => ({ t: "Scalar", v: fmt(ctx.stateAt(f, node.id)["transform.rotation"] ?? 0) });
  const opacityAt = (f) => ({ t: "Scalar", v: fmt((ctx.stateAt(f, node.id)["transform.opacity"] ?? 1) * 100) });

  const keyed = {};
  if (xTrack || yTrack) {
    const feeds = [];
    if (xTrack) feeds.push({ track: xTrack, prop: "transform.x", dims: [0] });
    if (yTrack) feeds.push({ track: yTrack, prop: "transform.y", dims: [1] });
    keyed.position = mergedTrackKeys({
      feeds, fps, losses, nodeId: node.id, prop: "transform",
      valueAtFrame: positionAt,
      deltaOf: (feed, f0, f1) => {
        const a = positionAt(f0).v;
        const b = positionAt(f1).v;
        return Math.max(...feed.dims.map((d) => Math.abs(b[d] - a[d])));
      },
    });
  }
  if (scaleTrack || scaleXTrack || scaleYTrack) {
    const feeds = [];
    if (scaleTrack) feeds.push({ track: scaleTrack, prop: "transform.scale", dims: [0, 1] });
    if (scaleXTrack) feeds.push({ track: scaleXTrack, prop: "transform.scaleX", dims: [0] });
    if (scaleYTrack) feeds.push({ track: scaleYTrack, prop: "transform.scaleY", dims: [1] });
    keyed.scale = mergedTrackKeys({
      feeds, fps, losses, nodeId: node.id, prop: "transform",
      valueAtFrame: scaleAt,
      deltaOf: (feed, f0, f1) => {
        const a = scaleAt(f0).v;
        const b = scaleAt(f1).v;
        return Math.max(...feed.dims.map((d) => Math.abs(b[d] - a[d])));
      },
    });
  }
  if (rotTrack) {
    keyed.rotation = singleTrackKeys({
      track: rotTrack, fps, losses, nodeId: node.id, prop: "transform.rotation",
      valueAtFrame: rotationAt,
      deltaOf: (f0, f1) => Math.abs(rotationAt(f1).v - rotationAt(f0).v),
    });
  }
  if (opTrack) {
    keyed.opacity = singleTrackKeys({
      track: opTrack, fps, losses, nodeId: node.id, prop: "transform.opacity",
      valueAtFrame: opacityAt,
      deltaOf: (f0, f1) => Math.abs(opacityAt(f1).v - opacityAt(f0).v),
    });
  }

  const layer = baseLayer(ids, node, state0, durationTicks);
  layer.source = { type: "Text" };
  layer.name_follows_text = true;
  const values = {
    anchor,
    position: positionAt(0).v,
    scale: scaleAt(0).v,
    orientation: [0.0, 0.0, 0.0],
    rotationX: 0.0,
    rotationY: 0.0,
    rotation: rotationAt(0).v,
    opacity: opacityAt(0).v,
  };
  const sourceText = {
    text: props.text ?? "",
    font: font.family ?? "Inter",
    style,
    size: fmt(size),
    fill: hexToFloats(colorHex, true),
    stroke: [0.0, 0.0, 0.0, 1.0],
    stroke_width: 0.0,
    apply_fill: true,
    apply_stroke: false,
    stroke_over_fill: true,
    line_join: "Miter",
    tracking: fmt((letterSpacing / size) * 1000),
    leading: font.lineHeight === undefined ? null : fmt(lineHeight * size),
    justify,
    baseline_shift: 0.0,
    h_scale: 100.0,
    v_scale: 100.0,
    faux_bold: false,
    faux_italic: false,
    all_caps: false,
    small_caps: false,
    box_size: hasBreak ? [fmt(box.w), fmt(box.h)] : null,
    box_pos: [0.0, 0.0],
    tsume: 0.0,
    baseline: "Normal",
    kerning: "Metrics",
    ligatures: true,
    tate_chu_yoko: false,
    vertical_roman_upright: false,
    indent_left: 0.0,
    indent_right: 0.0,
    indent_first: 0.0,
    space_before: 0.0,
    space_after: 0.0,
    direction: "Ltr",
    composer: "EveryLine",
    hanging_punctuation: false,
    vertical: false,
  };
  if (hasBreak) {
    losses.push({ code: "L17", node: node.id, prop: "props.text", reason: "text has line breaks, paragraph box is written, layout is unverified by render" });
  }
  const textGroup = group(ids, "text", "Text", "Plain", [
    leaf(ids, "sourceText", "Source Text", { t: "Text", v: sourceText }, { kind: "Text" }, { hold_only: true }),
    leaf(ids, "perChar3d", "Per-character 3D", { t: "Bool", v: false }, { kind: "Hidden" }, { hold_only: true, static_only: true }),
    group(ids, "pathOptions", "Path Options", "Plain", [
      leaf(ids, "path", "Path", { t: "Enum", v: 0 }, { kind: "Popup", options: ["None"] }, { hold_only: true, static_only: true }),
      leaf(ids, "reversePath", "Reverse Path", { t: "Bool", v: false }, { kind: "Checkbox" }, { hold_only: true }),
      leaf(ids, "perpendicular", "Perpendicular To Path", { t: "Bool", v: true }, { kind: "Checkbox" }, { hold_only: true }),
      leaf(ids, "forceAlignment", "Force Alignment", { t: "Bool", v: false }, { kind: "Checkbox" }, { hold_only: true }),
      leaf(ids, "firstMargin", "First Margin", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
      leaf(ids, "lastMargin", "Last Margin", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
    ]),
    group(ids, "moreOptions", "More Options", "Plain", [
      leaf(ids, "anchorGrouping", "Anchor Point Grouping", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Character", "Word", "Line", "All"] }, { hold_only: true, static_only: true }),
      leaf(ids, "groupingAlignment", "Grouping Alignment", { t: "Vec2", v: [0.0, 0.0] }, { kind: "Percent" }),
      leaf(ids, "fillStroke", "Fill & Stroke", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Per Character Palette", "All Fills Over All Strokes", "All Strokes Over All Fills"] }, { hold_only: true, static_only: true }),
      leaf(ids, "interCharBlend", "Inter-Character Blending", { t: "Enum", v: 0 }, { kind: "Popup", options: ["Normal", "Darken", "Multiply", "Color Burn", "Linear Burn", "Darker Color", "Add", "Lighten", "Screen", "Color Dodge", "Lighter Color", "Overlay", "Soft Light", "Hard Light", "Linear Light", "Vivid Light", "Pin Light", "Hard Mix", "Difference", "Exclusion", "Subtract", "Divide", "Hue", "Saturation", "Color", "Luminosity"] }, { hold_only: true, static_only: true }),
    ]),
    emptyGroup(ids, "animators", "Animators"),
  ]);
  layer.props = {
    uid: ids.uid(), match: "layer", name: node.id, kind: { kind: "Plain" }, enabled: true,
    children: [
      textGroup,
      emptyGroup(ids, "masks", "Masks"),
      emptyGroup(ids, "effects", "Effects"),
      transformGroup(ids, values, keyed, fps),
      materialOptions(ids),
    ],
  };
  return layer;
}

function buildShapeLayer(ctx, node) {
  const { ids, scene, fps, losses, notes, durationTicks } = ctx;
  const box = node.box;
  const props = node.props || {};
  const kind = props.kind || "rect";
  const tracks = tracksForNode(scene, node.id);
  const state0 = ctx.stateAt(0, node.id);
  const centre = [box.x + box.w / 2, box.y + box.h / 2];

  if (props.glow !== undefined) losses.push({ code: "L7", node: node.id, prop: "props.glow", reason: "glow has no EffectCraft match" });
  if (props.soft !== undefined) losses.push({ code: "L8", node: node.id, prop: "props.soft", reason: "soft has no EffectCraft match" });
  if (props.stroke && props.stroke.casing !== undefined) losses.push({ code: "L10", node: node.id, prop: "props.stroke.casing", reason: "stroke casing has no EffectCraft match" });
  if (props.fill && typeof props.fill === "object") losses.push({ code: "L9", node: node.id, prop: "props.fill", reason: "gradient fill is not written in this run, solid black is used" });

  const xTrack = trackByProp(tracks, "transform.x");
  const yTrack = trackByProp(tracks, "transform.y");
  const scaleTrack = trackByProp(tracks, "transform.scale");
  const scaleXTrack = trackByProp(tracks, "transform.scaleX");
  const scaleYTrack = trackByProp(tracks, "transform.scaleY");
  const rotTrack = trackByProp(tracks, "transform.rotation");
  const opTrack = trackByProp(tracks, "transform.opacity");
  const fillTrack = trackByProp(tracks, "props.fill");
  const colorTrack = trackByProp(tracks, "props.color");
  const pointsTrack = trackByProp(tracks, "props.points");
  if (pointsTrack) losses.push({ code: "L12", node: node.id, prop: "props.points", reason: "animated points are a loss, the static shape at frame 0 is written" });
  if (props.deform !== undefined) losses.push({ code: "L13", node: node.id, prop: "props.deform", reason: "deform has no EffectCraft match" });

  const positionAt = (f) => {
    const s = ctx.stateAt(f, node.id);
    return { t: "Vec3", v: [fmt(centre[0] + (s["transform.x"] ?? 0)), fmt(centre[1] + (s["transform.y"] ?? 0)), 0.0] };
  };
  const scaleAt = (f) => {
    const s = ctx.stateAt(f, node.id);
    return { t: "Vec3", v: [fmt((s["transform.scaleX"] ?? 1) * 100), fmt((s["transform.scaleY"] ?? 1) * 100), 100.0] };
  };
  const rotationAt = (f) => ({ t: "Scalar", v: fmt(ctx.stateAt(f, node.id)["transform.rotation"] ?? 0) });
  const opacityAt = (f) => ({ t: "Scalar", v: fmt((ctx.stateAt(f, node.id)["transform.opacity"] ?? 1) * 100) });
  const fillAt = (f) => {
    const s = ctx.stateAt(f, node.id);
    const hex = resolveHex(s["props.fill"] ?? s["props.color"], scene.palette) || "#000000";
    return { t: "Color", v: hexToFloats(hex, true) };
  };

  const keyed = {};
  if (xTrack || yTrack) {
    const feeds = [];
    if (xTrack) feeds.push({ track: xTrack, prop: "transform.x", dims: [0] });
    if (yTrack) feeds.push({ track: yTrack, prop: "transform.y", dims: [1] });
    keyed.position = mergedTrackKeys({
      feeds, fps, losses, nodeId: node.id, prop: "transform",
      valueAtFrame: positionAt,
      deltaOf: (feed, f0, f1) => {
        const a = positionAt(f0).v;
        const b = positionAt(f1).v;
        return Math.max(...feed.dims.map((d) => Math.abs(b[d] - a[d])));
      },
    });
  }
  if (scaleTrack || scaleXTrack || scaleYTrack) {
    const feeds = [];
    if (scaleTrack) feeds.push({ track: scaleTrack, prop: "transform.scale", dims: [0, 1] });
    if (scaleXTrack) feeds.push({ track: scaleXTrack, prop: "transform.scaleX", dims: [0] });
    if (scaleYTrack) feeds.push({ track: scaleYTrack, prop: "transform.scaleY", dims: [1] });
    keyed.scale = mergedTrackKeys({
      feeds, fps, losses, nodeId: node.id, prop: "transform",
      valueAtFrame: scaleAt,
      deltaOf: (feed, f0, f1) => {
        const a = scaleAt(f0).v;
        const b = scaleAt(f1).v;
        return Math.max(...feed.dims.map((d) => Math.abs(b[d] - a[d])));
      },
    });
  }
  if (rotTrack) {
    keyed.rotation = singleTrackKeys({
      track: rotTrack, fps, losses, nodeId: node.id, prop: "transform.rotation",
      valueAtFrame: rotationAt,
      deltaOf: (f0, f1) => Math.abs(rotationAt(f1).v - rotationAt(f0).v),
    });
  }
  if (opTrack) {
    keyed.opacity = singleTrackKeys({
      track: opTrack, fps, losses, nodeId: node.id, prop: "transform.opacity",
      valueAtFrame: opacityAt,
      deltaOf: (f0, f1) => Math.abs(opacityAt(f1).v - opacityAt(f0).v),
    });
  }

  const values = {
    // Shape anchor is [0, 0, 0]: the CLI writes it that way and the rect
    // is centred on the layer position (U1 shape probe). [w/2, h/2, 0]
    // shifts the shape by minus the anchor (fix cycle 3: bar rendered
    // 120 px left and up at f0). Solids and footage keep [w/2, h/2, 0].
    anchor: [0.0, 0.0, 0.0],
    position: positionAt(0).v,
    scale: scaleAt(0).v,
    orientation: [0.0, 0.0, 0.0],
    rotationX: 0.0,
    rotationY: 0.0,
    rotation: rotationAt(0).v,
    opacity: opacityAt(0).v,
  };

  const fillHex = resolveHex(state0["props.fill"] ?? state0["props.color"], scene.palette) || "#000000";
  const fill = fillGroup(ids, hexToFloats(fillHex, true));
  if (fillTrack && colorTrack) {
    notes.push({ code: "L10", node: node.id, prop: "props.color", reason: "both props.fill and props.color tracks exist, only the fill track is written" });
  }
  if (fillTrack || colorTrack) {
    const track = fillTrack || colorTrack;
    const colorProp = fill.children.find((c) => c.match === "color");
    const k = singleTrackKeys({
      track, fps, losses, nodeId: node.id, prop: "props.fill",
      valueAtFrame: fillAt,
      deltaOf: (f0, f1) => {
        const a = fillAt(f0).v;
        const b = fillAt(f1).v;
        return Math.max(...[0, 1, 2, 3].map((d) => Math.abs(b[d] - a[d])));
      },
    });
    if (k.frames.length > 1) colorProp.keys = buildKeys({ ...k, fps });
  }

  let contentsChildren;
  if (kind === "rect" || kind === "ellipse") {
    const isEllipse = kind === "ellipse";
    if (isEllipse) {
      notes.push({ code: "UNVERIFIED", node: node.id, prop: "props.kind", reason: "ellipse item is written from the rect pattern, unverified by render" });
    }
    const shapeItem = group(ids, isEllipse ? "ellipse" : "rect", isEllipse ? "Ellipse Path 1" : "Rectangle Path 1", "Indexed", [
      leaf(ids, "direction", "Path Direction", { t: "Enum", v: 0 }, { kind: "Hidden" }, { hold_only: true }),
      leaf(ids, "size", "Size", { t: "Vec2", v: [fmt(box.w), fmt(box.h)] }, { kind: "Pixels" }),
      leaf(ids, "position", "Position", { t: "Vec2", v: [0.0, 0.0] }, { kind: "Point" }),
      ...(isEllipse ? [] : [
        leaf(ids, "roundness", "Roundness", { t: "Scalar", v: fmt(props.radius ?? 0) }, { kind: "Pixels" }),
        leaf(ids, "perCorner", "Per-Corner Roundness", { t: "Bool", v: false }, { kind: "Checkbox" }, { hold_only: true }),
        leaf(ids, "topLeftRoundness", "Top Left Roundness", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
        leaf(ids, "topRightRoundness", "Top Right Roundness", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
        leaf(ids, "bottomRightRoundness", "Bottom Right Roundness", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
        leaf(ids, "bottomLeftRoundness", "Bottom Left Roundness", { t: "Scalar", v: 0.0 }, { kind: "Pixels" }),
      ]),
    ]);
    const items = [shapeItem, fill];
    if (props.stroke && typeof props.stroke === "object") {
      const sHex = resolveHex(props.stroke.color, scene.palette) || "#000000";
      items.push(strokeGroup(ids, hexToFloats(sHex, true), fmt(props.stroke.width ?? 1)));
    }
    const shapeGroup = group(ids, "group", isEllipse ? "Ellipse 1" : "Rectangle 1", "Indexed", [
      leaf(ids, "blend", "Blend Mode", { t: "Enum", v: 0 }, { kind: "Hidden" }, { hold_only: true }),
      group(ids, "contents", "Contents", "Plain", items),
      shapeGroupTransform(ids),
    ]);
    contentsChildren = [shapeGroup];
  } else if (kind === "polygon" || kind === "path" || kind === "line") {
    let points = state0["props.points"] || [];
    let closed = Boolean(state0["props.closed"]);
    if (points.length === 0 && typeof props.d === "string") {
      const parsed = parsePolygonD(props.d);
      if (parsed) {
        points = parsed;
        closed = kind === "polygon";
      } else {
        losses.push({ code: "L12", node: node.id, prop: "props.d", reason: "d string is not a plain x,y list and has no points list, the path is empty" });
      }
    }
    const pathValue = pointsToShapePath(points, closed, [box.w / 2, box.h / 2]);
    const pathGroup = group(ids, "path", "Path 1", "Indexed", [
      leaf(ids, "direction", "Path Direction", { t: "Enum", v: 0 }, { kind: "Hidden" }, { hold_only: true }),
      leaf(ids, "path", "Path", { t: "Path", v: pathValue }, { kind: "Path" }),
    ]);
    const items = [pathGroup, fill];
    if (props.stroke && typeof props.stroke === "object") {
      const sHex = resolveHex(props.stroke.color, scene.palette) || "#000000";
      items.push(strokeGroup(ids, hexToFloats(sHex, true), fmt(props.stroke.width ?? 1)));
    }
    contentsChildren = items;
  } else {
    losses.push({ code: "L12", node: node.id, prop: "props.kind", reason: `shape kind ${kind} has no EffectCraft match, no layer is written` });
    return null;
  }

  const layer = baseLayer(ids, node, state0, durationTicks);
  layer.source = { type: "Shape" };
  layer.props = {
    uid: ids.uid(), match: "layer", name: node.id, kind: { kind: "Plain" }, enabled: true,
    children: [
      group(ids, "contents", "Contents", "Plain", contentsChildren),
      emptyGroup(ids, "masks", "Masks"),
      emptyGroup(ids, "effects", "Effects"),
      transformGroup(ids, values, keyed, fps),
      materialOptions(ids),
    ],
  };
  return layer;
}

function buildImageLayer(ctx, node, footageItems) {
  const { ids, scene, fps, losses, notes, durationTicks, sceneDir } = ctx;
  const box = node.box;
  const props = node.props || {};
  const src = props.src;
  if (!src || typeof src !== "string") {
    losses.push({ code: "L19", node: node.id, prop: "props.src", reason: "image node has no src, no layer is written" });
    return null;
  }
  const abs = resolve(REPO_ROOT, "assets", src);
  const filePath = existsSync(abs) ? abs : resolve(sceneDir, src);
  if (!existsSync(filePath)) {
    losses.push({ code: "L19", node: node.id, prop: "props.src", reason: `image file not found: ${src}` });
    return null;
  }
  const size = readImageSize(filePath);
  if (!size) {
    losses.push({ code: "L19", node: node.id, prop: "props.src", reason: `image size cannot be read: ${src}` });
    return null;
  }
  const ext = extname(filePath).toLowerCase();
  const codec = ext === ".png" ? "PNG" : ext === ".jpg" || ext === ".jpeg" ? "JPEG" : null;
  if (!codec) {
    losses.push({ code: "L19", node: node.id, prop: "props.src", reason: `image format ${ext} is not supported, only PNG and JPEG` });
    return null;
  }
  const fit = props.fit || "cover";
  let sx;
  let sy;
  if (fit === "contain") {
    const s = Math.min(box.w / size.width, box.h / size.height) * 100;
    sx = s;
    sy = s;
  } else if (fit === "fill") {
    sx = (box.w / size.width) * 100;
    sy = (box.h / size.height) * 100;
  } else if (fit === "cover") {
    const s = Math.max(box.w / size.width, box.h / size.height) * 100;
    sx = s;
    sy = s;
  } else {
    notes.push({ code: "L19", node: node.id, prop: "props.fit", reason: `fit ${fit} is not known, cover is used` });
    const s = Math.max(box.w / size.width, box.h / size.height) * 100;
    sx = s;
    sy = s;
  }
  const itemId = ids.item();
  footageItems[String(itemId)] = {
    id: itemId,
    name: basename(filePath),
    label: "Lavender",
    comment: "",
    parent: null,
    kind: {
      type: "Footage", path: filePath, kind: "Still",
      width: size.width, height: size.height, pixel_aspect: 1.0,
      frame_rate: { num: 30, den: 1 }, native_rate: null, duration: 0,
      has_video: true, has_audio: false, alpha: "Ignore",
      premul_color: [0.0, 0.0, 0.0], loop_count: 1, codec, missing: false,
    },
  };

  const state0 = ctx.stateAt(0, node.id);
  const centre = [box.x + box.w / 2, box.y + box.h / 2];
  const layer = baseLayer(ids, node, state0, durationTicks);
  layer.source = { type: "Footage", item: itemId };
  layer.label = "Lavender";
  const values = {
    anchor: [fmt(size.width / 2), fmt(size.height / 2), 0.0],
    position: [fmt(centre[0] + (state0["transform.x"] ?? 0)), fmt(centre[1] + (state0["transform.y"] ?? 0)), 0.0],
    scale: [fmt(sx), fmt(sy), 100.0],
    orientation: [0.0, 0.0, 0.0],
    rotationX: 0.0,
    rotationY: 0.0,
    rotation: fmt(state0["transform.rotation"] ?? 0),
    opacity: fmt((state0["transform.opacity"] ?? 1) * 100),
  };
  layer.props = {
    uid: ids.uid(), match: "layer", name: node.id, kind: { kind: "Plain" }, enabled: true,
    children: [
      emptyGroup(ids, "masks", "Masks"),
      emptyGroup(ids, "effects", "Effects"),
      transformGroup(ids, values, {}, fps),
      materialOptions(ids),
    ],
  };
  return layer;
}

// ---------------------------------------------------------------------------
// Video export. A video file in, a frames folder plus a .ecproj file out.
// The frames folder sits next to the .ecproj file and holds one PNG per
// frame, named frame_0000.png onward. The .ecproj file holds one Sequence
// footage item and one comp with one full-frame layer, in the form the
// EffectCraft engine import wrote (units/F1/imported.ecproj): footage
// item 1, comp item 2, layer id 3, comp label Sandstone, footage label
// Lavender, alpha Ignore, codec PNG, activeComp set to the comp id.
// The frame rate comes from the video probe, never a default: the engine
// import defaulted to 30/1 on a 24 fps video and the comp lasted 24.0 s
// instead of 30.0 s. Paths in the file are relative (frames/frame_0000.png)
// so the project opens on the Mac, where absolute Linux paths cannot exist.

/** Read width, height, frame rate, and frame count from ffprobe JSON. */
export function parseVideoProbe(probe) {
  const stream = (probe.streams || []).find((s) => s.codec_type === "video");
  if (!stream) throw new Error("ffprobe found no video stream");
  const rate = String(stream.r_frame_rate || stream.avg_frame_rate || "");
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) throw new Error(`video frame rate is not readable: ${rate}`);
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!width || !height) throw new Error("video size is not readable");
  let frameCount = Number(stream.nb_frames);
  if (!frameCount) {
    const dur = Number(stream.duration || probe.format?.duration);
    if (!dur) throw new Error("video frame count and duration are both missing");
    frameCount = Math.round((dur * num) / den);
  }
  if (!frameCount) throw new Error("video frame count is zero");
  return { width, height, fpsNum: num, fpsDen: den, frameCount, durationS: (frameCount * den) / num };
}

/** Run ffprobe on a video file and parse the result. Throws on failure. */
export function probeVideo(videoPath) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", videoPath], { encoding: "utf8" });
  if (r.error) throw new Error(`ffprobe failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffprobe failed on ${videoPath}: ${String(r.stderr || "").trim()}`);
  let probe;
  try {
    probe = JSON.parse(r.stdout);
  } catch {
    throw new Error(`ffprobe output is not JSON for ${videoPath}`);
  }
  return parseVideoProbe(probe);
}

/**
 * List the frame files in a frames folder and check the numbering is
 * continuous from 0 to frameCount - 1. Returns the relative paths in
 * frame-number order, for the sequence list. Throws on any gap, any
 * missing frame, or any extra frame file.
 */
export function listSequenceFiles(framesDir, frameCount) {
  const files = readdirSync(framesDir).filter((f) => /^frame_\d{4}\.png$/.test(f)).sort();
  const present = new Set(files.map((f) => Number(f.slice(6, 10))));
  const missing = [];
  for (let i = 0; i < frameCount; i++) if (!present.has(i)) missing.push(i);
  const extra = [...present].filter((n) => n < 0 || n >= frameCount);
  if (files.length !== frameCount || missing.length > 0 || extra.length > 0) {
    const head = missing.slice(0, 5).join(", ");
    throw new Error(`frames folder ${framesDir} holds ${files.length} frames, expected ${frameCount}` +
      (missing.length > 0 ? `, missing frames ${head}${missing.length > 5 ? ", …" : ""}` : "") +
      (extra.length > 0 ? `, extra frames ${extra.slice(0, 5).join(", ")}` : ""));
  }
  const folder = basename(framesDir);
  return files.map((f) => `${folder}/${f}`);
}

/**
 * Extract every frame of a video to PNG files in framesDir, then verify
 * the sequence is complete. Returns the relative paths in frame order.
 * The extraction command is the F1-proven one: ffmpeg -vsync 0 writes
 * exactly one PNG per source frame, numbered from 0.
 */
export function extractVideoFrames(videoPath, framesDir, frameCount) {
  mkdirSync(framesDir, { recursive: true });
  const pattern = resolve(framesDir, "frame_%04d.png");
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", videoPath, "-vsync", "0", "-start_number", "0", pattern], { encoding: "utf8" });
  if (r.error) throw new Error(`ffmpeg failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${videoPath}: ${String(r.stderr || "").trim()}`);
  return listSequenceFiles(framesDir, frameCount);
}

/**
 * Build a .ecproj project for a video: one Sequence footage item plus
 * one comp with one full-frame layer. Pure apart from nothing: it takes
 * the probe result and the verified sequence list and returns
 * { project, stats }. The stem names the comp; pass the output file stem.
 */
export function exportVideo(info, sequenceFiles, opts = {}) {
  const { width, height, fpsNum, fpsDen, frameCount } = info;
  if (sequenceFiles.length !== frameCount) {
    throw new Error(`sequence holds ${sequenceFiles.length} files, expected ${frameCount}`);
  }
  const durationTicks = Math.round((frameCount * TICKS_PER_SECOND * fpsDen) / fpsNum);
  const ids = makeIds();
  const footageId = ids.item();
  const compId = ids.item();
  const stem = opts.stem || "sequence";
  const first = String(0).padStart(4, "0");
  const last = String(frameCount - 1).padStart(4, "0");
  const footageName = `frame_[${first}-${last}].png`;

  const footageItem = {
    id: footageId,
    name: footageName,
    label: "Lavender",
    comment: "",
    parent: null,
    kind: {
      type: "Footage", path: sequenceFiles[0], kind: "Sequence",
      width, height, pixel_aspect: 1.0,
      frame_rate: { num: fpsNum, den: fpsDen }, native_rate: null, duration: durationTicks,
      has_video: true, has_audio: false, alpha: "Ignore",
      premul_color: [0.0, 0.0, 0.0], loop_count: 1, codec: "PNG", missing: false,
      sequence: [...sequenceFiles],
    },
  };

  const layer = baseLayer(ids, { id: footageName }, null, durationTicks);
  layer.source = { type: "Footage", item: footageId };
  layer.label = "Lavender";
  layer.props = {
    uid: ids.uid(), match: "layer", name: footageName, kind: { kind: "Plain" }, enabled: true,
    children: [
      emptyGroup(ids, "masks", "Masks"),
      emptyGroup(ids, "effects", "Effects"),
      transformGroup(ids, {
        anchor: [fmt(width / 2), fmt(height / 2), 0.0],
        position: [fmt(width / 2), fmt(height / 2), 0.0],
        scale: [fmt(100), fmt(100), 100.0],
        orientation: [0.0, 0.0, 0.0],
        rotationX: 0.0,
        rotationY: 0.0,
        rotation: 0.0,
        opacity: 100.0,
      }, {}, fpsNum / fpsDen),
      materialOptions(ids),
    ],
  };

  const comp = {
    type: "Comp",
    width, height,
    pixel_aspect: 1.0,
    frame_rate: { num: fpsNum, den: fpsDen },
    duration: durationTicks,
    display_start: 0,
    background: [0.0, 0.0, 0.0],
    work_area: [0, durationTicks],
    layers: [layer],
    markers: [],
    shutter_angle: 180.0,
    shutter_phase: -90.0,
    motion_blur_samples: 16,
    motion_blur_adaptive_limit: 128,
    renderer: "Classic3D",
    hide_shy: false,
    enable_motion_blur: true,
    enable_frame_blending: true,
    draft_3d: false,
    preserve_frame_rate: false,
    preserve_resolution: false,
    poster_time: 0,
    global_light: globalLight(),
  };
  const compItem = {
    id: compId,
    name: stem,
    label: "Sandstone",
    comment: "",
    parent: null,
    kind: comp,
  };
  const project = {
    savedBy: ECPROJ_SAVED_BY,
    activeComp: compId,
    openComps: [compId],
    schema: ECPROJ_SCHEMA,
    render_queue: [],
    settings: { ...SETTINGS },
    items: { [footageId]: footageItem, [compId]: compItem },
    next_id: ids.nextId(),
  };
  return {
    project,
    stats: {
      video: stem,
      width,
      height,
      fps: fpsNum / fpsDen,
      duration_frames: frameCount,
      duration_s: (frameCount * fpsDen) / fpsNum,
      frame_count: frameCount,
      format: "PNG",
      layer_count: 1,
      loss_count: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Scene export. Pure apart from reading font and image files. Returns
// { project, losses, notes, stats }. Throws on an unreadable scene.
export function exportScene(scene, opts = {}) {
  const sceneDir = opts.sceneDir || REPO_ROOT;
  if (!scene || scene.schema !== "hme.scene/1.0") {
    throw new Error(`unsupported scene schema: ${scene && scene.schema}`);
  }
  const fps = sceneFps(scene);
  const durationFrames = scene.meta.duration;
  const durationTicks = frameToTicks(durationFrames, fps);
  const losses = [];
  const notes = [];
  const ids = makeIds();
  const compId = ids.item();

  const stateCache = new Map();
  const stateAt = (frame, nodeId) => {
    if (!stateCache.has(frame)) {
      stateCache.set(frame, sampleScene(scene, frame));
    }
    const all = stateCache.get(frame);
    if (nodeId) return all[nodeId];
    return all;
  };
  const safeStateAt = (frame, nodeId) => {
    try {
      return stateAt(frame, nodeId);
    } catch (err) {
      const s0 = stateAt(0, nodeId);
      losses.push({ code: "L12", node: nodeId, prop: "props.points", reason: `sample at frame ${frame} failed: ${err.message}, frame 0 state is used` });
      return s0;
    }
  };

  // Font ascents, read once per font entry.
  const fontAscents = {};
  for (const f of scene.fonts || []) {
    if (!f || !f.family) continue;
    const p = f.src ? resolveFontPath(f.src, sceneDir) : null;
    if (!p) {
      notes.push({ code: "L15", node: null, prop: "fonts", reason: `font file not found for ${f.family}: ${f.src}` });
      continue;
    }
    const ratio = readFontAscent(p);
    if (ratio === null) {
      notes.push({ code: "L15", node: null, prop: "fonts", reason: `ascent cannot be read for ${f.family}` });
      continue;
    }
    fontAscents[f.family] = ratio;
  }

  // Camera is a loss in this run.
  const hasCamera = scene.camera !== undefined || (scene.timeline || []).some((t) => t.node === "camera");
  if (hasCamera) {
    losses.push({ code: "L4", node: "camera", prop: "camera", reason: "camera zoom and center have no EffectCraft match in this run" });
  }
  // Ground gradient is a loss.
  let groundHex = "#000000";
  if (typeof scene.palette?.ground === "string") {
    groundHex = scene.palette.ground;
  } else if (scene.palette?.ground !== undefined) {
    losses.push({ code: "L9", node: null, prop: "palette.ground", reason: "gradient ground is not written in this run, black is used" });
  }
  notes.push({ code: "L16", node: null, prop: "meta", reason: `seed ${scene.meta.seed}, register ${scene.meta.register}, notes are not carried` });
  notes.push({ code: "L15", node: null, prop: "fonts", reason: "font files are not embedded, the reader machine must have the fonts installed" });

  const ctx = {
    ids, scene, fps, losses, notes, durationTicks, fontAscents, sceneDir,
    stateAt: (frame, nodeId) => safeStateAt(frame, nodeId),
  };

  const layers = [];
  const footageItems = {};
  const nodes = [...(scene.nodes || [])].sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
  for (const node of nodes) {
    if (node.parent !== null && node.parent !== undefined) {
      notes.push({ code: "L14", node: node.id, prop: "parent", reason: `parent ${node.parent} is dropped, HME parents have no visual effect` });
    }
    if (node.type === "text") {
      if (node.props?.kinetic !== undefined) {
        losses.push({ code: "L3", node: node.id, prop: "props.kinetic", reason: "kinetic text (split, stagger, from) has no EffectCraft match, the static text is written" });
      }
      layers.push(buildTextLayer(ctx, node));
    } else if (node.type === "shape") {
      const layer = buildShapeLayer(ctx, node);
      if (layer) layers.push(layer);
    } else if (node.type === "image") {
      const layer = buildImageLayer(ctx, node, footageItems);
      if (layer) layers.push(layer);
    } else if (node.type === "chart") {
      const kind = node.props?.kind || "chart";
      losses.push({ code: kind === "countup" ? "L1" : "L2", node: node.id, prop: "props.kind", reason: `chart ${kind} has no EffectCraft match, no layer is written` });
    } else if (node.type === "map") {
      losses.push({ code: "L5", node: node.id, prop: "type", reason: "map node has no EffectCraft match, no layer is written" });
    } else if (node.type === "particle") {
      losses.push({ code: "L6", node: node.id, prop: "type", reason: "particle node has no EffectCraft match, no layer is written" });
    } else {
      losses.push({ code: "L12", node: node.id, prop: "type", reason: `node type ${node.type} has no EffectCraft match, no layer is written` });
    }
  }

  const markers = (scene.events || [])
    .slice()
    .sort((a, b) => a.f - b.f)
    .map((e) => ({
      time: frameToTicks(e.f, fps),
      duration: 0,
      comment: e.note ?? e.id ?? "",
      label: "Red",
      chapter: "",
      url: "",
      protected: false,
    }));

  const comp = {
    type: "Comp",
    width: scene.meta.width,
    height: scene.meta.height,
    pixel_aspect: 1.0,
    frame_rate: { num: fps, den: 1 },
    duration: durationTicks,
    display_start: 0,
    background: hexToFloats(groundHex, false),
    work_area: [0, durationTicks],
    layers,
    markers,
    shutter_angle: 180.0,
    shutter_phase: -90.0,
    motion_blur_samples: 16,
    motion_blur_adaptive_limit: 128,
    renderer: "Classic3D",
    hide_shy: false,
    enable_motion_blur: true,
    enable_frame_blending: true,
    draft_3d: false,
    preserve_frame_rate: false,
    preserve_resolution: false,
    poster_time: 0,
    global_light: globalLight(),
  };

  const compItem = {
    id: compId,
    name: scene.meta.id,
    label: "Sandstone",
    comment: "",
    parent: null,
    kind: comp,
  };
  const items = { [compId]: compItem };
  for (const [k, v] of Object.entries(footageItems)) items[k] = v;

  const project = {
    savedBy: ECPROJ_SAVED_BY,
    schema: ECPROJ_SCHEMA,
    render_queue: [],
    settings: { ...SETTINGS },
    items,
    next_id: ids.nextId(),
  };
  return {
    project,
    losses,
    notes,
    stats: {
      scene_id: scene.meta.id,
      width: scene.meta.width,
      height: scene.meta.height,
      fps,
      duration_frames: durationFrames,
      duration_s: durationFrames / fps,
      layer_count: layers.length,
      loss_count: losses.length,
      note_count: notes.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Insight report. Pure function, tested without touching the disk.
export function buildExportReport(scene, result, outPath, loadError) {
  const stats = result ? result.stats : null;
  const losses = result ? result.losses : [];
  const notes = result ? result.notes : [];
  const failedBar = loadError !== null
    ? "scene file can be read"
    : !result
      ? "scene passes validation (0 errors allowed)"
      : null;
  const status = failedBar === null ? "PASS" : "FAIL";
  const detail = loadError !== null
    ? `Scene file cannot be read: ${loadError}`
    : status === "PASS"
      ? `Scene ${stats.scene_id} exported to ${outPath}: ${stats.layer_count} layers, ${stats.loss_count} losses listed.`
      : "Scene failed validation, no file was written.";
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      scene: scene ? scene.meta?.id ?? null : null,
      scene_id: stats ? stats.scene_id : null,
      out: outPath,
      layers: stats ? stats.layer_count : 0,
      loss_count: losses.length,
      losses,
      note_count: notes.length,
      notes,
      width: stats ? stats.width : null,
      height: stats ? stats.height : null,
      fps: stats ? stats.fps : null,
      duration_s: stats ? stats.duration_s : null,
    },
    corrections: [],
    context: {
      thresholds: { unlisted_losses: 0 },
      control_ceiling: null,
      meaning: status === "PASS"
        ? "The .ecproj file is written and every gap is listed in numbers.losses. A loss means the scene has a part EffectCraft cannot show, not that the export failed."
        : "The scene cannot be exported as written. Fix the validation errors first.",
    },
    next: status === "PASS"
      ? `effectcraft-cli info ${outPath} --json`
      : "hme validate <scene.json>",
    limits: [
      "The .ecproj file stores font family names only. The reader machine must have the fonts installed.",
      "Ellipse items, paragraph text, image fit, and the text centre-anchor form are written from probed formats and are not yet proven by render.",
      "The loss report lists every gap. It does not prove the rendered frames match HME.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Insight report for a video export. Pure function, tested without
// touching the disk. Mirrors buildExportReport: same insight shape, but
// the numbers describe the video, the frame count, and the frames folder.
export function buildVideoExportReport(info, result, outPath, framesDir, loadError) {
  const stats = result ? result.stats : null;
  const failedBar = loadError !== null
    ? "video file can be read and probed"
    : !result
      ? "video exports to an image-sequence comp"
      : null;
  const status = failedBar === null ? "PASS" : "FAIL";
  const detail = loadError !== null
    ? `Video export failed: ${loadError}`
    : status === "PASS"
      ? `Video exported to ${outPath}: ${stats.frame_count} PNG frames in ${framesDir}, 1 comp, 1 layer.`
      : "Video export failed, no file was written.";
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      video: info ? info.video ?? null : null,
      out: outPath,
      frames_dir: framesDir,
      frame_count: stats ? stats.frame_count : 0,
      format: stats ? stats.format : null,
      layers: stats ? stats.layer_count : 0,
      loss_count: 0,
      losses: [],
      width: stats ? stats.width : null,
      height: stats ? stats.height : null,
      fps: stats ? stats.fps : null,
      duration_s: stats ? stats.duration_s : null,
    },
    corrections: [],
    context: {
      thresholds: { ssim_mean: 0.99 },
      control_ceiling: null,
      meaning: status === "PASS"
        ? "The .ecproj file holds one Sequence footage item and one comp that plays all frames at the video rate. Frame quality is proven by the render-frame SSIM check, not by this report."
        : "The video cannot be exported as written. Fix the input first.",
    },
    next: status === "PASS"
      ? `effectcraft-cli info ${outPath} --json`
      : "ffprobe <input.mp4>",
    limits: [
      "Frames are PNG only. JPEG q2 measured mean SSIM 0.9894, below the 0.99 bar.",
      "The frames folder must stay next to the .ecproj file. Paths in the file are relative.",
      "The report does not prove the rendered frames match the source. Run the render-frame SSIM check.",
    ],
  };
}

// Export a video file: probe it, extract its frames to a frames folder
// next to the .ecproj file, verify the sequence, and write the project.
// Returns the process exit code.
export function runVideoExport(videoArg, videoPath, outPath, reportPath) {
  const outAbs = resolve(outPath);
  const framesDir = resolve(dirname(outAbs), "frames");
  const stem = basename(outAbs, extname(outAbs));
  if (!existsSync(videoPath)) {
    console.error(`hme export: no such file: ${videoArg}`);
    const report = buildVideoExportReport(null, null, outAbs, framesDir, `no such file: ${videoArg}`);
    writeInsightReport(report, reportPath);
    return 2;
  }
  let info;
  try {
    info = probeVideo(videoPath);
  } catch (err) {
    console.error(`hme export: cannot probe ${videoArg}: ${err.message}`);
    const report = buildVideoExportReport(null, null, outAbs, framesDir, err.message);
    writeInsightReport(report, reportPath);
    return 2;
  }
  info = { ...info, video: stem };
  let sequenceFiles;
  try {
    sequenceFiles = extractVideoFrames(videoPath, framesDir, info.frameCount);
  } catch (err) {
    console.error(`hme export: frame extraction failed: ${err.message}`);
    const report = buildVideoExportReport(info, null, outAbs, framesDir, err.message);
    writeInsightReport(report, reportPath);
    return 1;
  }
  let result;
  try {
    result = exportVideo(info, sequenceFiles, { stem });
  } catch (err) {
    console.error(`hme export: export failed: ${err.message}`);
    const report = buildVideoExportReport(info, null, outAbs, framesDir, err.message);
    writeInsightReport(report, reportPath);
    return 1;
  }
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, JSON.stringify(result.project, null, 2) + "\n");
  const report = buildVideoExportReport(info, result, outAbs, framesDir, null);
  const code = writeInsightReport(report, reportPath);
  if (code === 0) {
    console.error(`hme export: wrote ${outAbs} (${result.stats.frame_count} PNG frames, 1 comp)`);
  }
  return code;
}

// Run `hme export <scene.json> --to ecproj --out <file.ecproj>
// [--report <report.json>]`. Returns the process exit code.
export function runExport(argv) {
  const positionals = [];
  let to = null;
  let outPath = null;
  let reportPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to") {
      if (i + 1 >= argv.length) {
        console.error("hme export: --to needs a format");
        console.error(USAGE);
        return 2;
      }
      to = argv[++i];
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme export: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a === "--report") {
      if (i + 1 >= argv.length) {
        console.error("hme export: --report needs a file path");
        console.error(USAGE);
        return 2;
      }
      reportPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme export: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme export: needs one scene file, scene.json");
    console.error(USAGE);
    return 2;
  }
  if (to === null) {
    console.error("hme export: --to is required");
    console.error(USAGE);
    return 2;
  }
  if (to !== "ecproj") {
    console.error(`hme export: unsupported format "${to}", only ecproj is supported`);
    console.error(USAGE);
    return 2;
  }
  if (outPath === null) {
    console.error("hme export: --out is required");
    console.error(USAGE);
    return 2;
  }
  const inputArg = positionals[0];
  const inputPath = resolve(inputArg);
  if (isVideoPath(inputArg)) {
    return runVideoExport(inputArg, inputPath, outPath, reportPath);
  }
  const sceneArg = inputArg;
  const scenePath = inputPath;
  if (!existsSync(scenePath)) {
    console.error(`hme export: no such file: ${sceneArg}`);
    const report = buildExportReport(null, null, outPath, `no such file: ${sceneArg}`);
    writeInsightReport(report, reportPath);
    return 2;
  }
  let scene = null;
  let loadError = null;
  try {
    scene = loadScene(scenePath);
  } catch (err) {
    loadError = err.message;
  }
  if (loadError !== null) {
    console.error(`hme export: cannot read ${sceneArg}: ${loadError}`);
    const report = buildExportReport(null, null, outPath, loadError);
    writeInsightReport(report, reportPath);
    return 2;
  }
  const validation = validateScene(scene);
  if (validation.errors.length > 0) {
    console.error(`hme export: scene ${sceneArg} has ${validation.errors.length} validation error(s), no file was written`);
    for (const e of validation.errors) console.error(`  ${e.code} ${e.path} ${e.message}`);
    const report = buildExportReport(scene, null, outPath, null);
    report.numbers.errors = validation.errors;
    report.verdict.detail = `Scene ${scene.meta?.id ?? sceneArg} has ${validation.errors.length} validation error(s): ${validation.errors[0].code} ${validation.errors[0].path} ${validation.errors[0].message}`;
    writeInsightReport(report, reportPath);
    return 1;
  }
  let result;
  try {
    result = exportScene(scene, { sceneDir: dirname(scenePath) });
  } catch (err) {
    console.error(`hme export: export failed: ${err.message}`);
    const report = buildExportReport(scene, null, outPath, err.message);
    writeInsightReport(report, reportPath);
    return 1;
  }
  const outAbs = resolve(outPath);
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, JSON.stringify(result.project, null, 2) + "\n");
  const lossesPath = `${outAbs}.losses.json`;
  writeFileSync(lossesPath, JSON.stringify({
    scene: scene.meta.id,
    out: outAbs,
    losses: result.losses,
    notes: result.notes,
  }, null, 2) + "\n");
  const report = buildExportReport(scene, result, outAbs, null);
  const code = writeInsightReport(report, reportPath);
  if (code === 0) {
    console.error(`hme export: wrote ${outAbs} (${result.stats.layer_count} layers, ${result.stats.loss_count} losses, report in ${lossesPath})`);
  }
  return code;
}
