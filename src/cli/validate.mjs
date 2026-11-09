// hme validate: check a scene file against the scene schema, then run
// the determinism lint over the scene file text.
//
// Wraps src/scene/validate.mjs (schema walk plus cross-reference
// checks) and src/scene/lint-determinism.mjs (the same lint the
// tests/scene suite runs). Nothing here reimplements a check: the
// validator and the linter do the work, this module only reads their
// results into one insight report.
//
// The verdict is PASS when the scene has 0 errors and the lint finds
// 0 hits. Warnings do not fail the verdict: the validator exits 0
// with warnings too, and a warning names a part that was not checked
// (for example companion props with no schema yet), not a part that
// failed. The report carries the warnings so the agent can see them.
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateScene, loadScene, sceneFps } from "../scene/validate.mjs";
import { lintDir } from "../scene/lint-determinism.mjs";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
void REPO_ROOT;

export const USAGE = [
  "hme validate: Check a scene file against the scene schema.",
  "",
  "Usage: hme validate scene.json [--out report.json]",
  "",
  "Arguments:",
  "  scene.json  Path to the scene file.",
  "",
  "Options:",
  "  --out file  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error or the scene file cannot be read.",
].join("\n") + "\n";

// Build the insight report from the validator result and the lint
// hits. Pure function, tested without touching the disk.
// scene: the parsed scene, or null when it could not be read.
// result: { errors, warnings } from validateScene, or null.
// lintHits: [{ file, line, rule, text }] from lintDir.
// loadError: the read or parse error message, or null.
export function buildValidateReport(scene, result, lintHits, loadError, sceneArg) {
  const errors = result ? result.errors : (loadError ? [{ code: "SCENE_UNREADABLE", path: "/", message: loadError }] : []);
  const warnings = result ? result.warnings : [];
  const hits = Array.isArray(lintHits) ? lintHits : [];
  const id = scene?.meta?.id ?? null;
  const frames = scene?.meta?.duration ?? null;
  const fps = scene ? sceneFps(scene) : null;
  const nodes = Array.isArray(scene?.nodes) ? scene.nodes : [];
  const timeline = Array.isArray(scene?.timeline) ? scene.timeline : [];
  const failedBar = loadError !== null
    ? "scene file can be read"
    : errors.length > 0
      ? "scene schema and cross-reference checks (0 errors allowed)"
      : hits.length > 0
        ? "determinism lint (0 hits allowed)"
        : null;
  const status = failedBar === null ? "PASS" : "FAIL";
  const detail = loadError !== null
    ? `Scene file cannot be read: ${loadError}`
    : status === "PASS"
      ? `Scene ${id} is valid: ${frames} frames at ${fps} fps, 0 errors, 0 warnings, 0 determinism hits.`
      : errors.length > 0
        ? `Scene ${id ?? sceneArg} has ${errors.length} error${errors.length === 1 ? "" : "s"}: ${errors[0].code} ${errors[0].path} ${errors[0].message}`
        : `Scene ${id ?? sceneArg} passes the schema checks but the determinism lint found ${hits.length} hit${hits.length === 1 ? "" : "s"}: ${hits[0].rule} at line ${hits[0].line}.`;
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      scene: sceneArg,
      scene_id: id,
      frames,
      fps,
      node_count: nodes.length,
      track_count: timeline.length,
      event_count: Array.isArray(scene?.events) ? scene.events.length : 0,
      errors,
      warnings,
      error_count: errors.length,
      warning_count: warnings.length,
      determinism: { hits, hit_count: hits.length },
    },
    corrections: [],
    context: {
      thresholds: { errors: 0, determinism_hits: 0 },
      control_ceiling: null,
      meaning: status === "PASS"
        ? "The scene file matches the schema, every cross-reference resolves, and no banned construct appears in it, so the renderer can take it."
        : "The scene file cannot be trusted as written. Fix the errors in numbers.errors first; a render of this scene would fail or behave differently from the file.",
    },
    next: status === "PASS"
      ? `hme render ${sceneArg} --profile previs --out out/${id ?? "scene"}-render.json`
      : `hme validate ${sceneArg}`,
    limits: [
      "Validation checks the scene file only. It does not render frames or check the video.",
      "The determinism lint scans the scene file text for banned constructs. It does not prove the rendered frames are deterministic.",
      "Warnings do not fail the verdict. They name parts that were not checked, such as companion props with no schema yet.",
    ],
  };
}

// Run `hme validate <scene.json> [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run
// error. Never prints a stack trace.
export function runValidate(argv) {
  const positionals = [];
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme validate: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme validate: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme validate: needs one scene file, scene.json");
    console.error(USAGE);
    return 2;
  }
  const sceneArg = positionals[0];
  const scenePath = resolve(sceneArg);
  if (!existsSync(scenePath)) {
    console.error(`hme validate: no such file: ${sceneArg}`);
    const report = buildValidateReport(null, null, [], `no such file: ${sceneArg}`, sceneArg);
    writeInsightReport(report, outPath);
    return 2;
  }
  let scene = null;
  let loadError = null;
  try {
    scene = loadScene(scenePath);
  } catch (err) {
    loadError = err.message;
  }
  if (loadError !== null) {
    console.error(`hme validate: cannot read ${sceneArg}: ${loadError}`);
    const report = buildValidateReport(null, null, [], loadError, sceneArg);
    writeInsightReport(report, outPath);
    return 2;
  }
  let lintHits = [];
  try {
    lintHits = lintDir(scenePath);
  } catch (err) {
    console.error(`hme validate: determinism lint failed: ${err.message}`);
    return 2;
  }
  const result = validateScene(scene);
  const report = buildValidateReport(scene, result, lintHits, null, sceneArg);
  return writeInsightReport(report, outPath);
}
