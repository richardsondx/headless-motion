#!/usr/bin/env node
// tools/frame-style.mjs: thin wrapper for `hme frame-style`.
//
// Usage: node tools/frame-style.mjs <video.mp4> --start-s <n> --end-s <n> --out <prompt.md> [--report <report.json>] [--csv <per-frame.csv>]
//
// It runs one command and nothing else: it measures the reference
// video frame by frame over the window and writes a plain-language
// style prompt from the measured pace numbers. The prompt carries
// the style in words, so another model can reproduce the motion
// from text alone. All options pass straight through to
// `hme frame-style`; run `node src/cli/hme.mjs frame-style --help`
// for the full list. Exit code matches the hme command: 0 PASS,
// 1 FAIL, 2 usage error.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HME = join(HERE, "..", "src", "cli", "hme.mjs");

if (process.argv.length <= 2 || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node tools/frame-style.mjs <video.mp4> --start-s <n> --end-s <n> --out <prompt.md> [--report <report.json>] [--csv <per-frame.csv>] [--fps <n>]");
  console.log("   or: node tools/frame-style.mjs --gate-image <image.png> --reference <report.json> [--gate-out <gate.json>]");
  console.log("Runs: node src/cli/hme.mjs frame-style <same arguments>");
  console.log("See `node src/cli/hme.mjs frame-style --help` for the full option list.");
  process.exit(process.argv.length <= 2 ? 2 : 0);
}

const result = spawnSync(process.execPath, [HME, "frame-style", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 2);
