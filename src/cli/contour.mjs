// hme contour: measure one Sudan outline against a reference outline.
//
// One command, one frame pair, one JSON report. The tool measures, it
// does not judge: there is no pass or fail bar here. The headline is
// Hausdorff on full contour point sets, Chamfer is second with its
// containment caveat in plain words, and an aligned Hausdorff (centroid
// plus uniform scale) separates shape from camera.
//
// Method, from the first principles ladder (tested, not re-derived):
// - Segment each frame by its own measured Sudan median, tolerance 15,
//   largest component, hole fill. The shared palette centre misses 39
//   percent of ours Sudan, so it is not used.
// - Mask the RSF badge out (RSF mask, tol 12, dilated about 5 px) from
//   both Sudan masks before contouring. Badge-masked numbers are the
//   shape numbers. Unmasked numbers are a second line.
// - Full-res only, stride 1. Stride-2 sampling shifts Hausdorff by up
//   to 9 px, so it is not used.
// - Neighbours are directional presence plus colour in strips outside
//   the Sudan bbox, not bboxes from base-mask components: the ref base
//   mask is one whole-frame blob, so no per-country bbox exists.
//
// Node spawns the engine venv Python with a small driver on stdin,
// the same pattern compare.mjs and colour.mjs use. The driver prints
// exactly one JSON object to stdout. Progress goes to stderr.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleScene } from "../scene/evaluate.mjs";
import { loadScene, validateScene } from "../scene/validate.mjs";
import { computeMapState } from "../map/compile.mjs";
import { projectPoint } from "../map/project.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = resolve(REPO_ROOT, "src");
const VENV_PYTHON = resolve(REPO_ROOT, ".venv", "bin", "python");
const GEOJSON_PATH = resolve(REPO_ROOT, "assets", "natural-earth", "ne_10m_admin_0_countries.geojson");
const TOKENS_PATH = resolve(REPO_ROOT, "src", "map", "tokens.json");

export const FPS = 24;
export const STRIDE = 1;

export const CHAMFER_CAVEAT =
  "This Chamfer measures distance to the other mask area, not to its outline, so it reads near zero whenever one mask contains the other.";

export const USAGE = [
  "hme contour: Measure a Sudan outline against a reference outline on one frame pair.",
  "",
  "Usage: hme contour <ref-frame.png> <ours-frame.png> [--at-s <n>] [--scene <scene.json>] [--out <report.json>]",
  "",
  "Arguments:",
  "  <ref-frame.png>  One frame from the reference video.",
  "  <ours-frame.png>  The same frame from our video.",
  "",
  "Options:",
  "  --at-s <n>  Time in seconds of the frame. When absent, it is derived from the ref frame number at 24 fps (ref-0168.png means 7 s).",
  "  --scene <file>  Scene file for the ours side. Names the nearest path node to the worst outline point in the report (nearest_node), with the correction in px. Without it, nearest_node is null.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "The headline is Hausdorff on full contour point sets (no 400 point cap), badge-masked, at full resolution (stride 1). Chamfer is reported second, with its containment caveat. Aligned Hausdorff scales and centres the ours contour onto the ref contour first, so shape separates from camera. Neighbours are presence rows by direction (north, west, east), not bboxes.",
  "With --scene, the report also names the nearest node to the worst outline point on our side: a points-list node (kind points-node, movable with hme path move) or a Natural Earth map vertex of the focus country (kind map-vertex, which lives in map geometry, not in a points list, so hme path cannot move it). The correction is the outline delta at the worst spot, ref minus ours, in frame px.",
  "",
  "Exit codes: 0 measured (including Sudan absent), 2 usage or run error.",
].join("\n") + "\n";

function roundTo(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

// Seconds from a frame file name. Frame numbers map at 24 fps:
// ref-0168.png means 7 s. A name like real-7s.png also works.
export function parseAtS(filePath) {
  const base = basename(filePath);
  const byFrame = base.match(/-(\d+)\.png$/);
  if (byFrame) return roundTo(Number(byFrame[1]) / FPS, 3);
  const bySeconds = base.match(/(\d+(?:\.\d+)?)s\./);
  if (bySeconds) return Number(bySeconds[1]);
  return null;
}

// --- contour to node (U5) ---
//
// The worst outline point is a frame pixel. An agent cannot fix a
// pixel. It fixes a node. These functions map the worst point to the
// nearest editable node in the scene, in frame px, and state the
// correction as a node id plus a px delta.
//
// Two node kinds exist in a scene:
// - points-node: a shape node with a points list (U1 format). The
//   anchor projects to frame px through the sampled state at the
//   frame: box plus transform offset, scale and rotation about the
//   element centre, the same model the ledger uses for a node box.
//   This node moves with `hme path move`.
// - map-vertex: a vertex of a Natural Earth country polygon, drawn by
//   the map module through its own projection at the frame camera.
//   The Sudan outline in the proof scene is map geometry, not a
//   points list, so its nearest node is a map vertex. A map vertex
//   has no point id and `hme path` cannot move it. The report says
//   so plainly instead of printing a command that would fail.
//
// The nearest node is measured to the ours-side worst point
// (worst.ours_xy), the point on our outline that must move. The
// nearest node to the ref-side point can sit on a different stretch
// of the border: at 5 s the ref point is 29.7 px from a southern
// border vertex, while the ours point is 5.0 px from the vertex that
// forms the outline at the worst spot. The correction delta is ref
// minus ours at the worst spot.
//
// Vertex order is fixed: polygons in GeoJSON order, rings in order,
// vertices in ring order, one running index per feature. A ring's
// closing vertex repeats its first vertex, so it is skipped: it is
// the same point, not a second node.

const r1 = (v) => Math.round(v * 10) / 10;

// Screen xy of one points-list anchor at one frame. Pure function.
// box and transform come from the sampled state of the node.
export function pointsAnchorScreenXY(state, anchor) {
  const w = state["box.w"];
  const h = state["box.h"];
  const tx = state["transform.x"] || 0;
  const ty = state["transform.y"] || 0;
  const scaleX = state["transform.scaleX"] ?? state["transform.scale"] ?? 1;
  const scaleY = state["transform.scaleY"] ?? state["transform.scale"] ?? 1;
  const rot = state["transform.rotation"] || 0;
  const cx = (state["box.x"] || 0) + tx + w / 2;
  const cy = (state["box.y"] || 0) + ty + h / 2;
  const sx = (anchor[0] - w / 2) * scaleX;
  const sy = (anchor[1] - h / 2) * scaleY;
  const rad = (rot * Math.PI) / 180;
  const rx = sx * Math.cos(rad) - sy * Math.sin(rad);
  const ry = sx * Math.sin(rad) + sy * Math.cos(rad);
  return [r1(cx + rx), r1(cy + ry)];
}

function isPointsList(v) {
  return Array.isArray(v) && v.length > 0 && v.every((p) => p && Array.isArray(p.anchor)
    && p.anchor.length === 2 && p.anchor.every(Number.isFinite) && typeof p.id === "string");
}

// One candidate per points-list anchor of every visible shape node
// at the frame. Pure function of scene plus frame. Invisible nodes
// are skipped: they draw no outline at this frame.
export function pointsNodeCandidates(scene, frame) {
  const state = sampleScene(scene, frame);
  const out = [];
  for (const node of scene.nodes) {
    if (node.type !== "shape") continue;
    const s = state[node.id];
    if (!s || !s.visible) continue;
    const points = s["props.points"];
    if (!isPointsList(points)) continue;
    for (const p of points) {
      const [x, y] = pointsAnchorScreenXY(s, p.anchor);
      out.push({
        node_id: `${node.id}:${p.id}`,
        kind: "points-node",
        node: node.id,
        point: p.id,
        x,
        y,
      });
    }
  }
  return out;
}

// Camera plus focus subject of a map node at a frame, through the
// same computeMapState the renderer uses. Pure function of its
// arguments. Returns {camera, focus_subject}.
export function mapCameraAtFrame(mapProps, frame, fps, events, tokens, geoFeatures) {
  const state = computeMapState(mapProps, frame, fps, tokens, geoFeatures, events || []);
  return { camera: state.camera, focus_subject: state.focus ? state.focus.subject : null };
}

// One candidate per vertex of one GeoJSON feature, projected to
// screen px at the frame camera. Pure function. The closing vertex
// of each ring is skipped (see the note above).
export function projectMapVertices(feature, camera, width, height) {
  const iso = feature.properties ? feature.properties.ISO_A3 : null;
  const name = feature.properties ? (feature.properties.NAME || iso) : iso;
  const geom = feature.geometry || {};
  const polys = geom.type === "Polygon" ? [geom.coordinates]
    : geom.type === "MultiPolygon" ? geom.coordinates : [];
  const out = [];
  let n = 0;
  polys.forEach((poly, polyIndex) => {
    poly.forEach((ring, ringIndex) => {
      const verts = ring.length > 1
        && ring[0][0] === ring[ring.length - 1][0]
        && ring[0][1] === ring[ring.length - 1][1]
        ? ring.slice(0, -1) : ring;
      verts.forEach((v, posInRing) => {
        const [x, y] = projectPoint(v[0], v[1], camera, width, height);
        out.push({
          node_id: `map:${iso}:vertex-${n}`,
          kind: "map-vertex",
          country_iso: iso,
          country_name: name,
          vertex_index: n,
          polygon_index: polyIndex,
          ring_index: ringIndex,
          position_in_ring: posInRing,
          lon_lat: [v[0], v[1]],
          x: r1(x),
          y: r1(y),
        });
        n++;
      });
    });
  });
  return out;
}

// Map-vertex candidates for a scene at a frame. Pure function of
// scene plus frame plus tokens plus GeoJSON features. The focus
// subject country is used when the map has a focus; otherwise every
// included country is used. Returns {candidates, notes}.
export function mapVertexCandidates(scene, frame, tokens, geoFeatures) {
  const notes = [];
  const mapNode = (scene.nodes || []).find((n) => n.type === "map");
  if (!mapNode) return { candidates: [], notes: ["scene has no map node"] };
  const fps = scene.meta.fps;
  const width = scene.meta.width;
  const height = scene.meta.height;
  const { camera, focus_subject } = mapCameraAtFrame(
    mapNode.props, frame, fps, scene.events || [], tokens, geoFeatures);
  const include = (mapNode.props.geometry && mapNode.props.geometry.include) || [];
  const isos = focus_subject ? [focus_subject] : include;
  if (isos.length === 0) {
    return { candidates: [], notes: ["map node names no country: no focus subject and an empty include list"] };
  }
  const candidates = [];
  for (const iso of isos) {
    const feature = (geoFeatures || []).find((f) => f.properties && f.properties.ISO_A3 === iso);
    if (!feature) {
      notes.push(`no GeoJSON feature for country ${iso}`);
      continue;
    }
    candidates.push(...projectMapVertices(feature, camera, width, height));
  }
  return { candidates, notes };
}

// Nearest candidate to a target point, by screen distance. Pure
// function. Ties go to the first candidate in order, so the result
// is deterministic. Returns {candidate, distance_px} or null.
export function nearestNode(candidates, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (!best) return null;
  return { candidate: best, distance_px: r1(bestD) };
}

// A screen px delta as a lon/lat delta, by probing the affine
// projection at the vertex. Pure function. Returns null when the
// projection is singular at that point.
export function screenDeltaToLonLat(camera, lng, lat, dx, dy) {
  const p00 = projectPoint(lng, lat, camera);
  const p10 = projectPoint(lng + 1, lat, camera);
  const p01 = projectPoint(lng, lat + 1, camera);
  const a = p10[0] - p00[0];
  const b = p01[0] - p00[0];
  const c = p10[1] - p00[1];
  const d = p01[1] - p00[1];
  const det = a * d - b * c;
  if (!isFinite(det) || Math.abs(det) < 1e-9) return null;
  const dlng = (dx * d - dy * b) / det;
  const dlat = (a * dy - c * dx) / det;
  if (![dlng, dlat].every(Number.isFinite)) return null;
  const norm = (v) => Math.round(v * 1000) / 1000 + 0;
  return [norm(dlng), norm(dlat)];
}

// The correction for the nearest node, from the worst point. The
// delta is the outline delta at the worst spot, ref minus ours, in
// frame px: moving the node by this vector shifts the outline near
// the node toward the reference outline. Pure function. For a
// points node it also gives the exact `hme path move` command. For
// a map vertex it gives the lon/lat delta and states plainly that
// `hme path` cannot move map geometry.
export function nodeCorrection(nearest, worst, sceneArg, camera) {
  const c = nearest.candidate;
  const dx = r1(worst.ref_xy[0] - worst.ours_xy[0]);
  const dy = r1(worst.ref_xy[1] - worst.ours_xy[1]);
  const base = {
    node_id: c.node_id,
    kind: c.kind,
    screen_xy: [c.x, c.y],
    distance_to_worst_px: nearest.distance_px,
    correction_dx_px: dx,
    correction_dy_px: dy,
  };
  if (c.kind === "points-node") {
    const outArg = sceneArg.endsWith(".json")
      ? sceneArg.slice(0, -".json".length) + "-node-fix.json"
      : sceneArg + "-node-fix.json";
    const command = `hme path move --scene ${sceneArg} --node ${c.node} --point ${c.point} --dx ${dx} --dy ${dy} --out ${outArg}`;
    return {
      ...base,
      node: c.node,
      point: c.point,
      applies_with_hme_path: true,
      apply_command: command,
      lon_lat_delta: null,
      sentence: `Nearest node ${c.node_id} sits at (${c.x}, ${c.y}) px, ${nearest.distance_px} px from the worst point. Move node ${c.node_id} by (${dx}, ${dy}) px: ${command}.`,
    };
  }
  const delta = camera ? screenDeltaToLonLat(camera, c.lon_lat[0], c.lon_lat[1], dx, dy) : null;
  const deltaText = delta ? ` (about ${delta[0]} degrees lon, ${delta[1]} degrees lat)` : "";
  return {
    ...base,
    country_iso: c.country_iso,
    country_name: c.country_name,
    vertex_index: c.vertex_index,
    polygon_index: c.polygon_index,
    ring_index: c.ring_index,
    position_in_ring: c.position_in_ring,
    lon_lat: c.lon_lat,
    lon_lat_delta: delta,
    applies_with_hme_path: false,
    apply_command: null,
    sentence: `Nearest node ${c.node_id} sits at (${c.x}, ${c.y}) px, ${nearest.distance_px} px from the worst point. Move node ${c.node_id} by (${dx}, ${dy}) px in frame px${deltaText}. This vertex lives in Natural Earth map geometry, not in a points list, so hme path cannot move it. The outline must first exist as a points shape for hme path move to apply.`,
  };
}

// The Python driver. It loads the two PNGs, imports checker.dimensions
// and checker.layout, computes, and prints exactly one JSON object to
// stdout. Progress goes to stderr.
const DRIVER = `
import json
import math
import sys
sys.path.insert(0, sys.argv[3])
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree
from skimage import measure as _measure
from checker import dimensions, layout

REF, OURS = sys.argv[1], sys.argv[2]

def load(p):
    return np.array(Image.open(p).convert("RGB"))

def hex_of(rgb):
    r, g, b = (int(round(v)) for v in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"

def round2(v):
    return None if v is None else round(float(v), 2)

def segment(frame):
    # (1) Seed mask from the shared palette centre.
    m0 = layout.rgb_mask(frame, layout.PALETTE["sudan"], 15)
    if not m0.any():
        return None
    # (2) Centre is this frame's own measured median.
    centre = np.median(frame[m0].astype(np.float64), axis=0)
    centre = np.round(centre).astype(int)
    # (3) Re-mask around the measured centre.
    m1 = layout.rgb_mask(frame, tuple(int(v) for v in centre), 15)
    # (4) Keep the largest connected component.
    lab = _measure.label(m1, connectivity=1)
    if lab.max() == 0:
        return None
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    k = int(np.argmax(counts))
    comp = lab == k
    # (5) Fill holes.
    filled = ndimage.binary_fill_holes(comp)
    ys, xs = np.where(filled)
    return {"centre_hex": hex_of(centre),
            "centre_rgb": [int(v) for v in centre],
            "mask": filled,
            "px": int(filled.sum()),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "centroid": [round(float(xs.mean()), 1), round(float(ys.mean()), 1)]}

def badge_mask(frame):
    m = layout.rgb_mask(frame, layout.PALETTE["rsf"], layout.TOL["rsf"])
    return ndimage.binary_dilation(m, iterations=5)

def contour_pts(mask):
    cs = _measure.find_contours(mask.astype(np.float64), 0.5)
    if not cs:
        return np.zeros((0, 2), dtype=np.float64)
    c = max(cs, key=len)
    # find_contours returns (row, col); report points as (x, y).
    return np.column_stack([c[:, 1], c[:, 0]]).astype(np.float64)

def hausdorff_and_worst(pa, pb):
    tree_a = cKDTree(pa)
    tree_b = cKDTree(pb)
    d_ab, idx_ab = tree_b.query(pa, k=1)
    d_ba, idx_ba = tree_a.query(pb, k=1)
    i = int(np.argmax(d_ab))
    j = int(np.argmax(d_ba))
    if d_ab[i] >= d_ba[j]:
        return (round2(float(d_ab[i])),
                {"side": "ref",
                 "ref_xy": [round2(float(pa[i][0])), round2(float(pa[i][1]))],
                 "ours_xy": [round2(float(pb[idx_ab[i]][0])), round2(float(pb[idx_ab[i]][1]))],
                 "distance_px": round2(float(d_ab[i]))})
    return (round2(float(d_ba[j])),
            {"side": "ours",
             "ref_xy": [round2(float(pa[idx_ba[j]][0])), round2(float(pa[idx_ba[j]][1]))],
             "ours_xy": [round2(float(pb[j][0])), round2(float(pb[j][1]))],
             "distance_px": round2(float(d_ba[j]))})

def sector(x, y, cx, cy):
    # Compass sector from the Sudan centroid. Y grows downwards,
    # so north is negative dy. Angle 0 is east, 90 is north.
    ang = math.degrees(math.atan2(-(y - cy), x - cx))
    if -22.5 <= ang < 22.5:
        return "east"
    if 22.5 <= ang < 67.5:
        return "north-east"
    if 67.5 <= ang < 112.5:
        return "north"
    if 112.5 <= ang < 157.5:
        return "north-west"
    if ang >= 157.5 or ang < -157.5:
        return "west"
    if -157.5 <= ang < -112.5:
        return "south-west"
    if -112.5 <= ang < -67.5:
        return "south"
    return "south-east"

def neighbour_side(frame, bbox):
    h, w = frame.shape[:2]
    x0b, y0b, x1b, y1b = bbox
    strips = {
        "north": (max(0, x0b), max(0, y0b - 80), min(w, x1b), max(0, y0b - 20)),
        "west": (max(0, x0b - 80), max(0, y0b), max(0, x0b - 20), min(h, y1b)),
        "east": (min(w, x1b + 20), max(0, y0b), min(w, x1b + 80), min(h, y1b)),
    }
    out = {}
    for direction, (sx0, sy0, sx1, sy1) in strips.items():
        if sx1 <= sx0 or sy1 <= sy0:
            out[direction] = {"present": False, "share": 0.0, "median_hex": None}
            continue
        strip = frame[sy0:sy1, sx0:sx1]
        m = layout.rgb_mask(strip, layout.PALETTE["base"], 15)
        share = round(float(np.mean(m)), 4)
        med = np.median(strip.reshape(-1, 3).astype(np.float64), axis=0)
        out[direction] = {"present": bool(share >= 0.5), "share": share,
                          "median_hex": hex_of(med)}
    return out

def near_badge_or_title(frame, point):
    # Near means within 30 px of the RSF badge mask or of bright text
    # (luma >= 200 above the caption cut, or the October title grey).
    badge = layout.rgb_mask(frame, layout.PALETTE["rsf"], layout.TOL["rsf"])
    luma = dimensions.luma_of(frame)
    text = luma >= 200
    text[950:, :] = False
    title = layout.rgb_mask(frame, layout.PALETTE["october"], layout.TOL["october"])
    x, y = int(round(point[0])), int(round(point[1]))
    x = min(max(x, 0), frame.shape[1] - 1)
    y = min(max(y, 0), frame.shape[0] - 1)
    d_badge = float(ndimage.distance_transform_edt(~badge)[y, x]) if badge.any() else 1e9
    d_text = float(ndimage.distance_transform_edt(~text)[y, x]) if text.any() else 1e9
    d_title = float(ndimage.distance_transform_edt(~title)[y, x]) if title.any() else 1e9
    d = min(d_badge, d_text, d_title)
    if d > 30:
        return False, None
    if d_badge <= d_text and d_badge <= d_title:
        return True, "near the RSF badge"
    if d_title <= d_text:
        return True, "near the title text"
    return True, "near bright text"

ref = load(REF)
ours = load(OURS)
if ref.shape != ours.shape:
    raise RuntimeError(f"frames differ in size: ref {ref.shape}, ours {ours.shape}")

ref_seg = segment(ref)
ours_seg = segment(ours)
present = {"ref": ref_seg is not None, "ours": ours_seg is not None}
if not present["ref"] or not present["ours"]:
    print(json.dumps({
        "sudan_present": present,
        "segmentation": {
            "ref_centre": ref_seg["centre_hex"] if ref_seg else None,
            "ours_centre": ours_seg["centre_hex"] if ours_seg else None,
            "ref_px": ref_seg["px"] if ref_seg else None,
            "ours_px": ours_seg["px"] if ours_seg else None,
            "ref_bbox": ref_seg["bbox"] if ref_seg else None,
            "ours_bbox": ours_seg["bbox"] if ours_seg else None,
            "ref_centroid": ref_seg["centroid"] if ref_seg else None,
            "ours_centroid": ours_seg["centroid"] if ours_seg else None},
        "hausdorff_px": None, "chamfer_a_to_b_px": None,
        "chamfer_b_to_a_px": None, "chamfer_mean_px": None,
        "aligned_hausdorff_px": None, "aligned_scale": None,
        "unmasked": {"hausdorff_px": None, "chamfer_mean_px": None},
        "worst_point": None, "neighbours": [],
    }))
    sys.exit(0)

# Badge masks, dilated about 5 px, subtracted from both Sudan masks.
ref_badge = badge_mask(ref)
ours_badge = badge_mask(ours)
ref_mask = ref_seg["mask"] & ~ref_badge
ours_mask = ours_seg["mask"] & ~ours_badge
for name, mask in (("ref", ref_mask), ("ours", ours_mask)):
    if not mask.any():
        raise RuntimeError(f"badge masking removed all of Sudan in {name}")

def shape_of(mask):
    ys, xs = np.where(mask)
    return {"px": int(mask.sum()),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "centroid": [round(float(xs.mean()), 1), round(float(ys.mean()), 1)]}

ref_shape = shape_of(ref_mask)
ours_shape = shape_of(ours_mask)

# Headline: Hausdorff on FULL contour point sets, badge-masked.
ref_pts = contour_pts(ref_mask)
ours_pts = contour_pts(ours_mask)
haus, worst = hausdorff_and_worst(ref_pts, ours_pts)

# Chamfer second, reused from dimensions (mask-area distance).
ch = dimensions.chamfer_hausdorff(ref_mask, ours_mask)

# Aligned Hausdorff: uniform scale about the ours centroid, then
# translate so the centroids coincide.
s = math.sqrt(ref_shape["px"] / ours_shape["px"])
ours_centroid = np.array(ours_shape["centroid"], dtype=np.float64)
ref_centroid = np.array(ref_shape["centroid"], dtype=np.float64)
ours_aligned = (ours_pts - ours_centroid) * s + ref_centroid
aligned_haus, _ = hausdorff_and_worst(ref_pts, ours_aligned)

# Unmasked second line: same measures without the badge mask.
ref_pts_u = contour_pts(ref_seg["mask"])
ours_pts_u = contour_pts(ours_seg["mask"])
haus_u, _ = hausdorff_and_worst(ref_pts_u, ours_pts_u)
ch_u = dimensions.chamfer_hausdorff(ref_seg["mask"], ours_seg["mask"])

# Worst point: sector from its own side's Sudan centroid, and a note
# when it sits near the badge or the title text.
if worst["side"] == "ref":
    point = worst["ref_xy"]
    centroid = ref_shape["centroid"]
    near, note = near_badge_or_title(ref, point)
else:
    point = worst["ours_xy"]
    centroid = ours_shape["centroid"]
    near, note = near_badge_or_title(ours, point)
worst["sector"] = sector(point[0], point[1], centroid[0], centroid[1])
worst["near_badge_or_title"] = bool(near)
worst["near_badge_or_title_note"] = note

neighbours = []
ref_nb = neighbour_side(ref, ref_shape["bbox"])
ours_nb = neighbour_side(ours, ours_shape["bbox"])
for direction in ("north", "west", "east"):
    neighbours.append({"direction": direction,
                       "present_ref": ref_nb[direction]["present"],
                       "present_ours": ours_nb[direction]["present"],
                       "share_ref": ref_nb[direction]["share"],
                       "share_ours": ours_nb[direction]["share"],
                       "median_hex_ref": ref_nb[direction]["median_hex"],
                       "median_hex_ours": ours_nb[direction]["median_hex"]})

print(json.dumps({
    "sudan_present": present,
    "segmentation": {
        "ref_centre": ref_seg["centre_hex"],
        "ours_centre": ours_seg["centre_hex"],
        "ref_px": ref_shape["px"],
        "ours_px": ours_shape["px"],
        "ref_bbox": ref_shape["bbox"],
        "ours_bbox": ours_shape["bbox"],
        "ref_centroid": ref_shape["centroid"],
        "ours_centroid": ours_shape["centroid"],
        "ref_px_before_badge_mask": ref_seg["px"],
        "ours_px_before_badge_mask": ours_seg["px"]},
    "hausdorff_px": haus,
    "chamfer_a_to_b_px": ch["chamfer_a_to_b_px"],
    "chamfer_b_to_a_px": ch["chamfer_b_to_a_px"],
    "chamfer_mean_px": ch["chamfer_mean_px"],
    "aligned_hausdorff_px": aligned_haus,
    "aligned_scale": round2(s),
    "unmasked": {"hausdorff_px": haus_u, "chamfer_mean_px": ch_u["chamfer_mean_px"]},
    "worst_point": worst,
    "neighbours": neighbours,
}))
`;

function runDriver(refPath, oursPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", refPath, oursPath, SRC_DIR], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", (err) => rejectPromise(new Error(`could not start ${VENV_PYTHON}: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        rejectPromise(new Error(`contour measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`contour measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

function buildReport(measured, { ref, ours, atS }) {
  const seg = measured.segmentation;
  const absent = !measured.sudan_present.ref || !measured.sudan_present.ours;
  const missingSide = !measured.sudan_present.ref
    ? "the reference frame"
    : !measured.sudan_present.ours
      ? "our frame"
      : "both frames";
  if (absent) {
    return {
      second: atS,
      ref_frame: ref,
      ours_frame: ours,
      stride: STRIDE,
      sudan_present: measured.sudan_present,
      segmentation: seg,
      hausdorff_px: null,
      chamfer_a_to_b_px: null,
      chamfer_b_to_a_px: null,
      chamfer_mean_px: null,
      chamfer_caveat: CHAMFER_CAVEAT,
      aligned_hausdorff_px: null,
      aligned_scale: null,
      unmasked: measured.unmasked,
      worst_point: null,
      neighbours: [],
      nearest_node: null,
      nearest_node_reason: "Sudan is absent, so there is no worst outline point to map to a node.",
      cause: `Sudan is absent in ${missingSide}, so there is no outline to measure.`,
      correction: "No outline correction is possible until Sudan is visible in both frames at this second.",
      summary: `Sudan is absent in ${missingSide} at ${atS} s. No contour numbers are reported.`,
    };
  }

  const w = measured.worst_point;
  const refW = seg.ref_bbox[2] - seg.ref_bbox[0];
  const refH = seg.ref_bbox[3] - seg.ref_bbox[1];
  const oursW = seg.ours_bbox[2] - seg.ours_bbox[0];
  const oursH = seg.ours_bbox[3] - seg.ours_bbox[1];
  const raw = measured.hausdorff_px;
  const aligned = measured.aligned_hausdorff_px;
  const s = measured.aligned_scale;

  // Cause in plain words: shape, camera scale, badge bite, or a mix.
  const shapeMatches = aligned <= 10 && aligned < 0.5 * raw;
  const shapeWrong = aligned > 10 && aligned > 0.5 * raw;
  let cause;
  if (shapeMatches) {
    cause = `The shape matches after alignment (aligned Hausdorff ${aligned} px against raw Hausdorff ${raw} px), so the gap is camera scale, not the border: ours Sudan is ${oursW} by ${oursH} px against ref ${refW} by ${refH} px.`;
  } else if (shapeWrong) {
    cause = `The shape itself differs: aligned Hausdorff stays at ${aligned} px against raw Hausdorff ${raw} px, so scaling and centring the ours outline onto the ref outline does not close the gap.`;
  } else {
    cause = `The gap is a mix of camera scale and shape: raw Hausdorff is ${raw} px and aligned Hausdorff is ${aligned} px, so alignment closes part of the gap but not all of it. Ours Sudan is ${oursW} by ${oursH} px against ref ${refW} by ${refH} px.`;
  }
  if (w.near_badge_or_title) {
    cause += ` The worst point sits ${w.near_badge_or_title_note}, so the badge or text adds to the raw gap.`;
  }

  // Correction in scene terms.
  const pct = roundTo(Math.abs(s - 1) * 100, 1);
  const zoomWord = s >= 1 ? "in" : "out";
  const cameraFix = s === 1
    ? "The camera scale already matches, so no zoom change is needed."
    : `Zoom the map camera ${zoomWord} by a factor of ${s} (about ${pct} percent) so ours Sudan grows from ${oursW} px wide to ${refW} px wide.`;
  const edgeWord = w.side === "ref" ? "outward" : "inward";
  const shapeFix = shapeMatches
    ? "The outline needs no edge move after alignment."
    : `Move the Sudan ${w.sector} edge ${edgeWord} by about ${w.distance_px} px at (${w.ref_xy[0]}, ${w.ref_xy[1]}) ref against (${w.ours_xy[0]}, ${w.ours_xy[1]}) ours.`;
  const correction = `${cameraFix} ${shapeFix}`;

  const summary = `At ${atS} s the Sudan outline is ${raw} px apart at worst (Hausdorff), ${measured.chamfer_mean_px} px on mean Chamfer, and ${aligned} px after centroid and scale alignment (scale ${s}). The worst spot is ${w.sector} at (${w.ref_xy[0]}, ${w.ref_xy[1]}) ref against (${w.ours_xy[0]}, ${w.ours_xy[1]}) ours, ${w.distance_px} px apart. Ours Sudan is ${oursW} by ${oursH} px against ref ${refW} by ${refH} px.`;

  return {
    second: atS,
    ref_frame: ref,
    ours_frame: ours,
    stride: STRIDE,
    sudan_present: measured.sudan_present,
    segmentation: seg,
    hausdorff_px: raw,
    chamfer_a_to_b_px: measured.chamfer_a_to_b_px,
    chamfer_b_to_a_px: measured.chamfer_b_to_a_px,
    chamfer_mean_px: measured.chamfer_mean_px,
    chamfer_caveat: CHAMFER_CAVEAT,
    aligned_hausdorff_px: aligned,
    aligned_scale: s,
    unmasked: measured.unmasked,
    worst_point: w,
    neighbours: measured.neighbours,
    nearest_node: null,
    nearest_node_reason: "no --scene given, so no node mapping was run",
    cause,
    correction,
    summary,
  };
}

// Map the worst outline point to the nearest node in the scene and
// attach it to the report. Throws a named error when the scene file
// cannot be read or fails validation; a missing GeoJSON file only
// skips the map-vertex candidates, with the reason recorded.
export function attachNearestNode(report, sceneArg, atS) {
  const scenePath = resolve(sceneArg);
  if (!existsSync(scenePath)) {
    throw new Error(`hme contour: no such file: ${sceneArg}`);
  }
  let scene;
  try {
    scene = loadScene(scenePath);
  } catch (err) {
    throw new Error(`hme contour: cannot read scene ${sceneArg}: ${err.message}`);
  }
  const result = validateScene(scene);
  if (result.errors.length > 0) {
    throw new Error(`hme contour: scene ${sceneArg} fails validation: ${result.errors[0].code} ${result.errors[0].path} ${result.errors[0].message}`);
  }
  if (!report.worst_point) return;
  const frame = Math.round(atS * FPS);
  const notes = [];
  let candidates = pointsNodeCandidates(scene, frame);
  let camera = null;
  const hasMap = (scene.nodes || []).some((n) => n.type === "map");
  if (hasMap) {
    if (!existsSync(GEOJSON_PATH) || !existsSync(TOKENS_PATH)) {
      notes.push("map geometry files are missing, so no map-vertex candidate was checked");
    } else {
      const geo = JSON.parse(readFileSync(GEOJSON_PATH, "utf8"));
      const tokens = JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
      const mapRes = mapVertexCandidates(scene, frame, tokens, geo.features || []);
      candidates = candidates.concat(mapRes.candidates);
      notes.push(...mapRes.notes);
      const mapNode = scene.nodes.find((n) => n.type === "map");
      camera = mapCameraAtFrame(mapNode.props, frame, scene.meta.fps,
        scene.events || [], tokens, geo.features || []).camera;
    }
  }
  const nearest = nearestNode(candidates, report.worst_point.ours_xy[0], report.worst_point.ours_xy[1]);
  if (!nearest) {
    report.nearest_node_reason = "the scene holds no editable path node for this outline"
      + (notes.length > 0 ? `: ${notes.join("; ")}` : "");
    return;
  }
  const correction = nodeCorrection(nearest, report.worst_point, sceneArg, camera);
  report.nearest_node = correction;
  report.nearest_node_reason = null;
  if (notes.length > 0) report.nearest_node.notes = notes;
  report.correction += ` ${correction.sentence}`;
}

// Run `hme contour <ref-frame.png> <ours-frame.png> [--at-s <n>] [--out <report.json>]`.
// Returns the process exit code: 0 measured, 2 usage or run error.
// Never prints a stack trace.
export async function runContour(argv) {
  const positionals = [];
  let atS = null;
  let outPath = null;
  let sceneArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--at-s") {
      if (i + 1 >= argv.length) {
        console.error("hme contour: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
      atS = Number(argv[++i]);
      if (!Number.isFinite(atS)) {
        console.error("hme contour: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--scene") {
      if (i + 1 >= argv.length) {
        console.error("hme contour: --scene needs a scene file path");
        console.error(USAGE);
        return 2;
      }
      sceneArg = argv[++i];
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme contour: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme contour: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 2) {
    console.error("hme contour: needs two frames, <ref-frame.png> and <ours-frame.png>");
    console.error(USAGE);
    return 2;
  }
  const [refArg, oursArg] = positionals;
  const refPath = resolve(refArg);
  const oursPath = resolve(oursArg);
  if (!existsSync(refPath)) {
    console.error(`hme contour: no such file: ${refArg}`);
    return 2;
  }
  if (!existsSync(oursPath)) {
    console.error(`hme contour: no such file: ${oursArg}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme contour: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  if (sceneArg && !existsSync(resolve(sceneArg))) {
    console.error(`hme contour: no such file: ${sceneArg}`);
    return 2;
  }
  let atSFrom;
  if (atS === null) {
    atS = parseAtS(refArg);
    if (atS === null) {
      console.error("hme contour: cannot tell the seconds from the ref frame name; pass --at-s <n>");
      console.error(USAGE);
      return 2;
    }
    atSFrom = "derived from the ref frame number at 24 fps";
  } else {
    atSFrom = "--at-s flag";
  }
  void atSFrom;
  try {
    const measured = await runDriver(refPath, oursPath);
    const report = buildReport(measured, { ref: refArg, ours: oursArg, atS });
    if (sceneArg) attachNearestNode(report, sceneArg, atS);
    const text = JSON.stringify(report, null, 2) + "\n";
    if (outPath) {
      mkdirSync(dirname(resolve(outPath)), { recursive: true });
      writeFileSync(resolve(outPath), text);
    } else {
      process.stdout.write(text);
    }
    return 0;
  } catch (err) {
    console.error(`hme contour: ${err.message}`);
    return 2;
  }
}
