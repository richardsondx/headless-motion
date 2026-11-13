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
    assert.ok(existsSync(csvPath), "CSV file must exist");
    const csvLines = readFileSync(csvPath, "utf8").trim().split("\n");
    assert.equal(csvLines[0], "frame,time_s,mean_abs_diff,changed,mean_luma");
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
    assert.ok(Array.isArray(report.corrections));
    assert.ok(typeof report.context.meaning === "string");
    assert.ok(report.next.includes("hme trace"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frame-style on a missing video exits 2", () => {
  const r = spawnSync(process.execPath, [
    HME, "frame-style", "no-such-video.mp4",
    "--start-s", "0", "--end-s", "2", "--out", "out.md",
  ], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("no such file"));
});
