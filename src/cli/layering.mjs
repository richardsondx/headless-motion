// hme layering: measure depth and layering between a reference frame
// and our render.
//
// The metrics are Python (src/checker), so this module spawns the
// engine venv Python with a small driver on stdin, the same pattern as
// src/cli/compare.mjs. Nothing here reimplements the checker methods
// in JavaScript. Nothing is hardcoded to a video, a segment, or a
// frame count: the two frames, the scene, and the trace all come from
// the arguments, and the command measures one frame pair per call.
//
// Method (units U2 to U4 build it up in order):
// - U2 overlap: badge box from the RSF orange mask, label ink mask
//   from the El Fasher dot, one winner per shared box by pixel count
//   inside that box (dimensions.zorder_in_overlap). One pixel holds
//   one colour, so the masks never share a pixel; the winner is per
//   box, not per pixel. When the boxes do not overlap the honest
//   answer is winner None, overlap 0, plus corner composition counts
//   in the 120 px box around the badge top-right corner.
// - U3 shadow: dimensions.shadow_drop plus the ring mean (0-3 px
//   outside the ink) and the band mean (3-12 px out), same dilation
//   steps as shadow_drop. A negative drop means no dark fringe is
//   detectable; the dark map hides any shadow.
// - U4 badge interior: dimensions.badge_parts dark (luma under 80)
//   and bright (luma over 200) with centroids, plus a dark non-orange
//   count (RGB distance from RSF over 12, luma under 95) on the same
//   measure for both sides; dot merge flag when the found component
//   is larger than the scene dot box; label ink with the halo disc
//   and dot disc excluded, reported with and without the exclusion.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

// The dark non-orange rifle measure (U4): RGB distance from RSF
// (204, 71, 38) over 12, luma under this threshold. Settled by
// measuring the fresh post-fix render: T 95 puts the fresh ours
// count near the fixer count 2,668.
export const DARK_NON_ORANGE_LUMA = 95;
export const RSF_RGB = [204, 71, 38];
export const RSF_TOL = 12;
// Badge dark within this share of ref dark counts as a match (U4).
export const DARK_MATCH_PCT = 10;

export const USAGE = [
  "hme layering: Measure depth and layering between a reference frame and our render.",
  "",
  "Usage: hme layering --ref <frame> --ours <frame> --scene <scene.json> --trace <trace.json> [--profile <name>] --out <report.json>",
  "",
  "Options:",
  "  --ref <file>  Path to the reference frame. Required.",
  "  --ours <file>  Path to our rendered frame. Required.",
  "  --scene <file>  Path to the scene file. Required.",
  "  --trace <file>  Path to the trace file. Required.",
  "  --profile <name>  Render profile that made the ours frame (draft, final, ...). Optional, default unknown.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Example: hme layering --ref ref-0168.png --ours v5-0168.png --scene tests/fixtures/seg4-scene-clone-v5.json --trace verify-seg4/evidence/seg4-trace.json --out verify-seg4/evidence/work/layering/layering-seg4.json",
  "",
  "The command measures one frame pair per call. To cover sampled",
  "frames, run it once per frame (every 12th frame, 0 to 180).",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// The Python driver. It measures one frame pair and prints exactly
// one JSON object to stdout; progress goes to stderr.
const DRIVER = `
import json
import re
import sys
from pathlib import Path

REF, OURS, SCENE, TRACE = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
sys.path.insert(0, sys.argv[5])
from checker import dimensions, layout
import numpy as np
from PIL import Image

def load(p):
    return np.array(Image.open(p).convert("RGB"))

def scene_nodes(scene_path):
    with open(scene_path) as f:
        scene = json.load(f)
    nodes = {}
    for n in scene.get("nodes", []):
        nodes[n["id"]] = n
    return scene, nodes

def trace_info(trace_path):
    with open(trace_path) as f:
        return json.load(f)

scene, nodes = scene_nodes(SCENE)
trace = trace_info(TRACE)

def node_box(node_id):
    n = nodes.get(node_id)
    if n is None:
        return None
    b = n["box"]
    return [b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]]

def node_centre(node_id):
    b = node_box(node_id)
    if b is None:
        return None
    return [(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0]

# Scene dot and halo boxes, for the merge flag and the ink exclusion.
dot_box = node_box("dot-fasher")
halo_box = node_box("halo-fasher")
scene_dot_centre = node_centre("dot-fasher")
dot_box_area = None
if dot_box is not None:
    dot_box_area = (dot_box[2] - dot_box[0]) * (dot_box[3] - dot_box[1])
halo_radius = None
if halo_box is not None:
    halo_radius = (halo_box[2] - halo_box[0]) / 2.0
dot_radius = None
if dot_box is not None:
    dot_radius = (dot_box[2] - dot_box[0]) / 2.0

# Trace label box, for the ink bbox check.
trace_label_box = None
trace_dot = None
try:
    trace_label_box = trace["labels"]["el_fasher"]["bbox_1920x1080"]
    trace_dot = trace["labels"]["el_fasher_dot"]
except (KeyError, TypeError):
    pass

def measure(frame_path):
    frame = load(frame_path)
    luma = dimensions.luma_of(frame)
    H, W = luma.shape
    rsf_mask = layout.rgb_mask(frame, layout.PALETTE["rsf"], layout.TOL["rsf"])
    badge = dimensions.mask_extent(rsf_mask)
    out = {"frame": frame_path, "width": W, "height": H,
           "badge_bbox": badge["bbox"] if badge else None,
           "badge_centroid": badge["centroid"] if badge else None,
           "badge_px": badge["n"] if badge else 0}
    if badge is None:
        out.update({"dot": None, "dot_merged": None, "anchor": None,
                    "anchor_source": None, "halo": None,
                    "ink_raw_px": None, "ink_excluded_px": None,
                    "ink_bbox": None, "zorder": {"overlap_px": 0, "badge_px": 0,
                    "ink_px": 0, "winner": None},
                    "shadow": None, "corner": None,
                    "parts": None, "dark_non_orange_px": None,
                    "dark_non_orange_centroid": None})
        return out
    # Dot next to the badge top-right corner, with the 30 px gate
    # from the compare driver: without it find_dot can return a
    # bright text fragment far from the badge.
    dot = layout.find_dot(frame, (badge["bbox"][2], badge["bbox"][1]))
    if dot is not None:
        cx, cy = dot["centroid"]
        if float(np.hypot(cx - badge["bbox"][2], cy - badge["bbox"][1])) > 30:
            dot = None
    out["dot"] = dot
    merged = None
    if dot is not None and dot_box_area is not None:
        merged = bool(dot["pixels"] > dot_box_area)
    out["dot_merged"] = merged
    # When the found component merged dot, halo, and label, anchor
    # the halo and label window to the scene dot centre instead.
    if merged and scene_dot_centre is not None:
        anchor = [float(scene_dot_centre[0]), float(scene_dot_centre[1])]
        anchor_source = "scene"
    elif dot is not None:
        anchor = [float(dot["centroid"][0]), float(dot["centroid"][1])]
        anchor_source = "found"
    else:
        anchor = None
        anchor_source = None
    out["anchor"] = anchor
    out["anchor_source"] = anchor_source
    out["halo"] = dimensions.radial_profile(luma, anchor[0], anchor[1]) if anchor else None
    # Badge interior parts (U4).
    out["parts"] = dimensions.badge_parts(luma, badge["bbox"])
    x0, y0, x1, y1 = [int(v) for v in badge["bbox"]]
    patch = frame[y0:y1, x0:x1].astype(np.int32)
    patch_luma = luma[y0:y1, x0:x1]
    d2 = np.sum((patch - np.array([204, 71, 38], dtype=np.int32)) ** 2, axis=2)
    non_orange_dark = (d2 > 12 * 12) & (patch_luma < 95)
    out["dark_non_orange_px"] = int(non_orange_dark.sum())
    if non_orange_dark.any():
        ys, xs = np.where(non_orange_dark)
        out["dark_non_orange_centroid"] = [round(float(xs.mean()) + x0, 1),
                                           round(float(ys.mean()) + y0, 1)]
    else:
        out["dark_non_orange_centroid"] = None
    # Label window around the anchor, ink at luma 180 or higher.
    ink_raw = None
    ink_excluded = None
    ink_bbox = None
    full_ink = np.zeros(luma.shape, dtype=bool)
    if anchor is not None:
        ax, ay = anchor
        wx0, wx1 = max(0, int(ax) - 10), min(W, int(ax) + 220)
        wy0, wy1 = max(0, int(ay) - 25), min(H, int(ay) + 25)
        win = luma[wy0:wy1, wx0:wx1] >= 180
        ink_raw = int(win.sum())
        full_ink[wy0:wy1, wx0:wx1] = win
        # Exclude the halo disc and the dot disc, using the scene
        # box sizes around the anchor centre.
        yy, xx = np.mgrid[wy0:wy1, wx0:wx1]
        r = np.hypot(xx - ax, yy - ay)
        keep = np.ones(win.shape, dtype=bool)
        if halo_radius is not None:
            keep &= r > halo_radius
        if dot_radius is not None:
            keep &= r > dot_radius
        ink_excluded = int((win & keep).sum())
        ext = dimensions.mask_extent(full_ink)
        ink_bbox = ext["bbox"] if ext else None
    out["ink_raw_px"] = ink_raw
    out["ink_excluded_px"] = ink_excluded
    out["ink_bbox"] = ink_bbox
    out["zorder"] = dimensions.zorder_in_overlap(rsf_mask, full_ink)
    # Shadow: drop plus ring mean and band mean, with the same
    # dilation steps shadow_drop uses (U3).
    drop = dimensions.shadow_drop(luma, full_ink)
    ring_mean = None
    band_mean = None
    if full_ink.any():
        from scipy import ndimage
        near = ndimage.binary_dilation(full_ink, iterations=3)
        far = ndimage.binary_dilation(full_ink, iterations=12)
        ring = near & ~full_ink
        band = far & ~near
        if ring.any():
            ring_mean = round(float(np.mean(luma[ring])), 2)
        if band.any():
            band_mean = round(float(np.mean(luma[band])), 2)
    out["shadow"] = {"drop": drop, "ring_mean": ring_mean, "band_mean": band_mean}
    # Corner composition: 120 px box around the badge top-right corner.
    cx0, cx1 = max(0, badge["bbox"][2] - 60), min(W, badge["bbox"][2] + 60)
    cy0, cy1 = max(0, badge["bbox"][1] - 60), min(H, badge["bbox"][1] + 60)
    corner = {"badge_px": int(rsf_mask[cy0:cy1, cx0:cx1].sum()),
              "ink_px": int((luma[cy0:cy1, cx0:cx1] >= 180).sum()),
              "dot_px": 0}
    if dot is not None:
        dx0, dy0, dx1, dy1 = [int(v) for v in dot["bbox"]]
        ox0, oy0 = max(dx0, cx0), max(dy0, cy0)
        ox1, oy1 = min(dx1, cx1), min(dy1, cy1)
        if ox1 > ox0 and oy1 > oy0:
            corner["dot_px"] = int((luma[oy0:oy1, ox0:ox1] >= 170).sum())
    out["corner"] = corner
    return out

ref = measure(REF)
ours = measure(OURS)

# Rifle source ceiling: opaque pixels of rifle.png, resolved from
# the scene rifle node src. A ceiling only, never a ref value.
rifle_ceiling = None
rifle_node = nodes.get("rifle-rsf")
if rifle_node is not None:
    src = rifle_node.get("props", {}).get("src")
    if src:
        rifle_path = (Path(SCENE).parent / src).resolve()
        if rifle_path.exists():
            rgba = np.array(Image.open(rifle_path))
            if rgba.ndim == 3 and rgba.shape[2] == 4:
                rifle_ceiling = int((rgba[:, :, 3] > 0).sum())

m = re.search(r"(\\d+)\\.png$", Path(REF).name)
frame_no = int(m.group(1)) if m else None
second = round(frame_no / 24.0, 3) if frame_no is not None else None

print(json.dumps({
    "ref": REF, "ours": OURS, "scene": SCENE, "trace": TRACE,
    "frame": frame_no, "second": second,
    "ref_side": ref, "ours_side": ours,
    "scene_dot_box": dot_box, "scene_halo_box": halo_box,
    "scene_dot_centre": scene_dot_centre,
    "dot_box_area_px": dot_box_area,
    "halo_radius_px": halo_radius, "dot_radius_px": dot_radius,
    "trace_label_box": trace_label_box, "trace_dot": trace_dot,
    "rifle_source_ceiling_px": rifle_ceiling,
}))
`;

function runDriver(refPath, oursPath, scenePath, tracePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", refPath, oursPath, scenePath, tracePath, SRC_DIR], {
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
        rejectPromise(new Error(`layering measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`layering measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

function roundTo(value, digits) {
  if (value === null || value === undefined) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

// Deterministic correction rules, from the measured differences.
// Each rule names a scene node and a change, never only a score.
// Rules are stated in the report under context.correction_rules.
export function buildCorrections(measured) {
  const ref = measured.ref_side;
  const ours = measured.ours_side;
  const atS = measured.second;
  const source = `hme layering, frame ${measured.frame}`;
  const out = [];
  const seen = new Set();
  const add = (c) => {
    const key = `${c.element}:${c.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  const darkRef = ref.parts ? ref.parts.dark_rifle_px : 0;
  const darkOurs = ours.parts ? ours.parts.dark_rifle_px : 0;
  if (darkRef > 0 && darkOurs < 0.9 * darkRef) {
    const oc = ours.parts.dark_centroid;
    const rc = ref.parts.dark_centroid;
    add({
      element: "rifle-rsf",
      kind: "shape",
      at_s: atS,
      ours: { px: darkOurs, x: oc ? oc[0] : null, y: oc ? oc[1] : null },
      real: { px: darkRef, x: rc[0], y: rc[1] },
      shift_px: { dx: oc ? roundTo(rc[0] - oc[0], 1) : 0, dy: oc ? roundTo(rc[1] - oc[1], 1) : 0 },
      fix: "Restore the rifle-rsf image node on the badge box so the rifle renders. Our badge holds almost no dark rifle pixels while ref holds " + darkRef + ".",
      source,
    });
  }
  const haloOurs = ours.halo ? ours.halo.falloff : null;
  const haloRef = ref.halo ? ref.halo.falloff : null;
  const inkExOurs = ours.ink_excluded_px;
  const inkExRef = ref.ink_excluded_px;
  const cornerOurs = ours.corner ? ours.corner.ink_px : 0;
  const cornerRef = ref.corner ? ref.corner.ink_px : 0;
  const haloTooWide = haloRef !== null && haloOurs !== null && haloOurs > haloRef + 20;
  const inkTooBright = inkExRef !== null && inkExOurs !== null && inkExRef > 0 && inkExOurs > 1.5 * inkExRef;
  const cornerTooBright = cornerRef > 0 && cornerOurs > 2 * cornerRef;
  if (haloTooWide || inkTooBright || cornerTooBright) {
    const ax = ours.anchor ? ours.anchor[0] : null;
    const ay = ours.anchor ? ours.anchor[1] : null;
    const rx = ref.anchor ? ref.anchor[0] : null;
    const ry = ref.anchor ? ref.anchor[1] : null;
    add({
      element: "halo-fasher",
      kind: "size",
      at_s: atS,
      ours: { px: inkExOurs, x: ax, y: ay },
      real: { px: inkExRef, x: rx, y: ry },
      shift_px: { dx: rx !== null && ax !== null ? roundTo(rx - ax, 1) : 0, dy: ry !== null && ay !== null ? roundTo(ry - ay, 1) : 0 },
      fix: "Shrink halo-fasher and lower its opacity. Our halo glow spills past its scene box into the label window: label ink after excluding the halo disc is " + inkExOurs + " px against " + inkExRef + " px in ref, and corner ink is " + cornerOurs + " px against " + cornerRef + " px in ref.",
      source,
    });
  }
  if (ref.zorder.winner !== ours.zorder.winner && ref.zorder.overlap_px > 0) {
    add({
      element: "label-fasher",
      kind: "position",
      at_s: atS,
      ours: { px: ours.zorder.ink_px, x: ours.anchor ? ours.anchor[0] : null, y: ours.anchor ? ours.anchor[1] : null },
      real: { px: ref.zorder.ink_px, x: ref.anchor ? ref.anchor[0] : null, y: ref.anchor ? ref.anchor[1] : null },
      shift_px: { dx: 0, dy: 0 },
      fix: "Raise label-fasher z above the badge so the label wins the shared box, as it does in ref.",
      source,
    });
  }
  return out;
}

// Build the insight report from the driver output. Pure function.
export function buildInsightReport(measured, profile = "unknown") {
  const ref = measured.ref_side;
  const ours = measured.ours_side;
  const overlapPx = ref.zorder.overlap_px;
  const boxesOverlap = overlapPx > 0;
  const darkRef = ref.parts ? ref.parts.dark_rifle_px : 0;
  const darkOurs = ours.parts ? ours.parts.dark_rifle_px : 0;
  const darkDiffPct = darkRef > 0 ? roundTo(100 * Math.abs(darkOurs - darkRef) / darkRef, 1) : null;
  const darkWithin = darkRef > 0 && Math.abs(darkOurs - darkRef) <= 0.1 * darkRef;
  const corrections = buildCorrections(measured);
  const failedBar = darkWithin
    ? null
    : `badge dark rifle within ${DARK_MATCH_PCT}% of ref (pred-v1)`;
  const status = darkWithin ? "PASS" : "FAIL";
  const detail = darkWithin
    ? `Badge dark rifle matches ref within ${DARK_MATCH_PCT}% (${darkOurs} px ours against ${darkRef} px ref).`
    : `Badge dark rifle is ${darkOurs} px ours against ${darkRef} px ref, a ${darkDiffPct}% gap, outside the ${DARK_MATCH_PCT}% bar.`;
  const shadowRef = ref.shadow || {};
  const shadowOurs = ours.shadow || {};
  const headroom = (side) => {
    if (side.band_mean === null || side.band_mean === undefined) return null;
    return side.band_mean;
  };
  const profileSuffix = profile === "unknown" ? "" : ` --profile ${profile}`;
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      ref: measured.ref,
      ours: measured.ours,
      scene: measured.scene,
      trace: measured.trace,
      profile,
      frame: measured.frame,
      second: measured.second,
      overlap: {
        rule: "One pixel holds one colour, so the badge and ink masks never share a pixel. The winner is one per shared box, by pixel count inside that box.",
        boxes_overlap: boxesOverlap,
        winner_ref: ref.zorder.winner,
        winner_ours: ours.zorder.winner,
        overlap_px_ref: ref.zorder.overlap_px,
        overlap_px_ours: ours.zorder.overlap_px,
        badge_px_in_overlap_ref: ref.zorder.badge_px,
        badge_px_in_overlap_ours: ours.zorder.badge_px,
        ink_px_in_overlap_ref: ref.zorder.ink_px,
        ink_px_in_overlap_ours: ours.zorder.ink_px,
        headline_frame: measured.frame,
        headline_second: measured.second,
        corner_120px: {
          ref: ref.corner,
          ours: ours.corner,
          note: "When the boxes do not overlap, the corner box around the badge top-right corner is the reported substitute.",
        },
      },
      shadow: {
        drop_ref: shadowRef.drop ?? null,
        drop_ours: shadowOurs.drop ?? null,
        ring_mean_ref: shadowRef.ring_mean ?? null,
        ring_mean_ours: shadowOurs.ring_mean ?? null,
        band_mean_ref: shadowRef.band_mean ?? null,
        band_mean_ours: shadowOurs.band_mean ?? null,
        headroom_ref: headroom(shadowRef),
        headroom_ours: headroom(shadowOurs),
        finding_ref: shadowRef.drop === null ? "no ink found, shadow unmeasurable"
          : shadowRef.drop < 0 ? "no dark fringe detectable"
          : "dark fringe detected",
        finding_ours: shadowOurs.drop === null ? "no ink found, shadow unmeasurable"
          : shadowOurs.drop < 0 ? "no dark fringe detectable"
          : "dark fringe detected",
        reason: "A negative drop means the ring just outside the ink is brighter than the band 3 to 12 px out. The dark map behind the text hides any shadow, so this test cannot prove a shadow is present or absent.",
        headroom_note: "Headroom is the band mean luma: how bright the background is. A dark band leaves no room for a shadow darker than the map to show.",
      },
      badge: {
        measure: "badge_parts: dark is luma under 80 (rifle), bright is luma over 200 (RSF text). Dark non-orange is RGB distance from RSF (204, 71, 38) over 12 and luma under 95, one stated measure for both sides.",
        rifle_source_ceiling_px: measured.rifle_source_ceiling_px,
        rifle_source_note: "The rifle.png source file count is a ceiling only, not the ref value.",
        dark_non_orange_luma_threshold: DARK_NON_ORANGE_LUMA,
        ref: {
          badge_bbox: ref.badge_bbox,
          dark_rifle_px: ref.parts ? ref.parts.dark_rifle_px : null,
          bright_text_px: ref.parts ? ref.parts.bright_text_px : null,
          dark_centroid: ref.parts ? ref.parts.dark_centroid : null,
          bright_centroid: ref.parts ? ref.parts.bright_centroid : null,
          dark_non_orange_px: ref.dark_non_orange_px,
          dark_non_orange_centroid: ref.dark_non_orange_centroid,
        },
        ours: {
          badge_bbox: ours.badge_bbox,
          dark_rifle_px: ours.parts ? ours.parts.dark_rifle_px : null,
          bright_text_px: ours.parts ? ours.parts.bright_text_px : null,
          dark_centroid: ours.parts ? ours.parts.dark_centroid : null,
          bright_centroid: ours.parts ? ours.parts.bright_centroid : null,
          dark_non_orange_px: ours.dark_non_orange_px,
          dark_non_orange_centroid: ours.dark_non_orange_centroid,
        },
        dark_diff_pct: darkDiffPct,
        dark_within_10_pct: darkWithin,
      },
      dot: {
        scene_dot_box: measured.scene_dot_box,
        scene_dot_centre: measured.scene_dot_centre,
        dot_box_area_px: measured.dot_box_area_px,
        trace_dot: measured.trace_dot,
        merge_rule: "A merge is flagged when the found component is larger than the scene dot box (11 by 11, 121 px).",
        ref: {
          found: ref.dot,
          merged: ref.dot_merged,
          anchor: ref.anchor,
          anchor_source: ref.anchor_source,
        },
        ours: {
          found: ours.dot,
          merged: ours.dot_merged,
          anchor: ours.anchor,
          anchor_source: ours.anchor_source,
        },
        halo: {
          ref: ref.halo,
          ours: ours.halo,
          note: "Halo is dimensions.radial_profile at the anchor centre. When the dot merged, the anchor is the scene dot centre.",
        },
      },
      ink: {
        window: "x dot-10 to dot+220, y dot-25 to dot+25 around the anchor centre. Ink is luma 180 or higher.",
        exclusion: "The halo disc (radius from the scene halo box) and the dot disc (radius from the scene dot box) are excluded around the anchor centre.",
        trace_label_box: measured.trace_label_box,
        ref: {
          ink_raw_px: ref.ink_raw_px,
          ink_excluded_px: ref.ink_excluded_px,
          ink_bbox: ref.ink_bbox,
        },
        ours: {
          ink_raw_px: ours.ink_raw_px,
          ink_excluded_px: ours.ink_excluded_px,
          ink_bbox: ours.ink_bbox,
        },
      },
    },
    corrections,
    context: {
      thresholds: {
        dark_match_pct: DARK_MATCH_PCT,
        dark_non_orange_luma: DARK_NON_ORANGE_LUMA,
        rsf_tol: RSF_TOL,
        ink_luma_min: 180,
        badge_dark_luma_max: 80,
        badge_bright_luma_min: 200,
        dot_gate_px: 30,
      },
      control_ceiling: null,
      meaning: status === "PASS"
        ? `At frame ${measured.frame} (${measured.second} s) the rifle renders: badge dark is ${darkOurs} px against ${darkRef} px in ref. Layering still differs where corrections are listed.`
        : `At frame ${measured.frame} (${measured.second} s) the rifle does not match ref: badge dark is ${darkOurs} px against ${darkRef} px in ref.`,
      correction_rules: [
        "Ours badge dark under 90% of ref badge dark: restore rifle-rsf on the badge box.",
        "Ours halo falloff over ref falloff + 20, or ours ink after exclusion over 1.5x ref ink, or ours corner ink over 2x ref corner ink: shrink halo-fasher and lower its opacity.",
        "Overlap winners differ between sides while the boxes overlap: raise label-fasher z above the badge.",
        "A negative shadow drop never makes a correction: the test cannot separate a shadow from the dark map.",
      ],
    },
    next: corrections.length > 0
      ? `Fix ${corrections[0].element} in the scene, re-render frame ${measured.frame}, then rerun: hme layering --ref ${measured.ref} --ours ${measured.ours} --scene ${measured.scene} --trace ${measured.trace}${profileSuffix}`
      : `hme layering --ref ${measured.ref} --ours ${measured.ours} --scene ${measured.scene} --trace ${measured.trace}${profileSuffix}`,
    limits: [
      "One frame pair per call. A sampled sweep runs the command once per frame (every 12th frame, 0 to 180).",
      "One pixel holds one colour, so the badge and ink masks never share a pixel. The overlap winner is per shared box, not per pixel.",
      "The shadow test cannot prove a shadow is present or absent: a negative drop means no dark fringe is detectable, and the dark map hides any shadow.",
      "The dark non-orange luma threshold (95) was settled by measuring the fresh post-fix render, where it puts the ours count near the fixer count 2,668.",
      "The rifle.png source count is a ceiling only, not the ref value.",
      "Badge dark at luma under 80 catches only the darkest rifle core. Mid brown rifle pixels sit above 80 and are not counted.",
      "The dot merge flag fires when the found component is larger than the scene dot box. When it fires, the halo and label window anchor to the scene dot centre.",
      `Render profile of the ours frame: ${profile}.`,
    ],
  };
}

// Run `hme layering ...`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runLayering(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  let refPath = null;
  let oursPath = null;
  let scenePath = null;
  let tracePath = null;
  let profile = "unknown";
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = (flag) => {
      if (i + 1 >= argv.length) {
        console.error(`hme layering: ${flag} needs a file path`);
        console.error(USAGE);
        return null;
      }
      return argv[++i];
    };
    if (a === "--ref") {
      refPath = takeValue(a);
      if (refPath === null) return 2;
    } else if (a === "--ours") {
      oursPath = takeValue(a);
      if (oursPath === null) return 2;
    } else if (a === "--scene") {
      scenePath = takeValue(a);
      if (scenePath === null) return 2;
    } else if (a === "--trace") {
      tracePath = takeValue(a);
      if (tracePath === null) return 2;
    } else if (a === "--profile") {
      profile = takeValue(a);
      if (profile === null) return 2;
    } else if (a === "--out") {
      outPath = takeValue(a);
      if (outPath === null) return 2;
    } else if (a.startsWith("--")) {
      console.error(`hme layering: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      console.error(`hme layering: unexpected argument "${a}"`);
      console.error(USAGE);
      return 2;
    }
  }
  if (argv.length === 0 || refPath === null || oursPath === null || scenePath === null || tracePath === null) {
    console.error("hme layering: needs --ref, --ours, --scene, and --trace");
    console.error(USAGE);
    return 2;
  }
  for (const [flag, p] of [["--ref", refPath], ["--ours", oursPath], ["--scene", scenePath], ["--trace", tracePath]]) {
    if (!existsSync(resolve(p))) {
      console.error(`hme layering: no such file: ${p} (${flag})`);
      return 2;
    }
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme layering: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  try {
    const measured = await runDriver(resolve(refPath), resolve(oursPath), resolve(scenePath), resolve(tracePath));
    const report = buildInsightReport(measured, profile);
    return writeInsightReport(report, outPath ? resolve(outPath) : null);
  } catch (err) {
    console.error(`hme layering: ${err.message}`);
    return 2;
  }
}
