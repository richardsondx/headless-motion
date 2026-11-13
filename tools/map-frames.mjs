#!/usr/bin/env node
// tools/map-frames.mjs: thin wrapper for `hme trace`, the frame
// mapping tool.
//
// Usage: node tools/map-frames.mjs <video.mp4> --start-s <n> --end-s <n> --out <dir> [--skip-traces] [--subject-colour <hex>] [--badge-colour <hex>] [--labels <text,...>]
//
// It runs one command and nothing else: it maps a reference
// video's frames to a style profile, with measured colours,
// positions, timing, and easing. The profile holds cuts, palette,
// geometry, per-colour trajectories, the zoom curve, label tracks,
// and VTracer traces per keyframe. All options pass straight
// through to `hme trace`; run `node src/cli/hme.mjs trace --help`
// for the full list. Exit code matches the hme command: 0 PASS,
// 1 FAIL, 2 usage error.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HME = join(HERE, "..", "src", "cli", "hme.mjs");

if (process.argv.length <= 2 || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node tools/map-frames.mjs <video.mp4> --start-s <n> --end-s <n> --out <dir> [--skip-traces] [--subject-colour <hex>] [--badge-colour <hex>] [--labels <text,...>]");
  console.log("Runs: node src/cli/hme.mjs trace <same arguments>");
  console.log("See `node src/cli/hme.mjs trace --help` for the full option list.");
  process.exit(process.argv.length <= 2 ? 2 : 0);
}

const result = spawnSync(process.execPath, [HME, "trace", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 2);
