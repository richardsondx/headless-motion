// U5 contour to node: the report names the nearest path node to the
// worst outline point, with the correction in scene terms, in px.
// Points nodes project through the sampled state; map vertices project
// through the map camera; the nearest node is measured to the
// ours-side worst point, the point on our outline that must move.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  mapCameraAtFrame,
  mapVertexCandidates,
  nearestNode,
  nodeCorrection,
  pointsNodeCandidates,
  projectMapVertices,
  screenDeltaToLonLat,
} from "../../src/cli/contour.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const POINTS_FIXTURE = join(ROOT, "tests", "fixtures", "path-points.json");
const V5 = join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json");
const REF_5S = join(ROOT, "verify-seg4", "evidence", "work", "real-5s.png");
const OURS_5S = join(ROOT, "verify-seg4", "evidence", "work", "v5-5s.png");

const run = (args) => spawnSync("node", [HME, ...args], { encoding: "utf8" });
const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hme-contour-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const loadGeo = () => loadJson(join(ROOT, "assets", "natural-earth", "ne_10m_admin_0_countries.geojson"));
const loadTokens = () => loadJson(join(ROOT, "src", "map", "tokens.json"));

test("points nodes project to frame px through the box at frame 0", () => {
  const scene = loadJson(POINTS_FIXTURE);
  const c = pointsNodeCandidates(scene, 0);
  const at = (id) => c.find((x) => x.node_id === id);
  assert.deepEqual([at("outline:p1").x, at("outline:p1").y], [160, 600]);
  assert.deepEqual([at("outline:p2").x, at("outline:p2").y], [360, 600]);
  assert.deepEqual([at("outline:p3").x, at("outline:p3").y], [360, 750]);
  assert.deepEqual([at("outline:p4").x, at("outline:p4").y], [160, 750]);
  assert.equal(c.filter((x) => x.node === "both").length, 3);
  assert.ok(c.every((x) => x.kind === "points-node"));
});

test("points nodes follow the morph: p2 sits mid-way at frame 12", () => {
  const scene = loadJson(POINTS_FIXTURE);
  const c = pointsNodeCandidates(scene, 12);
  const p2 = c.find((x) => x.node_id === "outline:p2");
  assert.deepEqual([p2.x, p2.y], [372, 600]);
});

test("the v5 proof scene holds no points node", () => {
  const scene = loadJson(V5);
  assert.deepEqual(pointsNodeCandidates(scene, 120), []);
});

test("map camera at frame 120 is the s5 knot, focus subject Sudan", () => {
  const scene = loadJson(V5);
  const mapNode = scene.nodes.find((n) => n.id === "map");
  const { camera, focus_subject } = mapCameraAtFrame(
    mapNode.props, 120, scene.meta.fps, scene.events, loadTokens(), loadGeo().features);
  assert.deepEqual(camera.center, [29.73, 15.18]);
  assert.equal(camera.zoom, 2.231);
  assert.equal(focus_subject, "SDN");
});

test("map vertices project through the camera; a ring closing vertex is skipped", () => {
  const feature = {
    properties: { ISO_A3: "TST", NAME: "Testland" },
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    },
  };
  const camera = { center: [0, 0], zoom: 0, bearing: 0, pitch: 0 };
  const c = projectMapVertices(feature, camera, 1920, 1080);
  assert.equal(c.length, 3);
  assert.deepEqual([c[0].x, c[0].y], [960, 540]);
  assert.deepEqual([c[1].x, c[1].y], [967.5, 540]);
  assert.deepEqual([c[2].x, c[2].y], [967.5, 532.5]);
  assert.equal(c[0].node_id, "map:TST:vertex-0");
  assert.equal(c[2].node_id, "map:TST:vertex-2");
});

test("map vertex candidates for v5 at frame 120 cover the Sudan outline", () => {
  const scene = loadJson(V5);
  const { candidates, notes } = mapVertexCandidates(scene, 120, loadTokens(), loadGeo().features);
  assert.deepEqual(notes, []);
  assert.equal(candidates.length, 1176);
  assert.ok(candidates.every((x) => x.kind === "map-vertex" && x.country_iso === "SDN"));
});

test("nearest node picks the closest candidate, ties go to the first", () => {
  const cands = [
    { node_id: "a", x: 0, y: 0 },
    { node_id: "b", x: 10, y: 0 },
    { node_id: "c", x: 0, y: 10 },
  ];
  assert.equal(nearestNode(cands, 9, 1).candidate.node_id, "b");
  assert.equal(nearestNode(cands, 5, 0).candidate.node_id, "a");
  assert.equal(nearestNode([], 0, 0), null);
});

test("screen px delta converts to lon/lat through the projection", () => {
  const camera = { center: [0, 0], zoom: 0, bearing: 0, pitch: 0 };
  assert.deepEqual(screenDeltaToLonLat(camera, 0, 0, 7.5, 7.5), [1, -1]);
  assert.deepEqual(screenDeltaToLonLat(camera, 0, 0, 0, 0), [0, 0]);
});

test("points-node correction is ref minus ours, with the exact hme path command", () => {
  const nearest = {
    candidate: { node_id: "outline:p2", kind: "points-node", node: "outline", point: "p2", x: 360, y: 600 },
    distance_px: 5,
  };
  const worst = { ref_xy: [715, 734.5], ours_xy: [722, 668.5] };
  const corr = nodeCorrection(nearest, worst, "tests/fixtures/path-points.json", null);
  assert.equal(corr.correction_dx_px, -7);
  assert.equal(corr.correction_dy_px, 66);
  assert.equal(corr.applies_with_hme_path, true);
  assert.equal(corr.apply_command,
    "hme path move --scene tests/fixtures/path-points.json --node outline --point p2 --dx -7 --dy 66 --out tests/fixtures/path-points-node-fix.json");
  assert.match(corr.sentence, /Move node outline:p2 by \(-7, 66\) px/);
});

test("map-vertex correction states plainly that hme path cannot move it", () => {
  const nearest = {
    candidate: {
      node_id: "map:SDN:vertex-14", kind: "map-vertex", country_iso: "SDN",
      country_name: "Sudan", vertex_index: 14, polygon_index: 0, ring_index: 0,
      position_in_ring: 14, lon_lat: [22.900442, 11.408245], x: 719.5, y: 672.8,
    },
    distance_px: 5,
  };
  const worst = { ref_xy: [715, 734.5], ours_xy: [722, 668.5] };
  const camera = { center: [29.73, 15.18], zoom: 2.231, bearing: 0, pitch: 0 };
  const corr = nodeCorrection(nearest, worst, "tests/fixtures/seg4-scene-clone-v5.json", camera);
  assert.equal(corr.correction_dx_px, -7);
  assert.equal(corr.correction_dy_px, 66);
  assert.equal(corr.applies_with_hme_path, false);
  assert.equal(corr.apply_command, null);
  assert.deepEqual(corr.lon_lat_delta, [-0.199, -1.874]);
  assert.match(corr.sentence, /hme path cannot move it/);
});

test("contour at 5 s with --scene names map:SDN:vertex-14 and the px correction", (t) => {
  const dir = tmp(t);
  const out = join(dir, "contour-5s.json");
  const r = run(["contour", REF_5S, OURS_5S, "--at-s", "5", "--scene", V5, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(out), "report was not written");
  const report = loadJson(out);
  assert.equal(report.hausdorff_px, 66.37);
  assert.deepEqual(report.worst_point.ref_xy, [715, 734.5]);
  assert.deepEqual(report.worst_point.ours_xy, [722, 668.5]);
  const n = report.nearest_node;
  assert.equal(n.node_id, "map:SDN:vertex-14");
  assert.equal(n.kind, "map-vertex");
  assert.deepEqual(n.screen_xy, [719.5, 672.8]);
  assert.equal(n.distance_to_worst_px, 5);
  assert.equal(n.correction_dx_px, -7);
  assert.equal(n.correction_dy_px, 66);
  assert.deepEqual(n.lon_lat_delta, [-0.199, -1.874]);
  assert.equal(n.applies_with_hme_path, false);
  assert.equal(n.apply_command, null);
  assert.equal(report.nearest_node_reason, null);
  assert.match(report.correction, /Move node map:SDN:vertex-14 by \(-7, 66\) px/);
});

test("contour without --scene reports nearest_node null with a reason", (t) => {
  const dir = tmp(t);
  const out = join(dir, "contour-5s-noscene.json");
  const r = run(["contour", REF_5S, OURS_5S, "--at-s", "5", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const report = loadJson(out);
  assert.equal(report.nearest_node, null);
  assert.match(report.nearest_node_reason, /no --scene given/);
});

test("contour with a missing scene file fails fast with exit 2", () => {
  const r = run(["contour", REF_5S, OURS_5S, "--at-s", "5", "--scene", "tests/fixtures/no-such-scene.json"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no such file/);
});
