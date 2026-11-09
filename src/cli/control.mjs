// hme control: run the control experiment and report the ceiling.
//
// Promotes verify-seg4/evidence/work/control-shots.py and
// measure-control.py into a tool command. The method is the same,
// step for step:
//   1. Screenshot the video through the player path (system python3
//      Playwright, 1919x1497 window, the same :target player page
//      the reference screenshots used), at seconds 1, 4, 5, 7.
//      With --crf, a YouTube-like re-encode (x264, preset medium)
//      is screenshotted too, as a second arm.
//   2. Extract the clean frames straight from the video with
//      ffmpeg (same frame numbers check-v5.sh used) and measure
//      clean vs screenshotted with the venv Python: SSIM/PSNR via
//      src/checker/metrics.py, LPIPS alex, Delta E CIEDE2000 on
//      21x21 medians at the measure-v5.py points.
//   3. Report the ceiling in the insight format. The clean arm
//      (screenshot + resize only) is the ceiling. The verdict is
//      the frozen pred-v1 bar: SSIM >= 0.96, PSNR >= 35,
//      LPIPS <= 0.08, worst Delta E < 3.
//
// Nothing is hardcoded to a video or a segment: the video comes
// from the argument and the frame rate is probed. The four seconds
// and the sample points are the control experiment's fixed method,
// the same on any video.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const SYSTEM_PYTHON = "python3";

export const CONTROL_SECONDS = [1, 4, 5, 7];
export const BAR = { ssim: 0.96, psnr: 35, lpips: 0.08, delta_e: 3 };
export const DEFAULT_CRF = 28;

export const USAGE = [
  "hme control: Run the control experiment: screenshot the video through the player path and report the ceiling.",
  "",
  "Usage: hme control video.mp4 [--crf <n>] [--out <report.json>]",
  "",
  "Arguments:",
  "  video.mp4  Path to the video to screenshot.",
  "",
  "Options:",
  "  --crf <n>  Also screenshot a YouTube-like re-encode at this x264 crf (0-51, default 28 when the flag has no value). Without it, only the clean arm runs.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

function roundTo(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

// Summarize one arm's per-second pairs into means and the worst
// Delta E. pairs: {"1": {ssim, psnr_db, lpips, worst_delta_e}, ...}.
// Pure function, tested without any video.
export function summarizeArm(pairs) {
  const rows = Object.entries(pairs).map(([sec, p]) => ({ sec: Number(sec), ...p }));
  const mean = (key, digits) => roundTo(rows.reduce((s, r) => s + r[key], 0) / rows.length, digits);
  const means = {
    ssim: mean("ssim", 4),
    psnr_db: mean("psnr_db", 2),
    lpips: mean("lpips", 4),
  };
  let worst = { value: null, second: null };
  for (const r of rows) {
    if (r.worst_delta_e !== null && r.worst_delta_e !== undefined
      && (worst.value === null || r.worst_delta_e > worst.value)) {
      worst = { value: r.worst_delta_e, second: r.sec };
    }
  }
  return {
    pairs,
    means_4_pairs: means,
    worst_delta_e: worst,
    passes_pred_v1_seg4: Boolean(
      means.ssim >= BAR.ssim && means.psnr_db >= BAR.psnr
      && means.lpips <= BAR.lpips && worst.value !== null && worst.value < BAR.delta_e),
  };
}

// Build the insight report from the measurement driver output.
// measured: {fps, arms: {clean: {pairs}, yt?: {pairs, bitrate_mbps}}}.
// Pure function, tested without any video.
export function buildControlReport(measured, video, crf) {
  const arms = {};
  for (const [name, arm] of Object.entries(measured.arms)) {
    arms[name] = summarizeArm(arm.pairs);
    if (arm.bitrate_mbps !== undefined) arms[name].bitrate_mbps = arm.bitrate_mbps;
  }
  const clean = arms.clean;
  const means = clean.means_4_pairs;
  const failedBar = means.ssim < BAR.ssim
    ? `SSIM >= ${BAR.ssim} (pred-v1)`
    : means.psnr_db < BAR.psnr
      ? `PSNR >= ${BAR.psnr} (pred-v1)`
      : means.lpips > BAR.lpips
        ? `LPIPS <= ${BAR.lpips} (pred-v1)`
        : clean.worst_delta_e.value !== null && clean.worst_delta_e.value >= BAR.delta_e
          ? `Delta E < ${BAR.delta_e} (pred-v1)`
          : null;
  const status = failedBar === null ? "PASS" : "FAIL";
  return {
    verdict: {
      status,
      failed_bar: failedBar,
      detail: status === "PASS"
        ? `Clean ceiling SSIM ${means.ssim}, PSNR ${means.psnr_db}, and LPIPS ${means.lpips} all clear the bar.`
        : failedBar.startsWith("SSIM")
          ? `Clean ceiling SSIM ${means.ssim} is below the ${BAR.ssim} bar.`
          : failedBar.startsWith("PSNR")
            ? `Clean ceiling PSNR ${means.psnr_db} is below the ${BAR.psnr} bar.`
            : failedBar.startsWith("LPIPS")
              ? `Clean ceiling LPIPS ${means.lpips} is above the ${BAR.lpips} bar.`
              : `Clean ceiling worst Delta E ${clean.worst_delta_e.value} is at or above the ${BAR.delta_e} bar.`,
    },
    numbers: {
      video,
      fps: measured.fps,
      seconds: CONTROL_SECONDS,
      crf: crf ?? null,
      arms,
    },
    corrections: [],
    context: {
      thresholds: { ssim: BAR.ssim, psnr: BAR.psnr, lpips: BAR.lpips, delta_e: BAR.delta_e },
      control_ceiling: {
        ssim: means.ssim,
        psnr_db: means.psnr_db,
        lpips: means.lpips,
        worst_delta_e: clean.worst_delta_e,
        note: "Clean video vs its player screenshot, from this control run.",
      },
      meaning: status === "PASS"
        ? `A perfect clone scores about ${means.ssim} SSIM here, so a compare below that is a real clone gap, not a measurement gap.`
        : `The ceiling itself is below the bar, so the player path loses more than the bar allows. Treat compare scores against this ceiling, not against 1.0.`,
    },
    next: `hme compare <ref.mp4> ${video} --out out/compare.json`,
    limits: [
      "Control screenshots carry no captions, player chrome, watermark or cursor, so this ceiling is an UPPER bound. The true ceiling against real reference frames is lower.",
      "The clean arm isolates the screenshot + resize penalty. The re-encoded arm adds YouTube-like compression (x264). Neither arm reproduces YouTube's exact encoder, so the re-encoded arm is an approximation of the compression part.",
      "4 paired seconds only, same as the v5 check.",
    ],
  };
}

// The screenshot driver. It is control-shots.py, unchanged in
// method: one :target player page, seek each shot through its
// fragment, wait for the frame, screenshot, retry once. Progress
// goes to stdout; the exit code says whether all shots landed.
const SHOT_DRIVER = `
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

VIDEO_URI, YT_URI, PAGE_PATH, OUT, SECONDS = sys.argv[1:6]
seconds = [int(s) for s in SECONDS.split(",") if s.strip()]
out = Path(OUT)
out.mkdir(parents=True, exist_ok=True)

shots = []
for sec in seconds:
    shots.append((f"clean-{sec}s", sec, VIDEO_URI))
    if YT_URI:
        shots.append((f"yt-{sec}s", sec, YT_URI))

divs = ""
tag = "video"
for shot, sec, uri in shots:
    divs += (f'  <div class="shot" id="{shot}">'
             f'<{tag} src="{uri}#t={sec}" muted preload="auto"></{tag}></div>'
             + chr(10))
Path(PAGE_PATH).write_text(f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Control player</title>
<style>
  html, body {{ margin: 0; padding: 0; background: #000; width: 100%; height: 100%; overflow: hidden; }}
  .shot {{ display: none; position: absolute; left: 9.64%; top: 3.674%; width: 79.885%; aspect-ratio: 1533 / 831; }}
  .shot:target {{ display: block; }}
  video {{ width: 100%; height: 100%; object-fit: fill; background: #000; display: block; }}
</style>
</head>
<body>
{divs}</body>
</html>
""")

def shot_once(page, shot, target):
    url = Path(PAGE_PATH).as_uri() + "#" + shot
    page.goto(url, wait_until="load")
    page.wait_for_timeout(1500)
    try:
        page.wait_for_function(
            """([shot, target]) => {
                const div = document.getElementById(shot);
                if (!div) return false;
                const v = div.querySelector('video');
                return v && v.readyState >= 2 && Math.abs(v.currentTime - target) < 0.15;
            }""",
            arg=[shot, target], timeout=15000)
    except Exception as e:
        print(f"{shot}: seek wait timed out ({type(e).__name__})", flush=True)
    page.wait_for_timeout(500)
    info = page.evaluate(
        """(shot) => {
            const v = document.getElementById(shot).querySelector('video');
            return {currentTime: v.currentTime, readyState: v.readyState,
                    videoWidth: v.videoWidth, videoHeight: v.videoHeight,
                    paused: v.paused};
        }""", shot)
    path = out / f"control-{shot}.png"
    page.screenshot(path=str(path), full_page=False)
    size = path.stat().st_size if path.exists() else 0
    lum = None
    if size > 0:
        lum = round(sum(Image.open(path).convert("L").resize((64, 64)).getdata()) / 4096, 1)
    print(f"{shot}: {info} bytes={size} mean_luma={lum}", flush=True)
    return size > 0 and info["readyState"] >= 2

failed = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1919, "height": 1497})
    for shot, target, _uri in shots:
        ok = shot_once(page, shot, target)
        if not ok:
            print(f"{shot}: retrying once", flush=True)
            ok = shot_once(page, shot, target)
        if not ok:
            failed.append(shot)
    browser.close()
if failed:
    print("FAILED:", failed, flush=True)
    sys.exit(1)
print("ALL SHOTS OK", flush=True)
`;

// The measurement driver. It is measure-control.py, unchanged in
// method: clean frames from the video with ffmpeg, screenshots
// cropped (185,55,1533,831) and resized to 1920x1080, SSIM/PSNR via
// src/checker/metrics.py, LPIPS alex, Delta E CIEDE2000 on 21x21
// medians at the measure-v5.py points. It prints exactly one JSON
// object to stdout; progress goes to stderr.
const MEASURE_DRIVER = `
import contextlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

VIDEO, WORK, YT, SRC = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
sys.path.insert(0, SRC)
from checker import metrics, color  # noqa: E402

CROP = (185, 55, 185 + 1533, 55 + 831)
SECONDS = [1, 4, 5, 7]

POINTS = {
    1: {"sudan": [(980, 640), (1050, 720)],
        "land": [(750, 675), (1300, 620)],
        "water": [(1300, 620)], "rsf": None},
    4: {"sudan": [(969, 600), (1100, 650)],
        "land": [(500, 520), (500, 700)],
        "water": [(1350, 350)], "rsf": [(945, 552), (968, 597)]},
    5: {"sudan": [(976, 620), (1100, 650)],
        "land": [(480, 530), (480, 700)],
        "water": [(1380, 350)], "rsf": [(799, 666), (830, 700)]},
    7: {"sudan": [(970, 578), (770, 578), (1208, 578), (970, 344), (970, 772), (989, 552)],
        "land": [(645, 513), (1521, 383)],
        "water": [(1333, 383)], "rsf": [(945, 552), (693, 732)]},
}

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate,nb_frames",
        "-show_entries", "format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    num, den = (float(x) for x in s["r_frame_rate"].split("/"))
    fps = num / den
    if s.get("nb_frames"):
        frames = int(s["nb_frames"])
    else:
        frames = round(float(j["format"]["duration"]) * fps)
    return {"fps": fps, "frames": frames}

def run_ffmpeg(args):
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + p.stderr[-2000:])

def load(path):
    return np.array(Image.open(path).convert("RGB"))

def median21(frame, cx, cy):
    x0, y0 = max(0, cx - 10), max(0, cy - 10)
    patch = frame[y0:cy + 11, x0:cx + 11].reshape(-1, 3)
    return np.median(patch, axis=0).astype(float)

def hex_of(rgb):
    r, g, b = (int(round(v)) for v in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"

def delta_e(a_rgb, b_rgb):
    la = color.rgb_to_lab(np.array(a_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    lb = color.rgb_to_lab(np.array(b_rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    return color.ciede2000(la, lb)

info = probe(VIDEO)
fps = info["fps"]
work = Path(WORK)
arms = ["clean"] + (["yt"] if YT else [])

for sec in SECONDS:
    frame_no = int(round(sec * fps))
    if frame_no >= info["frames"]:
        raise RuntimeError(f"second {sec} is past the end of the video ({info['frames']} frames at {fps} fps)")
    run_ffmpeg(["ffmpeg", "-y", "-v", "error", "-i", VIDEO,
                "-vf", f"select=eq(n\\,{frame_no})", "-frames:v", "1",
                str(work / f"clean-{sec}s.png")])

pairs = {}
for arm in arms:
    pairs[arm] = {}
    for sec in SECONDS:
        clean = load(work / f"clean-{sec}s.png")
        src = Image.open(work / f"control-{arm}-{sec}s.png").convert("RGB")
        assert src.size == (1919, 1497), (arm, sec, src.size)
        frame = src.crop(CROP).resize((1920, 1080), Image.LANCZOS)
        frame.save(work / f"frame-{arm}-{sec}s.png")
        ctrl = np.array(frame)
        assert clean.shape == ctrl.shape == (1080, 1920, 3), (arm, sec, ctrl.shape)
        ssim = metrics.ssim_frame(metrics.luma(clean), metrics.luma(ctrl))
        psnr = metrics.psnr_frame(clean, ctrl)
        areas = {}
        for area in ("sudan", "land", "water", "rsf"):
            rp = POINTS[sec][area]
            if rp is None:
                areas[area] = {"present": False}
                continue
            c_med = np.median([median21(clean, x, y) for x, y in rp], axis=0)
            s_med = np.median([median21(ctrl, x, y) for x, y in rp], axis=0)
            de = round(delta_e(c_med, s_med), 2)
            areas[area] = {"present": True, "clean_hex": hex_of(c_med),
                           "control_hex": hex_of(s_med), "delta_e": de,
                           "pass": bool(de < 3)}
        worst = max((a["delta_e"] for a in areas.values() if a.get("present")), default=None)
        pairs[arm][sec] = {"ssim": round(float(ssim), 4), "psnr_db": round(float(psnr), 2),
                           "areas": areas, "worst_delta_e": worst}

import torch  # noqa: E402
import lpips as lpips_lib  # noqa: E402

with contextlib.redirect_stdout(sys.stderr):
    loss_fn = lpips_lib.LPIPS(net="alex")
for arm in arms:
    for sec in SECONDS:
        clean = load(work / f"clean-{sec}s.png")
        ctrl = load(work / f"frame-{arm}-{sec}s.png")
        a = torch.from_numpy(clean.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
        b = torch.from_numpy(ctrl.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
        with torch.no_grad():
            pairs[arm][sec]["lpips"] = round(float(loss_fn(a, b).item()), 4)
        print(f"lpips {arm} {sec}s done: {pairs[arm][sec]['lpips']}", file=sys.stderr)

out = {"fps": round(fps, 3), "arms": {}}
for arm in arms:
    entry = {"pairs": {str(k): v for k, v in pairs[arm].items()}}
    if arm == "yt":
        entry["bitrate_mbps"] = round(Path(YT).stat().st_size / 1e6, 2)
    out["arms"][arm] = entry
print(json.dumps(out))
`;

function runPython(python, args, driver, { captureJson }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(python, ["-", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!captureJson) process.stderr.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", (err) => rejectPromise(new Error(`could not start ${python}: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        rejectPromise(new Error(`control measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      if (!captureJson) {
        resolvePromise(null);
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`control measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(driver);
  });
}

// Run `hme control <video.mp4> [--crf <n>] [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runControl(argv) {
  const positionals = [];
  let crf = null;
  let crfGiven = false;
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--crf") {
      crfGiven = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && next !== "") {
        const n = Number(next);
        if (!Number.isInteger(n) || n < 0 || n > 51) {
          console.error(`hme control: --crf must be a whole number from 0 to 51, got ${JSON.stringify(next)}`);
          console.error(USAGE);
          return 2;
        }
        crf = n;
        i++;
      } else {
        crf = DEFAULT_CRF;
      }
    } else if (a.startsWith("--crf=")) {
      crfGiven = true;
      const n = Number(a.slice("--crf=".length));
      if (!Number.isInteger(n) || n < 0 || n > 51) {
        console.error(`hme control: --crf must be a whole number from 0 to 51, got ${JSON.stringify(a)}`);
        console.error(USAGE);
        return 2;
      }
      crf = n;
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme control: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme control: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme control: needs one video, video.mp4");
    console.error(USAGE);
    return 2;
  }
  const videoPath = resolve(positionals[0]);
  if (!existsSync(videoPath)) {
    console.error(`hme control: no such file: ${positionals[0]}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme control: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  const workdir = mkdtempSync(join(tmpdir(), "hme-control-"));
  try {
    let ytPath = "";
    if (crfGiven) {
      ytPath = join(workdir, "yt.mp4");
      const enc = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", videoPath,
        "-c:v", "libx264", "-crf", String(crf), "-preset", "medium",
        "-pix_fmt", "yuv420p", "-an", ytPath], { encoding: "utf8" });
      if (enc.status !== 0) {
        console.error(`hme control: re-encode at crf ${crf} failed: ${(enc.stderr || "").trim().slice(-500)}`);
        return 2;
      }
      console.error(`hme control: re-encoded at crf ${crf} (${(statSync(ytPath).size / 1e6).toFixed(2)} MB)`);
    }
    const videoUri = pathToFileURL(videoPath).href;
    const ytUri = ytPath ? pathToFileURL(ytPath).href : "";
    await runPython(SYSTEM_PYTHON,
      [videoUri, ytUri, join(workdir, "control-player.html"), workdir, CONTROL_SECONDS.join(",")],
      SHOT_DRIVER, { captureJson: false });
    const measured = await runPython(VENV_PYTHON,
      [videoPath, workdir, ytPath, SRC_DIR],
      MEASURE_DRIVER, { captureJson: true });
    const report = buildControlReport(measured, videoPath, crfGiven ? crf : null);
    return writeInsightReport(report, outPath);
  } catch (err) {
    console.error(`hme control: ${err.message}`);
    return 2;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
