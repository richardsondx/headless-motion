// hme player-pass: screenshot a video through the player path, as a
// viewer sees it.
//
// Promotes run-player-pass.py into a tool command. The method is the
// same, step for step: build a local player page (file://, no network)
// with one hidden shot div per second, open it in Playwright Chromium
// at the reference window size, seek each second through a media
// fragment (#t=N), wait for the frame to land, screenshot the full
// window, then crop the video area and resize it to frame size.
//
// The page is built here in JavaScript (buildPlayerPage) so the exact
// bytes are testable without a browser. The screenshots and the crop
// run in the system python3, because Playwright lives there, not in
// the engine venv. Nothing here reimplements the screenshot loop.
//
// --out is the output directory for this command: it receives
// player.html, shot-<sec>.png, frame-<sec>.png, and
// player-pass-report.json. The insight report goes to stdout.
// Defaults are the reference prep: 1919x1497 window, video area
// 185,55,1533,831, frames resized to 1920x1080. Nothing is hardcoded
// to a video or a segment: the video and the seconds come from the
// arguments, and the viewport, crop, and resize can change.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeInsightReport } from "./hme.mjs";

export const DEFAULT_VIEWPORT = [1919, 1497];
export const DEFAULT_CROP = [185, 55, 1533, 831];
export const DEFAULT_RESIZE = [1920, 1080];
const SYSTEM_PYTHON = "python3";

export const USAGE = [
  "hme player-pass: Screenshot a video through the player path, as a viewer sees it.",
  "",
  "Usage: hme player-pass video.mp4 --seconds <list> --out <dir>",
  "",
  "Arguments:",
  "  video.mp4  Path to the video.",
  "",
  "Options:",
  "  --seconds <list>  Seconds to capture, for example 1,4,5,7. Required.",
  "  --out <dir>  Output directory for player.html, the shots, the frames, and player-pass-report.json. Required.",
  "  --viewport <WxH>  Window size, default 1919x1497.",
  "  --crop <x,y,w,h>  Video area inside the window, default 185,55,1533,831.",
  "  --resize <WxH>  Frame size for the cropped frames, default 1920x1080.",
  "  --label <text>  Label written into player-pass-report.json, default empty.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// Parse "--seconds 1,4,5,7" into [1, 4, 5, 7]. Floats are allowed
// (7.75 captures 7.75 s); a whole value prints as an integer so file
// names stay shot-1.png, not shot-1.0.png. Pure function, tested
// without any video.
export function parseSeconds(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const out = [];
  for (const part of text.split(",")) {
    const value = Number(part.trim());
    if (part.trim() === "" || !Number.isFinite(value) || value < 0) return null;
    out.push(value);
  }
  return out.length === 0 ? null : out;
}

export function secLabel(sec) {
  return Number.isInteger(sec) ? String(sec) : String(sec);
}

// Build the player page, byte for byte as run-player-pass.py wrote
// it: one hidden shot div per second, shown by :target, video
// positioned by percentage so the crop box lands on the same pixels.
// Pure function, tested against the recorded player-pass run.
export function buildPlayerPage({ videoUri, seconds, viewport, crop }) {
  const [vw, vh] = viewport;
  const [cx, cy, cw, ch] = crop;
  const tag = "video";
  const boxCss = `left:${(cx / vw * 100).toFixed(3)}%;top:${(cy / vh * 100).toFixed(3)}%;width:${(cw / vw * 100).toFixed(3)}%;aspect-ratio:${cw} / ${ch};`;
  let shotsHtml = "";
  for (const sec of seconds) {
    const label = secLabel(sec);
    shotsHtml += `  <div class="shot" id="shot-${label}s"><${tag} src="${videoUri}#t=${label}" muted preload="auto"></${tag}></div>\n`;
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Player pass</title>
<style>
  html, body { margin: 0; padding: 0; background: #000; width: 100%; height: 100%; overflow: hidden; }
  .shot { display: none; position: absolute; ${boxCss} }
  .shot:target { display: block; }
  video { width: 100%; height: 100%; object-fit: fill; background: #000; display: block; }
</style></head><body>
${shotsHtml}</body></html>
`;
}

// Build the insight report from the player-pass-report.json content.
// Pure function, tested without any video.
export function buildInsightReport(measured) {
  const seconds = measured.seconds;
  const shots = measured.shots ?? {};
  const missing = seconds.filter((s) => !(String(s) in shots));
  const status = missing.length === 0 ? "PASS" : "FAIL";
  return {
    verdict: {
      status,
      failed_bar: status === "PASS" ? null : `all ${seconds.length} shots captured`,
      detail: status === "PASS"
        ? `All ${seconds.length} shots captured through the player path.`
        : `Missing shots for seconds: ${missing.join(", ")}.`,
    },
    numbers: {
      video: measured.video,
      seconds,
      viewport: measured.viewport,
      crop: measured.crop,
      resize: measured.resize,
      shots,
    },
    corrections: [],
    context: {
      thresholds: {},
      control_ceiling: null,
      meaning: "These frames show the video as a viewer sees it through the player path, not the raw frames. Compare them against the reference frames to score the clone.",
    },
    next: `hme compare <ref.mp4> ${measured.video} --out out/compare.json`,
    limits: [
      "Screenshots show the video as the player shows it. A seek that lands a frame early or late shows the wrong frame, so check current_time in player-pass-report.json.",
      "One still per second. Motion between the captured seconds is not checked.",
    ],
  };
}

function parsePair(text, name) {
  const m = /^(\d+)[x,](\d+)$/.exec(text.trim());
  if (!m) throw new Error(`${name} must be 'WxH', got ${JSON.stringify(text)}`);
  return [Number(m[1]), Number(m[2])];
}

function parseQuad(text, name) {
  const parts = text.split(",").map((v) => Number(v.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`${name} must be 'x,y,w,h', got ${JSON.stringify(text)}`);
  }
  return parts;
}

// The screenshot driver. It is run-player-pass.py, unchanged in
// method: seek each second through its fragment, wait for the frame,
// screenshot, retry once, crop and resize. It prints progress to
// stdout and writes player-pass-report.json. It prints exactly
// nothing to stdout that the caller must parse: Node checks the exit
// code and the files.
const DRIVER = `
import json
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

VIDEO, SECONDS, OUT, PAGE, VIEWPORT, CROP, RESIZE, LABEL = sys.argv[1:9]
seconds = []
for part in SECONDS.split(","):
    v = float(part)
    seconds.append(int(v) if v == int(v) else v)
vw, vh = (int(x) for x in VIEWPORT.split("x"))
crop = [int(x) for x in CROP.split(",")] if CROP else None
resize = tuple(int(x) for x in RESIZE.split("x")) if RESIZE else None
out = Path(OUT)
page_path = Path(PAGE)

def label(sec):
    return str(int(sec)) if float(sec) == int(sec) else str(sec)

report = {"label": LABEL, "video": VIDEO, "seconds": seconds,
          "viewport": [vw, vh], "crop": crop, "resize": list(resize) if resize else None,
          "shots": {}}
failed = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": vw, "height": vh})
    for sec in seconds:
        shot = f"shot-{label(sec)}s"
        ok = False
        for attempt in (1, 2):
            page.goto(page_path.as_uri() + "#" + shot, wait_until="load")
            page.wait_for_timeout(1500)
            try:
                page.wait_for_function(
                    """([shot, target]) => {
                        const v = document.getElementById(shot).querySelector('video');
                        return v && v.readyState >= 2 && Math.abs(v.currentTime - target) < 0.15;
                    }""", arg=[shot, sec], timeout=15000)
            except Exception:
                print(f"{shot}: seek wait timed out (attempt {attempt})", flush=True)
            page.wait_for_timeout(500)
            info = page.evaluate(
                """(shot) => {
                    const v = document.getElementById(shot).querySelector('video');
                    return {currentTime: v.currentTime, readyState: v.readyState,
                            videoWidth: v.videoWidth, videoHeight: v.videoHeight,
                            paused: v.paused};
                }""", shot)
            path = out / f"shot-{label(sec)}.png"
            page.screenshot(path=str(path), full_page=False)
            size = path.stat().st_size if path.exists() else 0
            if size > 0 and info["readyState"] >= 2:
                ok = True
                break
            print(f"{shot}: attempt {attempt} failed (bytes={size}, {info})", flush=True)
        if not ok:
            failed.append(sec)
            continue
        lum = round(sum(Image.open(path).convert("L").resize((64, 64)).getdata()) / 4096, 1)
        entry = {"file": f"shot-{label(sec)}.png", "bytes": size,
                 "current_time": info["currentTime"],
                 "mean_luma": lum}
        if crop and resize:
            frame = Image.open(path).convert("RGB")
            assert frame.size == (vw, vh), (sec, frame.size)
            cx, cy, cw, ch = crop
            frame = frame.crop((cx, cy, cx + cw, cy + ch)).resize(tuple(resize), Image.LANCZOS)
            fpath = out / f"frame-{label(sec)}.png"
            frame.save(fpath)
            entry["frame"] = f"frame-{label(sec)}.png"
            entry["frame_bytes"] = fpath.stat().st_size
        report["shots"][sec] = entry
        print(f"{sec}s: {entry}", flush=True)
    browser.close()

(out / "player-pass-report.json").write_text(json.dumps(report, indent=1))
if failed:
    print(f"FAILED seconds: {failed}", file=sys.stderr)
    sys.exit(1)
print(f"PLAYER PASS OK: {len(seconds)} shots in {out}", flush=True)
`;

function runDriver(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(SYSTEM_PYTHON, ["-", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", (d) => { process.stderr.write(d); });
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", (err) => rejectPromise(new Error(`could not start ${SYSTEM_PYTHON}: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        rejectPromise(new Error(`player pass failed (exit ${code}):\n${tail}`));
        return;
      }
      resolvePromise();
    });
    child.stdin.end(DRIVER);
  });
}

// Run `hme player-pass <video.mp4> --seconds <list> --out <dir>`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runPlayerPass(argv) {
  const positionals = [];
  let secondsText = null;
  let outDir = null;
  let viewportText = null;
  let cropText = null;
  let resizeText = null;
  let label = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seconds") {
      if (i + 1 >= argv.length) {
        console.error("hme player-pass: --seconds needs a comma list like 1,4,5,7");
        console.error(USAGE);
        return 2;
      }
      secondsText = argv[++i];
    } else if (a.startsWith("--seconds=")) {
      secondsText = a.slice("--seconds=".length);
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme player-pass: --out needs a directory");
        console.error(USAGE);
        return 2;
      }
      outDir = argv[++i];
    } else if (a.startsWith("--out=")) {
      outDir = a.slice("--out=".length);
    } else if (a === "--viewport") {
      if (i + 1 >= argv.length) {
        console.error("hme player-pass: --viewport needs WxH like 1919x1497");
        console.error(USAGE);
        return 2;
      }
      viewportText = argv[++i];
    } else if (a === "--crop") {
      if (i + 1 >= argv.length) {
        console.error("hme player-pass: --crop needs x,y,w,h like 185,55,1533,831");
        console.error(USAGE);
        return 2;
      }
      cropText = argv[++i];
    } else if (a === "--resize") {
      if (i + 1 >= argv.length) {
        console.error("hme player-pass: --resize needs WxH like 1920x1080");
        console.error(USAGE);
        return 2;
      }
      resizeText = argv[++i];
    } else if (a === "--label") {
      if (i + 1 >= argv.length) {
        console.error("hme player-pass: --label needs a text");
        console.error(USAGE);
        return 2;
      }
      label = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme player-pass: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme player-pass: needs one video, video.mp4");
    console.error(USAGE);
    return 2;
  }
  if (secondsText === null) {
    console.error("hme player-pass: --seconds is required, for example --seconds 1,4,5,7");
    console.error(USAGE);
    return 2;
  }
  const seconds = parseSeconds(secondsText);
  if (seconds === null) {
    console.error(`hme player-pass: --seconds must be a comma list of seconds, got ${JSON.stringify(secondsText)}`);
    console.error(USAGE);
    return 2;
  }
  let viewport = DEFAULT_VIEWPORT;
  let crop = DEFAULT_CROP;
  let resize = DEFAULT_RESIZE;
  try {
    if (viewportText !== null) viewport = parsePair(viewportText, "--viewport");
    if (cropText !== null) crop = parseQuad(cropText, "--crop");
    if (resizeText !== null) resize = parsePair(resizeText, "--resize");
  } catch (err) {
    console.error(`hme player-pass: ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (resize && !crop) {
    console.error("hme player-pass: --resize needs --crop");
    console.error(USAGE);
    return 2;
  }
  const videoPath = resolve(positionals[0]);
  if (!existsSync(videoPath)) {
    console.error(`hme player-pass: no such file: ${positionals[0]}`);
    return 2;
  }
  const out = outDir === null
    ? mkdtempSync(join(tmpdir(), "hme-player-pass-"))
    : resolve(outDir);
  mkdirSync(out, { recursive: true });
  if (outDir === null) {
    console.error(`hme player-pass: no --out given, writing shots to ${out}`);
  }
  const videoUri = pathToFileURL(videoPath).href;
  const pagePath = join(out, "player.html");
  writeFileSync(pagePath, buildPlayerPage({ videoUri, seconds, viewport, crop }));
  try {
    await runDriver([
      videoPath,
      seconds.map(secLabel).join(","),
      out,
      pagePath,
      `${viewport[0]}x${viewport[1]}`,
      crop ? crop.join(",") : "",
      resize ? `${resize[0]}x${resize[1]}` : "",
      label,
    ]);
  } catch (err) {
    console.error(`hme player-pass: ${err.message}`);
    return 2;
  }
  const reportPath = join(out, "player-pass-report.json");
  let measured;
  try {
    measured = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    console.error("hme player-pass: player-pass-report.json is missing or unreadable");
    return 2;
  }
  for (const sec of seconds) {
    for (const name of [`shot-${secLabel(sec)}.png`, `frame-${secLabel(sec)}.png`]) {
      const p = join(out, name);
      if (!existsSync(p) || statSync(p).size === 0) {
        console.error(`hme player-pass: missing or empty output: ${name}`);
        return 2;
      }
    }
  }
  const report = buildInsightReport(measured);
  return writeInsightReport(report, null);
}
