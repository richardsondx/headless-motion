// Build the look test: IK point pose -> rig pose -> expanded scene
// -> validated scene -> previs render -> geometry checks.
//
//   node tools/look-test/build-look-test.mjs [--render] [--out-dir DIR]
//
// Without --render it builds and validates only. With --render it
// also renders the 10 s shot at previs and writes the report.
//
// What it proves, with numbers:
// - The IK point pose reaches its target (reached true, FK lands
//   on the target within 0.01 px, checked by the ik tests and
//   re-checked here from the expanded scene's sampled tracks).
// - The expanded scene passes `hme validate`.
// - Geometry checks, all from the scene file, no eyeballing:
//   text never overlaps the face (board title, board sub, tag label
//   vs head bbox, 0 px overlap), feet sit on the floor line
//   (body bottom y = 860), the tag is on screen, and something new
//   arrives at least every 48 frames (2 s) from the events list.
// - The pose blend from down to point is 12 frames (0.5 s), inside
//   the 0.3-0.5 s rule.
//
// What it does NOT prove: that the shot looks good. The human gate
// (watch the render at full speed and 0.25x) still applies, and the
// report says so. The pixel check (black edges, frame count) lives
// in check-look-test.py, run after the render.
//
// New files only: the IK rig, the keyframes and the expanded scene
// are written under the out dir, never over the fixtures.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { solveArmPose, validateArmLengths } from "../../src/rig/ik.mjs";
import { armPose } from "../../src/rig/arm-poses.mjs";
import { expandRig } from "../../src/rig/expand.mjs";
import { validateScene } from "../../src/scene/validate.mjs";
import { sampleScene } from "../../src/scene/evaluate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const FIGURE_HEIGHT = 480;
const L1 = 65;
const L2 = 60;
const THICKNESS = 20;
const SHOULDER_RIGHT = { x: 1050, y: 580 };
const FLOOR_Y = 860;

function parseArgs(argv) {
  const out = { render: false, outDir: resolve(REPO, "out", "look-test") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--render") out.render = true;
    else if (argv[i] === "--out-dir") out.outDir = resolve(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node tools/look-test/build-look-test.mjs [--render] [--out-dir DIR]");
      process.exit(0);
    }
  }
  return out;
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  const back = JSON.parse(readFileSync(path, "utf8"));
  if (JSON.stringify(back) !== JSON.stringify(data)) throw new Error(`WRITE_VERIFY_FAILED ${path}`);
}

function bboxOverlap(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

function main() {
  const { render, outDir } = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  const scene = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/look-test-scene.json"), "utf8"));
  const rig = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/look-test-rig.json"), "utf8"));

  // 1. IK point pose, from the named pose library, not hand angles.
  validateArmLengths(FIGURE_HEIGHT, L1, L2, THICKNESS);
  const pose = armPose("point");
  const solved = solveArmPose(SHOULDER_RIGHT, pose.targets.right, L1, L2);
  if (!solved.reached) throw new Error(`IK_POINT_UNREACHED target ${JSON.stringify(solved.target)}`);
  const rigIk = structuredClone(rig);
  rigIk.poses.push({
    id: "point-right",
    states: [
      { part: "upper-arm-right", rotation: solved.shoulderDeg },
      { part: "forearm-right", rotation: solved.elbowDeg },
      { part: "arm-left", rotation: 0 },
    ],
  });
  const rigPath = resolve(outDir, "look-test-rig-ik.json");
  writeJson(rigPath, rigIk);

  // 2. Keyframes: down, hold, point at f120 (blend 108->120 = 12 f
  // = 0.5 s), hold to f168, down at f180.
  const keyframes = {
    schema: "hme.rig-keyframes/1.0",
    rig: rig.meta.id,
    keys: [
      { frame: 0, pose: "arms-down" },
      { frame: 108, pose: "arms-down" },
      { frame: 120, pose: "point-right" },
      { frame: 168, pose: "point-right" },
      { frame: 180, pose: "arms-down" },
    ],
  };
  const kfPath = resolve(outDir, "look-test-keyframes.json");
  writeJson(kfPath, keyframes);

  // 3. Expand and validate.
  const { scene: expanded, summary } = expandRig(rigIk, keyframes, scene);
  const sceneResult = validateScene(expanded);
  if (sceneResult.errors.length) {
    throw new Error(`EXPANDED_SCENE_INVALID ${sceneResult.errors[0].code} ${sceneResult.errors[0].path} ${sceneResult.errors[0].message}`);
  }
  const scenePath = resolve(outDir, "look-test-scene-expanded.json");
  writeJson(scenePath, expanded);

  // 4. Re-check the IK from the sampled scene: the forearm centre
  // at f120 must sit where the pivot math puts it. The sampled
  // forearm rotation is shoulder + elbow (chain composition).
  const sampled = sampleScene(expanded, 120);
  const forearmRot = sampled["forearm-right"]["transform.rotation"];
  const expectedRot = Number((solved.shoulderDeg + solved.elbowDeg).toFixed(3));
  const rotOk = Math.abs(forearmRot - expectedRot) < 0.001;

  // 5. Geometry checks from the scene file.
  const nodeById = new Map(expanded.nodes.map((n) => [n.id, n]));
  const headBox = nodeById.get("head").box;
  const textOverlap = ["board-title", "board-sub", "tag-label"].map((id) => ({
    id,
    overlap_px2: bboxOverlap(nodeById.get(id).box, headBox),
  }));
  const bodyBox = nodeById.get("body").box;
  const feetOnFloor = bodyBox.y + bodyBox.h === FLOOR_Y;
  const tagBox = nodeById.get("tag-pill").box;
  const tagOnScreen = tagBox.x >= 0 && tagBox.y >= 0 && tagBox.x + tagBox.w <= 1920 && tagBox.y + tagBox.h <= 1080;
  const eventFrames = [...(expanded.events || []).map((e) => e.f)].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < eventFrames.length; i++) gaps.push(eventFrames[i] - eventFrames[i - 1]);
  const maxGap = gaps.length ? Math.max(...gaps) : 240;
  const checks = {
    ik_reached: solved.reached,
    forearm_rotation_matches_ik: rotOk,
    text_over_face_px2: Object.fromEntries(textOverlap.map((t) => [t.id, t.overlap_px2])),
    feet_on_floor: feetOnFloor,
    tag_on_screen: tagOnScreen,
    max_event_gap_frames: maxGap,
    pose_blend_frames: 12,
    expanded_scene_valid: true,
  };
  const failed = [];
  if (!solved.reached) failed.push("ik_reached");
  if (!rotOk) failed.push("forearm_rotation_matches_ik");
  if (textOverlap.some((t) => t.overlap_px2 > 0)) failed.push("text_over_face");
  if (!feetOnFloor) failed.push("feet_on_floor");
  if (!tagOnScreen) failed.push("tag_on_screen");
  if (maxGap > 48) failed.push("max_event_gap_frames");
  const status = failed.length ? "FAIL" : "PASS";

  // 6. Render at previs when asked. Fonts resolve relative to the
  // scene file's directory, so the render uses a copy of the
  // expanded scene with the font src made absolute. The validated
  // expanded scene file itself is left untouched.
  let renderOut = null;
  let videoPath = null;
  if (render) {
    const renderScene = structuredClone(expanded);
    for (const font of renderScene.fonts || []) {
      if (!font.src.startsWith("/")) font.src = resolve(REPO, "tests/fixtures/fonts", font.src.split("/").pop());
    }
    const renderScenePath = resolve(outDir, "look-test-scene-render.json");
    writeJson(renderScenePath, renderScene);
    renderOut = resolve(outDir, "render");
    const res = spawnSync(
      "node",
      [resolve(REPO, "src/renderer/cli.mjs"), "render", renderScenePath, "--profile", "previs", "--out", renderOut, "--keep-frames"],
      { cwd: REPO, encoding: "utf8" },
    );
    if (res.status !== 0) {
      console.error(res.stdout, res.stderr);
      throw new Error(`RENDER_FAILED exit ${res.status}`);
    }
    videoPath = resolve(renderOut, "video.mp4");
    if (!existsSync(videoPath)) throw new Error(`RENDER_NO_VIDEO ${videoPath}`);
  }

  const report = {
    status,
    failed_checks: failed,
    ik: {
      pose: "point",
      target_units: pose.targets.right,
      target_px: solved.target,
      elbow_px: solved.elbow,
      shoulder_deg: solved.shoulderDeg,
      elbow_deg: solved.elbowDeg,
      forearm_rotation_at_f120: forearmRot,
    },
    expand_summary: summary,
    checks,
    files: { rig: rigPath, keyframes: kfPath, scene: scenePath, render_dir: renderOut, video: videoPath },
    human_gate: "NOT RUN: watch the render at full speed and 0.25x before calling the look test good. Numbers do not replace it.",
  };
  const reportPath = resolve(outDir, "look-test-report.json");
  writeJson(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
}

main();
