// hme render: render a scene to video through the renderer CLI.
//
// Wraps src/renderer/cli.mjs (`node src/renderer/cli.mjs render
// scene.json --profile previs|draft|final --out out/name`) as a
// subprocess. Nothing here reimplements rendering: the renderer
// captures the frames, encodes the video, and writes its own
// render-report.json. This module only passes the flags through,
// then reads that report and the video file into one insight report.
//
// Two outputs, two flags: --out is the JSON report, the same as
// every other hme command. --render-out is the directory the
// renderer writes the video and frames to. When --render-out is
// absent, the render goes to a directory named after the scene
// beside the report, or to out/scene-id-hme in the repo when there
// is no report path. The report names the render directory, so the
// agent always knows where the video is.
//
// The verdict is PASS when the renderer exits 0 and the video file
// exists with at least one frame captured. The renderer exit codes
// are carried in the report: 2 scene, font, or asset; 3 browser;
// 4 seek, capture, or module; 5 encode or probe; 6 nondeterminism.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const RENDER_CLI = join(REPO_ROOT, "src", "renderer", "cli.mjs");

export const PROFILES = ["previs", "draft", "final", "final-max", "preview-rt"];

export const RENDERER_EXIT_MEANING = {
  2: "scene, font, or asset",
  3: "browser",
  4: "seek, capture, or module",
  5: "encode or probe",
  6: "nondeterminism",
};

export const USAGE = [
  "hme render: Render a scene to video.",
  "",
  "Usage: hme render scene.json --profile previs|draft|final|final-max|preview-rt [--render-out dir] [--out report.json] [--frames a:b] [--keep-frames] [--verify-determinism]",
  "",
  "Arguments:",
  "  scene.json  Path to the scene file.",
  "",
  "Options:",
  "  --profile name  Render profile: previs, draft, final, final-max, or preview-rt. Required.",
  "  --render-out dir  Directory for the video and frames. Default: scene-id-render beside the report, or out/scene-id-hme in the repo.",
  "  --out file  Write the JSON report here. Without it, the report goes to stdout.",
  "  --frames a:b  Render frames a up to but not including b.",
  "  --order f,f,f  Render frames in this order.",
  "  --set path=value  Change one scene value. Repeatable.",
  "  --keep-frames  Keep the rendered frame images.",
  "  --verify-determinism  Render twice and fail if any frame differs.",
  "  --realtime  Shorthand for --profile preview-rt, a non-deterministic preview.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// Read the scene id and duration without failing when the scene
// cannot be read. Both are only used to name the default render
// directory and to count the frames requested.
export function readSceneHead(scenePath) {
  try {
    const scene = JSON.parse(readFileSync(scenePath, "utf8"));
    if (scene && typeof scene === "object" && !Array.isArray(scene) && scene.base) return { id: null, duration: null, compact: true };
    return {
      id: typeof scene?.meta?.id === "string" ? scene.meta.id : null,
      duration: typeof scene?.meta?.duration === "number" ? scene.meta.duration : null,
      compact: false,
    };
  } catch {
    return { id: null, duration: null, compact: false };
  }
}

// The render directory when --render-out is absent: beside the
// report when there is one, else under out/ in the repo.
export function defaultRenderOut(sceneArg, outPath) {
  const head = readSceneHead(resolve(sceneArg));
  const name = head.id ?? basename(sceneArg).replace(/\.json$/i, "");
  if (outPath) return join(dirname(resolve(outPath)), `${name}-render`);
  return join(REPO_ROOT, "out", `${name}-hme`);
}

// Build the insight report from the renderer run. Pure function,
// tested without rendering anything.
// run: { exit, stdout, stderr, renderReport, videoPath, videoBytes,
// framesRequested, verifyDeterminism, renderOut }.
export function buildRenderReport(run, sceneArg, profile, outPath) {
  const renderer = run.renderReport;
  const framesCaptured = renderer?.frames_captured ?? null;
  const videoExists = run.videoBytes !== null;
  const failedBar = run.exit === 0 && videoExists && framesCaptured !== 0
    ? null
    : run.exit === 0 && !videoExists
      ? "render produced no video file"
      : run.exit === 0
        ? "render captured 0 frames"
        : `${RENDERER_EXIT_MEANING[run.exit] ?? "render"} (renderer exit ${run.exit})`;
  const status = failedBar === null ? "PASS" : "FAIL";
  const tail = (run.stderr || "").trim().split("\n").filter((l) => l.trim().length > 0).slice(-3).join(" ");
  const detail = status === "PASS"
    ? `Rendered ${framesCaptured} frames at ${profile} to ${run.videoPath}.`
    : run.exit !== 0
      ? `Render failed at ${profile} (${RENDERER_EXIT_MEANING[run.exit] ?? `renderer exit ${run.exit}`})${renderer?.message ? `: ${renderer.message}` : ""}${tail ? ` ${tail}` : ""}`.slice(0, 300)
      : `Render exited 0 but ${!videoExists ? "the video file is missing" : "0 frames were captured"} at ${profile}.`;
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      scene: sceneArg,
      profile,
      render_out: run.renderOut,
      video: run.videoPath,
      video_exists: videoExists,
      video_bytes: run.videoBytes,
      frames_captured: framesCaptured,
      frames_requested: run.framesRequested,
      determinism_verified: run.verifyDeterminism ? (run.exit === 0) : null,
      renderer_exit: run.exit,
      renderer_code: renderer?.code ?? null,
      renderer_stage: renderer?.stage ?? null,
      renderer_message: renderer?.message ?? null,
      scene_sha256: renderer?.scene_sha256 ?? null,
      render_report: run.renderReportPath ?? null,
    },
    corrections: [],
    context: {
      thresholds: { renderer_exit: 0, frames_captured_min: 1 },
      control_ceiling: null,
      meaning: status === "PASS"
        ? "Exit 0 with a video file means the scene renders end to end at this profile."
        : "The renderer did not finish the video. The exit code names the stage that failed, and the renderer message in numbers.renderer_message says why.",
    },
    next: status === "PASS"
      ? `hme compare ref.mp4 ${run.videoPath} --out out/compare.json`
      : `hme render ${sceneArg} --profile ${profile} --out ${outPath ?? "out/render.json"}`,
    limits: profile === "previs"
      ? [
          "A previs render is small and fast (854x480). It proves the scene renders. It does not prove the final quality.",
          "This report covers the render only. It says nothing about how close the video is to a reference.",
        ]
      : profile === "preview-rt"
        ? [
            "preview-rt is non-deterministic. Never use it for verification.",
            "This report covers the render only. It says nothing about how close the video is to a reference.",
          ]
        : [
            "This report covers the render only. It says nothing about how close the video is to a reference.",
          ],
  };
}

// Run `hme render <scene.json> --profile <name> [--render-out <dir>]
// [--out <report.json>] [--frames a:b] [--order f,f,f] [--set p=v]
// [--keep-frames] [--verify-determinism] [--realtime]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run
// error. Never prints a stack trace.
export function runRender(argv) {
  const positionals = [];
  let profile = null;
  let renderOut = null;
  let outPath = null;
  let framesArg = null;
  let orderArg = null;
  const sets = [];
  let keepFrames = false;
  let verifyDeterminism = false;
  let realtime = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") {
      if (i + 1 >= argv.length) {
        console.error("hme render: --profile needs a profile name");
        console.error(USAGE);
        return 2;
      }
      profile = argv[++i];
    } else if (a === "--render-out") {
      if (i + 1 >= argv.length) {
        console.error("hme render: --render-out needs a directory");
        console.error(USAGE);
        return 2;
      }
      renderOut = argv[++i];
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme render: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a === "--frames") {
      if (i + 1 >= argv.length) {
        console.error("hme render: --frames needs a:b");
        console.error(USAGE);
        return 2;
      }
      framesArg = argv[++i];
    } else if (a === "--order") {
      if (i + 1 >= argv.length) {
        console.error("hme render: --order needs a frame list");
        console.error(USAGE);
        return 2;
      }
      orderArg = argv[++i];
    } else if (a === "--set") {
      if (i + 1 >= argv.length) {
        console.error("hme render: --set needs path=value");
        console.error(USAGE);
        return 2;
      }
      sets.push(argv[++i]);
    } else if (a === "--keep-frames") {
      keepFrames = true;
    } else if (a === "--verify-determinism") {
      verifyDeterminism = true;
    } else if (a === "--realtime") {
      realtime = true;
    } else if (a.startsWith("--")) {
      console.error(`hme render: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme render: needs one scene file, scene.json");
    console.error(USAGE);
    return 2;
  }
  if (realtime) profile = "preview-rt";
  if (!profile) {
    console.error("hme render: --profile is required");
    console.error(USAGE);
    return 2;
  }
  if (!PROFILES.includes(profile)) {
    console.error(`hme render: unknown profile "${profile}", use one of ${PROFILES.join(", ")}`);
    console.error(USAGE);
    return 2;
  }
  if (verifyDeterminism && profile === "preview-rt") {
    console.error("hme render: preview-rt is non-deterministic; --verify-determinism does not apply");
    console.error(USAGE);
    return 2;
  }
  let framesRequested = null;
  if (framesArg !== null) {
    const parts = framesArg.split(":").map(Number);
    if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n)) || parts[0] < 0 || parts[1] < parts[0]) {
      console.error(`hme render: --frames needs a:b with whole numbers and b >= a, got "${framesArg}"`);
      console.error(USAGE);
      return 2;
    }
    framesRequested = parts[1] - parts[0];
  } else if (orderArg !== null) {
    framesRequested = orderArg.split(",").filter((s) => s.trim().length > 0).length;
  } else {
    framesRequested = readSceneHead(resolve(positionals[0])).duration;
  }
  const sceneArg = positionals[0];
  const scenePath = resolve(sceneArg);
  if (!existsSync(scenePath)) {
    console.error(`hme render: no such file: ${sceneArg}`);
    return 2;
  }
  if (renderOut === null) renderOut = defaultRenderOut(sceneArg, outPath);
  const renderOutAbs = resolve(renderOut);
  const videoFile = profile === "preview-rt" ? "preview-rt.mp4" : "video.mp4";
  const videoPath = join(renderOutAbs, videoFile);
  const childArgs = ["render", scenePath, "--profile", profile, "--out", renderOutAbs];
  if (framesArg !== null) childArgs.push("--frames", framesArg);
  if (orderArg !== null) childArgs.push("--order", orderArg);
  for (const s of sets) childArgs.push("--set", s);
  if (keepFrames) childArgs.push("--keep-frames");
  if (verifyDeterminism) childArgs.push("--verify-determinism");
  let child;
  try {
    child = spawnSync(process.execPath, [RENDER_CLI, ...childArgs], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    console.error(`hme render: could not start the renderer: ${err.message}`);
    return 2;
  }
  if (child.error) {
    console.error(`hme render: could not start the renderer: ${child.error.message}`);
    return 2;
  }
  const exit = child.status ?? 2;
  if (child.stdout) process.stderr.write(child.stdout);
  // With --verify-determinism the renderer writes run-a and run-b
  // under the output directory. The report and video live in run-a.
  const reportDir = verifyDeterminism ? join(renderOutAbs, "run-a") : renderOutAbs;
  let renderReport = null;
  const reportPath = join(reportDir, "render-report.json");
  if (existsSync(reportPath)) {
    try {
      renderReport = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch (err) {
      console.error(`hme render: render report unreadable: ${err.message}`);
    }
  }
  let videoBytes = null;
  const videoInReportDir = join(reportDir, videoFile);
  if (existsSync(videoInReportDir)) {
    try {
      videoBytes = statSync(videoInReportDir).size;
    } catch {
      videoBytes = null;
    }
  }
  const report = buildRenderReport({
    exit,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
    renderReport,
    renderReportPath: renderReport ? reportPath : null,
    videoPath: videoInReportDir,
    videoBytes,
    framesRequested,
    verifyDeterminism,
    renderOut: renderOutAbs,
  }, sceneArg, profile, outPath);
  return writeInsightReport(report, outPath);
}
