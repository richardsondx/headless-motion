// hme rig: define, keyframe, and expand a character rig.
//
//   hme rig define <rig.json> [--out <report.json>]
//   hme rig keyframe <rig.json> --pose <pose-id> --frame <f> --out <keyframes.json>
//   hme rig expand <rig.json> <keyframes.json> --scene <scene.json> --out <expanded-scene.json>
//
// Wraps src/rig/validate.mjs (validateRig / loadRig) and src/rig/expand.mjs
// (expandRig, validateKeyframes). Nothing here reimplements a check: the
// validator and the expander do the work, this module only reads their
// results into one insight report.
//
// define: validates the rig file and reports PASS/FAIL.
// keyframe: records that a pose applies at a frame, in a separate
//   keyframes file (`hme.rig-keyframes/1.0`). Never edits the rig file.
//   An existing keyframes file gains the new key; a missing one is
//   created. The pose id must exist in the rig, or the command fails.
// expand: expands rig poses into flat node and timeline tracks in a
//   scene file. Fails clearly (exit 1, no file written) when a pose
//   references a part whose node is missing from the target scene.
//   Rotation around a joint pivot is computed by the pivot math in
//   src/rig/expand.mjs (Unit C): the flat tracks carry the rotation
//   angle plus the x/y translation that puts the element's centre
//   where rotation about the pivot puts it. The expanded scene is
//   validated with validateScene before it is written, so a written file
//   always passes `hme validate`.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { validateRig, loadRig } from "../rig/validate.mjs";
import { expandRig, validateKeyframes, loadKeyframesFile, KEYFRAMES_VERSION } from "../rig/expand.mjs";
import { validateScene, loadScene } from "../scene/validate.mjs";
import { writeInsightReport } from "./hme.mjs";

export const USAGE = [
  "hme rig: Define, keyframe, and expand a character rig.",
  "",
  "Usage:",
  "  hme rig define <rig.json> [--out <report.json>]",
  "  hme rig keyframe <rig.json> --pose <pose-id> --frame <f> --out <keyframes.json>",
  "  hme rig expand <rig.json> <keyframes.json> --scene <scene.json> --out <expanded-scene.json>",
  "",
  "Subcommands:",
  "  define    Validate a rig file and report PASS/FAIL.",
  "  keyframe  Record that a pose applies at a frame, in a keyframes file.",
  "  expand    Expand rig poses into flat node and timeline tracks in a scene.",
  "",
  "Options:",
  "  --pose <id>    Pose id from the rig. Required for keyframe.",
  "  --frame <f>    Frame number. Required for keyframe.",
  "  --scene <file> Target scene file. Required for expand.",
  "  --out <file>   define: insight report (stdout when absent).",
  "                 keyframe, expand: file to write. Required.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error or an input file cannot be read.",
].join("\n") + "\n";

const DEFINE_USAGE = [
  "hme rig define: Validate a rig file and report PASS/FAIL.",
  "",
  "Usage: hme rig define <rig.json> [--out <report.json>]",
  "",
  "Arguments:",
  "  <rig.json>  Path to the rig file (schema hme.rig/1.0).",
  "",
  "Options:",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Exit codes: 0 PASS, 1 FAIL, 2 usage error or the rig file cannot be read.",
].join("\n") + "\n";

const KEYFRAME_USAGE = [
  "hme rig keyframe: Record that a pose applies at a frame.",
  "",
  "Usage: hme rig keyframe <rig.json> --pose <pose-id> --frame <f> --out <keyframes.json>",
  "",
  "Arguments:",
  "  <rig.json>  Path to the rig file (schema hme.rig/1.0).",
  "",
  "Options:",
  "  --pose <id>   Pose id from the rig. Required. Fails when the pose does not exist.",
  "  --frame <f>   Frame number, 0 up to the rig duration. Required.",
  "  --out <file>  Keyframes file to write (schema hme.rig-keyframes/1.0). Required.",
  "                When it exists, the key is added to it; when it does not, it is created.",
  "                The rig file is never edited in place.",
  "",
  "Exit codes: 0 ok, 1 FAIL (unknown pose, frame out of range, keyframes file for another rig),",
  "  2 usage error or an input file cannot be read.",
].join("\n") + "\n";

const EXPAND_USAGE = [
  "hme rig expand: Expand rig poses into flat node and timeline tracks in a scene.",
  "",
  "Usage: hme rig expand <rig.json> <keyframes.json> --scene <scene.json> --out <expanded-scene.json>",
  "",
  "Arguments:",
  "  <rig.json>        Path to the rig file (schema hme.rig/1.0).",
  "  <keyframes.json>  Path to the keyframes file (schema hme.rig-keyframes/1.0).",
  "",
  "Options:",
  "  --scene <file>  Target scene file. Required.",
  "  --out <file>    Where to write the expanded scene. Required.",
  "",
  "Fails clearly (no file written) when a pose references a part whose node is",
  "missing from the target scene. Rotation around a joint pivot is computed",
  "by the pivot math in src/rig/expand.mjs (Unit C). The expanded",
  "scene is validated before it is written, so a written file passes `hme validate`.",
  "",
  "Exit codes: 0 ok, 1 FAIL (missing node, expanded scene invalid),",
  "  2 usage error or an input file cannot be read.",
].join("\n") + "\n";

function insight(status, failedBar, detail, numbers, next, limits, meaning, thresholds) {
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers,
    corrections: [],
    context: { thresholds, control_ceiling: null, meaning },
    next,
    limits,
  };
}

function readJson(file, label) {
  try {
    return { data: JSON.parse(readFileSync(file, "utf8")), error: null };
  } catch (err) {
    return { data: null, error: `${label} cannot be read: ${err.message}` };
  }
}

function writeJsonFile(file, data) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(resolve(file), JSON.stringify(data, null, 2) + "\n");
}

function parseOptions(argv, allowed, usage) {
  const positionals = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a.startsWith("--")) {
      if (!allowed.includes(a)) {
        console.error(`hme rig: unknown option "${a}"`);
        console.error(usage);
        return { error: 2 };
      }
      if (i + 1 >= argv.length) {
        console.error(`hme rig: ${a} needs a value`);
        console.error(usage);
        return { error: 2 };
      }
      opts[a.slice(2)] = argv[++i];
    } else {
      positionals.push(a);
    }
  }
  return { positionals, opts };
}

// --- define ---------------------------------------------------------------

export function buildDefineReport(rig, result, loadError, rigArg) {
  const errors = result ? result.errors : (loadError ? [{ code: "RIG_UNREADABLE", path: "/", message: loadError }] : []);
  const warnings = result ? result.warnings : [];
  const failedBar = loadError !== null
    ? "rig file can be read"
    : errors.length > 0
      ? "rig schema and cross-reference checks (0 errors allowed)"
      : null;
  const status = failedBar === null ? "PASS" : "FAIL";
  const detail = loadError !== null
    ? `Rig file cannot be read: ${loadError}`
    : status === "PASS"
      ? `Rig ${rig?.meta?.id} is valid: ${rig.parts.length} parts, ${rig.joints.length} joints, ${rig.poses.length} poses, 0 errors.`
      : `Rig ${rig?.meta?.id ?? rigArg} has ${errors.length} error${errors.length === 1 ? "" : "s"}: ${errors[0].code} ${errors[0].path} ${errors[0].message}`;
  return insight(
    status,
    failedBar,
    detail,
    {
      rig: rigArg,
      rig_id: rig?.meta?.id ?? null,
      character: rig?.character?.id ?? null,
      part_count: Array.isArray(rig?.parts) ? rig.parts.length : 0,
      joint_count: Array.isArray(rig?.joints) ? rig.joints.length : 0,
      pose_count: Array.isArray(rig?.poses) ? rig.poses.length : 0,
      errors,
      warnings,
      error_count: errors.length,
      warning_count: warnings.length,
    },
    status === "PASS" ? `hme rig keyframe ${rigArg} --pose <pose-id> --frame 0 --out keyframes.json` : `hme rig define ${rigArg}`,
    [
      "Validation checks the rig file only. It does not check that part nodes exist in any scene; that is an expansion-time check.",
      "A rig with a bad joint or a missing part fails here, before any keyframe or expand runs.",
    ],
    status === "PASS"
      ? "The rig file matches the schema, every joint names a real part, no joint chain loops, and every pose state names a real part."
      : "The rig file cannot be trusted as written. Fix the errors in numbers.errors first.",
    { errors: 0 },
  );
}

function runDefine(argv) {
  const parsed = parseOptions(argv, ["--out"], DEFINE_USAGE);
  if (parsed.help) {
    process.stdout.write(DEFINE_USAGE);
    return 0;
  }
  if (parsed.error) return parsed.error;
  if (parsed.positionals.length !== 1) {
    console.error("hme rig define: needs one rig file, <rig.json>");
    console.error(DEFINE_USAGE);
    return 2;
  }
  const rigArg = parsed.positionals[0];
  if (!existsSync(resolve(rigArg))) {
    console.error(`hme rig define: no such file: ${rigArg}`);
    const report = buildDefineReport(null, null, `no such file: ${rigArg}`, rigArg);
    writeInsightReport(report, parsed.opts.out ?? null);
    return 2;
  }
  let rig = null;
  let loadError = null;
  try {
    rig = loadRig(rigArg);
  } catch (err) {
    loadError = err.message;
  }
  if (loadError !== null) {
    console.error(`hme rig define: cannot read ${rigArg}: ${loadError}`);
    const report = buildDefineReport(null, null, loadError, rigArg);
    writeInsightReport(report, parsed.opts.out ?? null);
    return 2;
  }
  const result = validateRig(rig);
  const report = buildDefineReport(rig, result, null, rigArg);
  return writeInsightReport(report, parsed.opts.out ?? null);
}

// --- keyframe -------------------------------------------------------------

export function buildKeyframeReport({ status, failedBar, detail, rigArg, rigId, keyframesArg, pose, frame, keys, keyframes, errors }) {
  return insight(
    status,
    failedBar,
    detail,
    {
      rig: rigArg,
      rig_id: rigId,
      keyframes: keyframesArg,
      pose,
      frame,
      key_count: keys ? keys.length : 0,
      keys: keys ?? [],
      errors: errors ?? [],
      error_count: (errors ?? []).length,
    },
    status === "PASS"
      ? `hme rig expand ${rigArg} ${keyframesArg} --scene <scene.json> --out <expanded-scene.json>`
      : `hme rig keyframe ${rigArg} --pose ${pose ?? "<pose-id>"} --frame ${frame ?? 0} --out ${keyframesArg}`,
    [
      "The keyframes file records which pose applies at which frame. It never edits the rig file.",
      "A pose id must exist in the rig, and the frame must be inside the rig duration.",
    ],
    status === "PASS"
      ? `Pose "${pose}" is recorded at frame ${frame} in ${keyframesArg}.`
      : "The key was not recorded. Fix the error in numbers.errors first.",
    { errors: 0 },
  );
}

function runKeyframe(argv) {
  const parsed = parseOptions(argv, ["--pose", "--frame", "--out"], KEYFRAME_USAGE);
  if (parsed.help) {
    process.stdout.write(KEYFRAME_USAGE);
    return 0;
  }
  if (parsed.error) return parsed.error;
  if (parsed.positionals.length !== 1) {
    console.error("hme rig keyframe: needs one rig file, <rig.json>");
    console.error(KEYFRAME_USAGE);
    return 2;
  }
  const rigArg = parsed.positionals[0];
  const { pose, frame: frameRaw, out: keyframesArg } = parsed.opts;
  if (!pose || frameRaw === undefined || !keyframesArg) {
    console.error("hme rig keyframe: --pose, --frame, and --out are all required");
    console.error(KEYFRAME_USAGE);
    return 2;
  }
  const frame = Number(frameRaw);
  if (!Number.isInteger(frame) || frame < 0) {
    console.error(`hme rig keyframe: --frame must be a non-negative integer, got "${frameRaw}"`);
    console.error(KEYFRAME_USAGE);
    return 2;
  }
  if (!existsSync(resolve(rigArg))) {
    console.error(`hme rig keyframe: no such file: ${rigArg}`);
    return 2;
  }
  let rig;
  try {
    rig = loadRig(rigArg);
  } catch (err) {
    console.error(`hme rig keyframe: cannot read ${rigArg}: ${err.message}`);
    return 2;
  }
  const rigResult = validateRig(rig);
  if (rigResult.errors.length) {
    console.error(`hme rig keyframe: rig is invalid: ${rigResult.errors[0].code} ${rigResult.errors[0].path} ${rigResult.errors[0].message}`);
    const report = buildKeyframeReport({
      status: "FAIL",
      failedBar: "rig schema and cross-reference checks (0 errors allowed)",
      detail: `Rig ${rigArg} is invalid, so no key was recorded.`,
      rigArg, rigId: rig.meta?.id ?? null, keyframesArg, pose, frame,
      keys: null, errors: rigResult.errors,
    });
    writeInsightReport(report, null);
    return 1;
  }
  // Load the existing keyframes file when present; start fresh otherwise.
  let keyframes = null;
  if (existsSync(resolve(keyframesArg))) {
    const { data, error } = readJson(resolve(keyframesArg), "keyframes file");
    if (error) {
      console.error(`hme rig keyframe: ${error}`);
      return 2;
    }
    keyframes = data;
    if (keyframes.schema !== KEYFRAMES_VERSION) {
      const errors = [{ code: "SCHEMA_VERSION", path: "/schema", message: `expected "${KEYFRAMES_VERSION}", got ${JSON.stringify(keyframes.schema)}` }];
      console.error(`hme rig keyframe: ${errors[0].message}`);
      writeInsightReport(buildKeyframeReport({
        status: "FAIL", failedBar: "keyframes file schema", detail: errors[0].message,
        rigArg, rigId: rig.meta.id, keyframesArg, pose, frame, keys: null, errors,
      }), null);
      return 1;
    }
    if (keyframes.rig !== rig.meta.id) {
      const errors = [{ code: "RIG_MISMATCH", path: "/rig", message: `keyframes file is for rig "${keyframes.rig}", not rig "${rig.meta.id}"` }];
      console.error(`hme rig keyframe: ${errors[0].message}`);
      writeInsightReport(buildKeyframeReport({
        status: "FAIL", failedBar: "keyframes file rig match", detail: errors[0].message,
        rigArg, rigId: rig.meta.id, keyframesArg, pose, frame, keys: keyframes.keys ?? null, errors,
      }), null);
      return 1;
    }
    if (!Array.isArray(keyframes.keys)) {
      console.error("hme rig keyframe: keyframes file has no keys array");
      return 2;
    }
  } else {
    keyframes = { schema: KEYFRAMES_VERSION, rig: rig.meta.id, keys: [] };
  }
  // The pose must exist in the rig, or the key is refused, not recorded.
  if (!rig.poses.some((p) => p.id === pose)) {
    const errors = [{ code: "UNKNOWN_POSE", path: "/pose", message: `pose "${pose}" does not exist in rig "${rig.meta.id}"; known poses: ${rig.poses.map((p) => p.id).join(", ")}` }];
    console.error(`hme rig keyframe: ${errors[0].message}`);
    writeInsightReport(buildKeyframeReport({
      status: "FAIL", failedBar: "pose exists in the rig", detail: errors[0].message,
      rigArg, rigId: rig.meta.id, keyframesArg, pose, frame, keys: keyframes.keys, errors,
    }), null);
    return 1;
  }
  if (frame > rig.meta.duration) {
    const errors = [{ code: "KEY_RANGE", path: "/frame", message: `frame ${frame} is past the rig duration of ${rig.meta.duration} frames` }];
    console.error(`hme rig keyframe: ${errors[0].message}`);
    writeInsightReport(buildKeyframeReport({
      status: "FAIL", failedBar: "frame inside the rig duration", detail: errors[0].message,
      rigArg, rigId: rig.meta.id, keyframesArg, pose, frame, keys: keyframes.keys, errors,
    }), null);
    return 1;
  }
  // Add the key, or keep the existing one when the same pose is already
  // recorded at the same frame (idempotent; no duplicate keys).
  const already = keyframes.keys.some((k) => k.frame === frame && k.pose === pose);
  if (!already) {
    keyframes.keys.push({ frame, pose });
    keyframes.keys.sort((a, b) => a.frame - b.frame);
  }
  try {
    writeJsonFile(keyframesArg, keyframes);
  } catch (err) {
    console.error(`hme rig keyframe: cannot write ${keyframesArg}: ${err.message}`);
    return 2;
  }
  const report = buildKeyframeReport({
    status: "PASS",
    failedBar: null,
    detail: already
      ? `Pose "${pose}" was already recorded at frame ${frame} in ${keyframesArg}; no duplicate key was added.`
      : `Pose "${pose}" recorded at frame ${frame} in ${keyframesArg} (${keyframes.keys.length} key${keyframes.keys.length === 1 ? "" : "s"}).`,
    rigArg, rigId: rig.meta.id, keyframesArg, pose, frame, keys: keyframes.keys, errors: [],
  });
  // The keyframes file is the artifact; the insight report goes to stdout.
  writeInsightReport(report, null);
  return 0;
}

// --- expand ---------------------------------------------------------------

export function buildExpandReport({ status, failedBar, detail, rigArg, rigId, keyframesArg, sceneArg, outArg, summary, errors }) {
  return insight(
    status,
    failedBar,
    detail,
    {
      rig: rigArg,
      rig_id: rigId,
      keyframes: keyframesArg,
      scene: sceneArg,
      out: outArg,
      summary: summary ?? null,
      errors: errors ?? [],
      error_count: (errors ?? []).length,
    },
    status === "PASS"
      ? `hme validate ${outArg}`
      : `hme rig expand ${rigArg} ${keyframesArg} --scene ${sceneArg} --out ${outArg}`,
    [
      "Expand writes direct track keys for parts that need no joint rotation. Rotation on a jointed part is computed around the joint pivot (src/rig/expand.mjs, Unit C): the flat tracks carry the rotation angle plus the x/y translation that puts the element centre where rotation about the pivot puts it.",
      "A pose that references a part whose node is missing from the target scene fails; no node is silently skipped.",
      "The expanded scene is validated before it is written, so a written file passes `hme validate`.",
    ],
    status === "PASS"
      ? "The rig poses expanded into flat node and timeline tracks, and the expanded scene passes validation."
      : "Nothing was expanded and no file was written. Fix the error in numbers.errors first.",
    { errors: 0 },
  );
}

function runExpand(argv) {
  const parsed = parseOptions(argv, ["--scene", "--out"], EXPAND_USAGE);
  if (parsed.help) {
    process.stdout.write(EXPAND_USAGE);
    return 0;
  }
  if (parsed.error) return parsed.error;
  if (parsed.positionals.length !== 2) {
    console.error("hme rig expand: needs a rig file and a keyframes file, <rig.json> <keyframes.json>");
    console.error(EXPAND_USAGE);
    return 2;
  }
  const [rigArg, keyframesArg] = parsed.positionals;
  const { scene: sceneArg, out: outArg } = parsed.opts;
  if (!sceneArg || !outArg) {
    console.error("hme rig expand: --scene and --out are both required");
    console.error(EXPAND_USAGE);
    return 2;
  }
  for (const [arg, label] of [[rigArg, "rig"], [keyframesArg, "keyframes"], [sceneArg, "scene"]]) {
    if (!existsSync(resolve(arg))) {
      console.error(`hme rig expand: no such ${label} file: ${arg}`);
      return 2;
    }
  }
  let rig, keyframes, scene;
  try {
    rig = loadRig(rigArg);
  } catch (err) {
    console.error(`hme rig expand: cannot read ${rigArg}: ${err.message}`);
    return 2;
  }
  try {
    keyframes = loadKeyframesFile(keyframesArg);
  } catch (err) {
    console.error(`hme rig expand: cannot read ${keyframesArg}: ${err.message}`);
    return 2;
  }
  try {
    scene = loadScene(sceneArg);
  } catch (err) {
    console.error(`hme rig expand: cannot read ${sceneArg}: ${err.message}`);
    return 2;
  }
  let expanded;
  try {
    expanded = expandRig(rig, keyframes, scene);
  } catch (err) {
    console.error(`hme rig expand: ${err.message}`);
    const report = buildExpandReport({
      status: "FAIL",
      failedBar: err.message.split(":")[0] === "MISSING_NODE"
        ? "every pose part has a node in the target scene"
        : err.message.startsWith("ROTATION_NOT_IMPLEMENTED")
          ? "rotation around a joint pivot (pivot math in src/rig/expand.mjs)"
          : "rig, keyframes, and scene are valid for expansion",
      detail: err.message,
      rigArg, rigId: rig.meta?.id ?? null, keyframesArg, sceneArg, outArg,
      summary: null, errors: [{ code: err.message.split(":")[0], path: "/", message: err.message }],
    });
    writeInsightReport(report, null);
    return 1;
  }
  // Validate the expanded scene before writing it.
  const sceneResult = validateScene(expanded.scene);
  if (sceneResult.errors.length) {
    const first = sceneResult.errors[0];
    console.error(`hme rig expand: expanded scene is invalid: ${first.code} ${first.path} ${first.message}`);
    const report = buildExpandReport({
      status: "FAIL",
      failedBar: "expanded scene passes hme validate (0 errors allowed)",
      detail: `Expanded scene has ${sceneResult.errors.length} error${sceneResult.errors.length === 1 ? "" : "s"}: ${first.code} ${first.path} ${first.message}`,
      rigArg, rigId: rig.meta.id, keyframesArg, sceneArg, outArg,
      summary: expanded.summary, errors: sceneResult.errors,
    });
    writeInsightReport(report, null);
    return 1;
  }
  try {
    writeJsonFile(outArg, expanded.scene);
  } catch (err) {
    console.error(`hme rig expand: cannot write ${outArg}: ${err.message}`);
    return 2;
  }
  const report = buildExpandReport({
    status: "PASS",
    failedBar: null,
    detail: `Expanded ${expanded.summary.posesApplied} pose key${expanded.summary.posesApplied === 1 ? "" : "s"} into ${expanded.summary.keysWritten} track key${expanded.summary.keysWritten === 1 ? "" : "s"} across ${expanded.summary.tracksTouched} track${expanded.summary.tracksTouched === 1 ? "" : "s"}; ${outArg} passes hme validate.`,
    rigArg, rigId: rig.meta.id, keyframesArg, sceneArg, outArg,
    summary: expanded.summary, errors: [],
  });
  writeInsightReport(report, null);
  return 0;
}

// --- dispatcher -----------------------------------------------------------

// Run `hme rig <subcommand> ...`. Returns the process exit code:
// 0 ok or PASS, 1 FAIL, 2 usage error. Never prints a stack trace.
export function runRig(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  if (sub === "define") return runDefine(argv.slice(1));
  if (sub === "keyframe") return runKeyframe(argv.slice(1));
  if (sub === "expand") return runExpand(argv.slice(1));
  console.error(`hme rig: unknown subcommand "${sub}"`);
  console.error("Subcommands: define, keyframe, expand. Run `hme rig --help` for usage.");
  return 2;
}
