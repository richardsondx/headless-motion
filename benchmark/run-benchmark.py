#!/usr/bin/env python3
"""Time the headless motion engine on the frozen benchmark scenes.

Usage (from the engine repo root):
    python3 benchmark/run-benchmark.py [--scenes map-sample,text-sample,scene-min]
                                       [--profiles draft,final]
                                       [--tag v2]

Writes benchmark/results-<date>[-<tag>].json with wall seconds, seconds per
frame, exit code, video sha256, file size, and ffprobe stream facts per run.

Wall time is measured here, outside the renderer, because render-report.json
records elapsed_s=0 by design (determinism: no wall clock in the report).
Do not read render times from render-report.json.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCENES = {
    "map-sample": "tests/fixtures/map-sample.json",
    "text-sample": "tests/fixtures/text-sample.json",
    "scene-min": "tests/fixtures/scene-min.json",
}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ffprobe(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=width,height,r_frame_rate,nb_frames,duration,codec_name",
         "-of", "json", str(path)],
        capture_output=True, text=True)
    try:
        s = json.loads(r.stdout)["streams"][0]
    except Exception:
        return {"error": r.stderr[:200]}
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenes", default=",".join(SCENES))
    ap.add_argument("--profiles", default="draft,final")
    ap.add_argument("--tag", default="",
                    help="appended to the results file name, e.g. v2 -> results-<date>-v2.json")
    args = ap.parse_args()
    results = {"date": str(date.today()), "tool": "headless-motion-engine",
               "tag": args.tag or None,
               "notes": "wall_s is external shell time (subprocess, includes process exit); "
                        "render_wall_s is the renderer's own wall time from render-report.md "
                        "(launch to probe, excludes the ~25 s Chromium-teardown linger that "
                        "the exit fix removed in v2). Load average is recorded per run because "
                        "this is a shared 4-core VM.",
               "runs": []}
    for scene in args.scenes.split(","):
        for profile in args.profiles.split(","):
            out = ROOT / "benchmark" / "runs" / f"{scene}-{profile}"
            load_1m = round(os.getloadavg()[0], 2)
            t_start = time.time()
            attempts = 0
            r = None
            wall = 0.0
            # A render can fail on a transient write block (EPERM flapping
            # seen 2026-11-07: the first file write fails, exit 5, in ~1 s).
            # Retry a few times so one blocked minute does not lose the run.
            # t0 ends as the last attempt's start, so the video-staleness
            # check below still compares against the real render.
            while True:
                attempts += 1
                t0 = time.time()
                r = subprocess.run(
                    ["node", "src/renderer/cli.mjs", "render", SCENES[scene],
                     "--profile", profile, "--out", str(out)],
                    cwd=ROOT, capture_output=True, text=True, timeout=3600)
                # 3600, not 1200: under heavy shared-CPU load a 240-frame
                # final render can need over 20 min; the old 1200s cap
                # killed the run outright (TimeoutExpired, Nov 8 00:21 EST).
                wall = time.time() - t0
                if r.returncode == 0 or attempts >= 4:
                    break
                time.sleep(30)
            total_elapsed = time.time() - t_start
            video = out / "video.mp4"
            rec = {"scene": scene, "profile": profile, "exit": r.returncode,
                   "wall_s": round(wall, 1), "frames": 240,
                   "s_per_frame": round(wall / 240, 3),
                   "load_1m": load_1m,
                   "attempts": attempts,
                   "total_elapsed_s": round(total_elapsed, 1),
                   "out": str(out)}
            # The renderer's own wall time (render work only) and its worker
            # config, read from the report the CLI wrote next to the video.
            # Guarded: a render can die before writing its report (seen
            # 2026-11-07: transient EPERM left a 0-byte report), and the
            # benchmark must record that run as failed, not crash.
            md = out / "render-report.md"
            try:
                if md.exists():
                    m = re.search(r"wall_s: ([0-9.]+)", md.read_text())
                    if m:
                        rec["render_wall_s"] = float(m.group(1))
            except Exception as e:
                rec["report_md_error"] = str(e)[:200]
            js = out / "render-report.json"
            try:
                if js.exists() and js.stat().st_size > 0:
                    rep = json.loads(js.read_text())
                    rec["capture_workers"] = rep.get("capture_workers")
                    rec["ffmpeg_threads"] = rep.get("ffmpeg_threads")
                    rec["render_status"] = rep.get("status")
                    rec["render_code"] = rep.get("code")
                else:
                    rec["report_json_error"] = "missing or empty render-report.json"
            except Exception as e:
                rec["report_json_error"] = str(e)[:200]
            if video.exists():
                # The run dir is reused across benchmark versions, so a stale
                # video from an earlier run can sit here. Only claim the sha
                # if the video is newer than this run's start; otherwise the
                # render failed and the old file must not pose as the result.
                if video.stat().st_mtime >= t0:
                    rec["bytes"] = video.stat().st_size
                    rec["sha256"] = sha256(video)
                    rec["stream"] = ffprobe(video)
                else:
                    rec["stale_video"] = True
                    rec["error"] = (r.stdout + r.stderr)[-500:]
            else:
                rec["error"] = (r.stdout + r.stderr)[-500:]
            results["runs"].append(rec)
            print(f"{scene} {profile}: exit={rec['exit']} "
                  f"wall={rec['wall_s']}s s/frame={rec['s_per_frame']} "
                  f"sha={rec.get('sha256', '-')[:16]}")
    name = f"results-{date.today()}-{args.tag}.json" if args.tag else f"results-{date.today()}.json"
    dest = ROOT / "benchmark" / name
    payload = json.dumps(results, indent=2)
    # The write can fail transiently (EPERM flapping seen 2026-11-07, which
    # truncates the file on open). Retry a few times; if it still fails,
    # print the JSON so the run is preserved in the log instead of lost.
    for attempt in range(7):
        try:
            dest.write_text(payload)
            print(f"wrote {dest}")
            break
        except OSError as e:
            if attempt == 6:
                print(f"FAILED to write {dest}: {e}")
                print(payload)
                raise SystemExit(2)
            time.sleep(30)


if __name__ == "__main__":
    main()
