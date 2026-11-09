// Tests for the U9 compare gains: every missing dimension from the
// measurement-gap audit. The dimension functions live in Python
// (src/checker/dimensions.py), so these tests run them on small
// synthetic frames through the engine venv, plus check the JS side
// passes the dimensions through into the insight report. No video
// work here; the real pair is checked by the VERIFY run.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInsightReport, summarizeFrames } from "../../src/cli/compare.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENV_PYTHON = join(ROOT, ".venv", "bin", "python");

function py(code) {
  const r = spawnSync(VENV_PYTHON, ["-c", code], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `python failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}

const PRELUDE = `
import sys
sys.path.insert(0, "src")
import numpy as np
from checker import dimensions as d
`;

test("velocity_stats: width curve first difference is the zoom rate", () => {
  const out = py(`${PRELUDE}
s = d.velocity_stats([100, 110, 130, 130])
print(s["mean_width_px"], s["mean_abs_velocity_px_per_frame"], s["max_abs_velocity_px_per_frame"])
`);
  assert.equal(out, "117.5 10.0 20.0");
});

test("series_corr and mean_abs_diff behave on known series", () => {
  const out = py(`${PRELUDE}
print(d.series_corr([1, 2, 3, 4], [1, 2, 3, 4]))
print(d.series_corr([1, 2, 3, 4], [4, 3, 2, 1]))
print(d.mean_abs_diff([1, 2, 3], [2, 2, 2]))
print(d.series_corr([5, 5, 5], [1, 2, 3]))
`);
  assert.deepEqual(out.split("\n"), ["1.0", "-1.0", "0.6667", "None"]);
});

test("laplacian_variance: flat frame near zero, textured frame high", () => {
  const out = py(`${PRELUDE}
flat = np.full((20, 20), 100.0, dtype=np.float32)
rng = np.random.default_rng(0)
noisy = rng.normal(100, 30, (20, 20)).astype(np.float32)
print(d.laplacian_variance(flat) < 0.01)
print(d.laplacian_variance(noisy) > 100)
`);
  assert.deepEqual(out.split("\n"), ["True", "True"]);
});

test("grain_level: flat frame near zero, noisy frame positive", () => {
  const out = py(`${PRELUDE}
flat = np.full((20, 20), 100.0, dtype=np.float32)
rng = np.random.default_rng(1)
noisy = rng.normal(100, 20, (20, 20)).astype(np.float32)
print(d.grain_level(flat) < 0.01)
print(d.grain_level(noisy) > 5)
g = d.grain_temporal_stats([1.0, 1.0, 1.0, 1.0])
print(g["mean"], g["std_over_time"], g["lag1_autocorr"])
`);
  assert.deepEqual(out.split("\n"), ["True", "True", "1.0 0.0 None"]);
});

test("vignette_ratio: uniform frame is 1, dark corners below 1", () => {
  const out = py(`${PRELUDE}
flat = np.full((100, 100), 100.0, dtype=np.float32)
print(d.vignette_ratio(flat))
vig = np.full((100, 100), 100.0, dtype=np.float32)
vig[:10, :10] = 50; vig[:10, -10:] = 50; vig[-10:, :10] = 50; vig[-10:, -10:] = 50
print(d.vignette_ratio(vig))
`);
  assert.deepEqual(out.split("\n"), ["1.0", "0.5"]);
});

test("largest_component_width: stray specks do not stretch the subject width", () => {
  const out = py(`${PRELUDE}
m = np.zeros((50, 100), dtype=bool)
m[10:30, 20:50] = True
m[0, 0] = True
m[49, 99] = True
print(d.mask_width(m))
print(d.largest_component_width(m))
`);
  assert.deepEqual(out.split("\n"), ["100", "30"]);
});

test("histogram_intersection: identical frames score 1, shifted frames less", () => {
  const out = py(`${PRELUDE}
rng = np.random.default_rng(2)
a = rng.integers(0, 256, (30, 30, 3)).astype(np.uint8)
print(d.histogram_intersection(a, a)["mean"])
b = np.clip(a.astype(int) + 80, 0, 255).astype(np.uint8)
print(d.histogram_intersection(a, b)["mean"] < 0.9)
`);
  assert.deepEqual(out.split("\n"), ["1.0", "True"]);
});

test("dists_lite: identical frames score 1, different frames score less", () => {
  const out = py(`${PRELUDE}
rng = np.random.default_rng(3)
a = rng.integers(0, 256, (40, 40, 3)).astype(np.uint8)
print(d.dists_lite(a, a))
b = np.clip(a.astype(int) + 60, 0, 255).astype(np.uint8)
print(d.dists_lite(a, b) < 1.0)
print(d.dists_lite(a, b) > 0.0)
`);
  assert.deepEqual(out.split("\n"), ["1.0", "True", "True"]);
});

test("chamfer_hausdorff: identical masks score 0, shifted mask scores the shift", () => {
  const out = py(`${PRELUDE}
a = np.zeros((40, 40), dtype=bool); a[10:30, 10:30] = True
print(d.chamfer_hausdorff(a, a))
b = np.zeros((40, 40), dtype=bool); b[10:30, 15:35] = True
r = d.chamfer_hausdorff(a, b)
print(r["hausdorff_px"] >= 4.0)
print(r["chamfer_mean_px"] > 0)
`);
  const lines = out.split("\n");
  assert.ok(lines[0].includes("0.0"), lines[0]);
  assert.deepEqual(lines.slice(1), ["True", "True"]);
});

test("components and match_components: two blobs matched by centroid", () => {
  const out = py(`${PRELUDE}
m = np.zeros((50, 50), dtype=bool)
m[5:15, 5:15] = True
m[30:45, 30:45] = True
comps = d.components(m, min_n=10, top=6)
print(len(comps), comps[0]["n"], comps[1]["n"])
n2 = np.zeros((50, 50), dtype=bool)
n2[6:16, 6:16] = True
n2[31:46, 31:46] = True
matched = d.match_components(comps, d.components(n2, min_n=10, top=6))
print(len(matched), matched[0]["centroid_shift_px"], matched[0]["area_ratio"])
print(d.name_neighbour({"centroid": [10, 40]}, [25, 25]))
print(d.name_neighbour({"centroid": [40, 10]}, [25, 25]))
print(d.name_neighbour({"centroid": [25, 5]}, [25, 25]))
`);
  assert.deepEqual(out.split("\n"), [
    "2 225 100",
    "2 1.4 1.0",
    "libya_west",
    "saudi_east",
    "egypt_north",
  ]);
});

test("type_metrics: two letter boxes give a gap, a stroke, and an AA share", () => {
  const out = py(`${PRELUDE}
luma = np.full((30, 60), 20.0, dtype=np.float32)
ink = np.zeros((30, 60), dtype=bool)
ink[5:25, 5:15] = True
ink[5:25, 20:30] = True
luma[ink] = 255.0
# Anti-aliased edge: a dim ring just inside the ink border.
luma[5, 5:15] = 120.0
r = d.type_metrics(luma, ink)
print(r["present"], r["letters"], r["median_gap_px"], r["median_stroke_px"])
print(0.0 <= r["aa_fraction"] <= 1.0)
`);
  assert.deepEqual(out.split("\n"), ["True 2 5.0 4.0", "True"]);
});

test("radial_profile: falloff is centre minus outer ring", () => {
  const out = py(`${PRELUDE}
luma = np.full((50, 50), 40.0, dtype=np.float32)
luma[20:30, 20:30] = 200.0
p = d.radial_profile(luma, 25, 25)
print(p["falloff"] > 50)
print(p["5"] > p["30"])
`);
  assert.deepEqual(out.split("\n"), ["True", "True"]);
});

test("badge_parts, zorder, shadow: dark and bright parts split inside a badge", () => {
  const out = py(`${PRELUDE}
luma = np.full((40, 40), 120.0, dtype=np.float32)
luma[10:30, 10:30] = 150.0
luma[12:18, 12:28] = 30.0   # dark rifle bar
luma[25:28, 12:28] = 240.0  # bright text bar
parts = d.badge_parts(luma, [10, 10, 30, 30])
print(parts["dark_rifle_px"], parts["bright_text_px"])
badge = np.zeros((40, 40), dtype=bool); badge[10:30, 10:30] = True
ink = np.zeros((40, 40), dtype=bool); ink[15:20, 15:35] = True
z = d.zorder_in_overlap(badge, ink)
print(z["winner"], z["badge_px"] > 0, z["ink_px"] > 0)
print(d.shadow_drop(luma, ink) is not None)
`);
  assert.deepEqual(out.split("\n"), ["96 48", "tie True True", "True"]);
});

test("events: first crossing, fade span, and slope", () => {
  const out = py(`${PRELUDE}
print(d.first_crossing([0, 0, 5, 1200, 1500, 2000], 1000))
print(d.first_crossing([0, 0, 5], 1000))
print(d.fade_span([0, 10, 50, 90, 100, 100]))
print(d.linear_slope([0, 1, 2, 3]))
`);
  assert.deepEqual(out.split("\n"), ["3", "None", "{'start_frame': 1, 'end_frame': 3, 'duration_frames': 2}", "1.0"]);
});

function fakeMeasuredWithDims() {
  const rows = [0.8, 0.79, 0.81, 0.78].map((ssim, i) => ({
    frame: i, second: Math.round((i / 24) * 1000) / 1000, ssim, psnr_db: 20,
  }));
  return {
    ref: "ref.mp4", ours: "ours.mp4",
    ref_fps: 23.976, ours_fps: 24,
    ref_width: 1920, ref_height: 1038,
    ours_width: 1920, ours_height: 1080,
    frames: 4, fps: 24, rows,
    teal_counts: [2000000, 2000000, 2000000, 2000000],
    lpips_by_frame: { 0: 0.63 }, lpips_mean: 0.63,
    delta_e_seconds: {},
    worst_delta_e: { value: 1.5, second: 1, area: "sudan" },
    dimensions: {
      zoom_velocity: { ref_mean_width_px: 500, ours_mean_width_px: 490,
        ref_mean_abs_velocity_px_per_frame: 5, ours_mean_abs_velocity_px_per_frame: 4.5,
        velocity_mean_abs_diff_px_per_frame: 1.2, width_curve_corr: 0.99 },
      contour: { mean_chamfer_px: 2.5, mean_hausdorff_px: 12, neighbours: {} },
      motion_blur: { ref_laplacian_variance_mean: 100, ours_laplacian_variance_mean: 90 },
      grain: { ref: { mean: 3 }, ours: { mean: 1 } },
      vignette: { ref_corner_centre_ratio_mean: 0.95, ours_corner_centre_ratio_mean: 0.8 },
      colour: { histogram_intersection_mean: 0.7 },
      depth: { dim_ramp_slope_per_frame_ref: 0.01, dim_ramp_slope_per_frame_ours: 0.02 },
      type: { ref_median_gap_px_mean: 5, ours_median_gap_px_mean: 6 },
      events: { badge_appear_ref: { frame: 83, second: 3.458 } },
      calibration: { masked_ssim_mean: 0.8, dists_lite_mean: 0.75,
        dists_lite_note: "VGG-free pyramid approximation of DISTS, not the official DISTS." },
    },
  };
}

test("buildInsightReport passes dimensions through and still validates", () => {
  const measured = fakeMeasuredWithDims();
  const summary = summarizeFrames(measured.rows, null, 24);
  const report = buildInsightReport(measured, summary, null);
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.numbers.dimensions.zoom_velocity.ref_mean_width_px, 500);
  assert.equal(report.numbers.dimensions.calibration.dists_lite_mean, 0.75);
  assert.equal(report.numbers.dimensions.events.badge_appear_ref.frame, 83);
  assert.ok(report.limits.some((l) => l.includes("dists_lite")));
  assert.ok(report.limits.some((l) => l.includes("Caption strip")));
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("buildInsightReport without dimensions reports null, not a crash", () => {
  const measured = fakeMeasuredWithDims();
  delete measured.dimensions;
  const summary = summarizeFrames(measured.rows, null, 24);
  const report = buildInsightReport(measured, summary, null);
  assert.equal(report.numbers.dimensions, null);
  const { valid } = validateInsight(report);
  assert.equal(valid, true);
});
