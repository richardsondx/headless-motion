// Fast tests for `hme frame-style`. A synthetic testsrc video is
// generated with ffmpeg in a temp dir, so no reference footage is
// needed. The test checks the CLI end to end: --help, usage errors,
// a real 2 second measurement, the prompt file, the CSV, and the
// insight report.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");

function makeVideo(dir) {
  const video = join(dir, "testsrc.mp4");
  const r = spawnSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi",
    "-i", "testsrc=duration=2:size=320x240:rate=24",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    video,
  ], { encoding: "utf8" });
  assert.equal(r.status, 0, `ffmpeg testsrc failed: ${r.stderr}`);
  return video;
}

test("frame-style --help prints usage and exits 0", () => {
  const r = spawnSync(process.execPath, [HME, "frame-style", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme frame-style"));
  assert.ok(r.stdout.includes("Usage:"));
  assert.ok(r.stdout.includes("--start-s"));
  assert.ok(r.stdout.includes("--end-s"));
  assert.ok(r.stdout.includes("--out"));
});

test("frame-style without --start-s and --end-s exits 2", () => {
  const r = spawnSync(process.execPath, [HME, "frame-style", "nope.mp4"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--start-s"));
});

test("frame-style measures a 2 second testsrc video and writes prompt, CSV, and report", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-frame-style-test-"));
  try {
    const video = makeVideo(dir);
    const promptPath = join(dir, "style-prompt.md");
    const csvPath = join(dir, "frames.csv");
    const reportPath = join(dir, "report.json");
    const r = spawnSync(process.execPath, [
      HME, "frame-style", video,
      "--start-s", "0", "--end-s", "2",
      "--out", promptPath, "--csv", csvPath, "--report", reportPath,
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(promptPath), "prompt file must exist");
    const prompt = readFileSync(promptPath, "utf8");
    assert.ok(prompt.includes("48 frames"), prompt);
    assert.ok(prompt.includes("changed fraction"), prompt);
    assert.ok(prompt.includes("Mean change"), prompt);
    assert.ok(prompt.includes("Shots and cadence"), prompt);
    assert.ok(prompt.includes("Palette"), prompt);
    assert.ok(prompt.includes("Flatness, outline, and grain"), prompt);
    assert.ok(existsSync(csvPath), "CSV file must exist");
    const csvLines = readFileSync(csvPath, "utf8").trim().split("\n");
    assert.equal(csvLines[0], "frame,time_s,mean_abs_diff,changed,shot_cut,border_mad,center_mad,mean_luma,flat_fill_ratio,outline_density,grain");
    assert.equal(csvLines.length, 49, "one header row plus 48 frame rows");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.verdict.status, "PASS");
    assert.equal(report.verdict.failed_bar, null);
    assert.equal(report.numbers.frames, 48);
    assert.equal(report.numbers.fps, 24);
    // testsrc moves a little on most frames: mean change is about 0.46
    // levels per frame, so only 3 of 47 steps cross the 0.5 changed bar.
    // The bar below checks motion was detected at all, not a majority.
    assert.ok(report.numbers.changed_fraction > 0.05, `testsrc moves on some frames, changed fraction was ${report.numbers.changed_fraction}`);
    assert.ok(report.numbers.mean_change_per_second > 0);
    assert.ok(report.numbers.longest_static_run_frames < 48);
    assert.equal(report.numbers.prompt_path, promptPath);
    assert.ok(Array.isArray(report.numbers.per_second));
    assert.equal(report.numbers.per_second.length, 2);
    // v2 numbers: cuts, cadence, camera split, palette, gradient,
    // flatness, outline, grain. testsrc has no hard cuts.
    assert.equal(typeof report.numbers.shot_cut_count, "number");
    assert.equal(report.numbers.shot_cut_count, 0);
    assert.ok(Array.isArray(report.numbers.shot_cuts));
    assert.ok(["static", "on-1s", "on-2s", "on-3s", "hold-and-pop", "mixed"].includes(report.numbers.cadence), `cadence was ${report.numbers.cadence}`);
    assert.equal(typeof report.numbers.median_gap_between_changes, "number");
    assert.ok(report.numbers.camera_vs_subject, "camera_vs_subject must exist");
    assert.equal(typeof report.numbers.camera_vs_subject.camera_frames, "number");
    assert.equal(typeof report.numbers.camera_vs_subject.subject_frames, "number");
    assert.equal(report.numbers.palette.length, 8, "palette holds the top 8 quantized hexes");
    for (const p of report.numbers.palette) {
      assert.match(p.hex, /^#[0-9A-F]{6}$/);
      assert.ok(p.share > 0 && p.share <= 1);
    }
    assert.equal(report.numbers.gradient.stops.length, 5, "gradient holds 5 stops");
    assert.ok(report.numbers.gradient.max_row_step >= 0);
    assert.ok(report.numbers.flat_fill_ratio >= 0 && report.numbers.flat_fill_ratio <= 1);
    assert.ok(report.numbers.outline_density >= 0 && report.numbers.outline_density <= 1);
    assert.ok(report.numbers.grain_mean_abs_laplacian >= 0);
    assert.ok(report.numbers.mean_luma > 0);
    assert.ok(Array.isArray(report.corrections));
    assert.ok(typeof report.context.meaning === "string");
    assert.ok(report.next.includes("hme trace"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frame-style --gate-image checks one still against a v2 report", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-frame-style-gate-test-"));
  try {
    const video = makeVideo(dir);
    const reportPath = join(dir, "report.json");
    const r = spawnSync(process.execPath, [
      HME, "frame-style", video,
      "--start-s", "0", "--end-s", "2",
      "--out", join(dir, "style-prompt.md"), "--report", reportPath,
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // A real frame from the same video, gated against its own report.
    const framePath = join(dir, "frame.png");
    const grab = spawnSync("ffmpeg", [
      "-v", "error", "-ss", "0.5", "-i", video, "-frames:v", "1", framePath,
    ], { encoding: "utf8" });
    assert.equal(grab.status, 0, grab.stderr);
    const gatePath = join(dir, "gate.json");
    const g = spawnSync(process.execPath, [
      HME, "frame-style", "--gate-image", framePath,
      "--reference", reportPath, "--gate-out", gatePath,
    ], { encoding: "utf8" });
    assert.ok(g.status === 0 || g.status === 1, `gate exit was ${g.status}: ${g.stderr}`);
    const gate = JSON.parse(readFileSync(gatePath, "utf8"));
    assert.equal(gate.bars.length, 5, "gate checks five bars");
    assert.deepEqual(gate.bars.map((b) => b.bar), [
      "Palette Adherence", "Flat Fill Integrity", "Outline Contract", "Grain Floor", "Luminance Balance",
    ]);
    assert.ok(Array.isArray(gate.fixes));
    assert.equal(gate.verdict.status, g.status === 0 ? "PASS" : "FAIL");
    // A pure black still against the testsrc report must fail, and
    // every failed bar must carry a targeted FIX patch.
    const blackPath = join(dir, "black.png");
    const black = spawnSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1",
      "-frames:v", "1", blackPath,
    ], { encoding: "utf8" });
    assert.equal(black.status, 0, black.stderr);
    const blackGatePath = join(dir, "black-gate.json");
    const bg = spawnSync(process.execPath, [
      HME, "frame-style", "--gate-image", blackPath,
      "--reference", reportPath, "--gate-out", blackGatePath,
    ], { encoding: "utf8" });
    assert.equal(bg.status, 1, "black still must fail the gate");
    const blackGate = JSON.parse(readFileSync(blackGatePath, "utf8"));
    assert.equal(blackGate.verdict.status, "FAIL");
    assert.ok(blackGate.verdict.failed_bars.includes("Palette Adherence"));
    assert.ok(blackGate.verdict.failed_bars.includes("Luminance Balance"));
    assert.ok(blackGate.fixes.some((f) => f.startsWith("[FIX-1]")), "palette failure carries FIX-1");
    assert.ok(blackGate.fixes.some((f) => f.startsWith("[FIX-5]")), "luminance failure carries FIX-5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frame-style --gate-image without --reference exits 2", () => {
  const r = spawnSync(process.execPath, [
    HME, "frame-style", "--gate-image", "frame.png",
  ], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--gate-image"));
});

test("frame-style on a missing video exits 2", () => {
  const r = spawnSync(process.execPath, [
    HME, "frame-style", "no-such-video.mp4",
    "--start-s", "0", "--end-s", "2", "--out", "out.md",
  ], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file"));
});
