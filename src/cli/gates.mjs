// hme gates: run the map gates G8 and G9 on a scene.
//
// Wraps src/map/cli.mjs (`node src/map/cli.mjs check <scene.json>`)
// as a subprocess. Nothing here reimplements a gate: the map CLI
// loads the scene, validates it, computes every frame state, runs G8
// on sampled frames and G9 on all frames, and writes
// out/map-sample/g8-g9-report.json. This module only reads that
// report into one insight report that names the G8 and G9 outcomes
// separately, so the agent can see which gate failed without
// re-reading the map code.
//
// The verdict is PASS when G8 and G9 both pass. When the map CLI
// fails before it writes a report (bad scene, no map node, missing
// geometry), the verdict is FAIL and the report carries the map
// CLI's own output instead of gate numbers.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MAP_CLI = join(REPO_ROOT, "src", "map", "cli.mjs");
const MAP_REPORT = join(REPO_ROOT, "out", "map-sample", "g8-g9-report.json");
const MAP_REPORT_REL = "out/map-sample/g8-g9-report.json";

export const USAGE = [
  "hme gates: Run the map gates G8 and G9 on a scene.",
  "",
  "Usage: hme gates scene.json [--out report.json]",
  "",
  "Arguments:",
  "  scene.json  Path to the scene file. It must have a map node.",
  "",
  "Options:",
  "  --out file  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "The map CLI writes its own report to out/map-sample/g8-g9-report.json.",
  "This report names the G8 and G9 outcomes separately.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error or the map CLI could not run.",
].join("\n") + "\n";

// Read the scene duration without failing when the scene cannot be
// read. The duration is only the frame count G9 ran over.
export function readSceneDuration(scenePath) {
  try {
    const scene = JSON.parse(readFileSync(scenePath, "utf8"));
    return typeof scene?.meta?.duration === "number" ? scene.meta.duration : null;
  } catch {
    return null;
  }
}

// Build the insight report from the map CLI result. Pure function,
// tested without running the map CLI.
// map: { exit, stdout, stderr, report } where report is the parsed
// out/map-sample/g8-g9-report.json, or null when the map CLI wrote none.
export function buildGatesReport(map, sceneArg, outPath) {
  const report = map.report;
  const duration = readSceneDuration(resolve(sceneArg));
  if (report === null) {
    const tail = (map.stderr || "").trim().split("\n").slice(-5).join("\n")
      || (map.stdout || "").trim().split("\n").slice(-5).join("\n");
    return {
      verdict: {
        status: "FAIL",
        failed_bar: "map gates G8 and G9 (map CLI check did not finish)",
        detail: map.exit === 2
          ? `The map CLI could not run (exit 2): ${tail || "no output"}`.slice(0, 300)
          : `The map CLI failed before it wrote a gate report (exit ${map.exit}): ${tail || "no output"}`.slice(0, 300),
      },
      numbers: {
        scene: sceneArg,
        frames: duration,
        g8: null,
        g9: null,
        g8_failure_count: null,
        g9_failure_count: null,
        g8_failures: [],
        g9_failures: [],
        sampled_frames: [],
        sampled_frame_count: 0,
        map_report: null,
        map_exit: map.exit,
        map_stdout_tail: (map.stdout || "").trim().split("\n").slice(-5),
        map_stderr_tail: (map.stderr || "").trim().split("\n").slice(-5),
      },
      corrections: [],
      context: {
        thresholds: { g8_failures: 0, g9_failures: 0 },
        control_ceiling: null,
        meaning: "No gate ran, so there is nothing to pass or fail yet. Fix the scene problem the map CLI reports, then run the gates again.",
      },
      next: `hme gates ${sceneArg}`,
      limits: [
        "The gates check the map state the scene describes. They do not render frames or check the video.",
        "When the map CLI fails before it writes a report, this report carries the map CLI output instead of gate numbers.",
      ],
    };
  }
  const g8Pass = report.g8 === "pass";
  const g9Pass = report.g9 === "pass";
  const g8Failures = Array.isArray(report.g8Failures) ? report.g8Failures : [];
  const g9Failures = Array.isArray(report.g9Failures) ? report.g9Failures : [];
  const sampled = Array.isArray(report.sampledFrames) ? report.sampledFrames : [];
  const failedBar = g8Pass && g9Pass
    ? null
    : !g8Pass && !g9Pass
      ? "G8 contrast gate and G9 focus and camera gate"
      : !g8Pass
        ? "G8 contrast gate"
        : "G9 focus and camera gate";
  const status = failedBar === null ? "PASS" : "FAIL";
  const firstFailure = [...g8Failures, ...g9Failures][0];
  return {
    verdict: {
      status,
      failed_bar: failedBar,
      detail: status === "PASS"
        ? `G8 passed with 0 failures on ${sampled.length} sampled frames. G9 passed with 0 failures on all ${duration ?? "unknown"} frames.`
        : `${failedBar} failed: ${firstFailure ? `${firstFailure.code} at frame ${firstFailure.frame}: ${firstFailure.detail}` : "see numbers.g8_failures and numbers.g9_failures"}`.slice(0, 300),
    },
    numbers: {
      scene: sceneArg,
      frames: duration,
      g8: report.g8,
      g9: report.g9,
      g8_failure_count: g8Failures.length,
      g9_failure_count: g9Failures.length,
      g8_failures: g8Failures,
      g9_failures: g9Failures,
      sampled_frames: sampled,
      sampled_frame_count: sampled.length,
      map_report: MAP_REPORT_REL,
      map_exit: map.exit,
    },
    corrections: [],
    context: {
      thresholds: { g8_failures: 0, g9_failures: 0 },
      control_ceiling: null,
      meaning: status === "PASS"
        ? "The map state clears both gates: labels have contrast, lines have casing, floods stay apart, and the camera travels, lands, and holds as the rules require."
        : "At least one gate failed. The failures in numbers.g8_failures and numbers.g9_failures name the frame and the rule, so the fix goes to the scene, not to the gate.",
    },
    next: status === "PASS"
      ? `hme render ${sceneArg} --profile previs --out out/render.json`
      : `hme gates ${sceneArg} --out ${outPath ?? "out/gates.json"}`,
    limits: [
      "G8 runs on sampled frames only: event frames, landing frames, and route samples every 12 frames.",
      "G9 runs on every frame of the scene.",
      "The gates check the map state the scene describes. They do not render frames or check the video.",
    ],
  };
}

// Run `hme gates <scene.json> [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run
// error. Never prints a stack trace.
export function runGates(argv) {
  const positionals = [];
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme gates: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme gates: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme gates: needs one scene file, scene.json");
    console.error(USAGE);
    return 2;
  }
  const sceneArg = positionals[0];
  const scenePath = resolve(sceneArg);
  if (!existsSync(scenePath)) {
    console.error(`hme gates: no such file: ${sceneArg}`);
    const report = buildGatesReport({ exit: 2, stdout: "", stderr: `no such file: ${sceneArg}`, report: null }, sceneArg, outPath);
    writeInsightReport(report, outPath);
    return 2;
  }
  let child;
  try {
    child = spawnSync(process.execPath, [MAP_CLI, "check", scenePath], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    console.error(`hme gates: could not start the map CLI: ${err.message}`);
    return 2;
  }
  if (child.error) {
    console.error(`hme gates: could not start the map CLI: ${child.error.message}`);
    return 2;
  }
  const stdout = child.stdout || "";
  const summary = stdout.match(/^G8 (pass|fail) \(\d+ failures\) G9 (pass|fail) \(\d+ failures\)/m);
  let report = null;
  if (summary && existsSync(MAP_REPORT)) {
    try {
      report = JSON.parse(readFileSync(MAP_REPORT, "utf8"));
    } catch (err) {
      console.error(`hme gates: map report unreadable: ${err.message}`);
      return 2;
    }
  }
  const built = buildGatesReport({ exit: child.status ?? 2, stdout, stderr: child.stderr || "", report }, sceneArg, outPath);
  return writeInsightReport(built, outPath);
}
