// hme export: unit tests for the .ecproj exporter.
//
// Covers the ease conversion (all worked numbers come from
// workspace/handover-motion-export/units/U2/mapping.md), the tick and
// colour conversions, the path conversion, and the full export of the
// two proof scenes. The CLI is tested end to end in a temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  segmentEase, frameToTicks, hexToFloats, pointsToShapePath,
  parsePolygonD, readFontAscent, exportScene, buildExportReport, runExport,
  parseVideoProbe, listSequenceFiles, exportVideo, buildVideoExportReport,
  isVideoPath,
} from "../../src/cli/export.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";
import { loadScene } from "../../src/scene/validate.mjs";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const sceneMin = () => loadScene(fileURLToPath(new URL("scene-min.json", FIXTURES)));
const textSample = () => loadScene(fileURLToPath(new URL("text-sample.json", FIXTURES)));

const close = (a, b, tol = 0.001) => Math.abs(a - b) <= tol;

test("frame 120 at 24 fps is 1270080000000 ticks", () => {
  assert.equal(frameToTicks(120, 24), 1270080000000);
  assert.equal(frameToTicks(240, 24), 2540160000000);
  assert.equal(frameToTicks(0, 24), 0);
});

test("hex to floats matches the demo file values", () => {
  const [r, g, b, a] = hexToFloats("#e8a33d", true);
  assert.ok(close(r, 0.9098039));
  assert.ok(close(g, 0.6392157));
  assert.ok(close(b, 0.23921569));
  assert.equal(a, 1);
  assert.deepEqual(hexToFloats("#101820", false).map((v) => Number(v.toFixed(7))), [0.0627451, 0.0941176, 0.1254902]);
});

test("linear maps to linear, no ease entries", () => {
  assert.deepEqual(segmentEase("linear", 1200, 5), {
    outInterp: "Linear", outEase: [], inInterp: "Linear", inEase: [], losses: [],
  });
  assert.deepEqual(segmentEase(undefined, 1200, 5).outInterp, "Linear");
});

test("hold maps to hold on the out side", () => {
  const out = segmentEase("hold", 1200, 5);
  assert.equal(out.outInterp, "Hold");
  assert.equal(out.inInterp, "Linear");
  assert.deepEqual(out.outEase, []);
});

test("easeInOutCubic over 1200 px in 5 s gives speed 0 and influence 0.65", () => {
  const out = segmentEase("easeInOutCubic", 1200, 5);
  assert.equal(out.outInterp, "Bezier");
  assert.equal(out.inInterp, "Bezier");
  assert.deepEqual(out.outEase, [{ speed: 0, influence: 0.65 }]);
  assert.deepEqual(out.inEase, [{ speed: 0, influence: 0.65 }]);
  assert.deepEqual(out.losses, []);
});

test("easeOutQuint over -600 px in 5 s gives out speed 545.455 and influence 0.22", () => {
  const out = segmentEase("easeOutQuint", -600, 5);
  assert.ok(close(out.outEase[0].speed, 545.455));
  assert.equal(out.outEase[0].influence, 0.22);
  assert.deepEqual(out.inEase, [{ speed: 0, influence: 0.64 }]);
});

test("easeInOutBack keeps the magnitude and records the direction loss", () => {
  const out = segmentEase("easeInOutBack", 100, 1);
  assert.ok(close(out.outEase[0].speed, 88.235));
  assert.ok(close(out.inEase[0].speed, 88.235));
  assert.equal(out.losses.length, 2);
});

test("a custom bezier with x1 0 falls back to linear with a loss", () => {
  const out = segmentEase({ bezier: [0, 0.5, 0.5, 1] }, 100, 1);
  assert.equal(out.outInterp, "Linear");
  assert.equal(out.losses.length, 1);
});

test("an unknown ease throws", () => {
  assert.throws(() => segmentEase("easeNope", 100, 1), /UNKNOWN_EASE/);
});

test("line points become zero tangents", () => {
  const p = pointsToShapePath([
    { id: "p0", anchor: [0, 0], in: null, out: null, command: "move" },
    { id: "p1", anchor: [100, 0], in: null, out: null, command: "line" },
    { id: "p2", anchor: [50, 100], in: null, out: null, command: "line" },
  ]);
  assert.deepEqual(p.vertices, [[0, 0], [100, 0], [50, 100]]);
  assert.deepEqual(p.in_tangents, [[0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(p.out_tangents, [[0, 0], [0, 0], [0, 0]]);
  assert.equal(p.closed, false);
});

test("cubic handles become relative offsets, out belongs to the previous point", () => {
  const p = pointsToShapePath([
    { id: "p0", anchor: [0, 0], in: null, out: [30, 0], command: "move" },
    { id: "p1", anchor: [100, 0], in: [70, 0], out: null, command: "cubic" },
  ]);
  assert.deepEqual(p.out_tangents[0], [30, 0]);
  assert.deepEqual(p.in_tangents[1], [-30, 0]);
});

test("smooth reflects the previous in handle", () => {
  const p = pointsToShapePath([
    { id: "p0", anchor: [0, 0], in: null, out: [30, 0], command: "move" },
    { id: "p1", anchor: [100, 0], in: [70, 0], out: null, command: "cubic" },
    { id: "p2", anchor: [200, 0], in: [170, 0], out: null, command: "smooth" },
  ]);
  assert.deepEqual(p.out_tangents[0], [30, 0]);
  assert.deepEqual(p.in_tangents[1], [-30, 0]);
  assert.deepEqual(p.out_tangents[1], [30, 0]);
  assert.deepEqual(p.in_tangents[2], [-30, 0]);
});

test("line segments ignore handles, closed comes from the flag", () => {
  const p = pointsToShapePath([
    { id: "p0", anchor: [0, 0], in: [5, 5], out: [10, 0], command: "move" },
    { id: "p1", anchor: [100, 0], in: [90, 0], out: [110, 0], command: "line" },
  ]);
  assert.deepEqual(p.in_tangents, [[0, 0], [0, 0]]);
  assert.deepEqual(p.out_tangents, [[0, 0], [0, 0]]);
  assert.equal(p.closed, false);
  assert.equal(pointsToShapePath([{ id: "p0", anchor: [0, 0], in: null, out: null, command: "move" }], true).closed, true);
});

test("polygon d parses, SVG path data does not", () => {
  const p = parsePolygonD("0,0 100,0 50,100");
  assert.equal(p.length, 3);
  assert.deepEqual(p[0].anchor, [0, 0]);
  assert.equal(p[0].command, "move");
  assert.equal(p[1].command, "line");
  assert.equal(parsePolygonD("M0,0 L100,0 Z"), null);
  assert.equal(parsePolygonD(""), null);
});

test("font ascent reads Montserrat 0.968 and Anton 1.1763", () => {
  const root = new URL("../../", import.meta.url);
  const m = readFontAscent(fileURLToPath(new URL("assets/fonts/Montserrat-Bold.ttf", root)));
  const a = readFontAscent(fileURLToPath(new URL("assets/fonts/Anton-Regular.ttf", root)));
  assert.ok(close(m, 0.968));
  assert.ok(close(a, 1.1763));
  assert.equal(readFontAscent("/no/such/font.ttf"), null);
});

test("scene-min exports to 2 layers with zero losses", () => {
  const { project, losses, stats } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  assert.equal(project.schema, 1);
  assert.equal(project.savedBy, "0.3.1");
  assert.equal("activeComp" in project, false);
  assert.equal("openComps" in project, false);
  assert.equal("working_gamma" in project.settings, false);
  assert.deepEqual(project.render_queue, []);
  assert.equal(project.items[1].name, "scene-min");
  assert.deepEqual(project.items[1].kind.background.map((v) => Number(v.toFixed(7))), [0.0627451, 0.0941176, 0.1254902]);
  assert.equal(project.items[1].kind.layers.length, 2);
  assert.equal(stats.layer_count, 2);
  assert.deepEqual(losses, []);
  assert.equal(project.items[1].kind.markers.length, 1);
  assert.equal(project.items[1].kind.markers[0].time, 1270080000000);
  assert.equal(project.items[1].kind.markers[0].comment, "bar reaches its far position");
});

test("scene-min layer order is title above bar", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const layers = project.items[1].kind.layers;
  assert.equal(layers[0].name, "title");
  assert.equal(layers[1].name, "bar");
  assert.deepEqual(layers[0].source, { type: "Text" });
  assert.deepEqual(layers[1].source, { type: "Shape" });
});

test("scene-min bar position keys match the HME values", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const bar = project.items[1].kind.layers[1];
  const tr = bar.props.children.find((c) => c.match === "transform");
  const pos = tr.children.find((c) => c.match === "position");
  assert.deepEqual(pos.value, { t: "Vec3", v: [280, 720, 0] });
  assert.equal(pos.keys.length, 3);
  assert.deepEqual(pos.keys[0].value.v, [280, 720, 0]);
  assert.deepEqual(pos.keys[1].value.v, [1480, 720, 0]);
  assert.deepEqual(pos.keys[2].value.v, [880, 720, 0]);
  assert.equal(pos.keys[0].time, 0);
  assert.equal(pos.keys[1].time, 1270080000000);
  assert.equal(pos.keys[2].time, 2540160000000);
});

test("scene-min bar ease sides match the worked numbers", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const bar = project.items[1].kind.layers[1];
  const tr = bar.props.children.find((c) => c.match === "transform");
  const pos = tr.children.find((c) => c.match === "position");
  const [k0, k1, k2] = pos.keys;
  assert.equal(k0.in_interp, "Linear");
  assert.equal(k0.out_interp, "Bezier");
  assert.deepEqual(k0.out_ease, [{ speed: 0, influence: 0.65 }]);
  assert.equal(k1.in_interp, "Bezier");
  assert.deepEqual(k1.in_ease, [{ speed: 0, influence: 0.65 }]);
  assert.equal(k1.out_interp, "Bezier");
  assert.ok(close(k1.out_ease[0].speed, 545.455));
  assert.equal(k1.out_ease[0].influence, 0.22);
  assert.equal(k2.in_interp, "Bezier");
  assert.deepEqual(k2.in_ease, [{ speed: 0, influence: 0.64 }]);
  assert.equal(k2.out_interp, "Linear");
});

test("scene-min title text matches the scene", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const title = project.items[1].kind.layers[0];
  const text = title.props.children.find((c) => c.match === "text");
  const st = text.children.find((c) => c.match === "sourceText").value.v;
  assert.equal(st.text, "Headless motion engine");
  assert.equal(st.font, "Montserrat");
  assert.equal(st.style, "Bold");
  assert.equal(st.size, 96);
  assert.equal(st.tracking, -20.833);
  assert.ok(close(st.leading, 105.6));
  assert.equal(st.justify, "Left");
  const tr = title.props.children.find((c) => c.match === "transform");
  const pos = tr.children.find((c) => c.match === "position");
  assert.ok(close(pos.value.v[0], 160));
  assert.ok(close(pos.value.v[1], 217.728));
});

test("scene-min bar shape matches the scene", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const bar = project.items[1].kind.layers[1];
  const contents = bar.props.children.find((c) => c.match === "contents");
  const grp = contents.children[0];
  const inner = grp.children.find((c) => c.match === "contents");
  const rect = inner.children.find((c) => c.match === "rect");
  const fill = inner.children.find((c) => c.match === "fill");
  assert.deepEqual(rect.children.find((c) => c.match === "size").value.v, [240, 240]);
  assert.equal(rect.children.find((c) => c.match === "roundness").value.v, 24);
  const color = fill.children.find((c) => c.match === "color").value.v;
  assert.ok(close(color[0], 0.9098039));
  assert.ok(close(color[1], 0.6392157));
  assert.ok(close(color[2], 0.23921569));
  assert.equal(color[3], 1);
});

test("text-sample exports to 2 layers with exactly 3 losses", () => {
  const { project, losses, stats } = exportScene(textSample(), { sceneDir: dirname(fileURLToPath(new URL("text-sample.json", FIXTURES))) });
  assert.equal(stats.layer_count, 2);
  assert.deepEqual(losses.map((l) => l.code), ["L3", "L1", "L2"]);
  const layers = project.items[1].kind.layers;
  assert.equal(layers[0].name, "title");
  assert.equal(layers[1].name, "pill");
  const title = layers[0];
  const text = title.props.children.find((c) => c.match === "text");
  const st = text.children.find((c) => c.match === "sourceText").value.v;
  assert.equal(st.text, "COUNT");
  assert.equal(st.font, "Anton");
  assert.equal(st.style, "Regular");
  assert.equal(st.tracking, 0);
  const tr = title.props.children.find((c) => c.match === "transform");
  const pos = tr.children.find((c) => c.match === "position");
  assert.ok(close(pos.value.v[0], 200));
  assert.ok(close(pos.value.v[1], 257.722));
  const pill = layers[1];
  const ptr = pill.props.children.find((c) => c.match === "transform");
  assert.deepEqual(ptr.children.find((c) => c.match === "position").value.v, [760, 210, 0]);
});

test("export report passes the insight validator", () => {
  const scene = sceneMin();
  const result = exportScene(scene, { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const report = buildExportReport(scene, result, "/tmp/scene-min.ecproj", null);
  assert.equal(report.verdict.status, "PASS");
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
});

test("shape layer anchor is [0, 0, 0], rect centred on position", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const bar = project.items[1].kind.layers[1];
  const tr = bar.props.children.find((c) => c.match === "transform");
  const byMatch = Object.fromEntries(tr.children.map((c) => [c.match, c]));
  assert.deepEqual(byMatch.anchor.value.v, [0, 0, 0]);
  assert.deepEqual(byMatch.position.value.v, [280, 720, 0]);
});

test("path vertices are relative to the box centre", () => {
  const p = pointsToShapePath([
    { id: "p0", anchor: [0, 0], in: null, out: null, command: "move" },
    { id: "p1", anchor: [200, 100], in: null, out: null, command: "line" },
  ], false, [100, 50]);
  assert.deepEqual(p.vertices, [[-100, -50], [100, 50]]);
});

test("exported keys carry spatial_auto false with zero tangents", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const bar = project.items[1].kind.layers[1];
  const pos = bar.props.children.find((c) => c.match === "transform")
    .children.find((c) => c.match === "position");
  assert.equal(pos.keys.length, 3);
  for (const k of pos.keys) {
    assert.equal(k.spatial_auto, false);
    assert.deepEqual(k.spatial_in, [0, 0, 0]);
    assert.deepEqual(k.spatial_out, [0, 0, 0]);
  }
});

test("global light is two Property structs, uid 0, like the demo file", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const gl = project.items[1].kind.global_light;
  assert.equal(gl.angle.uid, 0);
  assert.equal(gl.angle.match, "globalLightAngle");
  assert.equal(gl.angle.name, "Global Light Angle");
  assert.deepEqual(gl.angle.value, { t: "Scalar", v: 120 });
  assert.deepEqual(gl.angle.ui, { kind: "Angle" });
  assert.equal(gl.altitude.match, "globalLightAltitude");
  assert.deepEqual(gl.altitude.value, { t: "Scalar", v: 30 });
});

test("comp, layer, and footage ids never collide", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const compId = project.items[1].id;
  const layerIds = project.items[1].kind.layers.map((l) => l.id);
  assert.equal(compId, 1);
  assert.deepEqual(layerIds, [2, 3]);
  assert.equal(new Set([compId, ...layerIds]).size, 1 + layerIds.length);
});

test("material options copy the demo ui descriptors", () => {
  const { project } = exportScene(sceneMin(), { sceneDir: dirname(fileURLToPath(new URL("scene-min.json", FIXTURES))) });
  const bar = project.items[1].kind.layers[1];
  const mat = bar.props.children.find((c) => c.match === "materialOptions");
  const byMatch = Object.fromEntries(mat.children.map((c) => [c.match, c]));
  assert.deepEqual(byMatch.castsShadows.ui, { kind: "Popup", options: ["Off", "On", "Only"] });
  assert.deepEqual(byMatch.acceptsShadows.ui, { kind: "Popup", options: ["Off", "On", "Only"] });
  assert.deepEqual(byMatch.ambient.ui, { kind: "Percent" });
  assert.deepEqual(byMatch.lightTransmission.ui, { kind: "Percent" });
  assert.equal(byMatch.acceptsLights.hold_only, true);
});

test("CLI writes a .ecproj file and a losses file for scene-min", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-export-"));
  const out = join(dir, "scene-min.ecproj");
  const scenePath = fileURLToPath(new URL("scene-min.json", FIXTURES));
  const code = runExport([scenePath, "--to", "ecproj", "--out", out, "--report", join(dir, "report.json")]);
  assert.equal(code, 0);
  const project = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(project.items[1].kind.layers.length, 2);
  const losses = JSON.parse(readFileSync(`${out}.losses.json`, "utf8"));
  assert.deepEqual(losses.losses, []);
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  assert.equal(report.verdict.status, "PASS");
});

test("CLI rejects a bad format and a missing scene", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-export-"));
  const scenePath = fileURLToPath(new URL("scene-min.json", FIXTURES));
  assert.equal(runExport([scenePath, "--to", "aep", "--out", join(dir, "x.ecproj")]), 2);
  assert.equal(runExport([join(dir, "nope.json"), "--to", "ecproj", "--out", join(dir, "x.ecproj")]), 2);
  assert.equal(runExport([scenePath, "--to", "ecproj"]), 2);
});

// --- Video export: image-sequence footage ---------------------------------

test("isVideoPath accepts video extensions only", () => {
  assert.equal(isVideoPath("clip.mp4"), true);
  assert.equal(isVideoPath("clip.MOV"), true);
  assert.equal(isVideoPath("scene-min.json"), false);
  assert.equal(isVideoPath("frame_0000.png"), false);
});

test("parseVideoProbe reads 24 fps, 720 frames, 1440 by 1280", () => {
  const info = parseVideoProbe({
    streams: [{ codec_type: "video", codec_name: "h264", width: 1440, height: 1280, r_frame_rate: "24/1", avg_frame_rate: "24/1", nb_frames: "720", duration: "30.000000" }],
    format: { duration: "30.000000" },
  });
  assert.deepEqual(info, { width: 1440, height: 1280, fpsNum: 24, fpsDen: 1, frameCount: 720, durationS: 30 });
});

test("parseVideoProbe derives the frame count from duration when nb_frames is missing", () => {
  const info = parseVideoProbe({
    streams: [{ codec_type: "video", width: 640, height: 480, r_frame_rate: "30/1", duration: "2.000000" }],
    format: { duration: "2.000000" },
  });
  assert.equal(info.frameCount, 60);
  assert.equal(info.durationS, 2);
});

test("parseVideoProbe throws with no video stream", () => {
  assert.throws(() => parseVideoProbe({ streams: [{ codec_type: "audio" }], format: {} }), /no video stream/);
});

test("listSequenceFiles returns relative paths in order and rejects a gap", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-seq-"));
  const framesDir = join(dir, "frames");
  mkdirSync(framesDir);
  for (const n of [0, 1, 2]) writeFileSync(join(framesDir, `frame_${String(n).padStart(4, "0")}.png`), "");
  assert.deepEqual(listSequenceFiles(framesDir, 3), ["frames/frame_0000.png", "frames/frame_0001.png", "frames/frame_0002.png"]);
  writeFileSync(join(framesDir, "frame_0004.png"), "");
  assert.throws(() => listSequenceFiles(framesDir, 5), /missing frames 3/);
});

test("exportVideo writes a Sequence footage item at 24 fps for 720 frames", () => {
  const sequenceFiles = Array.from({ length: 720 }, (_, i) => `frames/frame_${String(i).padStart(4, "0")}.png`);
  const { project, stats } = exportVideo(
    { width: 1440, height: 1280, fpsNum: 24, fpsDen: 1, frameCount: 720, durationS: 30 },
    sequenceFiles,
    { stem: "side-by-side" },
  );
  assert.equal(project.schema, 1);
  assert.equal(project.savedBy, "0.3.1");
  assert.equal(project.activeComp, 2);
  assert.deepEqual(project.openComps, [2]);
  const footage = project.items[1].kind;
  assert.equal(footage.type, "Footage");
  assert.equal(footage.kind, "Sequence");
  assert.equal(footage.path, "frames/frame_0000.png");
  assert.equal(footage.sequence.length, 720);
  assert.equal(footage.sequence[0], "frames/frame_0000.png");
  assert.equal(footage.sequence[719], "frames/frame_0719.png");
  assert.deepEqual(footage.frame_rate, { num: 24, den: 1 });
  assert.equal(footage.duration, 7620480000000);
  assert.equal(footage.alpha, "Ignore");
  assert.equal(footage.codec, "PNG");
  assert.equal(footage.missing, false);
  assert.equal(footage.has_video, true);
  assert.equal(footage.has_audio, false);
  assert.equal(project.items[1].label, "Lavender");
  const comp = project.items[2].kind;
  assert.equal(comp.type, "Comp");
  assert.equal(comp.width, 1440);
  assert.equal(comp.height, 1280);
  assert.deepEqual(comp.frame_rate, { num: 24, den: 1 });
  assert.equal(comp.duration, 7620480000000);
  assert.equal(comp.layers.length, 1);
  const layer = comp.layers[0];
  assert.deepEqual(layer.source, { type: "Footage", item: 1 });
  assert.equal(layer.label, "Lavender");
  assert.equal(layer.out_point, 7620480000000);
  const tr = layer.props.children.find((c) => c.match === "transform");
  const byMatch = Object.fromEntries(tr.children.map((c) => [c.match, c]));
  assert.deepEqual(byMatch.anchor.value.v, [720, 640, 0]);
  assert.deepEqual(byMatch.position.value.v, [720, 640, 0]);
  assert.deepEqual(byMatch.scale.value.v, [100, 100, 100]);
  assert.equal(stats.frame_count, 720);
  assert.equal(stats.format, "PNG");
  assert.equal(stats.duration_s, 30);
});

test("exportVideo throws when the sequence is short", () => {
  assert.throws(() => exportVideo(
    { width: 64, height: 48, fpsNum: 24, fpsDen: 1, frameCount: 3, durationS: 0.125 },
    ["frames/frame_0000.png"],
    { stem: "tiny" },
  ), /expected 3/);
});

test("video export report passes the insight validator", () => {
  const sequenceFiles = ["frames/frame_0000.png", "frames/frame_0001.png", "frames/frame_0002.png"];
  const info = { video: "tiny", width: 64, height: 48, fpsNum: 24, fpsDen: 1, frameCount: 3, durationS: 0.125 };
  const result = exportVideo(info, sequenceFiles, { stem: "tiny" });
  const report = buildVideoExportReport(info, result, "/tmp/tiny.ecproj", "/tmp/frames", null);
  assert.equal(report.verdict.status, "PASS");
  assert.deepEqual(validateInsight(report), { valid: true, errors: [] });
  assert.equal(report.numbers.frame_count, 3);
});

test("CLI exports a 3-frame video to an image-sequence comp", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-export-video-"));
  const video = join(dir, "tiny.mp4");
  const gen = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=24:duration=0.125", "-c:v", "libx264", "-pix_fmt", "yuv420p", video], { encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stderr);
  const out = join(dir, "tiny.ecproj");
  const code = runExport([video, "--to", "ecproj", "--out", out, "--report", join(dir, "report.json")]);
  assert.equal(code, 0);
  const project = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(project.schema, 1);
  assert.equal(project.savedBy, "0.3.1");
  const footage = project.items[1].kind;
  assert.equal(footage.kind, "Sequence");
  assert.equal(footage.sequence.length, 3);
  assert.deepEqual(footage.frame_rate, { num: 24, den: 1 });
  assert.equal(footage.duration, 31752000000);
  const frames = readdirSync(join(dir, "frames")).sort();
  assert.deepEqual(frames, ["frame_0000.png", "frame_0001.png", "frame_0002.png"]);
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.numbers.frame_count, 3);
});
