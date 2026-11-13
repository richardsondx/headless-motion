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
import { visualKey, loadMapContext } from "./framekey.mjs";
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

// JPEG input for the real-time preview: the screencast hands us JPEG
// frames, so the encoder takes mjpeg instead of PNG. Same output flags
// as encodePngs except the bitexact ones: the input is lossy and the
// capture is non-deterministic anyway, so byte-exact output is not a
// goal here.
function encodeJpegs(jpegs, outFile, { width, height, fps, crf, preset, threads = "0" }) {
  return new Promise((resolveP, rejectP) => {
    const args = [
      "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-r", String(fps), "-i", "pipe:0",
      "-vf", `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
      "-c:v", "libx264", "-profile:v", "high", "-preset", preset, "-crf", String(crf),
      "-r", String(fps), "-g", "48", "-threads", String(threads),
      "-map_metadata", "-1", "-an",
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
    for (const jpg of jpegs) proc.stdin.write(jpg);
    proc.stdin.end();
  });
}

async function encodeJpegsWithRetry(jpegs, outFile, opts) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await encodeJpegs(jpegs, outFile, opts);
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
  // The profile output must share the scene aspect: a landscape scene
  // under the vertical profile (or the reverse) fails loudly instead of
  // rendering a cropped frame. The match allows 1% slack, because the
  // previs output (854x480) is a rounded 16:9, not an exact one.
  const sceneAspect = scene.meta.width / scene.meta.height;
  const profileAspect = profile.output.width / profile.output.height;
  if (Math.abs(sceneAspect - profileAspect) / sceneAspect > 0.01) {
    fail("validate", "SCENE_INVALID", EXIT.scene, `scene size ${scene.meta.width}x${scene.meta.height} does not match profile ${profileName} output ${profile.output.width}x${profile.output.height} (aspect mismatch)`);
  }
  const fps = sceneFps(scene);
  const duration = scene.meta.duration;
  const frameList = order ? [...order] : frames ? Array.from({ length: frames[1] - frames[0] }, (_, i) => frames[0] + i) : Array.from({ length: duration }, (_, i) => i);
  for (const f of frameList) if (f < 0 || f >= duration) fail("validate", "SCENE_INVALID", EXIT.scene, `frame ${f} outside [0, ${duration})`, f);

  // Frame dedup: the picture at frame N is a pure function of (scene, N),
  // so frames with equal visual keys render identical pixels. Precompute
  // the key per frame in Node (pure functions only) and capture one frame
  // per key, reusing its PNG for the rest. HME_DEDUP=0 disables it.
  const dedupOn = process.env.HME_DEDUP !== "0";
  let frameKeys = null;
  if (dedupOn) {
    const mapCtx = loadMapContext(scene);
    frameKeys = frameList.map((f) => visualKey(scene, f, mapCtx));
  }
  const uniqueKeys = dedupOn ? new Set(frameKeys).size : frameList.length;
  report.dedup = dedupOn;
  report.frames_deduped = frameList.length - uniqueKeys;
  report.frames_captured_unique = uniqueKeys;

  const sceneDir = dirname(resolve(scenePath));
  const { html, errors: cErr, mapCache } = compileScene(scene, sceneDir);
  report.map_cache = mapCache === true;
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
    const pg = await browser.newPage({ viewport: { width: scene.meta.width, height: scene.meta.height }, deviceScaleFactor: profile.supersample });
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
    // Vertical scenes: the compiled stage is 1920x1080 in CSS, so resize
    // it to the scene size before the first seek. Landscape scenes skip
    // this: the values match, and the capture path stays byte-identical.
    if (scene.meta.width !== 1920 || scene.meta.height !== 1080) {
      for (const w of pages) {
        await w.pg.evaluate(([sw, sh]) => {
          const el = document.createElement("style");
          el.textContent = `html,body{width:${sw}px!important;height:${sh}px!important}#stage{width:${sw}px!important;height:${sh}px!important}`;
          document.head.appendChild(el);
        }, [scene.meta.width, scene.meta.height]);
      }
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
    const captureOne = async (w, f) => {
      // A 2880x1620 final-profile screenshot takes over 30 s in this
      // sandbox (measured 19.8 s at 1x; the seek takes about 1 s), so
      // the capture budget is 120 s, not 30 s.
      const pg = w.pg;
      const png = await Promise.race([
        (async () => {
          await pg.evaluate((frame) => window.__hme.seek(frame), f);
          return pg.screenshot({ type: "png", animations: "disabled", timeout: 120000, clip: { x: 0, y: 0, width: scene.meta.width, height: scene.meta.height } });
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("CAPTURE_TIMEOUT")), 120000)),
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
    // Dedup promise map: the first worker to reach a key starts its
    // capture; any other worker with the same key awaits that same
    // promise. A worker only ever awaits a capture another worker already
    // started, so no worker waits on a capture that waits on it.
    const pending = new Map();
    const getFramePng = async (w, idx) => {
      const f = frameList[idx];
      if (!dedupOn) return captureOne(w, f);
      const k = frameKeys[idx];
      let p = pending.get(k);
      if (!p) {
        p = captureOne(w, f);
        pending.set(k, p);
      }
      return p;
    };
    await Promise.all(pages.map(async (w, wi) => {
      for (let idx = wi; idx < frameList.length; idx += pages.length) {
        const f = frameList[idx];
        const png = await getFramePng(w, idx);
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

/**
 * Real-time preview (NON-DETERMINISTIC, preview only). Plays the scene in
 * the browser at wall-clock speed and records the compositor output with
 * a CDP screencast, sampling to the scene fps. The output video is named
 * preview-rt.mp4 and the report says nondeterministic: true. Never use
 * for final output or verification: the frames depend on machine load (a
 * slow seek shows up as a repeated frame), and two runs differ.
 * Wall-clock pacing lives here on purpose: this is the harness file, and
 * the mode is labelled non-deterministic everywhere.
 */
export async function renderRealtime({ scenePath, profileName, outDir, crfOverride = null, overrides = [] }) {
  const vers = versions();
  vers.ffmpeg = await ffmpegVersion();
  const scene = loadScene(scenePath);
  const sceneSha = sha256(readFileSync(scenePath));
  const profile = profiles[profileName];
  if (!profile) throw { stage: "validate", code: "SCENE_INVALID", exit: EXIT.scene, frame: null, message: `unknown profile ${profileName}` };
  if (!profile.realtime) throw { stage: "validate", code: "SCENE_INVALID", exit: EXIT.scene, frame: null, message: `${profileName} is not a realtime profile` };
  const report = baseReport({ profile: profileName, sceneSha256: sceneSha, versions: vers });
  report.mode = "realtime-preview";
  report.nondeterministic = true;
  report.dedup = false;
  report.overrides = overrides;
  const ffmpegThreads = process.env.HME_FFMPEG_THREADS || "0";
  report.ffmpeg_threads = ffmpegThreads;
  const fail = (stage, code, exit, message, frame = null) => {
    throw { stage, code, exit, frame, message, report };
  };
  const { errors } = validateScene(scene);
  if (errors.length) fail("validate", "SCENE_INVALID", EXIT.scene, errors.map((e) => `${e.code} ${e.path}`).join("; "));
  const fps = sceneFps(scene);
  const duration = scene.meta.duration;
  const sceneDir = dirname(resolve(scenePath));
  const { html, errors: cErr, mapCache } = compileScene(scene, sceneDir);
  report.map_cache = mapCache === true;
  if (cErr.length) {
    const e = cErr[0];
    fail("compile", e.code, EXIT.scene, e.message);
  }
  await mkdirRetryAsync(resolve(outDir), { recursive: true });
  await writeFileRetryAsync(resolve(outDir, "page.html"), html);
  report.stage = "launch";
  const chromePath = process.env.CHROME_PATH || findChrome();
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
  if (!browser) fail("launch", "BROWSER_LAUNCH", EXIT.browser, String(launchErr.message || launchErr));
  const blocked = [];
  const consoleErrors = [];
  let pg;
  const received = []; // {ts, data} screencast frames, base64 JPEG
  let t0 = null; // CDP timestamp of the first screencast frame
  let n0 = 0; // performance.now() when that frame arrived
  try {
    pg = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: profile.supersample });
    pg.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    pg.on("pageerror", (e) => consoleErrors.push(String(e.message || e)));
    await pg.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("file:") || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      blocked.push(url);
      return route.abort();
    });
    await pg.setContent(html, { waitUntil: "load", timeout: 30000 });
    vers.chrome = browser.version();
    report.versions = vers;
    await Promise.race([
      pg.evaluate(() => window.__hme.ready),
      new Promise((_, reject) => setTimeout(() => reject(new Error("READY_TIMEOUT")), 30000)),
    ]).catch((e) => {
      const msg = String(e.message || e);
      if (msg.includes("FONT_MISSING")) fail("ready", "FONT_MISSING", EXIT.scene, msg);
      throw e;
    });
    if (blocked.length) fail("seek", "NETWORK_BLOCKED", EXIT.seek, `blocked ${blocked.length} non-local request(s): ${blocked[0]}`);
    // Seek to frame 0 before recording, so the first screencast frame
    // shows the true frame-0 state, not the pre-apply static DOM.
    await pg.evaluate(() => window.__hme.seek(0));
    // Screencast: one JPEG per compositor frame, acked immediately or the
    // stream stalls. Slot sampling happens after playback, from the CDP
    // timestamps, so a slow machine shows up as repeated frames, not as
    // a wrong-length video.
    const cdp = await pg.context().newCDPSession(pg);
    const firstFrame = new Promise((resolveFirst) => {
      cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
        if (t0 === null) {
          t0 = metadata.timestamp;
          n0 = performance.now();
          resolveFirst();
        }
        received.push({ ts: metadata.timestamp, data });
        cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      });
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
    await Promise.race([firstFrame, new Promise((_, reject) => setTimeout(() => reject(new Error("SCREENCAST_TIMEOUT")), 15000))]);
    report.stage = "capture";
    // Playback: seek frame k at wall-clock n0 + k/fps. A seek that
    // overruns its slot starts the next seek at once (no catch-up). The
    // sampling below is per-seek (not per wall-clock slot): output frame
    // k shows the screencast frame painted for seek k, so the video
    // always covers the whole scene. When seeks lag, the video is the
    // scene sped up by wall_s / scene duration; the wall time in
    // render-report.md says by how much.
    const frameMs = 1000 / fps;
    const seekDone = [];
    let framesReached = 0;
    for (let k = 0; k < duration; k++) {
      const wait = n0 + k * frameMs - performance.now();
      if (wait > 0) await sleep(wait);
      try {
        await pg.evaluate((frame) => window.__hme.seek(frame), k);
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes("MODULE_WAIT_TIMEOUT")) fail("seek", "MODULE_WAIT_TIMEOUT", EXIT.seek, msg, k);
        if (msg.includes("SEEK_MISMATCH")) fail("seek", "SEEK_MISMATCH", EXIT.seek, msg, k);
        throw e;
      }
      seekDone[k] = performance.now();
      framesReached = k + 1;
    }
    // Let the compositor paint the final frame before stopping.
    await sleep(500);
    await cdp.send("Page.stopScreencast").catch(() => {});
    report.frames_reached = framesReached;
    report.frames_captured = received.length;
    // Sample per seek: for output frame k, the latest screencast frame
    // painted at or just after seek k completed (one frame of
    // compositing delay allowed). CDP timestamps are seconds; the offset
    // between them and performance.now() is fixed at the first frame.
    // A slot whose seek had not painted yet repeats the previous frame,
    // so the video is always `duration` frames.
    const offsetS = t0 - n0 / 1000;
    const sampled = [];
    let cursor = 0;
    let last = null;
    for (let k = 0; k < duration; k++) {
      const target = seekDone[k] / 1000 + offsetS + 1 / fps;
      while (cursor < received.length && received[cursor].ts <= target) {
        last = received[cursor];
        cursor++;
      }
      if (!last) {
        last = received[0];
        if (!last) fail("capture", "CAPTURE_TIMEOUT", EXIT.seek, "screencast delivered no frames");
      }
      sampled.push(Buffer.from(last.data, "base64"));
    }
    report.frames_captured_unique = sampled.length;
    const video = resolve(outDir, "preview-rt.mp4");
    const crf = crfOverride !== null ? crfOverride : profile.crf;
    report.stage = "encode";
    let enc;
    try {
      enc = await encodeJpegsWithRetry(sampled, video, { width: profile.output.width, height: profile.output.height, fps, crf, preset: profile.preset, threads: ffmpegThreads });
    } catch (e) {
      report.ffmpeg_stderr_tail = String(e.stderr || "").split("\n").slice(-40);
      report.ffmpeg_command = ["ffmpeg", "-f", "image2pipe", "-c:v", "mjpeg", "-crf", String(crf)];
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
    if (stream.width !== profile.output.width || stream.height !== profile.output.height || stream.r_frame_rate !== expectRate || Number(stream.nb_frames) !== duration || stream.pix_fmt !== "yuv420p" || stream.color_space !== "bt709") {
      fail("probe", "PROBE_MISMATCH", EXIT.encode, `probe: ${stream.width}x${stream.height} ${stream.r_frame_rate} frames=${stream.nb_frames} fmt=${stream.pix_fmt} cs=${stream.color_space}`);
    }
    report.status = "ok";
    report.stage = "probe";
    report.eperm_retries = takeRetryCount();
    try {
      writeReport(outDir, report);
    } catch (e) {
      fail("probe", "REPORT_WRITE", EXIT.encode, `render-report.json write failed: ${e.message}`);
    }
    return { outDir, video, frameHashes: {}, report };
  } catch (e) {
    try {
      await mkdirRetryAsync(resolve(outDir), { recursive: true });
      await writeFileRetryAsync(resolve(outDir, "failure", "console.log"), consoleErrors.join("\n"));
    } catch (_) { /* best effort */ }
    if (e && e.stage) throw e;
    const msg = String(e.message || e);
    if (msg.includes("FONT_MISSING")) fail("ready", "FONT_MISSING", EXIT.scene, msg);
    if (msg.includes("MODULE_WAIT_TIMEOUT") || msg.includes("SEEK_MISMATCH")) fail("seek", msg.includes("MODULE") ? "MODULE_WAIT_TIMEOUT" : "SEEK_MISMATCH", EXIT.seek, msg);
    fail("launch", "PAGE_ERROR", EXIT.browser, msg);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Write failure artefacts and report, then return the exit code. */
export async function renderWithReport(opts, renderFn = renderScene) {
  try {
    const r = await renderFn({ ...opts, overrides: opts.overrides || [] });
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
