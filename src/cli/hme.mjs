#!/usr/bin/env node
// hme: one binary for the headless motion tool.
// Every command takes paths as arguments, writes one JSON report in the
// insight format (src/cli/insight-schema.json), and exits non-zero on FAIL.
// Nothing is hardcoded to a video, a segment, or a frame count.
// Exit codes: 0 ok or PASS, 1 FAIL, 2 usage or not implemented yet.
// U1 builds this dispatcher and the insight schema only. The command
// modules (U3 to U9) do not exist yet, so every command below reports
// "not implemented yet" until its unit lands. That is by design, not a
// crash: no stack trace, exit code 2.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompare } from "./compare.mjs";
import { runLayering } from "./layering.mjs";
import { runBlurGrain } from "./blur-grain.mjs";
import { runFonts } from "./fonts.mjs";
import { runControl } from "./control.mjs";
import { runPlayerPass } from "./player-pass.mjs";
import { runTrace } from "./trace.mjs";
import { runFrameStyle } from "./frame-style.mjs";
import { runTiming } from "./timing.mjs";
import { runDiagnose } from "./diagnose.mjs";
import { runColour } from "./colour.mjs";
import { runContour } from "./contour.mjs";
import { runLedger } from "./ledger.mjs";
import { runPath } from "./path.mjs";
import { runType } from "./type.mjs";
import { runExtract } from "./extract.mjs";
import { runContext } from "./context.mjs";
import { runMcp } from "./mcp.mjs";
import { runRender } from "./render.mjs";
import { runValidate } from "./validate.mjs";
import { runExport } from "./export.mjs";
import { runGates } from "./gates.mjs";
import { runVignette } from "./vignette.mjs";
import { runZoomVelocity } from "./zoom-velocity.mjs";
import { runGradient } from "./gradient.mjs";
import { runComposition } from "./composition.mjs";
import { runFix } from "./fix.mjs";
import { runRig } from "./rig.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, "insight-schema.json");
export const insightSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

export const VERSION = "0.1.0";

// One entry per command. Later units import COMMANDS to wire their module
// and to keep --help and the MCP tool list in step.
export const COMMANDS = [
  {
    name: "render",
    summary: "Render a scene to video.",
    usage: "hme render <scene.json> --profile previs|draft|final|final-max|preview-rt [--render-out <dir>] [--out <report.json>]",
    args: ["<scene.json>  Path to the scene file."],
    options: [
      "--profile <name>  Render profile: previs, draft, final, final-max, or preview-rt. Required.",
      "--render-out <dir>  Directory for the video and frames. Default: scene-id-render beside the report.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
      "--frames <a:b>  Render frames a up to but not including b.",
      "--order <f,f,f>  Render frames in this order.",
      "--set <path=value>  Change one scene value, for example nodes.title.props.text=\"New title\". Repeatable.",
      "--keep-frames  Keep the rendered frame images.",
      "--verify-determinism  Render twice and fail if any frame differs.",
      "--realtime  Shorthand for --profile preview-rt, a non-deterministic preview.",
    ],
    example: "hme render tests/fixtures/scene-min.json --profile previs --out out/scene-min-render.json",
  },
  {
    name: "validate",
    summary: "Check a scene file against the scene schema.",
    usage: "hme validate <scene.json> [--out <report.json>]",
    args: ["<scene.json>  Path to the scene file."],
    options: ["--out <file>  Write the JSON report here. Without it, the report goes to stdout."],
    example: "hme validate tests/fixtures/seg4-scene-clone-v5.json",
  },
  {
    name: "export",
    summary: "Export a scene or a video to an EffectCraft .ecproj file.",
    usage: "hme export <scene.json> --to ecproj --out <file.ecproj> [--report <report.json>]\n       hme export <input.mp4> --to ecproj --out <file.ecproj> [--report <report.json>]",
    args: [
      "<scene.json>  Path to the scene file.",
      "<input.mp4>  Path to a video file. Frames are extracted with ffmpeg to a frames folder next to the .ecproj file, and the .ecproj file holds one Sequence footage item plus one comp.",
    ],
    options: [
      "--to <format>  Export format. Only ecproj is supported. Required.",
      "--out <file>  Write the .ecproj file here. Required.",
      "--report <file>  Write the JSON report here. Without it, the report goes to stdout.",
    ],
    example: "hme export tests/fixtures/scene-min.json --to ecproj --out out/scene-min.ecproj",
  },
  {
    name: "gates",
    summary: "Run the map gates G8 and G9 on a scene.",
    usage: "hme gates <scene.json> [--out <report.json>]",
    args: ["<scene.json>  Path to the scene file. It must have a map node."],
    options: ["--out <file>  Write the JSON report here. Without it, the report goes to stdout."],
    example: "hme gates tests/fixtures/seg4-scene-clone-v5.json",
  },
  {
    name: "compare",
    summary: "Compare our video against the reference, frame by frame.",
    usage: "hme compare <ref.mp4> <ours.mp4> [--out <report.json>]",
    args: [
      "<ref.mp4>  Path to the reference video.",
      "<ours.mp4>  Path to our rendered video.",
    ],
    options: [
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
      "--full  Compare the full span, not only the map part.",
    ],
    example: "hme compare ref.mp4 ours.mp4 --out out/seg4/compare.json",
  },
  {
    name: "layering",
    summary: "Measure depth and layering between a reference frame and our render.",
    usage: "hme layering --ref <frame> --ours <frame> --scene <scene.json> --trace <trace.json> [--profile <name>] --out <report.json>",
    args: [],
    options: [
      "--ref <file>  Path to the reference frame. Required.",
      "--ours <file>  Path to our rendered frame. Required.",
      "--scene <file>  Path to the scene file. Required.",
      "--trace <file>  Path to the trace file. Required.",
      "--profile <name>  Render profile that made the ours frame (draft, final, ...). Optional, default unknown.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
    ],
    example: "hme layering --ref ref-0168.png --ours v5-0168.png --scene tests/fixtures/seg4-scene-clone-v5.json --trace verify-seg4/evidence/seg4-trace.json --out verify-seg4/evidence/work/layering/layering-seg4.json",
  },
  {
    name: "blur-grain",
    summary: "Measure motion blur and grain over time in one video. Pair mode adds a reference.",
    usage: "hme blur-grain video.mp4 [--out <report.json>]\n       hme blur-grain reference.mp4 ours.mp4 [--out <report.json>]",
    args: ["video.mp4  Path to the video to measure."],
    options: ["--out <file>  Write the JSON report here. Without it, the report goes to stdout."],
    example: "hme blur-grain ours.mp4 --out out/blur-grain.json",
  },
  {
    name: "trace",
    summary: "Measure a video and write its reference profile: cuts, palette, and per-colour paths.",
    usage: "hme trace video.mp4 --start-s <n> --end-s <n> --out <dir> [--skip-traces] [--subject-colour <hex>] [--badge-colour <hex>] [--labels <text,...>]",
    args: ["video.mp4  Path to the video to measure."],
    options: [
      "--start-s <n>  Start time in seconds. Required.",
      "--end-s <n>  End time in seconds. Required.",
      "--out <dir>  Directory for reference-profile.json, or a .json file path. Without it, the profile goes to stdout.",
      "--skip-traces  Skip the VTracer pass (Pass 4), the slow part.",
      "--subject-colour <hex>  Colour the zoom curve follows. Default #143C34.",
      "--badge-colour <hex>  Colour the badge trajectory follows. Default #CC4726.",
      "--labels <text,...>  Label texts to record, for example SUDAN,EL FASHER.",
    ],
    example: "hme trace ref.mp4 --start-s 0 --end-s 8 --skip-traces --out out/seg4/",
  },
  {
    name: "frame-style",
    summary: "Measure a video frame by frame and write a plain-language style prompt from the pace numbers.",
    usage: "hme frame-style <video.mp4> --start-s <n> --end-s <n> --out <prompt.md> [--report <report.json>] [--csv <per-frame.csv>] [--fps <n>]",
    args: ["<video.mp4>  Path to the reference video."],
    options: [
      "--start-s <n>  Start time in seconds. Required.",
      "--end-s <n>  End time in seconds. Required, and after --start-s.",
      "--out <file>  Write the style prompt here. Required.",
      "--report <file>  Write the JSON insight report here. Without it, the report goes to stdout.",
      "--csv <file>  Write one row per frame (frame, time, mean_abs_diff, changed). Without it, no CSV is written.",
      "--fps <n>  Frames per second to extract at. Default: the video native fps from ffprobe.",
      "Proof: on the 24-frame Headless Motion descent clip (24 fps, 1.0 s, 480p) the tool reads 24 frames, a changed fraction of 0.3478, and a longest static run of 15 frames.",
    ],
    example: "hme frame-style ref.mp4 --start-s 0 --end-s 20 --out out/style-prompt.md --csv out/style-frames.csv",
  },
  {
    name: "timing",
    summary: "Measure the time offset of one object between two videos.",
    usage: "hme timing --ref ref.mp4 --render ours.mp4 [--object #CC4726] [--out report.json]\n       hme timing --ref-profile ref.json --render-profile ours.json [--object #CC4726] [--out report.json]",
    args: [],
    options: [
      "--ref <file>  Path to the reference video. Required, unless --ref-profile is given.",
      "--render <file>  Path to the rendered video. Required, unless --render-profile is given.",
      "--object <colour or label>  Hex colour (for example #CC4726) or a label from the alias table (for example RSF badge). Default #CC4726.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
      "--ref-profile <file>  Trace profile JSON for the reference video, instead of the video. Needs --render-profile too.",
      "--render-profile <file>  Trace profile JSON for the rendered video, instead of the video. Needs --ref-profile too.",
    ],
    example: "hme timing --ref ref.mp4 --render ours.mp4 --object '#CC4726' --out out/timing.json",
  },
  {
    name: "diagnose",
    summary: "List the corrections for one frame pair, in scene terms.",
    usage: "hme diagnose <ref-frame.png> <ours-frame.png> --scene <scene.json> [--out <report.json>]",
    args: [
      "<ref-frame.png>  One frame from the reference video.",
      "<ours-frame.png>  The same frame from our video.",
    ],
    options: [
      "--scene <file>  Path to the scene file. Required.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout. overlay.png and diff.png are written next to the report.",
      "--at-s <n>  Time in seconds of the frame. Detected from the frame name (for example real-7s.png means 7 s) when absent.",
    ],
    example: "hme diagnose ref-5s.png ours-5s.png --scene tests/fixtures/seg4-scene-clone-v5.json",
  },
  {
    name: "colour",
    summary: "Measure the whole-frame colour histogram and the halo radial profile for one frame pair.",
    usage: "hme colour <ref-frame.png> <ours-frame.png> [--at-s <n>] [--out <report.json>]",
    args: [
      "<ref-frame.png>  One frame from the reference video.",
      "<ours-frame.png>  The same frame from our video.",
    ],
    options: [
      "--at-s <n>  Time in seconds of the frame. When absent, it is derived from the ref frame number at 24 fps (ref-0168.png means 7 s).",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
    ],
    example: "hme colour ref-0168.png v5-0168.png --at-s 7 --out out/seg4/colour-7s.json",
  },
  {
    name: "contour",
    summary: "Measure a Sudan outline against a reference outline on one frame pair.",
    usage: "hme contour <ref-frame.png> <ours-frame.png> [--at-s <n>] [--out <report.json>]",
    args: [
      "<ref-frame.png>  One frame from the reference video.",
      "<ours-frame.png>  The same frame from our video.",
    ],
    options: [
      "--at-s <n>  Time in seconds of the frame. When absent, it is derived from the ref frame number at 24 fps (ref-0168.png means 7 s).",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
    ],
    example: "hme contour ref-0168.png v5-0168.png --at-s 7 --out out/seg4/contour-7s.json",
  },
  {
    name: "ledger",
    summary: "Build and diff coordinate ledgers, one JSON file per video or render.",
    usage: "hme ledger build --scene <scene.json> --frames <a:b> --out <ledger.json>\n       hme ledger build --video video.mp4 --alias <alias.json> [--frames <a:b>] --out <ledger.json>\n       hme ledger build --frames-dir <dir> --alias <alias.json> [--fps <n>] [--frames <a:b>] --out <ledger.json>\n       hme ledger diff --ref <ledger.json> --ours <ledger.json> [--out <diff.json>]",
    args: [
      "build  Write a ledger file from a scene (computed) or a video or frames dir (measured).",
      "diff  Compare two ledgers and list per-element per-frame deltas plus the worst element.",
    ],
    options: [
      "--scene <file>  Scene file for a computed build. No render is needed. No alias table is used.",
      "--video <file>  Video file for a measured build. Frames are extracted with ffmpeg at native fps.",
      "--frames-dir <dir>  Directory of frame PNGs for a measured build, in sorted order.",
      "--alias <file>  Alias table file (schema hme.alias/1.0). Required for a measured build. A cluster with no entry is listed as unnamed.",
      "--frames <a:b>  Frame window, a up to but not including b. Default for a scene is 0 up to its duration.",
      "--fps <n>  Frames per second of a frames dir. Default 24. A video reads its fps from ffprobe.",
      "--ref <file>  Reference ledger for diff. Required.",
      "--ours <file>  Our ledger for diff. Required.",
      "--out <file>  Write the ledger or diff JSON here. Required for build; diff writes to stdout without it.",
    ],
    example: "hme ledger build --scene tests/fixtures/seg4-scene-clone-v5.json --frames 0:120 --out out/seg4-computed.json",
  },
  {
    name: "path",
    summary: "Edit a vector path by node id and write a new versioned scene file.",
    usage: "hme path <command> --scene <scene.json> --node <node-id> [options] --out <new-scene.json>\n       hme path move --scene <scene.json> --node outline --point p2 --dx 12 --dy 0 --out <new-scene.json>",
    args: [
      "move  Move one named node by dx, dy px. Its handles move with it.",
      "handle  Pull one named handle (in or out) of one node by dx, dy px.",
      "insert  Insert a new node after a named node, at x, y px.",
      "delete  Delete one named node. At least one node stays.",
      "convert  Convert one named node between line, cubic, and smooth.",
      "smooth  Smooth a run of nodes from one id to another id.",
      "simplify  Drop run nodes within a px tolerance of the chord.",
    ],
    options: [
      "--scene <file>  Scene file to edit. Required.",
      "--node <id>  Shape node id that holds the points list. Required.",
      "--point <id>  Point id to move, pull, delete, or convert.",
      "--after <id>  Point id to insert after. Required for insert.",
      "--id <id>  Id for the inserted point. Required for insert.",
      "--x <n>  X in box-local px for the inserted point. Required for insert.",
      "--y <n>  Y in box-local px for the inserted point. Required for insert.",
      "--command <line|cubic|smooth>  Command for the inserted point. Default line.",
      "--in <x,y>  In-handle for the inserted point. Default null.",
      "--outh <x,y>  Out-handle for the inserted point. Default null.",
      "--handle <in|out>  Which handle to pull. Required for handle.",
      "--dx <n>  Move in x, px. Required for move and handle.",
      "--dy <n>  Move in y, px. Required for move and handle.",
      "--to <line|cubic|smooth>  Target command for convert, or last point id of a run for smooth and simplify.",
      "--from <id>  First point id of a run. Required for smooth and simplify.",
      "--tolerance <n>  Max px a dropped node may sit from the chord. Required for simplify.",
      "--out <file>  Where to write the new scene file. Required. Never overwrites an existing file.",
    ],
    example: "hme path move --scene tests/fixtures/path-points.json --node outline --point p2 --dx 12 --dy 0 --out /tmp/path-points-v2.json",
  },
  {
    name: "type",
    summary: "Measure letterforms in two labels: per-letter overlap, spacing, stroke, and anti-aliasing.",
    usage: "hme type <ref-frames-dir> <ours-frames-dir> --trace <trace.json> [--scene <scene.json>] [--frames <label:side:list>] [--out <report.json>]",
    args: [
      "<ref-frames-dir>  Directory of reference frames.",
      "<ours-frames-dir>  Directory of our rendered frames. Frame files are paired by sorted index, so the two dirs hold the same frame numbers in the same order.",
    ],
    options: [
      "--trace <file>  Path to the trace JSON. Required. It supplies the two label boxes and the El Fasher dot centre.",
      "--scene <file>  Path to the scene file. It supplies scene element ids and sizes for corrections.",
      "--frames <label:side:list>  Frame set for one label, for example el-fasher:156,168,180 or october:ref:12,24. Repeatable. Defaults: EL FASHER 156, 168, 180; October ref 12, 24; October ours 24, 36.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
      "Report fields: verdict (PASS or FAIL), numbers (per-letter overlap, spacing, stroke, and anti-aliasing per label, plus per-pair kerning gaps), corrections (in scene terms), context, next, limits.",
    ],
    example: "hme type verify-seg4/evidence/work/full-192 verify-seg4/evidence/work/full-192 --trace verify-seg4/evidence/seg4-trace.json --out out/seg4/type.json",
  },
  {
    name: "control",
    summary: "Run the control experiment: screenshot the video through the player path and report the ceiling.",
    usage: "hme control video.mp4 [--crf <n>] [--out <report.json>]",
    args: ["video.mp4  Path to the video to screenshot."],
    options: [
      "--crf <n>  Encode quality used for the screenshot pass.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
    ],
    example: "hme control ref.mp4 --out out/seg4/control.json",
  },
  {
    name: "extract",
    summary: "Extract pixels of one colour from a frame, plus the largest part.",
    usage: "hme extract <frame.png> --colour <hex> --out <png>",
    args: ["<frame.png>  Path to the frame image."],
    options: [
      "--colour <hex>  Colour to find, for example #c8102e. Required.",
      "--out <file>  Write the RGBA PNG here. Required. The JSON report goes to stdout.",
      "--luma-max <n>  Keep only pixels below this luma. Default 150.",
      "--dist-min <n>  Colour distance that counts as not-the-colour. Default 50.",
      "--exclude <x,y,w,h>  Rect to clear, in crop coordinates.",
    ],
    example: "hme extract frame.png --colour #CC4726 --out out/seg4/rifle.png --exclude 0,131,160,35",
  },
  {
    name: "fonts",
    summary: "Identify the font in a frame by matching against Google Fonts.",
    usage: "hme fonts <frame.png> --text <words> [--out <report.json>]",
    args: ["<frame.png>  Path to the frame image."],
    options: [
      "--text <words>  The words shown in the frame, for example \"EL FASHER\". Required.",
      "--box <x,y,w,h>  Search rectangle for the label. Without it, the label line is found from the frame.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
    ],
    example: "hme fonts frame.png --text \"EL FASHER\" --out out/seg4/fonts.json",
  },
  {
    name: "player-pass",
    summary: "Screenshot a video through the player path, as a viewer sees it.",
    usage: "hme player-pass video.mp4 --seconds <list> [--out <report.json>]",
    args: ["video.mp4  Path to the video."],
    options: [
      "--seconds <list>  Seconds to capture, for example 0,5,7.75.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
    ],
    example: "hme player-pass ref.mp4 --seconds 0,5,7.75 --out out/seg4/player-pass.json",
  },
  {
    name: "context",
    summary: "Return everything an agent needs to work on a clone in one JSON report.",
    usage: "hme context [--scene <scene.json>] [--out <report.json>]",
    args: [],
    options: [
      "--scene <file>  Path to the current scene file, when there is one.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
    ],
    example: "hme context --scene tests/fixtures/seg4-scene-clone-v5.json",
  },
  {
    name: "mcp",
    summary: "Serve the same commands as MCP tools over stdio.",
    usage: "hme mcp",
    args: [],
    options: [
      "Reads JSON-RPC 2.0 requests, one per line, on stdin and writes one response per line on stdout. No other output goes to stdout.",
      "Tools: compare, trace, diagnose, control, extract, fonts, player-pass, context, frame-style. Resources: hme://predicate, hme://ceiling, hme://rules/map, hme://schema/scene.",
    ],
    example: "hme mcp",
  },
  {
    name: "zoom-velocity",
    summary: "Measure the camera zoom as a move on two videos.",
    usage: "hme zoom-velocity <ref.mp4> <ours.mp4> --ref-colour '#123B34' --ours-colour '#0C352E' --tolerance 6 --scene <scene.json> --out <report.json>",
    args: [
      "<ref.mp4>  Path to the reference video.",
      "<ours.mp4>  Path to our rendered video.",
    ],
    options: [
      "--ref-colour <hex>  Sudan colour on the reference side. Default #123B34.",
      "--ours-colour <hex>  Sudan colour on our side. Default #0C352E.",
      "--tolerance <n>  Per-channel colour tolerance. Default 6.",
      "--scene <file>  Scene file for the camera knot times (its events list). Optional.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
    ],
    example: "hme zoom-velocity ref.mp4 ours.mp4 --scene tests/fixtures/seg4-scene-clone-v5.json --out out/seg4/zoom-velocity.json",
  },
  {
    name: "vignette",
    summary: "Measure whether a video has a vignette, and how strong.",
    usage: "hme vignette <input.mp4> [--out <report.json>]\n       hme vignette <ref.mp4> <ours.mp4> [--out <report.json>]",
    args: [
      "<input.mp4>  Path to the video to measure (one-video form).",
      "<ref.mp4>  Path to the reference video (pair form).",
      "<ours.mp4>  Path to our rendered video (pair form).",
    ],
    options: ["--out <file>  Write the JSON report here. Without it, the report goes to stdout."],
    example: "hme vignette ref.mp4 ours.mp4 --out out/vignette.json",
  },
  {
    name: "gradient",
    summary: "Measure the vertical colour gradient of one frame: slope top to bottom per channel plus a falloff curve.",
    usage: "hme gradient <frame.png> [--region <x,y,w,h>] [--bands <n>] [--at-s <n>] [--fps <n>] [--out <report.json>]",
    args: [
      "<frame.png>  One frame image (PNG).",
    ],
    options: [
      "--region <x,y,w,h>  Pixel rect to measure, in full-frame coords. Default: the whole frame. Use it to measure only the sky and keep a subject or a dark band out of the slope.",
      "--bands <n>  How many horizontal bands to split the region into. Default 10.",
      "--at-s <n>  Time in seconds of the frame. When absent, it is derived from the frame name: frame-360.png means frame 360 at --fps, real-7s.png means 7 s.",
      "--fps <n>  Frames per second for a frame-N name. Default 60.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
      "Proof: on real frame 360 the tool must read top median near RGB (132, 172, 254), bottom median near (75, 94, 241), green drop near 78, red near 57. On a batch 1 frame it must read a flat sky (drop near 0) and name the abrupt step into the dark band (34, 9, 81).",
    ],
    example: "hme gradient frame-360.png --at-s 6 --out out/gradient-360.json",
  },
  {
    name: "composition",
    summary: "Measure the subject box of one frame: box share, margins, thirds position, and eye placement.",
    usage: "hme composition <frame.png> [--threshold <n>] [--at-s <n>] [--fps <n>] [--expect <w_pct,h_pct>] [--tolerance <n>] [--out <report.json>]",
    args: [
      "<frame.png>  One frame image (PNG).",
    ],
    options: [
      "--threshold <n>  RGB distance from the row background that counts as subject. Default 40.",
      "--at-s <n>  Time in seconds of the frame. When absent, it is derived from the frame name: frame-360.png means frame 360 at --fps, real-7s.png means 7 s.",
      "--fps <n>  Frames per second for a frame-N name. Default 60.",
      "--expect <w_pct,h_pct>  Expected box shares in percent, for example 70,36. When given, the verdict is PASS only when both measured shares sit within --tolerance points of these.",
      "--tolerance <n>  Allowed gap in percentage points between a measured share and its expected share. Default 5.",
      "--out <file>  Write the JSON report here. Without it, the report goes to stdout.",
      "Proof: on batch 1 S1 the tool reads 45.3 percent wide, 68.3 percent tall, within 0.3 points of the stated 45 and 68. On real frame 360 the tool reads 93.9 percent wide, 13.3 percent tall, against the stated 70 and 36, so --expect 70,36 fails on frame 360. The stated frame 360 box does not reproduce from the pixels; see units/K/tool-report.md.",
    ],
    example: "hme composition frame-360.png --expect 70,36 --at-s 6 --out out/composition-360.json",
  },
  {
    name: "rig",
    summary: "Define, keyframe, and expand a character rig.",
    usage: "hme rig define <rig.json> [--out <report.json>]\n       hme rig keyframe <rig.json> --pose <pose-id> --frame <f> --out <keyframes.json>\n       hme rig expand <rig.json> <keyframes.json> --scene <scene.json> --out <expanded-scene.json>",
    args: [
      "<rig.json>  Path to the rig file (schema hme.rig/1.0).",
      "<keyframes.json>  Path to the keyframes file (schema hme.rig-keyframes/1.0).",
    ],
    options: [
      "define    Validate a rig file and report PASS/FAIL.",
      "keyframe  Record that a pose applies at a frame, in a keyframes file.",
      "expand    Expand rig poses into flat node and timeline tracks in a scene.",
      "--pose <id>  Pose id from the rig. Required for keyframe.",
      "--frame <f>  Frame number. Required for keyframe.",
      "--scene <file>  Target scene file. Required for expand.",
      "--out <file>  define: insight report (stdout when absent). keyframe, expand: file to write. Required.",
    ],
    example: "hme rig define rig-valid.json",
  },
  {
    name: "fix",
    summary: "Apply an insight report's corrections to a scene and write a new scene file.",
    usage: "hme fix --report <report.json> --scene <scene.json> --out <new-scene.json> [--report-out <report.json>] [--dry-run]",
    args: [],
    options: [
      "--report <file>  Insight report JSON (corrections[] plus numbers). Required.",
      "--scene <file>  Scene file to fix. Required.",
      "--out <file>  Where to write the fixed scene. Required. Never overwrites an existing file.",
      "--report-out <file>  Write the JSON report here. Without it, the report goes to stdout. Not written on --dry-run.",
      "--dry-run  Print the planned edits (the insight report) to stdout and write no file.",
      "Exit codes: 0 a file was written and the gate passed (or, on --dry-run, the plan passes the gate); 1 the gate failed or every correction was refused (no file written); 2 usage error or an input file cannot be read.",
      "Values come from the report numbers plus the scene only; the prose fix string is never parsed.",
    ],
    example: "hme fix --report out/seg4/timing.json --scene tests/fixtures/seg4-scene-clone-v5.json --out out/seg4/seg4-scene-v6.json --report-out out/seg4/fix.json",
  },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

function topHelp() {
  const lines = [
    "hme: measure, diagnose, and clone motion video through the tool.",
    "",
    `Usage: hme <command> [arguments] [options]`,
    "",
    "Commands:",
  ];
  for (const c of COMMANDS) lines.push(`  ${c.name.padEnd(12)} ${c.summary}`);
  lines.push(
    "",
    "Every measurement command writes one JSON report in the insight format",
    "(verdict, numbers, corrections, context, next, limits) to --out, or to",
    "stdout when --out is absent. It exits 0 on PASS and 1 on FAIL.",
    "",
    "Run `hme <command> --help` for one command. Run `hme --help` for this list.",
  );
  return lines.join("\n") + "\n";
}

function commandHelp(cmd) {
  const lines = [`hme ${cmd.name}: ${cmd.summary}`, "", `Usage: ${cmd.usage}`, ""];
  if (cmd.args.length) {
    lines.push("Arguments:");
    for (const a of cmd.args) lines.push(`  ${a}`);
    lines.push("");
  }
  if (cmd.options.length) {
    lines.push("Options:");
    for (const o of cmd.options) lines.push(`  ${o}`);
    lines.push("");
  }
  lines.push(`Example: ${cmd.example}`, "", "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.");
  return lines.join("\n") + "\n";
}

// Small validator for the insight format. The repo has no JSON-schema
// dependency, so this checks the required keys and types by hand. It
// mirrors src/cli/insight-schema.json; keep the two in step.
export function validateInsight(report) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  if (!isObj(report)) return { valid: false, errors: ["report must be an object"] };
  for (const k of ["verdict", "numbers", "corrections", "context", "next", "limits"]) {
    need(k in report, `missing required key: ${k}`);
  }
  if (isObj(report.verdict)) {
    need(report.verdict.status === "PASS" || report.verdict.status === "FAIL", "verdict.status must be PASS or FAIL");
    need(report.verdict.failed_bar === null || typeof report.verdict.failed_bar === "string", "verdict.failed_bar must be a string or null");
    if (report.verdict.status === "FAIL") need(typeof report.verdict.failed_bar === "string" && report.verdict.failed_bar.length > 0, "verdict.failed_bar must name the bar when status is FAIL");
    if (report.verdict.status === "PASS") need(report.verdict.failed_bar === null, "verdict.failed_bar must be null when status is PASS");
  } else if ("verdict" in report) {
    errors.push("verdict must be an object");
  }
  if ("numbers" in report) need(isObj(report.numbers), "numbers must be an object");
  if (Array.isArray(report.corrections)) {
    report.corrections.forEach((c, i) => {
      const at = `corrections[${i}]`;
      if (!isObj(c)) { errors.push(`${at} must be an object`); return; }
      for (const k of ["element", "kind", "at_s", "ours", "real", "shift_px", "fix", "source"]) {
        need(k in c, `${at} is missing ${k}`);
      }
      need(typeof c.element === "string" && c.element.length > 0, `${at}.element must be a non-empty string`);
      need(typeof c.kind === "string" && c.kind.length > 0, `${at}.kind must be a non-empty string`);
      need(isNum(c.at_s), `${at}.at_s must be a number`);
      for (const side of ["ours", "real"]) {
        if (isObj(c[side])) {
          need(isNum(c[side].x), `${at}.${side}.x must be a number`);
          need(isNum(c[side].y), `${at}.${side}.y must be a number`);
          need(isNum(c[side].px), `${at}.${side}.px must be a number`);
        } else if (side in c) errors.push(`${at}.${side} must be an object`);
      }
      if (isObj(c.shift_px)) {
        need(isNum(c.shift_px.dx), `${at}.shift_px.dx must be a number`);
        need(isNum(c.shift_px.dy), `${at}.shift_px.dy must be a number`);
      } else if ("shift_px" in c) errors.push(`${at}.shift_px must be an object`);
      need(typeof c.fix === "string" && c.fix.length > 0, `${at}.fix must be a non-empty string`);
      need(typeof c.source === "string" && c.source.length > 0, `${at}.source must be a non-empty string`);
    });
  } else if ("corrections" in report) {
    errors.push("corrections must be an array");
  }
  if (isObj(report.context)) {
    need("thresholds" in report.context && isObj(report.context.thresholds), "context.thresholds must be an object");
    need("control_ceiling" in report.context && (isObj(report.context.control_ceiling) || report.context.control_ceiling === null), "context.control_ceiling must be an object or null");
    need(typeof report.context.meaning === "string" && report.context.meaning.length > 0, "context.meaning must be a non-empty string");
  } else if ("context" in report) {
    errors.push("context must be an object");
  }
  if ("next" in report) need(typeof report.next === "string" && report.next.length > 0, "next must be a non-empty string naming one command");
  if ("limits" in report) {
    need(Array.isArray(report.limits), "limits must be an array");
    if (Array.isArray(report.limits)) need(report.limits.every((l) => typeof l === "string"), "limits must be an array of strings");
  }
  return { valid: errors.length === 0, errors };
}

// Write one insight report to --out, or to stdout when --out is absent.
// Returns 0 on PASS, 1 on FAIL, 2 when the report itself is invalid.
export function writeInsightReport(report, outPath) {
  const { valid, errors } = validateInsight(report);
  if (!valid) {
    for (const e of errors) console.error(`insight report invalid: ${e}`);
    return 2;
  }
  const text = JSON.stringify(report, null, 2) + "\n";
  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(resolve(outPath), text);
  } else {
    process.stdout.write(text);
  }
  return report.verdict.status === "PASS" ? 0 : 1;
}

async function main(argv) {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`hme ${VERSION}`);
    return 0;
  }
  if (argv.length === 0) {
    process.stderr.write(topHelp());
    return 2;
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help" && argv.length === 1) {
    process.stdout.write(topHelp());
    return 0;
  }
  if (argv[0] === "help" && argv[1]) {
    const cmd = BY_NAME.get(argv[1]);
    if (!cmd) {
      console.error(`hme: unknown command "${argv[1]}"`);
      console.error("Run `hme --help` for the list of commands.");
      return 2;
    }
    process.stdout.write(commandHelp(cmd));
    return 0;
  }
  const cmd = BY_NAME.get(argv[0]);
  if (!cmd) {
    console.error(`hme: unknown command "${argv[0]}"`);
    console.error("Run `hme --help` for the list of commands.");
    return 2;
  }
  if (argv.slice(1).includes("--help") || argv.slice(1).includes("-h")) {
    process.stdout.write(commandHelp(cmd));
    return 0;
  }
  if (cmd.name === "compare") {
    return runCompare(argv.slice(1));
  }
  if (cmd.name === "layering") {
    return runLayering(argv.slice(1));
  }
  if (cmd.name === "blur-grain") {
    return runBlurGrain(argv.slice(1));
  }
  if (cmd.name === "fonts") {
    return runFonts(argv.slice(1));
  }
  if (cmd.name === "control") {
    return runControl(argv.slice(1));
  }
  if (cmd.name === "player-pass") {
    return runPlayerPass(argv.slice(1));
  }
  if (cmd.name === "trace") {
    return runTrace(argv.slice(1));
  }
  if (cmd.name === "frame-style") {
    return runFrameStyle(argv.slice(1));
  }
  if (cmd.name === "timing") {
    return runTiming(argv.slice(1));
  }
  if (cmd.name === "diagnose") {
    return runDiagnose(argv.slice(1));
  }
  if (cmd.name === "colour") {
    return runColour(argv.slice(1));
  }
  if (cmd.name === "contour") {
    return runContour(argv.slice(1));
  }
  if (cmd.name === "ledger") {
    return runLedger(argv.slice(1));
  }
  if (cmd.name === "path") {
    return runPath(argv.slice(1));
  }
  if (cmd.name === "type") {
    return runType(argv.slice(1));
  }
  if (cmd.name === "extract") {
    return runExtract(argv.slice(1));
  }
  if (cmd.name === "context") {
    return runContext(argv.slice(1));
  }
  if (cmd.name === "render") {
    return runRender(argv.slice(1));
  }
  if (cmd.name === "validate") {
    return runValidate(argv.slice(1));
  }
  if (cmd.name === "export") {
    return runExport(argv.slice(1));
  }
  if (cmd.name === "gates") {
    return runGates(argv.slice(1));
  }
  if (cmd.name === "mcp") {
    return runMcp();
  }
  if (cmd.name === "vignette") {
    return runVignette(argv.slice(1));
  }
  if (cmd.name === "zoom-velocity") {
    return runZoomVelocity(argv.slice(1));
  }
  if (cmd.name === "fix") {
    return runFix(argv.slice(1));
  }
  if (cmd.name === "rig") {
    return runRig(argv.slice(1));
  }
  if (cmd.name === "gradient") {
    return runGradient(argv.slice(1));
  }
  if (cmd.name === "composition") {
    return runComposition(argv.slice(1));
  }
  // The command module does not exist yet (units U3 to U9). Say so plainly.
  console.error(`hme ${cmd.name}: not implemented yet`);
  console.error(`Run \`hme ${cmd.name} --help\` to see what it will take.`);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
