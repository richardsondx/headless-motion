// hme mcp: the MCP server over stdio.
//
// One tool per implemented hme command (compare, trace, diagnose,
// control, extract, fonts, player-pass, context, frame-style), each
// with a JSON schema for its arguments, plus four readable resources
// (hme://predicate, hme://ceiling, hme://rules/map,
// hme://schema/scene). The placeholder commands (render, validate,
// gates) have no tool: the design doc gives them no implemented
// command to wrap, and a tool that returned fake results would be
// worse than no tool.
//
// Dependency-free: the repo has no MCP SDK, so this speaks JSON-RPC
// 2.0 over stdio by hand (newline-delimited, one request per line).
// Nothing but JSON-RPC lines goes to stdout; all diagnostics go to
// stderr, because stdout is the protocol.
//
// Tool execution reuses the CLI exactly: each call spawns
// `node src/cli/hme.mjs <command> ...` as a child process and reads
// the JSON report the CLI writes. That keeps the MCP result
// identical to the CLI result by construction (same code, same
// inputs), and it keeps the server's stdout clean: a command that
// writes its report to stdout (extract, player-pass) writes to the
// child's stdout, which this server captures, never to the server's
// own stdout. A FAIL verdict is data, not a transport error, so a
// command that exits 1 still returns its report; only exit 2
// (usage or run failure) becomes a JSON-RPC error.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, VERSION } from "./hme.mjs";
import { readContextParts } from "./context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const HME_PATH = join(HERE, "hme.mjs");
const DEFAULT_SCENE = join(REPO_ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json");

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const SERVER_NAME = "hme";

// The four resources, from the design doc. Their contents come from
// src/cli/context.mjs at read time, so they stay in step with the
// predicate, the ceiling, the map tokens, and the scene schema.
export const RESOURCES = [
  {
    uri: "hme://predicate",
    name: "predicate",
    description: "The frozen pred-v1 bar: the thresholds every measurement is judged against.",
    mimeType: "application/json",
  },
  {
    uri: "hme://ceiling",
    name: "ceiling",
    description: "The control ceiling: what a perfect clone scores here, from the control experiment.",
    mimeType: "application/json",
  },
  {
    uri: "hme://rules/map",
    name: "map-rules",
    description: "The Harris map rules, compact: registers, palette, typography, lines, camera, focus, gates.",
    mimeType: "application/json",
  },
  {
    uri: "hme://schema/scene",
    name: "scene-schema",
    description: "The scene schema, compact form: node types, key properties, track types.",
    mimeType: "application/json",
  },
];

const RESOURCE_PART = {
  "hme://predicate": "bar",
  "hme://ceiling": "control_ceiling",
  "hme://rules/map": "harris_rules",
  "hme://schema/scene": "scene_schema",
};

// Read one resource. Pure apart from the disk reads inside
// readContextParts. Throws an Error with a plain message when the
// URI is unknown.
export function readResource(uri, scenePath = DEFAULT_SCENE) {
  const part = RESOURCE_PART[uri];
  if (!part) throw new Error(`unknown resource: ${uri}`);
  const parts = readContextParts(scenePath);
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(parts[part], null, 2),
  };
}

// One tool per implemented command. The description comes from the
// hme COMMANDS table so --help and the tool list cannot drift apart;
// the input schema is written here, next to the argv builder that
// consumes it. Placeholder commands (render, validate, gates) are
// deliberately absent: see the header comment.
const TOOL_SCHEMAS = {
  compare: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Path to the reference video." },
      ours: { type: "string", description: "Path to our rendered video." },
      scene: { type: "string", description: "Scene file for the render, recorded in the report." },
      full: { type: "boolean", description: "Compare the full span, not only the map part. The report always covers both." },
      out: { type: "string", description: "Write the JSON report here. Without it, a temp file is used." },
    },
    required: ["ref", "ours"],
    additionalProperties: false,
  },
  trace: {
    type: "object",
    properties: {
      video: { type: "string", description: "Path to the video to measure." },
      start_s: { type: "number", description: "Start time in seconds. Required." },
      end_s: { type: "number", description: "End time in seconds. Required." },
      skip_traces: { type: "boolean", description: "Skip the VTracer pass (Pass 4), the slow part." },
      subject_colour: { type: "string", description: "Colour the zoom curve follows. Default #143C34." },
      badge_colour: { type: "string", description: "Colour the badge trajectory follows. Default #CC4726." },
      labels: { type: "array", items: { type: "string" }, description: "Label texts to record, for example [\"SUDAN\", \"EL FASHER\"]." },
      out: { type: "string", description: "Directory for reference-profile.json, or a .json file path." },
    },
    required: ["video", "start_s", "end_s"],
    additionalProperties: false,
  },
  diagnose: {
    type: "object",
    properties: {
      ref_frame: { type: "string", description: "One frame from the reference video." },
      ours_frame: { type: "string", description: "The same frame from our video." },
      scene: { type: "string", description: "Path to the scene file. Required." },
      at_s: { type: "number", description: "Time in seconds of the frame. Detected from the frame name when absent." },
      out: { type: "string", description: "Write the JSON report here. Without it, a temp file is used. overlay.png and diff.png are written next to the report." },
    },
    required: ["ref_frame", "ours_frame", "scene"],
    additionalProperties: false,
  },
  control: {
    type: "object",
    properties: {
      video: { type: "string", description: "Path to the video to screenshot." },
      crf: { type: "integer", description: "Encode quality used for the screenshot pass, 0 to 51. Without it, only the clean arm runs." },
      out: { type: "string", description: "Write the JSON report here. Without it, a temp file is used." },
    },
    required: ["video"],
    additionalProperties: false,
  },
  extract: {
    type: "object",
    properties: {
      frame: { type: "string", description: "Path to the frame image." },
      colour: { type: "string", description: "Colour to find, for example #CC4726. Required." },
      luma_max: { type: "number", description: "Keep only pixels below this luma. Default 150." },
      dist_min: { type: "number", description: "Colour distance that counts as not-the-colour. Default 50." },
      exclude: { type: "string", description: "Rect to clear, as x,y,w,h in crop coordinates." },
      out: { type: "string", description: "Write the RGBA PNG here. Without it, a temp file is used." },
    },
    required: ["frame", "colour"],
    additionalProperties: false,
  },
  fonts: {
    type: "object",
    properties: {
      frame: { type: "string", description: "Path to the frame image." },
      text: { type: "string", description: "The words shown in the frame, for example \"EL FASHER\". Required." },
      box: { type: "string", description: "Search rectangle for the label, as x,y,w,h. Without it, the label line is found from the frame." },
      out: { type: "string", description: "Write the JSON report here. Without it, a temp file is used." },
    },
    required: ["frame", "text"],
    additionalProperties: false,
  },
  "player-pass": {
    type: "object",
    properties: {
      video: { type: "string", description: "Path to the video." },
      seconds: { type: "array", items: { type: "number" }, description: "Seconds to capture, for example [0, 5, 7.75]. Required." },
      viewport: { type: "string", description: "Viewport as WxH, for example 1919x1497." },
      crop: { type: "string", description: "Crop as x,y,w,h, for example 185,55,1533,831." },
      resize: { type: "string", description: "Resize as WxH, for example 1920x1080. Needs --crop." },
      label: { type: "string", description: "Label for the output files." },
      out: { type: "string", description: "Directory for the shots and player-pass-report.json. Without it, a temp directory is used." },
    },
    required: ["video", "seconds"],
    additionalProperties: false,
  },
  context: {
    type: "object",
    properties: {
      scene: { type: "string", description: "Path to the current scene file. Default: tests/fixtures/seg4-scene-clone-v5.json." },
      out: { type: "string", description: "Write the JSON report here. Without it, a temp file is used." },
    },
    required: [],
    additionalProperties: false,
  },
  "frame-style": {
    type: "object",
    properties: {
      video: { type: "string", description: "Path to the reference video." },
      start_s: { type: "number", description: "Start time in seconds. Required." },
      end_s: { type: "number", description: "End time in seconds. Required, and after start_s." },
      out: { type: "string", description: "Write the plain-language style prompt here. Required." },
      report: { type: "string", description: "Write the JSON insight report here. Without it, a temp file is used." },
      csv: { type: "string", description: "Write one row per frame (frame, time, mean_abs_diff, changed). Without it, no CSV is written." },
      fps: { type: "number", description: "Frames per second to extract at. Default: the video native fps from ffprobe." },
    },
    required: ["video", "start_s", "end_s", "out"],
    additionalProperties: false,
  },
};

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS);

// Build the MCP tool list from the hme COMMANDS table plus the
// schemas above. Called at request time, not at module load, so the
// circular import with hme.mjs (which imports runMcp from here) has
// finished by then.
export function listTools() {
  const byName = new Map(COMMANDS.map((c) => [c.name, c]));
  return TOOL_NAMES.map((name) => ({
    name,
    description: byName.get(name)?.summary ?? name,
    inputSchema: TOOL_SCHEMAS[name],
  }));
}

function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Check the tool arguments against the schema's required keys and
// basic types. Returns an error string, or null when they pass.
// This is a guard against typos and missing paths, not a full JSON
// Schema validator: the CLI re-checks everything and its exit code
// is the authority.
export function validateToolArgs(name, args) {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return `unknown tool: ${name}`;
  if (!isRecord(args)) return `arguments for ${name} must be an object`;
  for (const key of schema.required) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return `missing required argument: ${key}`;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) continue;
    if (prop.type === "string" && typeof value !== "string") return `argument ${key} must be a string`;
    if (prop.type === "number" && typeof value !== "number") return `argument ${key} must be a number`;
    if (prop.type === "integer" && (!Number.isInteger(value))) return `argument ${key} must be a whole number`;
    if (prop.type === "boolean" && typeof value !== "boolean") return `argument ${key} must be true or false`;
    if (prop.type === "array" && !Array.isArray(value)) return `argument ${key} must be an array`;
  }
  return null;
}

// One plain-words summary per tool result, from the report itself.
// Insight reports carry verdict.detail; the trace profile carries
// cuts and a palette instead. Defensive throughout: a summary must
// never throw on a report shape it has not seen.
export function buildSummary(tool, report) {
  if (!isRecord(report)) return `${tool} finished.`;
  if (isRecord(report.verdict) && typeof report.verdict.detail === "string") {
    const parts = [report.verdict.detail];
    const n = isRecord(report.numbers) ? report.numbers : {};
    if (tool === "compare" && typeof n.ssim_mean === "number") {
      parts.push(`Mean SSIM ${n.ssim_mean}, PSNR ${n.psnr_mean}, LPIPS ${n.lpips_mean} over ${n.frames} frames.`);
      if (isRecord(n.cut) && n.cut.found) {
        parts.push(`Cut at frame ${n.cut.frame} (${n.cut.second} s).`);
      }
      if (isRecord(n.map_only) && typeof n.map_only.ssim_mean === "number") {
        parts.push(`Map-only mean SSIM ${n.map_only.ssim_mean}, PSNR ${n.map_only.psnr_mean}.`);
      }
    }
    if (tool === "fonts" && Array.isArray(n.ranking) && n.ranking.length > 0) {
      parts.push(`Top match: ${n.ranking[0].family} ${n.ranking[0].weight} (score ${n.ranking[0].score}).`);
    }
    if (tool === "control" && isRecord(n.arms) && isRecord(n.arms.clean)
      && isRecord(n.arms.clean.means_4_pairs)) {
      parts.push(`Clean ceiling SSIM ${n.arms.clean.means_4_pairs.ssim}.`);
    }
    if (tool === "extract" && typeof n.opaque_pixels === "number") {
      parts.push(`${n.opaque_pixels} opaque pixels. Output: ${n.output}.`);
    }
    if (tool === "diagnose" && Array.isArray(report.corrections)) {
      parts.push(`${report.corrections.length} correction${report.corrections.length === 1 ? "" : "s"}.`);
    }
    if (tool === "player-pass" && isRecord(n.shots)) {
      parts.push(`${Object.keys(n.shots).length} shots.`);
    }
    if (tool === "frame-style" && typeof n.frames === "number") {
      parts.push(`Measured ${n.frames} frames, changed fraction ${n.changed_fraction}, mean change ${n.mean_change_per_second} levels per second. Prompt: ${n.prompt_path}.`);
    }
    return parts.join(" ");
  }
  if (tool === "trace") {
    const cuts = Array.isArray(report.cuts_s) ? report.cuts_s : [];
    const palette = Array.isArray(report.palette)
      ? report.palette.map((p) => (typeof p === "string" ? p : p.hex)).filter(Boolean)
      : [];
    const frames = typeof report.frames === "number" ? report.frames : null;
    return [
      `Trace finished${frames === null ? "" : ` over ${frames} frames`}.`,
      cuts.length ? `Cuts at ${cuts.join(", ")} s.` : "No cuts found.",
      palette.length ? `Palette: ${palette.join(" ")}.` : "",
    ].filter(Boolean).join(" ");
  }
  return `${tool} finished.`;
}

// Run one CLI command as a child process and return its JSON report.
// kind is "file" (the report is written to reportPath with --out),
// "stdout" (the report is the child's stdout JSON), or "trace"
// (the profile file is written under outDir).
// Returns { report, extra }. Throws an Error with a plain message
// on exit code 2 or on an unreadable report. Exit 1 (FAIL verdict)
// is not an error: the report is returned.
function runCli(command, argv, { kind, reportPath, outDir, profilePath }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [HME_PATH, command, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", (err) => rejectPromise(new Error(`could not start hme ${command}: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 2) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        rejectPromise(new Error(`hme ${command} failed: ${tail || "usage or run error"}`));
        return;
      }
      if (code !== 0 && code !== 1) {
        rejectPromise(new Error(`hme ${command} exited with code ${code}: ${stderr.trim().slice(-500)}`));
        return;
      }
      try {
        if (kind === "file") {
          const report = JSON.parse(readFileSync(reportPath, "utf8"));
          resolvePromise({ report, extra: {} });
        } else if (kind === "stdout") {
          const report = JSON.parse(stdout);
          resolvePromise({ report, extra: {} });
        } else {
          const profile = profilePath ?? join(outDir, "reference-profile.json");
          const report = JSON.parse(readFileSync(profile, "utf8"));
          resolvePromise({ report, extra: { profile_path: profile } });
        }
      } catch (err) {
        rejectPromise(new Error(`hme ${command} returned an unreadable report: ${err.message}`));
      }
    });
  });
}

// Turn validated tool arguments into a CLI call. Returns the tool
// result payload: { summary, report, ...extra }. Throws an Error
// with a plain message when the CLI fails.
export async function callTool(name, args) {
  const err = validateToolArgs(name, args);
  if (err) throw new Error(err);
  const workdir = mkdtempSync(join(tmpdir(), "hme-mcp-"));
  // When the caller gives no --out, the tool's file output (trace
  // profile, extract PNG, player-pass shots) lives in the temp dir,
  // and the payload names that path. Keep the dir in that case so
  // the named files still exist when the caller reads them.
  let keepWorkdir = false;
  try {
    let out;
    switch (name) {
      case "compare": {
        const reportPath = args.out ? resolve(args.out) : join(workdir, "report.json");
        const argv = [args.ref, args.ours];
        if (args.full) argv.push("--full");
        if (args.scene) argv.push("--scene", args.scene);
        argv.push("--out", reportPath);
        out = await runCli("compare", argv, { kind: "file", reportPath });
        break;
      }
      case "trace": {
        const outArg = args.out ? resolve(args.out) : workdir;
        const profilePath = outArg.endsWith(".json")
          ? outArg
          : join(outArg, "reference-profile.json");
        if (!args.out) keepWorkdir = true;
        const argv = [args.video, "--start-s", String(args.start_s), "--end-s", String(args.end_s), "--out", outArg];
        if (args.skip_traces) argv.push("--skip-traces");
        if (args.subject_colour) argv.push("--subject-colour", args.subject_colour);
        if (args.badge_colour) argv.push("--badge-colour", args.badge_colour);
        if (args.labels) argv.push("--labels", args.labels.join(","));
        out = await runCli("trace", argv, { kind: "trace", outDir: outArg, profilePath });
        break;
      }
      case "diagnose": {
        const reportPath = args.out ? resolve(args.out) : join(workdir, "report.json");
        const argv = [args.ref_frame, args.ours_frame, "--scene", args.scene];
        if (args.at_s !== undefined) argv.push("--at-s", String(args.at_s));
        argv.push("--out", reportPath);
        out = await runCli("diagnose", argv, { kind: "file", reportPath });
        break;
      }
      case "control": {
        const reportPath = args.out ? resolve(args.out) : join(workdir, "report.json");
        const argv = [args.video];
        if (args.crf !== undefined) argv.push("--crf", String(args.crf));
        argv.push("--out", reportPath);
        out = await runCli("control", argv, { kind: "file", reportPath });
        break;
      }
      case "extract": {
        const pngPath = args.out ? resolve(args.out) : join(workdir, "extract.png");
        if (!args.out) keepWorkdir = true;
        const argv = [args.frame, "--colour", args.colour, "--out", pngPath];
        if (args.luma_max !== undefined) argv.push("--luma-max", String(args.luma_max));
        if (args.dist_min !== undefined) argv.push("--dist-min", String(args.dist_min));
        if (args.exclude) argv.push("--exclude", args.exclude);
        out = await runCli("extract", argv, { kind: "stdout" });
        break;
      }
      case "fonts": {
        const reportPath = args.out ? resolve(args.out) : join(workdir, "report.json");
        const argv = [args.frame, "--text", args.text];
        if (args.box) argv.push("--box", args.box);
        argv.push("--out", reportPath);
        out = await runCli("fonts", argv, { kind: "file", reportPath });
        break;
      }
      case "player-pass": {
        const outDir = args.out ? resolve(args.out) : workdir;
        if (!args.out) keepWorkdir = true;
        const argv = [args.video, "--seconds", args.seconds.join(",")];
        if (args.viewport) argv.push("--viewport", args.viewport);
        if (args.crop) argv.push("--crop", args.crop);
        if (args.resize) argv.push("--resize", args.resize);
        if (args.label) argv.push("--label", args.label);
        argv.push("--out", outDir);
        out = await runCli("player-pass", argv, { kind: "stdout" });
        out.extra.output_dir = outDir;
        break;
      }
      case "context": {
        const reportPath = args.out ? resolve(args.out) : join(workdir, "report.json");
        const argv = [];
        if (args.scene) argv.push("--scene", args.scene);
        argv.push("--out", reportPath);
        out = await runCli("context", argv, { kind: "file", reportPath });
        break;
      }
      case "frame-style": {
        const promptPath = resolve(args.out);
        const reportPath = args.report ? resolve(args.report) : join(workdir, "report.json");
        const argv = [args.video, "--start-s", String(args.start_s), "--end-s", String(args.end_s), "--out", promptPath, "--report", reportPath];
        if (args.csv) argv.push("--csv", resolve(args.csv));
        if (args.fps !== undefined) argv.push("--fps", String(args.fps));
        out = await runCli("frame-style", argv, { kind: "file", reportPath });
        out.extra.prompt_path = promptPath;
        break;
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return { summary: buildSummary(name, out.report), report: out.report, ...out.extra };
  } finally {
    if (!keepWorkdir) rmSync(workdir, { recursive: true, force: true });
  }
}

// --- JSON-RPC over stdio ---

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Handle one parsed JSON-RPC message. Returns the response object,
// or null for a notification (no reply). Never throws: a handler
// failure becomes a -32603 error, so the server stays up for the
// next request.
export async function handleMessage(msg) {
  if (!isRecord(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(isRecord(msg) ? msg.id ?? null : null, -32600, "Invalid Request: expected a JSON-RPC 2.0 object with a method");
  }
  const id = "id" in msg ? msg.id : null;
  const isNotification = !("id" in msg);
  try {
    switch (msg.method) {
      case "initialize": {
        const clientVersion = isRecord(msg.params) && typeof msg.params.protocolVersion === "string"
          ? msg.params.protocolVersion
          : MCP_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion: clientVersion,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: SERVER_NAME, version: VERSION },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: listTools() });
      case "tools/call": {
        const params = isRecord(msg.params) ? msg.params : {};
        const result = await callTool(params.name, params.arguments ?? {});
        const payload = { summary: result.summary, report: result.report };
        for (const [k, v] of Object.entries(result)) {
          if (k !== "summary" && k !== "report") payload[k] = v;
        }
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        });
      }
      case "resources/list":
        return rpcResult(id, { resources: RESOURCES });
      case "resources/read": {
        const params = isRecord(msg.params) ? msg.params : {};
        const content = readResource(params.uri);
        return rpcResult(id, { contents: [content] });
      }
      default:
        if (msg.method.startsWith("notifications/")) return null;
        return rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    const message = err instanceof Error ? err.message : String(err);
    // A bad tool call (missing file, bad argument) is an invalid
    // params error; anything else is an internal error.
    const code = /missing required argument|must be a |unknown tool|unknown resource|hme \w+ failed/.test(message) ? -32602 : -32603;
    return rpcError(id, code, message);
  }
}

// Serve MCP over stdio until stdin ends. Returns the process exit
// code: 0 on a clean EOF. Only JSON-RPC lines go to stdout.
export async function runMcp() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          process.stdout.write(JSON.stringify(rpcError(null, -32700, "Parse error: line is not JSON")) + "\n");
          newline = buffer.indexOf("\n");
          continue;
        }
        const response = await handleMessage(msg);
        if (response !== null) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      }
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim().length > 0) {
    try {
      const response = await handleMessage(JSON.parse(buffer));
      if (response !== null) process.stdout.write(JSON.stringify(response) + "\n");
    } catch {
      process.stdout.write(JSON.stringify(rpcError(null, -32700, "Parse error: line is not JSON")) + "\n");
    }
  }
  return 0;
}
