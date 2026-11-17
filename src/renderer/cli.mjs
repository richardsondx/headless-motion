// CLI: node src/renderer/cli.mjs render <scene.json> --profile previs|draft|final
//   --out out/<name> [--frames a:b] [--order f,f,f] [--keep-frames] [--verify-determinism] [--watch]
// Exit codes: 0 ok, 2 scene/font/asset, 3 browser, 4 seek/capture/module,
// 5 encode/probe, 6 nondeterminism.
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { renderWithReport, renderRealtime } from "./render.mjs";
import { writeWatchState } from "./watch-state.mjs";
import { writeFileRetry, mkdirRetry } from "./retry.mjs";
import profiles from "../scene/profiles.json" with { type: "json" };

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function parseArgs(argv) {
  const out = { frames: null, order: null, keepFrames: false, verifyDeterminism: false, realtime: false, watch: false, sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--realtime") out.realtime = true;
    else if (a === "--set") out.sets.push(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--frames") {
      const [s, e] = argv[++i].split(":").map(Number);
      out.frames = [s, e];
    } else if (a === "--order") out.order = argv[++i].split(",").map(Number);
    else if (a === "--keep-frames") out.keepFrames = true;
    else if (a === "--verify-determinism") out.verifyDeterminism = true;
    else if (a === "--watch") out.watch = true;
    else if (!out.scene) out.scene = a;
  }
  return out;
}

// Compact authoring: one label or number change is one --set flag or one
// line in a compact scene file, then a draft-only re-render.
//   --set nodes.title.props.text="New title" --set nodes.views.props.to=20000
//   compact file: {"base": "tests/fixtures/text-sample.json",
//                  "set": {"nodes.title.props.text": "New title"}}
// Paths: nodes.<id>.<dot.path> into that node, palette.<key>, meta.<key>.
// Values from --set are JSON-parsed when possible, else plain strings.
export function parseSetValue(raw) {
  try { return JSON.parse(raw); } catch { return raw; }
}

export function applySet(scene, path, value) {
  const parts = path.split(".");
  if (parts[0] === "nodes" && parts.length >= 3) {
    const node = (scene.nodes || []).find((n) => n.id === parts[1]);
    if (!node) throw new Error(`--set: no node ${parts[1]}`);
    let cur = node;
    for (const k of parts.slice(2, -1)) {
      if (cur[k] === undefined || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
    return;
  }
  if ((parts[0] === "palette" || parts[0] === "meta") && parts.length === 2) {
    scene[parts[0]][parts[1]] = value;
    return;
  }
  throw new Error(`--set: unsupported path ${path} (use nodes.<id>.<path>, palette.<key>, meta.<key>)`);
}

// Patched scenes live in .tmp/, so relative asset paths (fonts, images)
// would resolve against .tmp/ instead of the original scene's directory
// and fail with FONT_MISSING. Rewrite them to absolute paths resolved
// against the original scene dir before writing the patched file.
// Absolute and http(s) srcs are untouched (http stays http so the
// NETWORK_BLOCKED failure still fires instead of being silently rewritten).
function absolutizeAssets(scene, origDir) {
  const isRelative = (s) => s && !/^(https?:|file:|\/)/.test(s);
  for (const font of scene.fonts || []) {
    if (isRelative(font.src)) font.src = resolve(origDir, font.src);
  }
  for (const node of scene.nodes || []) {
    if (node.type === "image" && isRelative(node.props?.src)) node.props.src = resolve(origDir, node.props.src);
  }
}

function writePatched(scene, origDir) {
  absolutizeAssets(scene, origDir);
  const patched = resolve(process.cwd(), ".tmp", `patched-${createHash("sha256").update(JSON.stringify(scene)).digest("hex").slice(0, 16)}.json`);
  mkdirRetry(dirname(patched), { recursive: true });
  writeFileRetry(patched, JSON.stringify(scene, null, 2) + "\n");
  return patched;
}

export function resolveCompact(scenePath) {
  const raw = JSON.parse(readFileSync(resolve(scenePath), "utf8"));
  if (!raw.base) return { scenePath, sets: [] };
  const basePath = resolve(dirname(scenePath), raw.base);
  const scene = JSON.parse(readFileSync(basePath, "utf8"));
  const sets = Object.entries(raw.set || {});
  for (const [path, value] of sets) applySet(scene, path, value);
  const patched = writePatched(scene, dirname(basePath));
  return { scenePath: patched, sets: sets.map(([path, value]) => `${path}=${JSON.stringify(value)}`) };
}

// Wall time lives in render-report.md only, never in render-report.json:
// the JSON must stay byte-identical across runs for the same inputs, and a
// wall clock would break that. The .md is evidence, not part of the hash.
function writeReportMd(outDir, { profile, scenePath, wallS, overrides, status, videoSha, videoFile = "video.mp4", mode = "deterministic" }) {
  try {
    mkdirRetry(resolve(outDir), { recursive: true });
  const lines = [
    "# render report (wall time, not hashed)",
    "",
    `- profile: ${profile}`,
    `- scene: ${scenePath}`,
    `- status: ${status}`,
    `- mode: ${mode}`,
    `- video: ${videoFile}`,
    `- wall_s: ${wallS}`,
    `- video_sha256: ${videoSha || "-"}`,
    `- overrides: ${overrides.length ? overrides.join("; ") : "-"}`,
    "",
    "Wall time is measured here, in the CLI harness, with Date.now. It is",
    "kept out of render-report.json, whose elapsed_s stays 0 by design, so",
    "two runs on the same inputs still give byte-identical JSON.",
  ];
    writeFileRetry(resolve(outDir, "render-report.md"), lines.join("\n") + "\n");
  } catch (e) {
    // The wall-time note is evidence, not the render. If it cannot be
    // written (transient EPERM seen 2026-11-07), report on stderr and
    // keep the render's own exit code instead of crashing.
    console.error(`REPORT_MD_WRITE_FAILED profile=${profile} wall_s=${wallS} (${e.message})`);
  }
}

async function main(argv) {
  if (argv[0] !== "render" || !argv[1]) {
    console.error("usage: node src/renderer/cli.mjs render <scene.json> --profile previs|draft|final|final-max|preview-rt [--realtime] --out out/<name> [--frames a:b] [--order f,f,f] [--keep-frames] [--verify-determinism] [--watch]");
    console.error("  --realtime is shorthand for --profile preview-rt: a NON-DETERMINISTIC real-time preview (preview-rt.mp4), never for final or verification.");
    return 2;
  }
  const opts = parseArgs(argv.slice(1));
  if (opts.realtime) opts.profile = "preview-rt";
  if (!opts.profile || !opts.out) {
    console.error("missing --profile or --out");
    return 2;
  }
  const isRealtime = Boolean(profiles[opts.profile]?.realtime);
  if (isRealtime && opts.verifyDeterminism) {
    console.error("preview-rt is non-deterministic; --verify-determinism does not apply");
    return 2;
  }
  const crfOverride = process.env.HME_CRF !== undefined ? Number(process.env.HME_CRF) : null;
  // Compact scene file ({"base": ..., "set": {...}}) and --set flags both
  // resolve to a patched scene file under .tmp/; the patched file is what
  // gets rendered, so its sha in render-report.json covers the overrides.
  let scenePath = opts.scene;
  let overrides = [];
  try {
    const c = resolveCompact(scenePath);
    scenePath = c.scenePath;
    overrides = [...c.sets];
    if (opts.sets.length) {
      const scene = JSON.parse(readFileSync(resolve(scenePath), "utf8"));
      for (const s of opts.sets) {
        const eq = s.indexOf("=");
        if (eq < 0) throw new Error(`--set needs path=value, got ${s}`);
        applySet(scene, s.slice(0, eq), parseSetValue(s.slice(eq + 1)));
      }
      const patched = writePatched(scene, dirname(resolve(scenePath)));
      scenePath = patched;
      overrides = [...overrides, ...opts.sets];
    }
  } catch (e) {
    console.error(`scene resolve failed: ${e.message}`);
    return 2;
  }
  const timed = async (fn) => {
    const t0 = Date.now();
    const r = await fn();
    return { r, wallS: Math.round((Date.now() - t0) / 100) / 10 };
  };
  if (opts.verifyDeterminism) {
    const { r: a, wallS: wa } = await timed(() => renderWithReport({ scenePath, profileName: opts.profile, outDir: resolve(opts.out, "run-a"), frames: opts.frames, order: opts.order, keepFrames: opts.keepFrames, crfOverride, overrides }));
    writeReportMd(resolve(opts.out, "run-a"), { profile: opts.profile, scenePath, wallS: wa, overrides, status: a.exit === 0 ? "ok" : "failed", videoSha: a.exit === 0 ? sha256File(resolve(opts.out, "run-a", "video.mp4")) : null });
    if (a.exit !== 0) {
      console.error(`determinism run-a failed: ${a.report?.code} ${a.report?.message}`);
      return a.exit;
    }
    const { r: b, wallS: wb } = await timed(() => renderWithReport({ scenePath, profileName: opts.profile, outDir: resolve(opts.out, "run-b"), frames: opts.frames, order: opts.order, keepFrames: opts.keepFrames, crfOverride, overrides }));
    writeReportMd(resolve(opts.out, "run-b"), { profile: opts.profile, scenePath, wallS: wb, overrides, status: b.exit === 0 ? "ok" : "failed", videoSha: b.exit === 0 ? sha256File(resolve(opts.out, "run-b", "video.mp4")) : null });
    if (b.exit !== 0) {
      console.error(`determinism run-b failed: ${b.report?.code} ${b.report?.message}`);
      return b.exit;
    }
    const ha = JSON.parse(readFileSync(resolve(opts.out, "run-a", "frame-hashes.json"), "utf8"));
    const hb = JSON.parse(readFileSync(resolve(opts.out, "run-b", "frame-hashes.json"), "utf8"));
    const firstDiff = Object.keys(ha).find((f) => ha[f] !== hb[f]);
    const va = sha256File(resolve(opts.out, "run-a", "video.mp4"));
    const vb = sha256File(resolve(opts.out, "run-b", "video.mp4"));
    if (firstDiff !== undefined || va !== vb) {
      console.error(`NONDETERMINISTIC first differing frame: ${firstDiff ?? "video bytes"}`);
      return 6;
    }
    console.log(`OK deterministic ${opts.profile} ${Object.keys(ha).length} frames video ${va.slice(0, 16)}`);
    return 0;
  }
  const videoFile = isRealtime ? "preview-rt.mp4" : "video.mp4";
  const renderFn = isRealtime ? renderRealtime : undefined;
  const { r, wallS } = await timed(() => renderWithReport({ scenePath, profileName: opts.profile, outDir: resolve(opts.out), frames: opts.frames, order: opts.order, keepFrames: opts.keepFrames, crfOverride, overrides, watch: opts.watch }, renderFn));
  // Watch preview: publish the final state so the page swaps from
  // the latest frame to the finished video (or names the failure).
  // The determinism path above ignores --watch: two runs share one
  // preview, so the hme door rejects that combination instead.
  if (opts.watch && !opts.verifyDeterminism) {
    const captured = r.result?.report?.frames_captured ?? r.report?.frames_captured ?? 0;
    writeWatchState(resolve(opts.out), {
      status: r.exit === 0 ? "done" : "failed",
      frame: captured, frames_total: null, frames_captured: captured,
    });
  }
  writeReportMd(resolve(opts.out), { profile: opts.profile, scenePath, wallS, overrides, status: r.exit === 0 ? "ok" : "failed", videoSha: r.exit === 0 ? sha256File(resolve(opts.out, videoFile)) : null, videoFile, mode: isRealtime ? "realtime-preview (NON-DETERMINISTIC)" : "deterministic" });
  if (r.exit !== 0) {
    rmSync(resolve(opts.out, videoFile), { force: true });
    console.error(`${r.report?.code || "FAILED"} ${r.report?.stage || ""} frame=${r.report?.frame ?? ""} ${r.report?.message || ""}`);
    return r.exit;
  }
  console.log(`OK ${opts.profile} ${r.result.report.frames_captured} frames ${resolve(opts.out, videoFile)}${isRealtime ? " NON-DETERMINISTIC preview" : ""}`);
  return 0;
}

// Process-level write-gate retry (2026-11-07). The gate assignment is
// sticky per process: a process that starts blocked stays blocked for
// its whole life, and in-process write retries never recover it (a render
// retried page.html for 10 minutes and never wrote a byte, while fresh
// processes wrote fine in the same minutes). So the parent runs the
// render in a fresh child process, and if the child fails with a gate
// marker in stderr, the parent starts another fresh child, up to 10
// attempts, 10 s apart. A non-gate failure returns at once, and a child
// that is killed (signal, timeout) is not retried as a gate failure.
// Disable with HME_GATE_RETRY=0. The child sets HME_GATE_CHILD=1 so it
// runs the render directly instead of spawning again.
const GATE_MARKERS = ["EPERM", "Operation not permitted", "REPORT_WRITE_FAILED", "REPORT_MD_WRITE_FAILED"];
const GATE_MAX_ATTEMPTS = 10;
const GATE_SLEEP_MS = 10000;

async function runWithGateRetry(argv) {
  if (process.env.HME_GATE_RETRY === "0" || process.env.HME_GATE_CHILD === "1") {
    return main(argv);
  }
  let lastCode = 5;
  for (let attempt = 1; attempt <= GATE_MAX_ATTEMPTS; attempt++) {
    const child = spawnSync(process.execPath, [process.argv[1], ...argv], {
      env: { ...process.env, HME_GATE_CHILD: "1" },
      encoding: "utf8",
      stdio: ["inherit", "inherit", "pipe"],
    });
    if (child.stderr) process.stderr.write(child.stderr);
    lastCode = child.status ?? 5;
    if (lastCode === 0) return 0;
    if (!GATE_MARKERS.some((m) => (child.stderr || "").includes(m))) return lastCode;
    if (attempt < GATE_MAX_ATTEMPTS) {
      console.error(`write gate blocked this process (attempt ${attempt}/${GATE_MAX_ATTEMPTS}), starting a fresh process in 10 s`);
      await new Promise((r) => setTimeout(r, GATE_SLEEP_MS));
    }
  }
  console.error(`write gate: ${GATE_MAX_ATTEMPTS} fresh processes all blocked, giving up`);
  return lastCode;
}

const code = await runWithGateRetry(process.argv.slice(2));
// Explicit exit. After main() returns the render is done and every file
// write is synchronous, but Node lingers ~25 s: the Chromium child is
// already dead, yet its stdio pipe stays open because Chromium's
// crashpad/renderer children inherited it, so the event loop never
// drains. Flush stdout first (process.exit can cut a pending console.log
// when output is piped), then exit with main()'s code.
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(code);
