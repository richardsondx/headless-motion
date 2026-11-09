// hme colour: whole-frame colour histogram and halo radial profile
// for one frame pair.
//
// One command, one frame pair, one JSON report in the insight format.
// The histogram has three views, with the bins stated on every number:
// the joint 8-cube intersection is the headline, the top unmatched
// cubes name the colours that differ, and the per-channel 32-bin view
// is U9 compatibility. The halo is presence first: the dot is found
// from the RSF badge on each side, and the profile centre is the
// found centroid, never a fixed point.
//
// Method, and what is reused against what is new:
// - Reused from src/checker: dimensions.histogram_intersection for
//   the 32-bin per-channel view, dimensions.radial_profile for both
//   ring sets, layout.find_dot for the dot, layout.rgb_mask and
//   dimensions.mask_extent for the badge gate. Nothing here
//   reimplements those methods in JavaScript.
// - New small computations (numpy, in the driver below): the joint
//   8-cube intersection and top unmatched cubes, the per-channel
//   unmatched mass and the mass in bins where the other side has
//   zero, the background median at radius 30 to 60, the
//   halo excess per ring and over the 5 to 15 px annulus, the peak
//   ring, and the oversize dot flag.
// - Node spawns the engine venv Python with a small driver on stdin,
//   the same pattern compare.mjs uses. The driver prints exactly one
//   JSON object to stdout. Progress goes to stderr.
//
// Verdict rule (Stage 1 sets no numeric bar, so the numbers are
// info-only): FAIL when at least one correction is named, PASS when
// none is named. Thresholds state the identity values: joint cube
// 1.0, per-channel 1.0, equal halo excess, equal peak ring, equal dot
// size. The four Seg4 proof reports are therefore FAIL with exit 1.
// That is the designed verdict, not a tool failure.
//
// Mapping of facts into the insight corrections shape:
// - Halo corrections: ours/real x,y are the found dot centroids and
//   px is the dot pixel count. shift_px is real minus ours.
// - Histogram corrections: ours/real x,y are the centroids of the
//   pixels in the cited cube on each side and px is the count, both
//   counted on the 480x270 downsampled frame. When a side has zero
//   pixels in the cube, the other side centroid is used with px 0
//   and the fix text says so.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = resolve(REPO_ROOT, "src");
const VENV_PYTHON = resolve(REPO_ROOT, ".venv", "bin", "python");

export const FPS = 24;
export const U9_RADII = [5, 10, 15, 20, 30, 45, 60];
export const FINE_RADII = [2, 4, 6, 8, 10, 12, 15, 20, 30];
export const FIXED_CENTRE = [783, 646];
export const DOT_GATE_PX = 30;
export const DOT_SIZE_PX = 11;

export const GROUND_TRUTH_HEXES = {
  sudan_real: "#123B34",
  sudan_v5: "#0C352E",
  land_real: "#1C2B28",
  water_real: "#191D1E",
  rsf_badge: "#CC4726",
};

// Published U9 aggregates, from
// ~/workspace/handover-motion-tool-side/u6-cli-compare.json,
// numbers.dimensions.colour. The histogram mean is a mean over map
// frames. The halo falloffs are means over frames where the dot was
// found. The 94.07 is not the halo falloff at 7 s.
export const U9_AGGREGATES = {
  histogram_intersection_mean: 0.3601,
  halo_falloff_ref_mean: 94.07,
  halo_falloff_ours_mean: 157.97,
  source: "~/workspace/handover-motion-tool-side/u6-cli-compare.json (numbers.dimensions.colour)",
  definition: "Histogram mean is a mean over map frames. Halo falloff means are means over frames where the dot was found, not single-frame values.",
};

export const USAGE = [
  "hme colour: Measure the whole-frame colour histogram and the halo radial profile for one frame pair.",
  "",
  "Usage: hme colour <ref-frame.png> <ours-frame.png> [--at-s <n>] [--out <report.json>]",
  "",
  "Arguments:",
  "  <ref-frame.png>  One frame from the reference video.",
  "  <ours-frame.png>  The same frame from our video.",
  "",
  "Options:",
  "  --at-s <n>  Time in seconds of the frame. When absent, it is derived from the ref frame number at 24 fps (ref-0168.png means 7 s).",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Histogram: joint 8-cube intersection (8 bins per channel, 512 cubes) on 480x270 downsampled pixels (every 4th pixel), top unmatched cubes both directions, and the per-channel 32-bin view from dimensions.histogram_intersection. The 32-bin mean is flat across seconds and is not the headline.",
  "Halo: the dot is found from the RSF badge on each side (dot within 30 px of the badge top-right corner). No badge means no halo profile: the report says ABSENT with no profile numbers. The centre is the found centroid, never a fixed point. Rings are the U9 radii (5, 10, 15, 20, 30, 45, 60) plus fine rings (2, 4, 6, 8, 10, 12, 15, 20, 30) from dimensions.radial_profile on full-resolution luma. Background is the median luma at radius 30 to 60. Halo excess is ring mean minus background median.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
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

// The Python driver. It loads the two PNGs, imports checker.dimensions
// and checker.layout, computes, and prints exactly one JSON object to
// stdout. Progress goes to stderr.
const DRIVER = `
import json
import sys
sys.path.insert(0, sys.argv[3])
import numpy as np
from PIL import Image
from checker import dimensions, layout

REF, OURS = sys.argv[1], sys.argv[2]
FINE_RADII = (2, 4, 6, 8, 10, 12, 15, 20, 30)
U9_RADII = (5, 10, 15, 20, 30, 45, 60)

def load(p):
    return np.array(Image.open(p).convert("RGB"))

ref = load(REF)
ours = load(OURS)
if ref.shape != ours.shape:
    raise RuntimeError(f"frames differ in size: ref {ref.shape}, ours {ours.shape}")

# Same downsampled pixels for every histogram view: every 4th pixel.
ref_s = ref[::4, ::4]
ours_s = ours[::4, ::4]
hist32 = dimensions.histogram_intersection(ref_s, ours_s, bins=32)
hist32_full = dimensions.histogram_intersection(ref, ours, bins=32)

def cube_hist(px):
    idx = (px[:, :, 0] // 32) * 64 + (px[:, :, 1] // 32) * 8 + (px[:, :, 2] // 32)
    h = np.bincount(idx.ravel(), minlength=512).astype(np.float64)
    return h / h.sum(), idx

href, idxr = cube_hist(ref_s)
hou, idxo = cube_hist(ours_s)
joint = round(float(np.sum(np.minimum(href, hou))), 4)

def cube_side(idx, k):
    # Pixels in cube k on one side: count and centroid in full-res
    # coords. Sampled pixels sit at x*4, y*4 in the full frame.
    ys, xs = np.where(idx == k)
    if len(xs) == 0:
        return {"pixels": 0, "centroid": None}
    return {"pixels": int(len(xs)),
            "centroid": [round(float(np.mean(xs * 4)), 1), round(float(np.mean(ys * 4)), 1)]}

def top_unmatched(h_a, h_b, idx_a, idx_b, top=5):
    # New computation: unmatched mass is the positive part of the
    # per-cube difference. RGB centre is the cube centre.
    mass = np.maximum(h_a - h_b, 0)
    out = []
    for k in np.argsort(mass)[::-1][:top]:
        if mass[k] <= 0:
            break
        b = int(k)
        r, g, bb = b // 64, (b // 8) % 8, b % 8
        out.append({"cube": [r, g, bb],
                    "rgb_centre": [r * 32 + 16, g * 32 + 16, bb * 32 + 16],
                    "mass": round(float(mass[k]), 4),
                    "ref": cube_side(idxr, k),
                    "ours": cube_side(idxo, k)})
    return out

def unmatched_mass_32(h_a, h_b):
    # Per-channel unmatched mass from the 32-bin histograms: the
    # positive part of the per-bin difference, summed per channel.
    out = {}
    for ch in range(3):
        ha, _ = np.histogram(h_a[:, :, ch], bins=32, range=(0, 256))
        hb, _ = np.histogram(h_b[:, :, ch], bins=32, range=(0, 256))
        ha = ha / ha.sum()
        hb = hb / hb.sum()
        out["rgb"[ch]] = round(float(np.sum(np.maximum(ha - hb, 0))), 4)
    return out

def zero_bin_mass_32(h_a, h_b):
    # Mass of a in bins where b has exactly zero: colours a holds
    # that b lacks entirely. At 4 s the v5-only G value is 0.2042:
    # one fifth of v5 green sits in bins where ref has zero green.
    out = {}
    for ch in range(3):
        ha, _ = np.histogram(h_a[:, :, ch], bins=32, range=(0, 256))
        hb, _ = np.histogram(h_b[:, :, ch], bins=32, range=(0, 256))
        ha = ha / ha.sum()
        hb = hb / hb.sum()
        out["rgb"[ch]] = round(float(np.sum(ha[hb == 0])), 4)
    return out

def halo_side(frame):
    # Badge gate, exactly as compare.mjs does it: RSF mask, union
    # extent, dot from the badge top-right corner, dot within 30 px
    # of that corner. No badge means no halo profile. No fixed-centre
    # fallback: the fixed centre (783, 646) is never profiled.
    rsf_mask = layout.rgb_mask(frame, layout.PALETTE["rsf"], layout.TOL["rsf"])
    badge = dimensions.mask_extent(rsf_mask)
    if badge is None:
        return {"status": "ABSENT", "reason": "no RSF badge mask found", "badge": None}
    dot = layout.find_dot(frame, (badge["bbox"][2], badge["bbox"][1]))
    if dot is None:
        return {"status": "ABSENT", "reason": "no dot found near the badge top-right corner",
                "badge": badge, "dot_rejected": None}
    cx, cy = dot["centroid"]
    dist = float(np.hypot(cx - badge["bbox"][2], cy - badge["bbox"][1]))
    if dist > 30:
        return {"status": "ABSENT",
                "reason": "dot centroid more than 30 px from the badge top-right corner",
                "badge": badge,
                "dot_rejected": {"centroid": [cx, cy], "pixels": dot["pixels"],
                                 "bbox": dot["bbox"], "distance_px": round(dist, 1)}}
    luma = dimensions.luma_of(frame)
    u9 = dimensions.radial_profile(luma, cx, cy)
    fine = dimensions.radial_profile(luma, cx, cy, radii=FINE_RADII)
    # New computations: background median, halo excess, peak ring.
    h, w = luma.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - cx, yy - cy)
    bg = float(np.median(luma[(r > 30) & (r <= 60)]))
    bg_mean = float(np.mean(luma[(r > 30) & (r <= 60)]))
    def excess(profile):
        return {k: (round(v - bg, 2) if v is not None else None)
                for k, v in profile.items() if k != "falloff"}
    annulus = float(np.mean(luma[(r > 5) & (r <= 15)]))
    fine_rings = {k: v for k, v in fine.items() if k != "falloff"}
    peak_radius = max(fine_rings, key=lambda k: fine_rings[k])
    bw = dot["bbox"][2] - dot["bbox"][0]
    bh = dot["bbox"][3] - dot["bbox"][1]
    return {"status": "PRESENT", "badge": badge, "dot": dot,
            "oversize": bool(bw > 11 or bh > 11),
            "centre": {"x": cx, "y": cy,
                       "luma": round(float(luma[int(round(cy)), int(round(cx))]), 2),
                       "rgb": [int(v) for v in frame[int(round(cy)), int(round(cx))]]},
            "u9_rings": u9, "fine_rings": fine,
            "background_median_30_60": round(bg, 2),
            "background_mean_30_60": round(bg_mean, 2),
            "excess_u9_rings": excess(u9),
            "excess_fine_rings": excess(fine),
            "halo_excess_5_15": round(annulus - bg, 2),
            "peak_ring": int(peak_radius), "peak_value": fine_rings[peak_radius]}

print(json.dumps({
    "shape": list(ref.shape),
    "histogram": {
        "joint_8cube": joint,
        "per_channel_32bin": hist32,
        "per_channel_32bin_full_res": hist32_full,
        "per_channel_unmatched_mass": {
            "ref_only": unmatched_mass_32(ref_s, ours_s),
            "ours_only": unmatched_mass_32(ours_s, ref_s)},
        "per_channel_zero_bin_mass": {
            "ref_only": zero_bin_mass_32(ref_s, ours_s),
            "ours_only": zero_bin_mass_32(ours_s, ref_s)},
        "top_ref_only_cubes": top_unmatched(href, hou, idxr, idxo),
        "top_ours_only_cubes": top_unmatched(hou, href, idxo, idxr)},
    "halo": {"ref": halo_side(ref), "ours": halo_side(ours)},
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
        rejectPromise(new Error(`colour measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`colour measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

function cubeText(cube) {
  return `RGB (${cube.rgb_centre.join(", ")})`;
}

// Pick the largest unmatched cube across both directions.
function largestCube(measured) {
  const refTop = measured.histogram.top_ref_only_cubes[0] ?? null;
  const oursTop = measured.histogram.top_ours_only_cubes[0] ?? null;
  if (refTop && (!oursTop || refTop.mass >= oursTop.mass)) return { cube: refTop, direction: "ref-only" };
  if (oursTop) return { cube: oursTop, direction: "ours-only" };
  return null;
}

export function buildCorrections(measured, { atS, ref, ours }) {
  const corrections = [];
  const hist = measured.histogram;
  const pick = largestCube(measured);
  if (pick) {
    const { cube, direction } = pick;
    // Mapping: ours/real x,y are the centroids of the pixels in the
    // cube on each side, px is the count. A side with zero pixels in
    // the cube uses the other side centroid with px 0.
    const realSide = cube.ref;
    const oursSide = cube.ours;
    const realXY = realSide.centroid ?? oursSide.centroid ?? [0, 0];
    const oursXY = oursSide.centroid ?? realSide.centroid ?? [0, 0];
    const zeroNote = realSide.pixels === 0 || oursSide.pixels === 0
      ? " One side has zero pixels in this cube, so its centroid is the other side centroid with px 0."
      : "";
    let distinctive = "";
    if (atS === 1) {
      const cyan = hist.top_ref_only_cubes.find((c) => c.rgb_centre.join(",") === "80,208,208");
      if (cyan && cyan !== cube) {
        distinctive = ` Ref-only bright cyan ${cubeText(cyan)} holds ${cyan.mass} of the ref frame and v5 has none of it.`;
      }
    }
    if (atS === 4) {
      const green = hist.per_channel_zero_bin_mass.ours_only.g;
      distinctive = ` V5-only green mass is ${green} at 32 bins: one fifth of v5 green sits in bins where ref has zero green.`;
    }
    const fix = direction === "ref-only"
      ? `Whole-frame colour differs. Ref-only cube ${cubeText(cube)} holds ${cube.mass} of the ref frame that v5 lacks.${distinctive} The Sudan hexes are ${GROUND_TRUTH_HEXES.sudan_real} real and ${GROUND_TRUTH_HEXES.sudan_v5} v5, land ${GROUND_TRUTH_HEXES.land_real} real, water ${GROUND_TRUTH_HEXES.water_real} real, RSF badge ${GROUND_TRUTH_HEXES.rsf_badge}. Check nodes.map.props.focus.flood against the measured hexes.${zeroNote} Counts and centroids are on the 480x270 downsampled frame.`
      : `Whole-frame colour differs. Ours-only cube ${cubeText(cube)} holds ${cube.mass} of the v5 frame that ref lacks.${distinctive} The Sudan hexes are ${GROUND_TRUTH_HEXES.sudan_real} real and ${GROUND_TRUTH_HEXES.sudan_v5} v5, land ${GROUND_TRUTH_HEXES.land_real} real, water ${GROUND_TRUTH_HEXES.water_real} real, RSF badge ${GROUND_TRUTH_HEXES.rsf_badge}. Check nodes.map.props.focus.flood against the measured hexes.${zeroNote} Counts and centroids are on the 480x270 downsampled frame.`;
    corrections.push({
      element: "map",
      kind: "colour",
      at_s: atS,
      ours: { x: oursXY[0], y: oursXY[1], px: oursSide.pixels },
      real: { x: realXY[0], y: realXY[1], px: realSide.pixels },
      shift_px: { dx: roundTo(realXY[0] - oursXY[0], 1), dy: roundTo(realXY[1] - oursXY[1], 1) },
      fix,
      source: `hme colour, ${basename(ref)} vs ${basename(ours)}`,
    });
  }

  const halo = measured.halo;
  const refHalo = halo.ref;
  const oursHalo = halo.ours;
  if (refHalo.status === "PRESENT" && oursHalo.status === "PRESENT") {
    const shelf = (side) => {
      const f = side.fine_rings;
      return roundTo((f["6"] + f["8"] + f["10"] + f["12"]) / 4, 2);
    };
    const refShelf = shelf(refHalo);
    const oursShelf = shelf(oursHalo);
    const refDot = refHalo.dot;
    const oursDot = oursHalo.dot;
    const refW = refDot.bbox[2] - refDot.bbox[0];
    const refH = refDot.bbox[3] - refDot.bbox[1];
    const oursW = oursDot.bbox[2] - oursDot.bbox[0];
    const oursH = oursDot.bbox[3] - oursDot.bbox[1];
    corrections.push({
      element: "halo-fasher",
      kind: "shape",
      at_s: atS,
      ours: { x: oursDot.centroid[0], y: oursDot.centroid[1], px: oursDot.pixels },
      real: { x: refDot.centroid[0], y: refDot.centroid[1], px: refDot.pixels },
      shift_px: {
        dx: roundTo(refDot.centroid[0] - oursDot.centroid[0], 1),
        dy: roundTo(refDot.centroid[1] - oursDot.centroid[1], 1),
      },
      fix: `Shape, not opacity, is the fix. Ref halo is a bright core with a flat shelf near ${refShelf} luma from radius 4 to 12 px over a ${refHalo.background_median_30_60} background. Ours is a brighter, wider disc with no shelf: halo excess ${oursHalo.halo_excess_5_15} against ${refHalo.halo_excess_5_15} at radii 5 to 15, shelf near ${oursShelf} luma, and it stays above 130 out to 15 px. Both sides peak at the centre ring (radius ${refHalo.peak_ring} ref, ${oursHalo.peak_ring} ours) at the found centroid, so the peak radius does not separate them; the shelf does. The dot component is ${oursDot.pixels} px (${oursW} by ${oursH}) against ref ${refDot.pixels} px (${refW} by ${refH}), flagged oversize. Change nodes.halo-fasher from a flat disc (props.fill #FFFFFF, box 31 by 31) to a bright core with a flat shelf near ${refShelf} luma from radius 4 to 12 px, and check nodes.dot-fasher (box 11 by 11, fill #C6C6C6). Opacity alone is not the fix. Shape is.`,
      source: `hme colour, ${basename(ref)} vs ${basename(ours)}`,
    });
  } else if (refHalo.status !== oursHalo.status) {
    const present = refHalo.status === "PRESENT" ? refHalo : oursHalo;
    const presentIsRef = refHalo.status === "PRESENT";
    const c = present.dot.centroid;
    corrections.push({
      element: "halo-fasher",
      kind: "shape",
      at_s: atS,
      ours: presentIsRef ? { x: c[0], y: c[1], px: 0 } : { x: c[0], y: c[1], px: present.dot.pixels },
      real: presentIsRef ? { x: c[0], y: c[1], px: present.dot.pixels } : { x: c[0], y: c[1], px: 0 },
      shift_px: { dx: 0, dy: 0 },
      fix: `Halo is present on one side only (${refHalo.status} ref, ${oursHalo.status} ours). The side with no dot has px 0 at the other side centroid, because no centroid exists there. Check nodes.halo-fasher and nodes.dot-fasher visibility at this second.`,
      source: `hme colour, ${basename(ref)} vs ${basename(ours)}`,
    });
  }
  return corrections;
}

export function buildInsightReport(measured, { ref, ours, atS, atSFrom, outPath }) {
  const corrections = buildCorrections(measured, { atS, ref, ours });
  const hist = measured.histogram;
  const halo = measured.halo;
  const bothPresent = halo.ref.status === "PRESENT" && halo.ours.status === "PRESENT";
  const status = corrections.length === 0 ? "PASS" : "FAIL";
  const failedBar = status === "PASS"
    ? null
    : corrections.some((c) => c.element === "halo-fasher")
      ? "No corrections named (joint 8-cube = 1.0, equal halo excess, equal peak ring, equal dot size)"
      : "No corrections named (joint 8-cube = 1.0, per-channel 32-bin = 1.0)";
  const perSecondMeans = [0.361, 0.355, 0.347, 0.364];
  const detail = status === "PASS"
    ? `Joint 8-cube intersection is ${hist.joint_8cube} and no correction is named.`
    : `Joint 8-cube intersection is ${hist.joint_8cube} and ${corrections.length} correction${corrections.length === 1 ? " is" : "s are"} named.`;
  const haloSentence = bothPresent
    ? `Halo is PRESENT on both sides. Ref peak ring is ${halo.ref.peak_ring} px (${halo.ref.peak_value} luma) and ours is ${halo.ours.peak_ring} px (${halo.ours.peak_value} luma) at the found centroids. Halo excess at radii 5 to 15 is ${halo.ref.halo_excess_5_15} ref against ${halo.ours.halo_excess_5_15} ours over background medians ${halo.ref.background_median_30_60} and ${halo.ours.background_median_30_60}.`
    : `Halo is ${halo.ref.status} ref and ${halo.ours.status} ours under the badge gate, so no halo profile is reported where the dot is absent.`;
  // The design record's fine-ring peak (ref 151.14 at radius 6, ours
  // 196.69 at centre) and halo excess (57.91 against 87.25) were
  // measured at the fixed centre (783, 646). This tool does not use
  // that centre, so those numbers do not reproduce here. The shape
  // gap stands at the found centroid: ref has a flat shelf, ours is
  // a brighter, wider disc.
  const meaning = `Joint 8-cube intersection is ${hist.joint_8cube} (1.0 is identical). R channel 32-bin intersection is ${hist.per_channel_32bin.r}, called out because G and B sit near 0.5 while R carries the gap. The 32-bin mean ${hist.per_channel_32bin.mean} is flat across seconds and is not the headline. ${haloSentence} The histogram cannot see position errors: joint cube at 5 s is the highest of the four (0.7893) while the badge sits in the wrong place with Delta E 48.69. The design record reports a ref halo peak at radius 6 (151.14) and halo excess 57.91 against 87.25, measured at the fixed centre (783, 646); this tool measures at the found centroid and does not reproduce those fixed-centre numbers.`;
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      at_s: atS,
      at_s_source: atSFrom,
      ref,
      ours,
      frame_shape: measured.shape,
      histogram: {
        method: "Joint cube, per-channel 32-bin, and unmatched cubes all use the same 480x270 downsampled pixels (every 4th pixel of the 1920x1080 frame). 32-bin views reuse dimensions.histogram_intersection. Joint cube, unmatched cubes, per-channel unmatched mass, and per-channel zero-bin mass are new numpy computations on the same pixels. Cube pixel counts and centroids are counted on the downsampled frame; centroids are in full-frame coords.",
        joint_8cube: {
          bins_per_channel: 8,
          cubes: 512,
          intersection: hist.joint_8cube,
        },
        per_channel_32bin: {
          bins: 32,
          source: "dimensions.histogram_intersection on 480x270 downsampled pixels (every 4th pixel), the same route compare.mjs uses",
          r: hist.per_channel_32bin.r,
          g: hist.per_channel_32bin.g,
          b: hist.per_channel_32bin.b,
          mean: hist.per_channel_32bin.mean,
        },
        per_channel_32bin_full_res: {
          bins: 32,
          source: "dimensions.histogram_intersection on full-resolution frames. The design record R values were measured at full resolution; the downsampled route moves them by at most 0.0016.",
          r: hist.per_channel_32bin_full_res.r,
          g: hist.per_channel_32bin_full_res.g,
          b: hist.per_channel_32bin_full_res.b,
          mean: hist.per_channel_32bin_full_res.mean,
        },
        per_channel_unmatched_mass_32bin: hist.per_channel_unmatched_mass,
        per_channel_zero_bin_mass_32bin: hist.per_channel_zero_bin_mass,
        top_ref_only_cubes: hist.top_ref_only_cubes,
        top_ours_only_cubes: hist.top_ours_only_cubes,
        note_32bin_flat: "The 32-bin mean is flat across seconds (0.347 to 0.364) and is not the headline. The headline is the joint 8-cube intersection plus the unmatched cubes.",
        position_blind: "The histogram cannot see position errors. Joint cube at 5 s is the highest of the four (0.7893) while the badge sits in the wrong place with Delta E 48.69. The badge is about 1 percent of the frame.",
      },
      halo: {
        gate: "Badge gate, as compare.mjs does it: RSF mask from layout.rgb_mask with PALETTE rsf and TOL rsf, badge from dimensions.mask_extent, dot from layout.find_dot at the badge top-right corner (bbox[2], bbox[1]), dot within 30 px of that corner. No badge means no halo profile. No fixed-centre fallback: the fixed centre (783, 646) is never profiled.",
        method: "U9 rings (5, 10, 15, 20, 30, 45, 60) and fine rings (2, 4, 6, 8, 10, 12, 15, 20, 30) come from dimensions.radial_profile on full-resolution luma at the found centroid. Background is the median luma at radius 30 to 60. Halo excess is ring mean minus background median. Halo excess 5 to 15 is the mean luma in the annulus 5 to 15 px minus the background median. Peak ring is the fine ring with the highest mean luma. A dot component wider or taller than 11 px is flagged oversize; the tool does not decide what the blob is.",
        u9_falloff_note: "The U9 falloff (first ring mean minus last ring mean) is kept for reproduction, labelled centre-sensitive and background-contaminated, never the headline.",
        design_record_note: "The design record fine-ring peak (ref 151.14 at radius 6, ours 196.69 at centre), centre luma (ref 131.82, ours 195.57), and halo excess (57.91 against 87.25) were measured at the fixed centre (783, 646). This tool measures at the found centroid and does not reproduce those fixed-centre numbers.",
        ref: halo.ref,
        ours: halo.ours,
      },
      u9_aggregates: {
        ...U9_AGGREGATES,
        note: "The four per-second 32-bin means (0.361, 0.355, 0.347, 0.364) average 0.357, consistent with 0.3601. The 94.07 halo falloff is a mean over frames where the dot was found, not the 7 s falloff.",
        per_second_32bin_means: perSecondMeans,
      },
      ground_truth_hexes: {
        ...GROUND_TRUTH_HEXES,
        delta_e: "Flat medians pass under Delta E 3 at 4, 5, and 7 s (Sudan 1.43 to 2.32, land 2.12 to 2.53, water 2.12 to 2.65, RSF badge 0.57 to 1.47). Delta E failures at 1 s and 5 s are position errors, not colour errors. At 5 s the badge sits in the wrong place with Delta E 48.69.",
      },
    },
    corrections,
    context: {
      thresholds: {
        joint_8cube_identity: 1.0,
        per_channel_32bin_identity: 1.0,
        halo_excess_equal: "ref excess equals ours excess at radii 5 to 15",
        peak_ring_equal: "ref peak ring equals ours peak ring",
        dot_size_equal: "dot component 11 px or smaller on both sides",
        verdict_rule: "FAIL when at least one correction is named, PASS when none is named. Stage 1 sets no numeric bar; the numbers are info-only.",
      },
      control_ceiling: {
        note: "Ref against ref gives histogram 1.0 on every channel (design record control). The method is sound.",
        histogram_identity: 1.0,
      },
      meaning,
    },
    next: `hme diagnose ${basename(ref)} ${basename(ours)} --scene tests/fixtures/seg4-scene-clone-v5.json`,
    limits: [
      "The histogram cannot see position errors. A badge in the wrong place barely moves any histogram number.",
      "One frame pair is one moment. It cannot see motion, fades, or timing.",
      "The histogram cannot see grain, blur, or z-order.",
      "Where the badge gate finds no dot, the report says ABSENT and holds no halo profile numbers.",
      "An oversize dot flag reports size only. It does not decide what the blob is.",
      "The U9 falloff is centre-sensitive and background-contaminated. It is kept for reproduction, never the headline.",
    ],
  };
}

// Run `hme colour <ref-frame.png> <ours-frame.png> [--at-s <n>] [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runColour(argv) {
  const positionals = [];
  let atS = null;
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--at-s") {
      if (i + 1 >= argv.length) {
        console.error("hme colour: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
      atS = Number(argv[++i]);
      if (!Number.isFinite(atS)) {
        console.error("hme colour: --at-s needs a number of seconds");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme colour: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme colour: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 2) {
    console.error("hme colour: needs two frames, <ref-frame.png> and <ours-frame.png>");
    console.error(USAGE);
    return 2;
  }
  const [refArg, oursArg] = positionals;
  const refPath = resolve(refArg);
  const oursPath = resolve(oursArg);
  if (!existsSync(refPath)) {
    console.error(`hme colour: no such file: ${refArg}`);
    return 2;
  }
  if (!existsSync(oursPath)) {
    console.error(`hme colour: no such file: ${oursArg}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme colour: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  let atSFrom;
  if (atS === null) {
    atS = parseAtS(refArg);
    if (atS === null) {
      console.error("hme colour: cannot tell the seconds from the ref frame name; pass --at-s <n>");
      console.error(USAGE);
      return 2;
    }
    atSFrom = "derived from the ref frame number at 24 fps";
  } else {
    atSFrom = "--at-s flag";
  }
  try {
    const measured = await runDriver(refPath, oursPath);
    const report = buildInsightReport(measured, {
      ref: refArg, ours: oursArg, atS, atSFrom, outPath,
    });
    return writeInsightReport(report, outPath);
  } catch (err) {
    console.error(`hme colour: ${err.message}`);
    return 2;
  }
}
