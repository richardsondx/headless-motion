// Headless render: validate -> compile -> launch Chrome -> seek loop ->
// capture PNGs -> FFmpeg encode -> ffprobe. All FFmpeg arguments are
// arrays, never a shell string. No automatic retry.
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";
import { rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { chromium } from "playwright-core";
import { writeFileRetryAsync, mkdirRetryAsync, sleep, takeRetryCount } from "./retry.mjs";
import { validateScene, loadScene, sceneFps } from "../scene/validate.mjs";
import { compileScene } from "./compile.mjs";
import { writeReport, baseReport } from "./report.mjs";
import profiles from "../scene/profiles.json" with { type: "json" };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const CHROME_ARGS = ["--disable-gpu", "--font-render-hinting=none", "--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars", "--no-sandbox", "--force-device-scale-factor=1"];
const EXIT = { ok: 0, scene: 2, browser: 3, seek: 4, encode: 5, nondet: 6 };

/** Newest cached full Chromium, or undefined when the cache is empty. */
export function findChrome() {
  const base = resolve(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse();
  for (const d of dirs) {
    const cand = resolve(base, d, "chrome-linux64", "chrome");
    if (existsSync(cand)) return cand;
  }
  return undefined;
}

export function versions() {
  return {
    node: process.version,
    chrome: null,
    ffmpeg: null,
    gsap: "3.15.0",
    hyperframes: "0.9.20",
  };
}

function ffprobe(file) {
  return new Promise((res, rej) => {
    execFile("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file], (err, stdout) => {
      if (err) return rej(err);
      try {
        res(JSON.parse(stdout));
      } catch (e) {
        rej(e);
      }
    });
  });
}

function ffmpegVersion() {
  return new Promise((res) => {
    execFile("ffmpeg", ["-version"], (err, stdout) => res(err ? null : stdout.split("\n")[0]));
  });
}

function encodePngs(pngs, outFile, { width, height, fps, crf, preset, threads = "0" }) {
  return new Promise((resolveP, rejectP) => {
    const args = [
      "-y", "-f", "image2pipe", "-c:v", "png", "-r", String(fps), "-i", "pipe:0",
      "-vf", `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
      "-c:v", "libx264", "-profile:v", "high", "-preset", preset, "-crf", String(crf),
      "-r", String(fps), "-g", "48", "-threads", String(threads),
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1", "-an",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-movflags", "+faststart", outFile,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (e) => rejectP({ code: "ENCODE_FAIL", stderr, error: e }));
    proc.on("close", (code) => {
      if (code === 0) resolveP({ args, stderr });
      else rejectP({ code: "ENCODE_FAIL", stderr, exitCode: code });
    });
    for (const png of pngs) proc.stdin.write(png);
    proc.stdin.end();
  });
}

/** ffmpeg writes video.mp4 itself, so a write-gate hit mid-encode kills
 * the encode with a plain failure. Retry the whole encode up to 3 times,
 * but only when the failure names the gate (EPERM / Operation not
 * permitted in stderr or in the error); a genuinely bad input must still
 * fail fast instead of re-encoding three times. */
async function encodeWithRetry(pngs, outFile, opts) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await encodePngs(pngs, outFile, opts);
    } catch (e) {
      last = e;
      const text = String(e.stderr || "") + String(e.error?.message || "");
      if (!/Operation not permitted|EPERM/.test(text) || attempt === 2) throw e;
      await sleep(2000);
    }
  }
  throw last;
}

/**
 * Render one scene. Throws an object {stage, code, exit, frame, message}.
 * On success returns {outDir, video, frameHashes, report}.
 */
export async function renderScene({ scenePath, profileName, outDir, frames = null, order = null, keepFrames = false, crfOverride = null, overrides = [] }) {
  // No wall-clock time anywhere in this file: prompt 01 bans Date in src/,
  // and render-report.json must be byte-identical across runs. elapsed_s
  // stays 0 (the baseReport default); wall time, if anyone needs it, goes
  // in report.md, never in the hashed JSON.
  const vers = versions();
  vers.ffmpeg = await ffmpegVersion();
  const scene = loadScene(scenePath);
  const sceneSha = sha256(readFileSync(scenePath));
  const profile = profiles[profileName];
  if (!profile) throw { stage: "validate", code: "SCENE_INVALID", exit: EXIT.scene, frame: null, message: `unknown profile ${profileName}` };
  const report = baseReport({ profile: profileName, sceneSha256: sceneSha, versions: vers });
  // Capture workers: parallel pages in one browser, each seeking its own
  // frames. Frame order in the output is always frameList order, so the
  // video bytes do not depend on which worker captured which frame.
  // HME_WORKERS=1 restores the old serial capture. HME_FFMPEG_THREADS
  // defaults to "0" (ffmpeg picks core count); the old pin was "1".
  const captureWorkers = Math.max(1, Math.min(4, parseInt(process.env.HME_WORKERS || "2", 10) || 2));
  const ffmpegThreads = process.env.HME_FFMPEG_THREADS || "0";
  report.capture_workers = captureWorkers;
  report.ffmpeg_threads = ffmpegThreads;
  report.overrides = overrides;
  const fail = (stage, code, exit, message, frame = null) => {
    throw { stage, code, exit, frame, message, report };
  };

  const { errors } = validateScene(scene);
  if (errors.length) fail("validate", "SCENE_INVALID", EXIT.scene, errors.map((e) => `${e.code} ${e.path}`).join("; "));
  const fps = sceneFps(scene);
  const duration = scene.meta.duration;
  const frameList = order ? [...order] : frames ? Array.from({ length: frames[1] - frames[0] }, (_, i) => frames[0] + i) : Array.from({ length: duration }, (_, i) => i);
  for (const f of frameList) if (f < 0 || f >= duration) fail("validate", "SCENE_INVALID", EXIT.scene, `frame ${f} outside [0, ${duration})`, f);

  const sceneDir = dirname(resolve(scenePath));
  const { html, errors: cErr } = compileScene(scene, sceneDir);
  if (cErr.length) {
    const e = cErr[0];
    fail("compile", e.code, EXIT.scene, e.message);
  }
  await mkdirRetryAsync(resolve(outDir), { recursive: true });
  await writeFileRetryAsync(resolve(outDir, "page.html"), html);
  report.stage = "launch";

  // Playwright-core's default build (chromium_headless_shell-1200) is not
  // in this VM's cache; the cache holds chromium-1243/1248. Use the newest
  // cached full Chromium unless CHROME_PATH names one explicitly.
  const chromePath = process.env.CHROME_PATH || findChrome();
  // Chromium's own profile and cache writes hit the same EPERM gate as
  // ours, so a launch that fails for that reason gets two more tries,
  // 2 s apart, before it counts as a real launch failure.
  let browser;
  let launchErr = null;
  for (let attempt = 0; attempt < 3 && !browser; attempt++) {
    try {
      browser = await chromium.launch({ executablePath: chromePath, args: CHROME_ARGS });
    } catch (e) {
      launchErr = e;
      if (attempt < 2) await sleep(2000);
    }
  }
  if (!browser) {
    fail("launch", "BROWSER_LAUNCH", EXIT.browser, String(launchErr.message || launchErr));
  }
  // One page per capture worker. Each page holds its own __hme state, so
  // workers seek independently and never share a timeline position.
  // blocked/consoleErrors are SHARED live arrays: the route and console
  // handlers push into them, and the report reads them through getters so
  // the values written at the end include requests from every page (a
  // flatMap snapshot taken here would stay empty forever).
  const blocked = [];
  const consoleErrors = [];
  const makePage = async () => {
    const pg = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: profile.supersample });
    pg.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    pg.on("pageerror", (e) => consoleErrors.push(String(e.message || e)));
    await pg.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("file:") || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      blocked.push(url);
      return route.abort();
    });
    return { pg };
  };
  const pages = [];
  for (let i = 0; i < captureWorkers; i++) pages.push(await makePage());
  const page = pages[0].pg; // first page, for failure artefacts below
  Object.defineProperty(report, "blocked_requests", { enumerable: true, get: () => [...new Set(blocked)] });
  Object.defineProperty(report, "console_errors", { enumerable: true, get: () => consoleErrors });

  const hashes = {};
  const pngs = [];
  let lastGood = null;
  try {
    for (const w of pages) {
      await w.pg.setContent(html, { waitUntil: "load", timeout: 30000 });
    }
    vers.chrome = browser.version();
    report.versions = vers;
    for (const w of pages) {
      await Promise.race([
        w.pg.evaluate(() => window.__hme.ready),
        new Promise((_, reject) => setTimeout(() => reject(new Error("READY_TIMEOUT")), 30000)),
      ]).catch((e) => {
        const msg = String(e.message || e);
        if (msg.includes("FONT_MISSING")) fail("ready", "FONT_MISSING", EXIT.scene, msg);
        throw e;
      });
    }
    if (blocked.length) fail("seek", "NETWORK_BLOCKED", EXIT.seek, `blocked ${blocked.length} non-local request(s): ${blocked[0]}`);
    report.stage = "seek";
    // Parallel capture: worker i takes frames i, i+workers, i+2*workers...
    // in frame order. Results are placed back into frameList order, so the
    // PNG sequence, frame hashes, and video bytes are identical to serial
    // capture for the same scene and profile.
    const captureOne = async (pg, f) => {
      const png = await Promise.race([
        (async () => {
          await pg.evaluate((frame) => window.__hme.seek(frame), f);
          return pg.screenshot({ type: "png", animations: "disabled", clip: { x: 0, y: 0, width: 1920, height: 1080 } });
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("CAPTURE_TIMEOUT")), 30000)),
      ]).catch((e) => {
        const msg = String(e.message || e);
        if (msg.includes("MODULE_WAIT_TIMEOUT")) fail("seek", "MODULE_WAIT_TIMEOUT", EXIT.seek, msg, f);
        if (msg.includes("SEEK_MISMATCH")) fail("seek", "SEEK_MISMATCH", EXIT.seek, msg, f);
        if (msg.includes("CAPTURE_TIMEOUT")) fail("capture", "CAPTURE_TIMEOUT", EXIT.seek, msg, f);
        throw e;
      });
      return png;
    };
    const slots = new Array(frameList.length);
    await Promise.all(pages.map(async (w, wi) => {
      for (let idx = wi; idx < frameList.length; idx += pages.length) {
        const f = frameList[idx];
        const png = await captureOne(w.pg, f);
        slots[idx] = png;
        if (keepFrames) {
          await mkdirRetryAsync(resolve(outDir, "frames"), { recursive: true });
          await writeFileRetryAsync(resolve(outDir, "frames", `${String(f).padStart(6, "0")}.png`), png);
        }
      }
    }));
    for (let idx = 0; idx < frameList.length; idx++) {
      const f = frameList[idx];
      const png = slots[idx];
      hashes[f] = sha256(png);
      pngs.push(png);
      lastGood = png;
    }
    report.frames_captured = frameList.length;
  } catch (e) {
    try {
      await mkdirRetryAsync(resolve(outDir, "failure"), { recursive: true });
      if (lastGood) await writeFileRetryAsync(resolve(outDir, "failure", "last-good-frame.png"), lastGood);
      await writeFileRetryAsync(resolve(outDir, "failure", "dom.html"), await page.content().catch(() => ""));
      await writeFileRetryAsync(resolve(outDir, "failure", "console.log"), consoleErrors.join("\n"));
    } catch (_) { /* artefacts are best-effort; the report still names the failure */ }
    if (e && e.stage) throw e;
    const msg = String(e.message || e);
    if (msg.includes("FONT_MISSING")) fail("ready", "FONT_MISSING", EXIT.scene, msg);
    if (msg.includes("MODULE_WAIT_TIMEOUT") || msg.includes("SEEK_MISMATCH")) fail("seek", msg.includes("MODULE") ? "MODULE_WAIT_TIMEOUT" : "SEEK_MISMATCH", EXIT.seek, msg);
    fail("launch", "PAGE_ERROR", EXIT.browser, msg);
  } finally {
    await browser.close().catch(() => {});
  }

  await writeFileRetryAsync(resolve(outDir, "frame-hashes.json"), JSON.stringify(hashes, null, 2) + "\n");
  const video = resolve(outDir, "video.mp4");
  const crf = crfOverride !== null ? crfOverride : profile.crf;
  report.stage = "encode";
  let enc;
  try {
    enc = await encodeWithRetry(pngs, video, { width: profile.output.width, height: profile.output.height, fps, crf, preset: profile.preset, threads: ffmpegThreads });
  } catch (e) {
    report.ffmpeg_stderr_tail = String(e.stderr || "").split("\n").slice(-40);
    report.ffmpeg_command = ["ffmpeg", "-f", "image2pipe", "-crf", String(crf)];
    rmSync(video, { force: true });
    fail("encode", "ENCODE_FAIL", EXIT.encode, String(e.error?.message || e.stderr || "ffmpeg failed"));
  }
  report.ffmpeg_command = enc.args;
  report.ffmpeg_stderr_tail = String(enc.stderr || "").split("\n").slice(-40);
  report.stage = "probe";
  let probe;
  try {
    probe = await ffprobe(video);
  } catch (e) {
    fail("probe", "PROBE_MISMATCH", EXIT.encode, `ffprobe failed: ${e.message}`);
  }
  const stream = (probe.streams || []).find((s) => s.codec_type === "video") || {};
  const expectRate = `${fps}/1`;
  if (stream.width !== profile.output.width || stream.height !== profile.output.height || stream.r_frame_rate !== expectRate || Number(stream.nb_frames) !== frameList.length || stream.pix_fmt !== "yuv420p" || stream.color_space !== "bt709") {
    fail("probe", "PROBE_MISMATCH", EXIT.encode, `probe: ${stream.width}x${stream.height} ${stream.r_frame_rate} frames=${stream.nb_frames} fmt=${stream.pix_fmt} cs=${stream.color_space}`);
  }
  report.status = "ok";
  report.stage = "probe";
  report.eperm_retries = takeRetryCount();
  // A report write can fail (seen 2026-11-07: transient EPERM left a
  // 0-byte file). That is a clean failure, not an uncaught exception:
  // the video exists, but without a report the run cannot be trusted.
  try {
    writeReport(outDir, report);
  } catch (e) {
    fail("probe", "REPORT_WRITE", EXIT.encode, `render-report.json write failed: ${e.message}`);
  }
  return { outDir, video, frameHashes: hashes, report };
}

/** Write failure artefacts and report, then return the exit code. */
export async function renderWithReport(opts) {
  try {
    const r = await renderScene({ ...opts, overrides: opts.overrides || [] });
    return { exit: 0, result: r };
  } catch (e) {
    const outDir = opts.outDir;
    await mkdirRetryAsync(resolve(outDir), { recursive: true });
    const report = e.report || baseReport({ profile: opts.profileName, sceneSha256: "", versions: versions() });
    report.status = "failed";
    report.stage = e.stage || "validate";
    report.code = e.code || "PAGE_ERROR";
    report.frame = e.frame ?? null;
    report.message = e.message || String(e);
    report.eperm_retries = takeRetryCount();
    try {
      writeReport(outDir, report);
    } catch (writeErr) {
      // Even the failure report cannot be written (e.g. transient EPERM).
      // Report on stderr instead of crashing with an uncaught exception.
      console.error(`REPORT_WRITE_FAILED ${JSON.stringify(report)} (${writeErr.message})`);
    }
    return { exit: e.exit ?? 5, error: e, report };
  }
}
