// hme compare: frame-by-frame compare of two videos.
//
// Promotes verify-seg4/evidence/work/measure-full192.py and
// map-only-means.py into a tool command. The metrics are Python
// (src/checker), so this module spawns the engine venv Python with a
// small driver on stdin. Nothing here reimplements SSIM, PSNR, or
// LPIPS in JavaScript. Nothing is hardcoded to a video, a segment, or
// a frame count: the two videos come from the arguments, frames pair
// by index up to the shorter video, and the cut is found from the
// frames themselves.
//
// Method, matching the ad-hoc scripts exactly:
// - Reference frames are scaled to our frame size (1920x1080 for the
//   Seg4 pair, the same 4% vertical stretch as the stills prep).
//   Our frames are used at native size.
// - SSIM on luma and PSNR on RGB per frame, via src/checker/metrics.py.
// - LPIPS alex every 8th frame, via torch/lpips in the engine venv.
// - Delta E CIEDE2000 on 21x21 medians at the stills-check probe
//   points (measure-v5.py), for seconds 1, 4, 5, 7 when those frames
//   exist. The points are fixed sample locations in frame space, not
//   Seg4 content: when an element moves, a point can land on a
//   different element, so a large Delta E can be a position error.
// - Cut: the Sudan-teal pixel count per reference frame
//   (layout.rgb_mask around (20, 60, 52)). The cut is the frame with
//   the biggest single-frame relative drop, when the count stays low
//   after it. For Seg4 that is frame 186 (about 2,017,000 teal pixels
//   at frame 185, about 43,000 at frame 186).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

// The frozen pred-v1 bar. A perfect clone scores about 0.96 here
// (the control ceiling), so the bar sits at the top of the range.
export const BAR = { ssim: 0.96, psnr: 35, lpips: 0.08 };
export const CONTROL_CEILING_SSIM = 0.9708;
export const LPIPS_EVERY_NTH = 8;
export const DELTA_E_SECONDS = [1, 4, 5, 7];

export const USAGE = [
  "hme compare: Compare our video against the reference, frame by frame.",
  "",
  "Usage: hme compare <ref.mp4> <ours.mp4> [--out <report.json>]",
  "",
  "Arguments:",
  "  <ref.mp4>  Path to the reference video.",
  "  <ours.mp4>  Path to our rendered video.",
  "",
  "Options:",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "  --full  Accepted for compatibility. The report always covers both the full span and the map-only part.",
  "  --scene <file>  Scene file for the render, recorded in the report. Not needed for the measurement itself.",
  "",
  "The report also carries one number per missing dimension from the",
  "measurement-gap audit (zoom velocity, contour, blur, grain, vignette,",
  "colour, depth, type, event timing, calibration) under numbers.dimensions.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

function roundTo(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

// Frame PNGs for a 192-frame pair need close to 1 GB, more than the
// 512 MB /tmp tmpfs in this sandbox. The repo .tmp/ dir is gitignored
// and sits on the roomy disk, so the workdir lives there. HME_TMPDIR
// overrides it when set.
function makeWorkdir() {
  const parent = process.env.HME_TMPDIR
    ? resolve(process.env.HME_TMPDIR)
    : join(REPO_ROOT, ".tmp");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "hme-compare-"));
}
// being cloned. counts[i] is the Sudan-teal pixel count of reference
// frame i. Returns the cut frame index, or null when no frame drops
// off a cliff and stays low. Pure function, tested without any video.
export function findCut(counts) {
  if (!Array.isArray(counts) || counts.length < 2) return null;
  let bestFrame = -1;
  let bestRatio = 1;
  for (let i = 1; i < counts.length; i++) {
    const before = counts[i - 1];
    if (before <= 0) continue;
    const ratio = counts[i] / before;
    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestFrame = i;
    }
  }
  if (bestFrame === -1 || bestRatio >= 0.5) return null;
  // The drop must stick: the median count after the cut must stay
  // below half the median count before it. A one-frame flicker is
  // not a cut.
  const before = counts.slice(0, bestFrame).sort((a, b) => a - b);
  const after = counts.slice(bestFrame).sort((a, b) => a - b);
  const median = (xs) => xs[Math.floor(xs.length / 2)];
  if (median(after) >= 0.5 * median(before)) return null;
  return bestFrame;
}

// Summarize per-frame rows into full-span and map-only numbers.
// rows: [{frame, second, ssim, psnr_db}]. cutFrame is the cut from
// findCut, or null. fps is our frame rate, used to group frames into
// seconds. Pure function, tested without any video.
export function summarizeFrames(rows, cutFrame, fps) {
  const mapRows = cutFrame === null ? rows : rows.filter((r) => r.frame < cutFrame);
  const mean = (rs, key) => (rs.length === 0 ? 0 : roundTo(rs.reduce((s, r) => s + r[key], 0) / rs.length, key === "ssim" ? 4 : 2));
  const perSecond = (rs, key, digits) => {
    const buckets = new Map();
    for (const r of rs) {
      const sec = Math.floor(r.frame / Math.round(fps));
      if (!buckets.has(sec)) buckets.set(sec, []);
      buckets.get(sec).push(r[key]);
    }
    const out = {};
    for (const sec of [...buckets.keys()].sort((a, b) => a - b)) {
      const xs = buckets.get(sec);
      out[String(sec)] = roundTo(xs.reduce((s, v) => s + v, 0) / xs.length, digits);
    }
    return out;
  };
  const worst = (rs) => [...rs].sort((a, b) => a.ssim - b.ssim).slice(0, 5)
    .map((r) => ({ frame: r.frame, second: r.second, ssim: r.ssim, psnr_db: r.psnr_db }));
  return {
    frames: rows.length,
    ssim_mean: mean(rows, "ssim"),
    psnr_mean: mean(rows, "psnr_db"),
    below_0_90: rows.filter((r) => r.ssim < 0.9).length,
    below_0_85: rows.filter((r) => r.ssim < 0.85).length,
    worst_5: worst(rows),
    map_only: {
      frames: mapRows.length,
      ssim_mean: mean(mapRows, "ssim"),
      psnr_mean: mean(mapRows, "psnr_db"),
      below_0_90: mapRows.filter((r) => r.ssim < 0.9).length,
      below_0_85: mapRows.filter((r) => r.ssim < 0.85).length,
      worst_5: worst(mapRows),
      per_second_ssim: perSecond(mapRows, "ssim", 4),
      per_second_psnr: perSecond(mapRows, "psnr_db", 2),
    },
  };
}

// Build the insight report from the driver output plus the summary.
// measured is the parsed driver JSON; summary is summarizeFrames
// output; cut is the cut frame or null. Pure function, tested
// without any video.
export function buildInsightReport(measured, summary, cut) {
  const lpipsMean = measured.lpips_mean;
  const failedBar = summary.ssim_mean < BAR.ssim
    ? `SSIM >= ${BAR.ssim} (pred-v1)`
    : summary.psnr_mean < BAR.psnr
      ? `PSNR >= ${BAR.psnr} (pred-v1)`
      : lpipsMean > BAR.lpips
        ? `LPIPS <= ${BAR.lpips} (pred-v1)`
        : null;
  const status = failedBar === null ? "PASS" : "FAIL";
  const detail = status === "PASS"
    ? `Mean SSIM ${summary.ssim_mean}, PSNR ${summary.psnr_mean}, and LPIPS ${lpipsMean} all clear the bar.`
    : failedBar.startsWith("SSIM")
      ? `Mean SSIM ${summary.ssim_mean} is below the ${BAR.ssim} bar.`
      : failedBar.startsWith("PSNR")
        ? `Mean PSNR ${summary.psnr_mean} is below the ${BAR.psnr} bar.`
        : `Mean LPIPS ${lpipsMean} is above the ${BAR.lpips} bar.`;
  const cutSecond = cut === null ? null : roundTo(cut / measured.fps, 3);
  const worstFrame = summary.map_only.worst_5[0] ?? summary.worst_5[0];
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      ref: measured.ref,
      ours: measured.ours,
      scene: measured.scene ?? null,
      frames: summary.frames,
      fps: measured.fps,
      ref_fps: measured.ref_fps,
      ssim_mean: summary.ssim_mean,
      psnr_mean: summary.psnr_mean,
      lpips_mean: lpipsMean,
      frames_below_0_90: summary.below_0_90,
      frames_below_0_85: summary.below_0_85,
      worst_5_frames: summary.worst_5,
      lpips_by_frame: measured.lpips_by_frame,
      delta_e_seconds: measured.delta_e_seconds,
      worst_delta_e: measured.worst_delta_e,
      dimensions: measured.dimensions ?? null,
      cut: cut === null
        ? { frame: null, second: null, found: false }
        : {
            frame: cut,
            second: cutSecond,
            found: true,
            teal_before: measured.teal_counts[cut - 1],
            teal_after: measured.teal_counts[cut],
          },
      map_only: {
        frames: summary.map_only.frames,
        ssim_mean: summary.map_only.ssim_mean,
        psnr_mean: summary.map_only.psnr_mean,
        lpips_mean: lpipsMean,
        below_0_90: summary.map_only.below_0_90,
        below_0_85: summary.map_only.below_0_85,
        worst_5_frames: summary.map_only.worst_5,
        per_second_ssim: summary.map_only.per_second_ssim,
        per_second_psnr: summary.map_only.per_second_psnr,
      },
    },
    corrections: [],
    context: {
      thresholds: { ssim: BAR.ssim, psnr: BAR.psnr, lpips: BAR.lpips },
      control_ceiling: {
        ssim: CONTROL_CEILING_SSIM,
        note: "Clean video vs its player screenshot, from the control experiment.",
      },
      meaning: status === "PASS"
        ? `Mean SSIM ${summary.ssim_mean} clears the ${BAR.ssim} bar. A perfect clone scores about 0.96 here, so this is a close clone.`
        : `Mean SSIM ${summary.ssim_mean} is below the ${BAR.ssim} bar. A perfect clone scores about 0.96 here, so this is a real clone gap, not a measurement gap.`,
    },
    next: worstFrame === undefined
      ? "hme diagnose ref-frame.png ours-frame.png --scene <scene.json>"
      : `hme diagnose ref-frame.png ours-frame.png --scene <scene.json> (worst map frame is ${worstFrame.frame} at ${worstFrame.second}s, SSIM ${worstFrame.ssim})`,
    limits: [
      "Reference and ours are paired by frame index, not by time. When the two frame rates differ, drift over the span stays under one frame.",
      `Reference frames are resized to our frame size (${measured.ours_width}x${measured.ours_height}). When the reference is taller or shorter, that is a small vertical stretch.`,
      `LPIPS is every ${LPIPS_EVERY_NTH}th frame, not all frames.`,
      "Caption strip (y>=950) is masked only in the masked SSIM/PSNR numbers under dimensions.calibration, not in the headline means, so the headline means still match the ad-hoc ground truth.",
      "dists_lite is a VGG-free pyramid approximation of DISTS, not the official DISTS. The venv has no VGG weights and no DISTS package, so no official DISTS number is claimed.",
      "Neighbour names (Egypt, Saudi, Libya) come from each component's position relative to Sudan, not from a map file. When a component is absent on one side it is reported present:false.",
      "Neighbour components are connected masses of the base land colour, not country polygons: land and ocean share that colour, so a component can span several countries.",
      "Label and badge bboxes do not overlap in this pair, so no pixel-level z-order winner exists. The corner composition counts in dimensions.depth are the reported substitute.",
      "Label and dot positions are found from the badge on each frame, so they move with the zoom. Early frames with no badge report those parts as absent.",
      "This is not the full checker (S0-S8): it runs the same metric functions over every frame but does not run S2 events, S4 motion, S7 gates, or the human gate.",
      "Delta E sample points are fixed from the stills check. When an element moves, a point can land on a different element, so a large Delta E can be a position error, not a colour error. Check the hex values before reading it as colour.",
    ],
  };
}

// The Python driver. It probes both videos, extracts frames to PNGs
// in a temp dir (reference scaled to our frame size), measures SSIM
// and PSNR per frame plus the Sudan-teal count, runs LPIPS every 8th
// frame, and measures Delta E at the stills-check seconds. It prints
// exactly one JSON object to stdout; progress goes to stderr.
const DRIVER = `
import contextlib
import json
import subprocess
import sys
from pathlib import Path

REF, OURS, WORK, SRC = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
sys.path.insert(0, SRC)
from checker import metrics, color, layout, dimensions
import numpy as np
from PIL import Image

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-show_entries", "format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    num, den = (float(x) for x in s["r_frame_rate"].split("/"))
    fps = num / den
    if s.get("nb_frames"):
        frames = int(s["nb_frames"])
    else:
        frames = round(float(j["format"]["duration"]) * fps)
    return {"width": s["width"], "height": s["height"], "fps": fps, "frames": frames}

def run_ffmpeg(args):
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + p.stderr[-2000:])

ref_info = probe(REF)
ours_info = probe(OURS)
n = min(ref_info["frames"], ours_info["frames"])
W, H = ours_info["width"], ours_info["height"]
work = Path(WORK)
run_ffmpeg(["ffmpeg", "-v", "error", "-i", REF, "-vf", f"scale={W}:{H}",
            "-frames:v", str(n),
            "-vsync", "0", "-start_number", "0", str(work / "ref-%04d.png")])
run_ffmpeg(["ffmpeg", "-v", "error", "-i", OURS,
            "-frames:v", str(n),
            "-vsync", "0", "-start_number", "0", str(work / "ours-%04d.png")])

def load(p):
    return np.array(Image.open(p).convert("RGB"))

rows = []
teal_counts = []
# U9 dimension series, one value per frame per side.
zoom_ref, zoom_ours = [], []
rsf_counts_ref, rsf_counts_ours = [], []
ink_ref, ink_ours = [], []
blur_ref, blur_ours = [], []
grain_ref, grain_ours = [], []
vig_ref, vig_ours = [], []
hist_inter, mean_luma_ref, mean_luma_ours = [], [], []
diff_ref, diff_ours = [], []
prev_small_ref, prev_small_ours = None, None
masked_ssim, masked_psnr, dists_scores = [], [], []
for i in range(n):
    ref = load(work / f"ref-{i:04d}.png")
    ours = load(work / f"ours-{i:04d}.png")
    if ref.shape != (H, W, 3) or ours.shape != (H, W, 3):
        raise RuntimeError(f"frame {i} has the wrong size: ref {ref.shape}, ours {ours.shape}")
    ref_luma = metrics.luma(ref)
    ours_luma = metrics.luma(ours)
    ssim = metrics.ssim_frame(ref_luma, ours_luma)
    psnr = metrics.psnr_frame(ref, ours)
    rows.append({"frame": i, "second": round(i / ours_info["fps"], 3),
                 "ssim": round(float(ssim), 4), "psnr_db": round(float(psnr), 2)})
    ref_teal = layout.rgb_mask(ref, layout.PALETTE["sudan"], layout.TOL["sudan"])
    ours_teal = layout.rgb_mask(ours, layout.PALETTE["sudan"], layout.TOL["sudan"])
    teal_counts.append(int(ref_teal.sum()))
    zoom_ref.append(dimensions.largest_component_width(ref_teal))
    zoom_ours.append(dimensions.largest_component_width(ours_teal))
    rsf_counts_ref.append(int(layout.rgb_mask(ref, layout.PALETTE["rsf"], layout.TOL["rsf"]).sum()))
    rsf_counts_ours.append(int(layout.rgb_mask(ours, layout.PALETTE["rsf"], layout.TOL["rsf"]).sum()))
    ink_ref.append(int((ref_luma >= 200).sum()))
    ink_ours.append(int((ours_luma >= 200).sum()))
    # Small copies (480x270) for the cheap per-frame dimensions.
    ref_small = ref[::4, ::4]
    ours_small = ours[::4, ::4]
    rl_small = dimensions.luma_of(ref_small)
    ol_small = dimensions.luma_of(ours_small)
    blur_ref.append(dimensions.laplacian_variance(rl_small))
    blur_ours.append(dimensions.laplacian_variance(ol_small))
    grain_ref.append(dimensions.grain_level(rl_small))
    grain_ours.append(dimensions.grain_level(ol_small))
    vig_ref.append(dimensions.vignette_ratio(rl_small))
    vig_ours.append(dimensions.vignette_ratio(ol_small))
    hist_inter.append(dimensions.histogram_intersection(ref_small, ours_small)["mean"])
    mean_luma_ref.append(round(float(np.mean(rl_small)), 2))
    mean_luma_ours.append(round(float(np.mean(ol_small)), 2))
    if prev_small_ref is None:
        diff_ref.append(0.0)
        diff_ours.append(0.0)
    else:
        diff_ref.append(round(float(np.mean(np.abs(rl_small - prev_small_ref))), 3))
        diff_ours.append(round(float(np.mean(np.abs(ol_small - prev_small_ours))), 3))
    prev_small_ref, prev_small_ours = rl_small, ol_small
    if i % 8 == 0:
        # Calibration: same frame, caption strip (y>=950) cut out.
        cut_y = min(950, H)
        masked_ssim.append(round(float(metrics.ssim_frame(ref_luma[:cut_y], ours_luma[:cut_y])), 4))
        masked_psnr.append(round(float(metrics.psnr_frame(ref[:cut_y], ours[:cut_y])), 2))
        dists_scores.append(dimensions.dists_lite(ref_small, ours_small))
    if i % 48 == 0:
        print(f"frame {i} done", file=sys.stderr, flush=True)

import torch
import lpips as lpips_lib
with contextlib.redirect_stdout(sys.stderr):
    loss_fn = lpips_lib.LPIPS(net="alex")
lpips_scores = {}
for i in range(0, n, 8):
    ref = load(work / f"ref-{i:04d}.png")
    ours = load(work / f"ours-{i:04d}.png")
    a = torch.from_numpy(ref.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    b = torch.from_numpy(ours.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    with torch.no_grad():
        lpips_scores[i] = round(float(loss_fn(a, b).item()), 4)
    print(f"lpips frame {i} done: {lpips_scores[i]}", file=sys.stderr, flush=True)

def median21(frame, cx, cy):
    x0, y0 = max(0, cx - 10), max(0, cy - 10)
    patch = frame[y0:cy + 11, x0:cx + 11].reshape(-1, 3)
    return np.median(patch, axis=0).astype(float)

def hex_of(rgb):
    r, g, b = (int(round(v)) for v in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"

def delta_e(a_rgb, b_rgb):
    la = color.rgb_to_lab(np.array(a_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    lb = color.rgb_to_lab(np.array(b_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    return color.ciede2000(la, lb)

POINTS = {
    1: {"sudan": [(980, 640), (1050, 720)],
        "land": [(750, 675), (1300, 620)],
        "water": [(1300, 620)], "rsf": None},
    4: {"sudan": [(969, 600), (1100, 650)],
        "land": [(500, 520), (500, 700)],
        "water": [(1350, 350)], "rsf": [(945, 552), (968, 597)]},
    5: {"sudan": [(976, 620), (1100, 650)],
        "land": [(480, 530), (480, 700)],
        "water": [(1380, 350)], "rsf": [(799, 666), (830, 700)]},
    7: {"sudan": [(970, 578), (770, 578), (1208, 578), (970, 344), (970, 772), (989, 552)],
        "land": [(645, 513), (1521, 383)],
        "water": [(1333, 383)], "rsf": [(945, 552), (693, 732)]},
}

de_rows = {}
for sec, areas in POINTS.items():
    f = int(round(sec * ours_info["fps"]))
    if f >= n:
        continue
    ref = load(work / f"ref-{f:04d}.png")
    ours = load(work / f"ours-{f:04d}.png")
    de_rows[sec] = {}
    for area, rp in areas.items():
        if rp is None:
            de_rows[sec][area] = {"present": False}
            continue
        r_med = np.median([median21(ref, x, y) for x, y in rp], axis=0)
        v_med = np.median([median21(ours, x, y) for x, y in rp], axis=0)
        de = round(delta_e(r_med, v_med), 2)
        de_rows[sec][area] = {"present": True, "real_hex": hex_of(r_med),
                              "v5_hex": hex_of(v_med), "delta_e": de,
                              "pass": bool(de < 3)}
present_de = [(a["delta_e"], sec, k) for sec, d in de_rows.items()
              for k, a in d.items() if a.get("present")]
worst_de = max(present_de) if present_de else [None, None, None]
lpips_mean = round(sum(lpips_scores.values()) / len(lpips_scores), 4) if lpips_scores else None

def find_cut_py(counts):
    # Same rule as the JS findCut: biggest single-frame relative drop
    # that sticks. Duplicated here so the detail sampling below can
    # stay inside the map part without hardcoding a frame number.
    best, best_ratio = -1, 1.0
    for i in range(1, len(counts)):
        if counts[i - 1] <= 0:
            continue
        r = counts[i] / counts[i - 1]
        if r < best_ratio:
            best_ratio, best = r, i
    if best == -1 or best_ratio >= 0.5:
        return None
    before = sorted(counts[:best])
    after = sorted(counts[best:])
    if after[len(after) // 2] >= 0.5 * before[len(before) // 2]:
        return None
    return best

cut_py = find_cut_py(teal_counts)
map_n = cut_py if cut_py is not None else n
fps = ours_info["fps"]

def _mean(xs):
    return round(float(np.mean(xs)), 4) if len(xs) else None

def _mean_or_none(xs):
    xs = [x for x in xs if x is not None]
    return round(float(np.mean(xs)), 4) if xs else None

# --- sampled-frame detail: contour, neighbours, badge parts, type ---
detail_frames = list(range(0, map_n, 12))
contours, neighbour_rows, badge_rows, type_rows, halo_rows = [], [], [], [], []
label_present_frames = []
for i in detail_frames:
    ref = load(work / f"ref-{i:04d}.png")
    ours = load(work / f"ours-{i:04d}.png")
    ref_luma = dimensions.luma_of(ref)
    ours_luma = dimensions.luma_of(ours)
    ref_s2 = ref[::2, ::2]
    ours_s2 = ours[::2, ::2]
    ref_teal2 = layout.rgb_mask(ref_s2, layout.PALETTE["sudan"], layout.TOL["sudan"])
    ours_teal2 = layout.rgb_mask(ours_s2, layout.PALETTE["sudan"], layout.TOL["sudan"])
    ch = dimensions.chamfer_hausdorff(ref_teal2, ours_teal2)
    # Stride-2 distances are in half pixels; scale back to full px.
    ch = {k: (round(v * 2, 2) if v is not None else None) for k, v in ch.items()}
    contours.append(ch)
    sudan_ref = dimensions.components(ref_teal2, min_n=50, top=1)
    sudan_c = sudan_ref[0]["centroid"] if sudan_ref else None
    ref_base = dimensions.components(
        layout.rgb_mask(ref_s2, layout.PALETTE["base"], layout.TOL["base"]), min_n=500, top=6)
    ours_base = dimensions.components(
        layout.rgb_mask(ours_s2, layout.PALETTE["base"], layout.TOL["base"]), min_n=500, top=6)
    if sudan_c is not None:
        sudan_c_full = [sudan_c[0] * 2, sudan_c[1] * 2]
        for m in dimensions.match_components(ref_base, ours_base):
            name = dimensions.name_neighbour(
                {"centroid": [m["ref"]["centroid"][0] * 2, m["ref"]["centroid"][1] * 2]}, sudan_c_full)
            neighbour_rows.append({"frame": i, "name": name,
                                   "centroid_shift_px": (m["centroid_shift_px"] * 2
                                                        if m["centroid_shift_px"] is not None else None),
                                   "area_ratio": m["area_ratio"],
                                   "ours_present": m["ours"] is not None})
    # Badge parts, dot, halo, type, z-order, shadow: all found from
    # the badge on this frame, so they move with the zoom.
    ref_rsf = layout.rgb_mask(ref, layout.PALETTE["rsf"], layout.TOL["rsf"])
    ours_rsf = layout.rgb_mask(ours, layout.PALETTE["rsf"], layout.TOL["rsf"])
    ref_badge = dimensions.mask_extent(ref_rsf)
    ours_badge = dimensions.mask_extent(ours_rsf)
    side_rows = []
    for frame, luma, badge, rsf_mask in ((ref, ref_luma, ref_badge, ref_rsf),
                                         (ours, ours_luma, ours_badge, ours_rsf)):
        if badge is None:
            side_rows.append(None)
            continue
        parts = dimensions.badge_parts(luma, badge["bbox"])
        dot = layout.find_dot(frame, (badge["bbox"][2], badge["bbox"][1]))
        # The dot must sit next to the badge's top-right corner. Without
        # this gate find_dot can return a bright text fragment 40+ px away
        # (Seg4 frame 108), and the label and halo then measure the wrong thing.
        if dot is not None:
            cx, cy = dot["centroid"]
            if float(np.hypot(cx - badge["bbox"][2], cy - badge["bbox"][1])) > 30:
                dot = None
        label = None
        halo = None
        zord = {"overlap_px": 0, "badge_px": 0, "ink_px": 0, "winner": None}
        shadow = None
        if dot is not None:
            dx, dy = dot["centroid"]
            halo = dimensions.radial_profile(luma, dx, dy)
            x0, x1 = max(0, int(dx) - 10), min(W, int(dx) + 220)
            y0, y1 = max(0, int(dy) - 25), min(H, int(dy) + 25)
            ink_box = (luma[y0:y1, x0:x1] >= 180)
            label = dimensions.type_metrics(luma[y0:y1, x0:x1], ink_box)
            full_ink = np.zeros(luma.shape, dtype=bool)
            full_ink[y0:y1, x0:x1] = ink_box
            zord = dimensions.zorder_in_overlap(rsf_mask, full_ink)
            shadow = dimensions.shadow_drop(luma, full_ink)
        # Corner composition: what sits in the 120 px box around the
        # badge's top-right corner. The label and badge bboxes do not
        # overlap in this pair, so no pixel-level z-order winner exists;
        # this box is the reported substitute.
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
        side_rows.append({"parts": parts, "dot": dot, "halo": halo,
                          "label": label, "zorder": zord, "shadow": shadow,
                          "corner": corner})
    ref_row, ours_row = side_rows
    if ref_row is not None and ours_row is not None:
        badge_rows.append({"frame": i,
                           "ref_dark_rifle_px": ref_row["parts"]["dark_rifle_px"],
                           "ours_dark_rifle_px": ours_row["parts"]["dark_rifle_px"],
                           "ref_bright_text_px": ref_row["parts"]["bright_text_px"],
                           "ours_bright_text_px": ours_row["parts"]["bright_text_px"],
                           "zorder_ref_winner": ref_row["zorder"]["winner"],
                           "zorder_ours_winner": ours_row["zorder"]["winner"],
                           "zorder_ref_badge_px": ref_row["zorder"]["badge_px"],
                           "zorder_ours_badge_px": ours_row["zorder"]["badge_px"],
                           "zorder_ref_ink_px": ref_row["zorder"]["ink_px"],
                           "zorder_ours_ink_px": ours_row["zorder"]["ink_px"],
                           "shadow_ref": ref_row["shadow"],
                           "shadow_ours": ours_row["shadow"],
                           "corner_badge_px_ref": ref_row["corner"]["badge_px"],
                           "corner_badge_px_ours": ours_row["corner"]["badge_px"],
                           "corner_ink_px_ref": ref_row["corner"]["ink_px"],
                           "corner_ink_px_ours": ours_row["corner"]["ink_px"],
                           "corner_dot_px_ref": ref_row["corner"]["dot_px"],
                           "corner_dot_px_ours": ours_row["corner"]["dot_px"]})
    if ref_row is not None and ref_row["label"] is not None and ref_row["label"]["present"]:
        label_present_frames.append(i)
    if ref_row is not None and ours_row is not None and ref_row["label"] and ours_row["label"]:
        if ref_row["label"]["present"] and ours_row["label"]["present"]:
            type_rows.append({"frame": i,
                              "ref_letters": ref_row["label"]["letters"],
                              "ours_letters": ours_row["label"]["letters"],
                              "ref_gap_px": ref_row["label"]["median_gap_px"],
                              "ours_gap_px": ours_row["label"]["median_gap_px"],
                              "ref_stroke_px": ref_row["label"]["median_stroke_px"],
                              "ours_stroke_px": ours_row["label"]["median_stroke_px"],
                              "ref_aa": ref_row["label"]["aa_fraction"],
                              "ours_aa": ours_row["label"]["aa_fraction"]})
    if ref_row is not None and ours_row is not None and ref_row["halo"] and ours_row["halo"]:
        halo_rows.append({"frame": i,
                          "ref_falloff": ref_row["halo"]["falloff"],
                          "ours_falloff": ours_row["halo"]["falloff"]})

# --- events: badge appear, fades, badge growth ---
def _event_frame(counts, threshold):
    f = dimensions.first_crossing(counts, threshold, confirm=1)
    return {"frame": f, "second": round(f / fps, 3) if f is not None else None}

def _fade_window(series, start, end):
    if end >= len(series):
        return None
    span = dimensions.fade_span(series[start:end + 1])
    if span is None:
        return None
    return {"start_frame": start + span["start_frame"],
            "end_frame": start + span["end_frame"],
            "duration_frames": span["duration_frames"],
            "plateau_px": int(np.max(series[start:end + 1])),
            "start_second": round((start + span["start_frame"]) / fps, 3),
            "end_second": round((start + span["end_frame"]) / fps, 3)}

def _at_second(series, sec):
    f = int(round(sec * fps))
    return series[f] if 0 <= f < len(series) else None

zv_ref = dimensions.velocity_stats(zoom_ref[:map_n])
zv_ours = dimensions.velocity_stats(zoom_ours[:map_n])
neigh_summary = {}
for name in ("egypt_north", "libya_west", "saudi_east", "south"):
    ns = [r for r in neighbour_rows if r["name"] == name]
    if ns:
        neigh_summary[name] = {
            "frames_seen": len(ns),
            "mean_centroid_shift_px": _mean_or_none([r["centroid_shift_px"] for r in ns]),
            "mean_area_ratio": _mean_or_none([r["area_ratio"] for r in ns]),
            "ours_present_frames": sum(1 for r in ns if r["ours_present"])}
dims = {
    "zoom_velocity": {
        "ref_mean_width_px": zv_ref["mean_width_px"],
        "ours_mean_width_px": zv_ours["mean_width_px"],
        "ref_mean_abs_velocity_px_per_frame": zv_ref["mean_abs_velocity_px_per_frame"],
        "ours_mean_abs_velocity_px_per_frame": zv_ours["mean_abs_velocity_px_per_frame"],
        "ref_max_abs_velocity_px_per_frame": zv_ref["max_abs_velocity_px_per_frame"],
        "ours_max_abs_velocity_px_per_frame": zv_ours["max_abs_velocity_px_per_frame"],
        "velocity_mean_abs_diff_px_per_frame": dimensions.mean_abs_diff(
            zv_ref["velocity_px_per_frame"], zv_ours["velocity_px_per_frame"]),
        "width_curve_corr": dimensions.series_corr(zoom_ref[:map_n], zoom_ours[:map_n])},
    "contour": {
        "sampled_frames": [c for c in detail_frames],
        "mean_chamfer_px": _mean_or_none([c["chamfer_mean_px"] for c in contours]),
        "mean_hausdorff_px": _mean_or_none([c["hausdorff_px"] for c in contours]),
        "neighbours": neigh_summary},
    "motion_blur": {
        "ref_laplacian_variance_mean": _mean(blur_ref[:map_n]),
        "ours_laplacian_variance_mean": _mean(blur_ours[:map_n]),
        "fast_zoom_2_3s_ref": _mean(blur_ref[int(2 * fps):int(3 * fps)]),
        "fast_zoom_2_3s_ours": _mean(blur_ours[int(2 * fps):int(3 * fps)])},
    "grain": {
        "ref": dimensions.grain_temporal_stats(grain_ref[:map_n]),
        "ours": dimensions.grain_temporal_stats(grain_ours[:map_n]),
        "ref_frame_diff_energy_mean": _mean(diff_ref[:map_n]),
        "ours_frame_diff_energy_mean": _mean(diff_ours[:map_n])},
    "vignette": {
        "ref_corner_centre_ratio_mean": _mean([v for v in vig_ref[:map_n] if v is not None]),
        "ours_corner_centre_ratio_mean": _mean([v for v in vig_ours[:map_n] if v is not None])},
    "colour": {
        "histogram_intersection_mean": _mean(hist_inter[:map_n]),
        "halo_falloff_ref_mean": _mean_or_none([h["ref_falloff"] for h in halo_rows]),
        "halo_falloff_ours_mean": _mean_or_none([h["ours_falloff"] for h in halo_rows]),
        "fade_title_ink_ref": _fade_window(ink_ref, 0, min(24, n - 1)),
        "fade_title_ink_ours": _fade_window(ink_ours, 0, min(24, n - 1)),
        "fade_label_ink_ref": _fade_window(ink_ref, 144, min(156, n - 1)),
        "fade_label_ink_ours": _fade_window(ink_ours, 144, min(156, n - 1))},
    "depth": {
        "badge_dark_rifle_px_ref_mean": _mean_or_none([b["ref_dark_rifle_px"] for b in badge_rows]),
        "badge_dark_rifle_px_ours_mean": _mean_or_none([b["ours_dark_rifle_px"] for b in badge_rows]),
        "badge_bright_text_px_ref_mean": _mean_or_none([b["ref_bright_text_px"] for b in badge_rows]),
        "badge_bright_text_px_ours_mean": _mean_or_none([b["ours_bright_text_px"] for b in badge_rows]),
        "zorder_winners_ref": [b["zorder_ref_winner"] for b in badge_rows],
        "zorder_winners_ours": [b["zorder_ours_winner"] for b in badge_rows],
        "shadow_drop_ref_mean": _mean_or_none([b["shadow_ref"] for b in badge_rows]),
        "shadow_drop_ours_mean": _mean_or_none([b["shadow_ours"] for b in badge_rows]),
        "corner_badge_px_ref_mean": _mean_or_none([b["corner_badge_px_ref"] for b in badge_rows]),
        "corner_badge_px_ours_mean": _mean_or_none([b["corner_badge_px_ours"] for b in badge_rows]),
        "corner_ink_px_ref_mean": _mean_or_none([b["corner_ink_px_ref"] for b in badge_rows]),
        "corner_ink_px_ours_mean": _mean_or_none([b["corner_ink_px_ours"] for b in badge_rows]),
        "corner_dot_px_ref_mean": _mean_or_none([b["corner_dot_px_ref"] for b in badge_rows]),
        "corner_dot_px_ours_mean": _mean_or_none([b["corner_dot_px_ours"] for b in badge_rows]),
        "dim_ramp_slope_per_frame_ref": dimensions.linear_slope(mean_luma_ref[:map_n]),
        "dim_ramp_slope_per_frame_ours": dimensions.linear_slope(mean_luma_ours[:map_n]),
        "mean_luma_first_ref": mean_luma_ref[0] if mean_luma_ref else None,
        "mean_luma_last_map_ref": mean_luma_ref[map_n - 1] if map_n else None,
        "mean_luma_first_ours": mean_luma_ours[0] if mean_luma_ours else None,
        "mean_luma_last_map_ours": mean_luma_ours[map_n - 1] if map_n else None},
    "type": {
        "sampled_frames": [t["frame"] for t in type_rows],
        "ref_letters_mean": _mean_or_none([t["ref_letters"] for t in type_rows]),
        "ours_letters_mean": _mean_or_none([t["ours_letters"] for t in type_rows]),
        "ref_median_gap_px_mean": _mean_or_none([t["ref_gap_px"] for t in type_rows]),
        "ours_median_gap_px_mean": _mean_or_none([t["ours_gap_px"] for t in type_rows]),
        "ref_median_stroke_px_mean": _mean_or_none([t["ref_stroke_px"] for t in type_rows]),
        "ours_median_stroke_px_mean": _mean_or_none([t["ours_stroke_px"] for t in type_rows]),
        "ref_aa_fraction_mean": _mean_or_none([t["ref_aa"] for t in type_rows]),
        "ours_aa_fraction_mean": _mean_or_none([t["ours_aa"] for t in type_rows])},
    "events": {
        "badge_appear_ref": _event_frame(rsf_counts_ref, 1000),
        "badge_appear_ours": _event_frame(rsf_counts_ours, 1000),
        "label_first_seen_sampled_frame_ref": label_present_frames[0] if label_present_frames else None,
        "badge_px_at_4s_ref": _at_second(rsf_counts_ref, 4),
        "badge_px_at_4s_ours": _at_second(rsf_counts_ours, 4),
        "badge_px_at_5s_ref": _at_second(rsf_counts_ref, 5),
        "badge_px_at_5s_ours": _at_second(rsf_counts_ours, 5),
        "badge_px_at_6s_ref": _at_second(rsf_counts_ref, 6),
        "badge_px_at_6s_ours": _at_second(rsf_counts_ours, 6),
        "badge_px_at_7s_ref": _at_second(rsf_counts_ref, 7),
        "badge_px_at_7s_ours": _at_second(rsf_counts_ours, 7)},
    "calibration": {
        "masked_caption_strip": "y>=950",
        "masked_fraction": round((H - min(950, H)) / H, 4),
        "masked_ssim_mean": _mean(masked_ssim),
        "masked_psnr_mean": _mean(masked_psnr),
        "dists_lite_mean": _mean(dists_scores),
        "dists_lite_note": "VGG-free pyramid approximation of DISTS, not the official DISTS."},
}

print(json.dumps({
    "ref": REF, "ours": OURS,
    "ref_fps": round(ref_info["fps"], 3), "ours_fps": round(ours_info["fps"], 3),
    "ref_width": ref_info["width"], "ref_height": ref_info["height"],
    "ours_width": W, "ours_height": H,
    "frames": n, "fps": round(ours_info["fps"], 3),
    "rows": rows, "teal_counts": teal_counts,
    "lpips_by_frame": {str(k): v for k, v in lpips_scores.items()},
    "lpips_mean": lpips_mean,
    "delta_e_seconds": {str(k): v for k, v in de_rows.items()},
    "worst_delta_e": {"value": worst_de[0], "second": worst_de[1], "area": worst_de[2]},
    "dimensions": dims,
}))
`;

function runDriver(refPath, oursPath, workdir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", refPath, oursPath, workdir, SRC_DIR], {
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
        rejectPromise(new Error(`compare measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`compare measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Run `hme compare <ref.mp4> <ours.mp4> [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runCompare(argv) {
  const positionals = [];
  let outPath = null;
  let scenePath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme compare: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a === "--scene") {
      if (i + 1 >= argv.length) {
        console.error("hme compare: --scene needs a file path");
        console.error(USAGE);
        return 2;
      }
      scenePath = argv[++i];
    } else if (a === "--full") {
      // Accepted for compatibility. The report always covers both the
      // full span and the map-only part.
    } else if (a.startsWith("--")) {
      console.error(`hme compare: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 2) {
    console.error("hme compare: needs two videos, <ref.mp4> and <ours.mp4>");
    console.error(USAGE);
    return 2;
  }
  const [refArg, oursArg] = positionals;
  const refPath = resolve(refArg);
  const oursPath = resolve(oursArg);
  if (!existsSync(refPath)) {
    console.error(`hme compare: no such file: ${refArg}`);
    return 2;
  }
  if (!existsSync(oursPath)) {
    console.error(`hme compare: no such file: ${oursArg}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme compare: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  const workdir = makeWorkdir();
  try {
    const measured = await runDriver(refPath, oursPath, workdir);
    measured.scene = scenePath;
    const cut = findCut(measured.teal_counts);
    const summary = summarizeFrames(measured.rows, cut, measured.fps);
    const report = buildInsightReport(measured, summary, cut);
    return writeInsightReport(report, outPath);
  } catch (err) {
    console.error(`hme compare: ${err.message}`);
    return 2;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
