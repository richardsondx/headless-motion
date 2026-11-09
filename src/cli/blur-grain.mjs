// hme blur-grain: measure motion blur and grain over time in one video.
//
// B2 adds pair mode, per-second blur aggregation, denoised blur, and
// the blur ratio on top of the B1 decode and driver. B3 adds grain
// over time: flat-region residual correlation, flat-region
// frame-difference energy, and flat-region grain level, per second.
// B4 adds corrections: a blur correction in scene terms when the
// ratio gap is present, and a grain correction in scene terms when
// the residual correlation gap is present. Each correction fires
// only on its own gap, so a pair with no gap names no correction,
// and a single video names none at all.
//
// Grain method, the tested method from the design record:
// - The residual is luma minus its 3x3 mean blur, the same residual
//   grain_level uses. Flat means local gradient under 2.0
//   (|gx| + |gy| < 2.0), the same flat test the probe used. Static
//   means flat and uniform during a zoom, not geometrically fixed:
//   during a zoom every pixel moves, but a flat region keeps the
//   same pixel values, so motion does not change what is measured.
// - Flat-region residual correlation is the Pearson correlation of
//   the residual in one frame with the residual in the next frame,
//   over pixels flat in both frames. Frozen grain repeats the same
//   pattern, so it correlates near 1; live grain changes every
//   frame, so it correlates low. This is the frozen-versus-live
//   headline. Flat grain level is amount only and never decides
//   frozen-ness: ours has more grain yet is frozen.
// - Per second, correlation and flat diff use the first consecutive
//   pair of the second (frames s*24 and s*24+1), exactly the pair
//   the probe sampled and the bands were set on. Averaging every
//   pair in the second is a different statistic: mid-zoom pairs
//   decorrelate (ours mean 0.949, second 3 at 0.847) and flat diff
//   spikes (ours mean 0.137), because content moves through the
//   3x3 neighbourhood and changes residuals even on pixels flat in
//   both frames. The probe pair gives ours 0.991 mean, lowest
//   second 0.941, and flat diff 0.023. The per-frame series still
//   hold every pair; only the per-second value uses the probe pair.
// - Flat-region frame-difference energy is the mean absolute luma
//   change from the previous frame over pixels flat in both frames.
//   Whole-frame frame-difference energy is not a grain verdict:
//   it tracks zoom speed. Lag-1 autocorr of grain level is not a
//   grain verdict either: it sits near 1 on both sides.
//
// Method, matching the compare command exactly:
// - Frames are extracted with ffmpeg to PNGs in a temp dir. In pair
//   mode the reference frames are scaled to our frame size first
//   (1920x1080 for the Seg4 pair, the same 4% vertical stretch as
//   the stills prep), exactly as the compare command scales them.
//   Our frames are used at native size. A single video is measured
//   at native size: there is no pair target to scale to.
// - Blur and grain are measured on small copies (every 4th pixel,
//   480x270 for a 1920x1080 frame) with src/checker/dimensions.py:
//   dimensions.laplacian_variance for blur, dimensions.grain_level
//   for grain. Frame-difference energy is the mean absolute luma
//   change from the previous frame, on the same small copies.
// - Nothing is hardcoded to a video, a segment, or a frame count:
//   the video comes from the argument, fps comes from ffprobe, and
//   every frame is measured.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

export const USAGE = [
  "hme blur-grain: Measure motion blur and grain over time in one video.",
  "",
  "Usage: hme blur-grain video.mp4 [--out <report.json>]",
  "       hme blur-grain <reference.mp4> <ours.mp4> [--out <report.json>]",
  "",
  "Arguments:",
  "  video.mp4       Path to the video to measure.",
  "  reference.mp4   First video of a pair (the reference).",
  "  ours.mp4        Second video of a pair (our render).",
  "",
  "Options:",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "The report holds one value per frame: blur (Laplacian variance of",
  "luma), denoised blur (Laplacian variance after a 3x3 mean blur),",
  "grain level, and frame-difference energy, plus the frame count and",
  "fps. It also holds one blur value per second, the blur ratio:",
  "mean blur over fast seconds 2-3 divided by blur over title-free",
  "held second 7, and one grain value per second: flat-region residual",
  "correlation with the next frame, flat-region frame-difference",
  "energy, and flat-region grain level. Each video is compared with",
  "its own baseline.",
  "Pair mode reports both videos plus the gap between them. It also",
  "names a correction in scene terms for each gap it finds: motion",
  "blur for the camera zoom, live grain for the frozen tile. One",
  "video alone names no correction.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

function roundTo(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function meanOf(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return 0;
  return roundTo(xs.reduce((s, v) => s + v, 0) / xs.length, 3);
}

// Map span: frames 0 to 185. Frames 186 and later are phone footage,
// not the map. All pair numbers use this span, the same span U9 used
// in the compare command (map_n = 186, cut at frame 186).
export const MAP_SPAN_FRAMES = 186;
// U9 fast zoom is the [2s, 3s) slice: frames 48 to 71 at 24 fps.
export const FAST_ZOOM_START_S = 2;
export const FAST_ZOOM_END_S = 3;
// Blur ratio numerator: frames of seconds 2 and 3, [2s, 4s).
export const RATIO_FAST_START_S = 2;
export const RATIO_FAST_END_S = 4;
// Blur ratio baseline: title-free held second 7, frames 168 to 185
// inside the map span.
export const HELD_SECOND = 7;
// Blur ratio bands from the tested design (stage1-02).
export const BLUR_RATIO_REFERENCE_LOW = 0.2;
export const BLUR_RATIO_REFERENCE_HIGH = 0.45;
export const BLUR_RATIO_OURS_LOW = 0.65;
export const BLUR_RATIO_OURS_HIGH = 0.9;
// Grain bands from the tested design (stage1-02). Flat means local
// gradient under 2.0. Frozen: mean residual correlation 0.95 or
// higher, every second 0.90 or higher. Live: mean residual
// correlation 0.85 or lower. Flat diff: reference mean 0.10 or
// higher, ours mean 0.05 or lower. Flat grain level is amount only
// and never decides frozen-ness, so it has no band here.
export const GRAIN_FROZEN_MEAN_MIN = 0.95;
export const GRAIN_FROZEN_PER_SECOND_MIN = 0.9;
export const GRAIN_LIVE_MEAN_MAX = 0.85;
export const GRAIN_FLAT_DIFF_REFERENCE_MIN = 0.1;
export const GRAIN_FLAT_DIFF_OURS_MAX = 0.05;
// Flat test: a pixel is flat when |gx| + |gy| < 2.0, the same flat
// test the probe used.
export const FLAT_GRADIENT_MAX = 2.0;

// Mean of series[start..end), clamped to the series. Null when the
// slice is empty.
export function meanOver(series, start, end) {
  const lo = Math.max(0, Math.floor(start));
  const hi = Math.min(series.length, Math.ceil(end));
  if (hi <= lo) return null;
  return roundTo(series.slice(lo, hi).reduce((s, v) => s + v, 0) / (hi - lo), 3);
}

// Mean per second of a per-frame series. Second s covers frames
// [s*fps, (s+1)*fps) by frame index, the same frame-indexed seconds
// the compare command uses (it groups by Math.round(fps), so the
// 23.976 fps reference and the 24 fps render share the same frame
// ranges). Only frames inside the map span are used.
export function perSecondMeans(series, fps) {
  const step = Math.max(1, Math.round(fps));
  const spanEnd = Math.min(MAP_SPAN_FRAMES, series.length);
  const out = [];
  for (let s = 0; s * step < spanEnd; s++) {
    out.push(meanOver(series, s * step, Math.min((s + 1) * step, spanEnd)));
  }
  return out;
}

// Mean of series[start..end), clamped to the series, skipping
// null and undefined entries (the first frame has no previous frame,
// so its flat diff and residual correlation are null). Null when
// the slice holds no number.
export function meanOverNonNull(series, start, end) {
  const lo = Math.max(0, Math.floor(start));
  const hi = Math.min(series.length, Math.ceil(end));
  const vals = series.slice(lo, hi).filter((v) => typeof v === "number");
  if (vals.length === 0) return null;
  return roundTo(vals.reduce((s, v) => s + v, 0) / vals.length, 3);
}

// Mean per second of a per-frame series that may hold nulls, same
// frame-indexed seconds as perSecondMeans. Only frames inside the
// map span are used.
export function perSecondMeansNonNull(series, fps) {
  const step = Math.max(1, Math.round(fps));
  const spanEnd = Math.min(MAP_SPAN_FRAMES, series.length);
  const out = [];
  for (let s = 0; s * step < spanEnd; s++) {
    out.push(meanOverNonNull(series, s * step, Math.min((s + 1) * step, spanEnd)));
  }
  return out;
}

// Mean of a per-second series, skipping null seconds. Null when
// there is no number.
export function meanOfPerSecond(perSecond) {
  const vals = (perSecond ?? []).filter((v) => typeof v === "number");
  if (vals.length === 0) return null;
  return roundTo(vals.reduce((s, v) => s + v, 0) / vals.length, 3);
}

// One value per second from a per-frame pair series (flat residual
// correlation, flat frame-diff energy): the value on the second
// pair of the second, frames (s*step, s*step+1), the first
// consecutive pair of the second. This is the probe's sampling and
// the sampling the bands were set on. Null when the pair falls
// outside the map span.
export function probePairPerSecond(series, fps) {
  const step = Math.max(1, Math.round(fps));
  const spanEnd = Math.min(MAP_SPAN_FRAMES, series.length);
  const out = [];
  for (let s = 0; s * step < spanEnd; s++) {
    const idx = s * step + 1;
    out.push(idx < spanEnd && typeof series[idx] === "number" ? roundTo(series[idx], 3) : null);
  }
  return out;
}

// Grain summary of one measured video, over the map span. Per
// second: flat-region residual correlation with the next frame,
// flat-region frame-difference energy, and flat-region grain level.
// Correlation and flat diff take the probe pair of each second (see
// probePairPerSecond); flat grain level is the mean over all frames
// of the second. The means are the means of the eight per-second
// values, so each second weighs the same. Flat grain level is
// reported as amount only and never decides frozen-ness. Pure
// function, tested without any video.
export function summarizeGrain(measured) {
  const corrPerSecond = probePairPerSecond(measured.flat_residual_correlation_per_frame ?? [], measured.fps);
  const flatDiffPerSecond = probePairPerSecond(measured.flat_frame_diff_energy_per_frame ?? [], measured.fps);
  const flatGrainPerSecond = perSecondMeansNonNull(measured.flat_grain_level_per_frame ?? [], measured.fps);
  return {
    flat_residual_correlation_per_second: corrPerSecond,
    flat_frame_diff_energy_per_second: flatDiffPerSecond,
    flat_grain_level_per_second: flatGrainPerSecond,
    flat_residual_correlation_mean: meanOfPerSecond(corrPerSecond),
    flat_frame_diff_energy_mean: meanOfPerSecond(flatDiffPerSecond),
    flat_grain_level_mean: meanOfPerSecond(flatGrainPerSecond),
    flat_fraction_per_second: perSecondMeansNonNull(measured.flat_fraction_per_frame ?? [], measured.fps),
  };
}

// Blur summary of one measured video, over the map span. The blur
// ratio is the headline: mean blur over fast seconds 2-3 divided by
// blur over title-free held second 7. Each video is compared with
// its own baseline, so content cannot drive the number. Absolute
// levels stay in the report as U9 reproduction reference, not as
// the verdict. Pure function, tested without any video.
export function summarizeBlur(measured) {
  const step = Math.max(1, Math.round(measured.fps));
  const blur = measured.blur_laplacian_variance_per_frame;
  const denoised = measured.blur_denoised_laplacian_variance_per_frame ?? [];
  const spanEnd = Math.min(MAP_SPAN_FRAMES, blur.length);
  const fastSecondsMean = meanOver(blur, RATIO_FAST_START_S * step, Math.min(RATIO_FAST_END_S * step, spanEnd));
  const heldMean = meanOver(blur, HELD_SECOND * step, spanEnd);
  const ratio = fastSecondsMean === null || heldMean === null || heldMean === 0
    ? null
    : roundTo(fastSecondsMean / heldMean, 3);
  return {
    blur_laplacian_variance_per_second: perSecondMeans(blur, measured.fps),
    blur_denoised_laplacian_variance_per_second: perSecondMeans(denoised, measured.fps),
    blur_laplacian_variance_map_span_mean: meanOver(blur, 0, spanEnd),
    fast_zoom_2_3s: meanOver(blur, FAST_ZOOM_START_S * step, FAST_ZOOM_END_S * step),
    fast_seconds_2_3_mean: fastSecondsMean,
    held_second_7_mean: heldMean,
    blur_ratio: ratio,
  };
}

// Per-video numbers block, shared by the single-video and pair
// reports: the B1 per-frame series and means, plus the B2 per-second
// blur series, denoised blur, map-span mean, fast-zoom means, and
// blur ratio, plus the B3 per-second grain series: flat-region
// residual correlation, flat-region frame-difference energy, and
// flat-region grain level.
export function videoNumbers(measured, videoArg) {
  return {
    video: videoArg,
    width: measured.width,
    height: measured.height,
    fps: measured.fps,
    frames: measured.frames,
    blur_laplacian_variance_per_frame: measured.blur_laplacian_variance_per_frame,
    blur_denoised_laplacian_variance_per_frame: measured.blur_denoised_laplacian_variance_per_frame ?? [],
    grain_level_per_frame: measured.grain_level_per_frame,
    frame_diff_energy_per_frame: measured.frame_diff_energy_per_frame,
    flat_grain_level_per_frame: measured.flat_grain_level_per_frame ?? [],
    flat_frame_diff_energy_per_frame: measured.flat_frame_diff_energy_per_frame ?? [],
    flat_residual_correlation_per_frame: measured.flat_residual_correlation_per_frame ?? [],
    flat_fraction_per_frame: measured.flat_fraction_per_frame ?? [],
    blur_laplacian_variance_mean: measured.blur_laplacian_variance_mean,
    blur_denoised_laplacian_variance_mean: measured.blur_denoised_laplacian_variance_mean ?? null,
    grain_level_mean: measured.grain_level_mean,
    frame_diff_energy_mean: measured.frame_diff_energy_mean,
    ...summarizeBlur(measured),
    ...summarizeGrain(measured),
  };
}

// Frame PNGs for a 192-frame video need close to 1 GB, more than the
// 512 MB /tmp tmpfs in this sandbox. The repo .tmp/ dir is gitignored
// and sits on the roomy disk, so the workdir lives there. HME_TMPDIR
// overrides it when set. Same rule as the compare command.
function makeWorkdir() {
  const parent = process.env.HME_TMPDIR
    ? resolve(process.env.HME_TMPDIR)
    : join(REPO_ROOT, ".tmp");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "hme-blur-grain-"));
}

// Build the insight report from one measured video. Pure function,
// tested without any video. B2 adds the per-second blur series, the
// denoised blur series, and the blur ratio; B3 adds grain over time.
// The single-video verdict is always PASS: there is no pair bar to
// fail, and the report says so in plain words. A single video names
// no correction: a blur or grain gap needs a reference video, so
// corrections is always empty here.
export function buildInsightReport(measured, videoArg) {
  const numbers = videoNumbers(measured, videoArg);
  return {
    verdict: {
      status: "PASS",
      failed_bar: null,
      detail: `Measured one video (${numbers.frames} frames at ${numbers.fps} fps): per-frame blur (Laplacian variance), grain level, and frame-difference energy are recorded, with one blur value per second and the blur ratio (fast seconds 2-3 over held second 7: ${numbers.blur_ratio}), and one grain value per second: flat-region residual correlation (mean ${numbers.flat_residual_correlation_mean}), flat-region frame-difference energy (mean ${numbers.flat_frame_diff_energy_mean}), and flat-region grain level (mean ${numbers.flat_grain_level_mean}). No pair bar applies to a single video, so no blur or grain gap can be judged from this report alone.`,
    },
    numbers,
    corrections: [],
    context: {
      thresholds: {},
      control_ceiling: null,
      meaning: "One video alone records its own blur and grain over time. A blur or grain gap needs a reference video to compare against, so this report judges nothing and names no fix.",
    },
    next: "hme blur-grain <reference.mp4> --out out/blur-grain-ref.json",
    limits: [
      "A single-video report cannot judge blur or grain gaps: there is no reference to compare against.",
      "Blur and grain are measured on small copies (every 4th pixel, 480x270 for a 1920x1080 frame), the same copies the compare command uses.",
      "Frame-difference energy is the mean absolute luma change from the previous frame. The first frame reports 0.",
      "Pair numbers use the map span, frames 0 to 185. Frames 186 and later are phone footage, not the map.",
      "Flat means local gradient under 2.0 (|gx| + |gy| < 2.0). Flat-region numbers use pixels flat in both frames of a pair.",
      "Per second, residual correlation and flat diff use the first consecutive pair of the second, the probe pair the bands were set on. The per-frame series hold every pair; averaging every pair in a second is a different statistic and is not used.",
      "A single video names no correction: a blur or grain gap needs a reference video to compare against, so corrections is empty here.",
    ],
  };
}

// Frozen grain: mean flat-region residual correlation 0.95 or
// higher, with every second 0.90 or higher. Live grain: mean 0.85
// or lower. Pure helpers on a video numbers block, shared by the
// verdict and the corrections so both read the same bars.
export function isFrozenGrain(numbers) {
  const mean = numbers.flat_residual_correlation_mean;
  const perSecond = numbers.flat_residual_correlation_per_second ?? [];
  const vals = perSecond.filter((v) => typeof v === "number");
  return mean !== null && mean >= GRAIN_FROZEN_MEAN_MIN
    && vals.length === perSecond.length
    && vals.every((v) => v >= GRAIN_FROZEN_PER_SECOND_MIN);
}

export function isLiveGrain(numbers) {
  const mean = numbers.flat_residual_correlation_mean;
  return mean !== null && mean <= GRAIN_LIVE_MEAN_MAX;
}

// The blur gap is present when the reference ratio sits in its band
// (the fast zoom blurs there) and ours sits at 0.65 or higher (the
// fast zoom stays crisp in ours). No upper bound on ours: a ratio
// above 0.90 is even crisper, so the fix still applies. The verdict
// band keeps its upper bound; only the correction trigger is open
// above it.
export function hasBlurGap(reference, ours) {
  const refRatio = reference.blur_ratio;
  const oursRatio = ours.blur_ratio;
  return refRatio !== null && oursRatio !== null
    && refRatio >= BLUR_RATIO_REFERENCE_LOW && refRatio <= BLUR_RATIO_REFERENCE_HIGH
    && oursRatio >= BLUR_RATIO_OURS_LOW;
}

// Corrections for a pair, in scene terms. One correction per gap,
// each firing only on its own gap:
// - Blur: the ratio gap (reference blurs, ours stays crisp). The
//   fix names the time span and the scene change, not just the
//   numbers: the camera zoom between 0:02 and 0:03.
// - Grain: the residual correlation gap (ours frozen, reference
//   live). The fix names the scene change and the span, and rests
//   on the means: the reference per-second correlation swings wide
//   (0.268 to 0.982 on the Seg4 pair), so no single second decides
//   it. A pair with no gap names no correction.
// Pure function, tested without any video. The correction objects
// follow the insight shape: ours and real carry the measured
// numbers (x is the headline number, y the supporting number, px
// is 0 because no pixel count applies), shift_px is real minus
// ours, fix is the scene-terms text, source names the command.
export function buildCorrections(reference, ours) {
  const corrections = [];
  if (hasBlurGap(reference, ours)) {
    corrections.push({
      element: "camera zoom",
      kind: "motion-blur",
      at_s: FAST_ZOOM_START_S,
      ours: { x: ours.blur_ratio, y: ours.fast_seconds_2_3_mean, px: 0 },
      real: { x: reference.blur_ratio, y: reference.fast_seconds_2_3_mean, px: 0 },
      shift_px: {
        dx: roundTo(reference.blur_ratio - ours.blur_ratio, 3),
        dy: roundTo(reference.fast_seconds_2_3_mean - ours.fast_seconds_2_3_mean, 3),
      },
      fix: `Add motion blur to the camera zoom between 0:02 and 0:03. The fast zoom stays crisp in ours while it blurs in the reference: blur ratio ours ${ours.blur_ratio} vs reference ${reference.blur_ratio}.`,
      source: "hme blur-grain, Seg4 pair",
    });
  }
  if (isFrozenGrain(ours) && isLiveGrain(reference)) {
    corrections.push({
      element: "grain",
      kind: "live-grain",
      at_s: 0,
      ours: { x: ours.flat_residual_correlation_mean, y: ours.flat_frame_diff_energy_mean, px: 0 },
      real: { x: reference.flat_residual_correlation_mean, y: reference.flat_frame_diff_energy_mean, px: 0 },
      shift_px: {
        dx: roundTo(reference.flat_residual_correlation_mean - ours.flat_residual_correlation_mean, 3),
        dy: roundTo(reference.flat_frame_diff_energy_mean - ours.flat_frame_diff_energy_mean, 3),
      },
      fix: `Make the grain change every frame instead of one fixed tile. The grain is frozen across the whole 0:00 to 0:08 span: flat-region residual correlation mean ours ${ours.flat_residual_correlation_mean} vs reference ${reference.flat_residual_correlation_mean}.`,
      source: "hme blur-grain, Seg4 pair",
    });
  }
  return corrections;
}

// Build the insight report from a measured pair: reference first,
// ours second. The blur verdict is the separation bar from stage1-02:
// the reference ratio sits in 0.20 to 0.45 and ours sits in 0.65 to
// 0.90, so the fast zoom blurs in the reference and stays crisp in
// ours. The grain verdict is the frozen-versus-live bar from
// stage1-02: ours is frozen when its mean flat-region residual
// correlation is 0.95 or higher with every second 0.90 or higher,
// and the reference is live when its mean is 0.85 or lower; the
// flat-region frame-difference energy backs it up (reference mean
// 0.10 or higher, ours mean 0.05 or lower). Flat grain level is
// amount only and never decides frozen-ness. Whole-frame grain level
// and whole-frame diff energy stay in the report as reproduction
// reference only: they do not decide any verdict. Pure function,
// tested without any video. B4 adds corrections: one per gap, each
// firing only when its gap is present.
export function buildPairInsightReport(refMeasured, oursMeasured, refArg, oursArg) {
  const reference = videoNumbers(refMeasured, refArg);
  const ours = videoNumbers(oursMeasured, oursArg);
  const refRatio = reference.blur_ratio;
  const oursRatio = ours.blur_ratio;
  const blurSeparates = refRatio !== null && oursRatio !== null
    && refRatio >= BLUR_RATIO_REFERENCE_LOW && refRatio <= BLUR_RATIO_REFERENCE_HIGH
    && oursRatio >= BLUR_RATIO_OURS_LOW && oursRatio <= BLUR_RATIO_OURS_HIGH;
  const gap = oursRatio !== null && refRatio !== null ? roundTo(oursRatio - refRatio, 3) : null;
  const refCorrMean = reference.flat_residual_correlation_mean;
  const oursCorrMean = ours.flat_residual_correlation_mean;
  const oursFrozen = isFrozenGrain(ours);
  const refLive = isLiveGrain(reference);
  const refFlatDiffMean = reference.flat_frame_diff_energy_mean;
  const oursFlatDiffMean = ours.flat_frame_diff_energy_mean;
  const flatDiffSeparates = refFlatDiffMean !== null && oursFlatDiffMean !== null
    && refFlatDiffMean >= GRAIN_FLAT_DIFF_REFERENCE_MIN
    && oursFlatDiffMean <= GRAIN_FLAT_DIFF_OURS_MAX;
  const grainPasses = oursFrozen && refLive && flatDiffSeparates;
  const passes = blurSeparates && grainPasses;
  const failedBars = [];
  if (!blurSeparates) failedBars.push("blur ratio separation: reference in 0.20 to 0.45 and ours in 0.65 to 0.90");
  if (!oursFrozen) failedBars.push("frozen grain: ours mean flat-region residual correlation 0.95 or higher with every second 0.90 or higher");
  if (!refLive) failedBars.push("live grain: reference mean flat-region residual correlation 0.85 or lower");
  if (!flatDiffSeparates) failedBars.push("flat-region frame-difference energy: reference mean 0.10 or higher and ours mean 0.05 or lower");
  return {
    verdict: {
      status: passes ? "PASS" : "FAIL",
      failed_bar: passes ? null : failedBars.join("; "),
      detail: passes
        ? `Blur ratio (mean blur over fast seconds 2-3 divided by blur over title-free held second 7): reference ${refRatio}, ours ${oursRatio}. The reference ratio sits in 0.20 to 0.45 and ours sits in 0.65 to 0.90, so the fast zoom blurs in the reference and stays crisp in ours. Grain (flat-region residual correlation with the next frame): reference mean ${refCorrMean}, ours mean ${oursCorrMean}. Ours is frozen (mean 0.95 or higher, every second 0.90 or higher) and the reference is live (mean 0.85 or lower). Flat-region frame-difference energy: reference mean ${refFlatDiffMean}, ours mean ${oursFlatDiffMean}.`
        : `Blur ratio (mean blur over fast seconds 2-3 divided by blur over title-free held second 7): reference ${refRatio}, ours ${oursRatio}. Grain (flat-region residual correlation with the next frame): reference mean ${refCorrMean}, ours mean ${oursCorrMean}. Flat-region frame-difference energy: reference mean ${refFlatDiffMean}, ours mean ${oursFlatDiffMean}. The pair does not pass: ${failedBars.join("; ")}.`,
    },
    numbers: {
      reference,
      ours,
      gap: {
        blur_ratio_reference: refRatio,
        blur_ratio_ours: oursRatio,
        blur_ratio_gap: gap,
        blur_laplacian_variance_map_span_mean_reference: reference.blur_laplacian_variance_map_span_mean,
        blur_laplacian_variance_map_span_mean_ours: ours.blur_laplacian_variance_map_span_mean,
        fast_zoom_2_3s_reference: reference.fast_zoom_2_3s,
        fast_zoom_2_3s_ours: ours.fast_zoom_2_3s,
        flat_residual_correlation_mean_reference: refCorrMean,
        flat_residual_correlation_mean_ours: oursCorrMean,
        flat_frame_diff_energy_mean_reference: refFlatDiffMean,
        flat_frame_diff_energy_mean_ours: oursFlatDiffMean,
        flat_grain_level_mean_reference: reference.flat_grain_level_mean,
        flat_grain_level_mean_ours: ours.flat_grain_level_mean,
        grain_level_mean_reference: reference.grain_level_mean,
        grain_level_mean_ours: ours.grain_level_mean,
      },
    },
    corrections: buildCorrections(reference, ours),
    context: {
      thresholds: {
        blur_ratio_reference_low: BLUR_RATIO_REFERENCE_LOW,
        blur_ratio_reference_high: BLUR_RATIO_REFERENCE_HIGH,
        blur_ratio_ours_low: BLUR_RATIO_OURS_LOW,
        blur_ratio_ours_high: BLUR_RATIO_OURS_HIGH,
        grain_frozen_mean_min: GRAIN_FROZEN_MEAN_MIN,
        grain_frozen_per_second_min: GRAIN_FROZEN_PER_SECOND_MIN,
        grain_live_mean_max: GRAIN_LIVE_MEAN_MAX,
        grain_flat_diff_reference_min: GRAIN_FLAT_DIFF_REFERENCE_MIN,
        grain_flat_diff_ours_max: GRAIN_FLAT_DIFF_OURS_MAX,
      },
      control_ceiling: null,
      meaning: "The blur ratio compares each video with its own baseline, so content cannot drive the number. A low ratio means the fast zoom blurs; a ratio near 1 means it stays crisp. Flat-region residual correlation near 1 means the grain pattern repeats frame to frame (frozen); a low value means it changes every frame (live). Flat grain level is amount only: ours has more grain yet is frozen, so level never decides frozen-ness.",
    },
    next: "hme blur-grain <reference.mp4> <ours.mp4> --out out/blur-grain-pair.json",
    limits: [
      `Reference frames are scaled to our frame size (${ours.width}x${ours.height}) before measuring, the same prep the compare command uses, so the reference small copy is 480x270.`,
      "Blur and grain are measured on small copies (every 4th pixel, 480x270 for a 1920x1080 frame), the same copies the compare command uses.",
      "Frame-difference energy is the mean absolute luma change from the previous frame. The first frame reports 0.",
      "Pair numbers use the map span, frames 0 to 185. Frames 186 and later are phone footage, not the map.",
      "The two videos are paired by frame index, not by time. When the frame rates differ, drift over the span stays under one frame, the same handling the compare command uses.",
      "Flat means local gradient under 2.0 (|gx| + |gy| < 2.0). Flat-region numbers use pixels flat in both frames of a pair.",
      "Per second, residual correlation and flat diff use the first consecutive pair of the second, the probe pair the bands were set on. The per-frame series hold every pair; averaging every pair in a second is a different statistic and is not used.",
      "Flat grain level is amount only and never decides frozen-ness. Whole-frame frame-difference energy and lag-1 autocorr of grain level are not grain verdicts: whole-frame diff tracks zoom speed, and lag-1 sits near 1 on both sides.",
      "Corrections name a fix in scene terms only when its gap is present: a blur correction when the reference ratio sits in 0.20 to 0.45 and ours sits at 0.65 or higher, a grain correction when ours grain is frozen and the reference grain is live. When a gap is absent, its correction is absent too.",
    ],
  };
}

// The Python driver. It probes one video, extracts its frames to
// PNGs in a temp dir, and measures Laplacian variance, grain level,
// and frame-difference energy per frame on the small copies. It
// prints exactly one JSON object to stdout; progress goes to stderr.
// TARGET_W and TARGET_H (argv 4 and 5) are the frame size to scale
// to before measuring, the compare command's prep: pair mode passes
// our frame size here for the reference, so its small copy is
// 480x270 exactly as U9 measured it. Empty means native size.
const DRIVER = `
import json
import subprocess
import sys
from pathlib import Path

VIDEO, WORK, SRC = sys.argv[1], sys.argv[2], sys.argv[3]
TARGET_W = sys.argv[4] if len(sys.argv) > 4 else ""
TARGET_H = sys.argv[5] if len(sys.argv) > 5 else ""
sys.path.insert(0, SRC)
from checker import dimensions
import numpy as np
from PIL import Image
from scipy import ndimage

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

info = probe(VIDEO)
n = info["frames"]
work = Path(WORK)
extract_args = ["ffmpeg", "-v", "error", "-i", VIDEO]
if TARGET_W and TARGET_H:
    extract_args += ["-vf", f"scale={TARGET_W}:{TARGET_H}"]
extract_args += ["-frames:v", str(n),
                 "-vsync", "0", "-start_number", "0", str(work / "frame-%04d.png")]
run_ffmpeg(extract_args)

def load(p):
    return np.array(Image.open(p).convert("RGB"))

def resid_of(luma):
    # High-pass residual: luma minus its 3x3 mean blur, the same
    # residual grain_level uses.
    blur = ndimage.uniform_filter(luma.astype(np.float32), size=3, mode="nearest")
    return luma.astype(np.float32) - blur

def flat_mask(luma):
    # Flat means local gradient under 2.0, the same flat test the
    # probe used. Static means flat and uniform during a zoom, not
    # geometrically fixed.
    gy, gx = np.gradient(luma.astype(np.float32))
    return (np.abs(gx) + np.abs(gy)) < 2.0

blur, grain, diff, denoised = [], [], [], []
flat_grain, flat_diff, flat_corr, flat_frac = [], [], [], []
prev_small = None
prev_resid = None
prev_flat = None
for i in range(n):
    frame = load(work / f"frame-{i:04d}.png")
    small = frame[::4, ::4]
    luma = dimensions.luma_of(small)
    blur.append(dimensions.laplacian_variance(luma))
    # Denoised blur (B2): Laplacian variance after a 3x3 mean blur.
    # Same 3x3 uniform filter grain_level uses. It shows grain is not
    # driving the blur dip.
    denoised.append(dimensions.laplacian_variance(
        ndimage.uniform_filter(luma.astype(np.float32), size=3, mode="nearest")))
    grain.append(dimensions.grain_level(luma))
    # Flat-region grain (B3): residual std over flat pixels only.
    # Correlation and diff use pixels flat in both frames of a pair.
    r = resid_of(luma)
    fm = flat_mask(luma)
    flat_grain.append(round(float(np.std(r[fm])), 3) if fm.sum() > 100 else None)
    flat_frac.append(round(float(np.mean(fm)), 3))
    if prev_small is None:
        diff.append(0.0)
        flat_diff.append(None)
        flat_corr.append(None)
    else:
        diff.append(round(float(np.mean(np.abs(luma - prev_small))), 3))
        both = fm & prev_flat
        if both.sum() > 100:
            flat_diff.append(round(float(np.mean(np.abs(luma[both] - prev_small[both]))), 3))
            a, b = r[both], prev_resid[both]
            if np.std(a) > 0 and np.std(b) > 0:
                flat_corr.append(round(float(np.corrcoef(a, b)[0, 1]), 4))
            else:
                flat_corr.append(None)
        else:
            flat_diff.append(None)
            flat_corr.append(None)
    prev_small = luma
    prev_resid = r
    prev_flat = fm
    if i % 48 == 0:
        print(f"frame {i} done", file=sys.stderr, flush=True)

print(json.dumps({
    "video": VIDEO,
    "width": info["width"], "height": info["height"],
    "fps": round(info["fps"], 3), "frames": n,
    "blur_laplacian_variance_per_frame": blur,
    "blur_denoised_laplacian_variance_per_frame": denoised,
    "grain_level_per_frame": grain,
    "frame_diff_energy_per_frame": diff,
    "flat_grain_level_per_frame": flat_grain,
    "flat_frame_diff_energy_per_frame": flat_diff,
    "flat_residual_correlation_per_frame": flat_corr,
    "flat_fraction_per_frame": flat_frac,
}))
`;

function runDriver(videoPath, workdir, targetSize) {
  const targetW = targetSize ? String(targetSize.width) : "";
  const targetH = targetSize ? String(targetSize.height) : "";
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VENV_PYTHON, ["-", videoPath, workdir, SRC_DIR, targetW, targetH], {
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
        rejectPromise(new Error(`blur-grain measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`blur-grain measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Measure one video and return its per-frame series plus frame count
// and fps. B2/B3 reuse this function as it is: they add aggregation
// and temporal stats on top of the series it returns, and pair mode
// calls it once per video. targetSize ({width, height}) scales the
// frames to that size before measuring, the compare command's prep;
// without it the video is measured at native size. The reported
// width and height are always the video's native probed size.
export async function measureOneVideo(videoPath, targetSize) {
  const workdir = makeWorkdir();
  try {
    const measured = await runDriver(videoPath, workdir, targetSize);
    return {
      video: measured.video,
      width: measured.width,
      height: measured.height,
      fps: measured.fps,
      frames: measured.frames,
      blur_laplacian_variance_per_frame: measured.blur_laplacian_variance_per_frame,
      blur_denoised_laplacian_variance_per_frame: measured.blur_denoised_laplacian_variance_per_frame,
      grain_level_per_frame: measured.grain_level_per_frame,
      frame_diff_energy_per_frame: measured.frame_diff_energy_per_frame,
      flat_grain_level_per_frame: measured.flat_grain_level_per_frame ?? [],
      flat_frame_diff_energy_per_frame: measured.flat_frame_diff_energy_per_frame ?? [],
      flat_residual_correlation_per_frame: measured.flat_residual_correlation_per_frame ?? [],
      flat_fraction_per_frame: measured.flat_fraction_per_frame ?? [],
      blur_laplacian_variance_mean: meanOf(measured.blur_laplacian_variance_per_frame),
      blur_denoised_laplacian_variance_mean: meanOf(measured.blur_denoised_laplacian_variance_per_frame),
      grain_level_mean: meanOf(measured.grain_level_per_frame),
      frame_diff_energy_mean: meanOf(measured.frame_diff_energy_per_frame),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

// Run `hme blur-grain video.mp4 [--out <report.json>]` or
// `hme blur-grain <reference.mp4> <ours.mp4> [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runBlurGrain(argv) {
  const positionals = [];
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme blur-grain: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme blur-grain: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length < 1 || positionals.length > 2) {
    console.error("hme blur-grain: needs one video, video.mp4, or two videos for pair mode");
    console.error(USAGE);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme blur-grain: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  if (positionals.length === 1) {
    const videoArg = positionals[0];
    const videoPath = resolve(videoArg);
    if (!existsSync(videoPath)) {
      console.error(`hme blur-grain: no such file: ${videoArg}`);
      return 2;
    }
    try {
      const measured = await measureOneVideo(videoPath);
      const report = buildInsightReport(measured, videoArg);
      return writeInsightReport(report, outPath);
    } catch (err) {
      console.error(`hme blur-grain: ${err.message}`);
      return 2;
    }
  }
  const refArg = positionals[0];
  const oursArg = positionals[1];
  const refPath = resolve(refArg);
  const oursPath = resolve(oursArg);
  if (!existsSync(refPath)) {
    console.error(`hme blur-grain: no such file: ${refArg}`);
    return 2;
  }
  if (!existsSync(oursPath)) {
    console.error(`hme blur-grain: no such file: ${oursArg}`);
    return 2;
  }
  try {
    // Ours first, at native size; then the reference scaled to our
    // frame size, exactly the compare command's prep. Measuring the
    // reference at its native 1920x1038 would sample it at 480x260
    // where U9 sampled 480x270, so the order matters.
    const oursMeasured = await measureOneVideo(oursPath);
    const refMeasured = await measureOneVideo(refPath, { width: oursMeasured.width, height: oursMeasured.height });
    const report = buildPairInsightReport(refMeasured, oursMeasured, refArg, oursArg);
    return writeInsightReport(report, outPath);
  } catch (err) {
    console.error(`hme blur-grain: ${err.message}`);
    return 2;
  }
}
