"""Player pass: screenshot our own video the way the reference was taken.

Permanent review step. Given a rendered video, it plays it in a local
player page (Playwright Chromium, file://, no network) at a set window size
and screenshots it at the given seconds, the same way the reference frames
were captured. Optionally crops each screenshot to a video area and resizes
it to a frame size, reproducing the reference prep.

Usage:
  python3 run-player-pass.py --video out/seg4-final-v5/run-a/video.mp4 \\
      --seconds 1,4,5,7 --out verify-seg4/evidence/work/player-pass-v5 \\
      --viewport 1919x1497 --crop 185,55,1533,831 --resize 1920,1080

Outputs in --out: player.html, shot-<sec>.png (full window), frame-<sec>.png
(cropped and resized, only with --crop and --resize), player-pass-report.json.
Exit 0 when all shots are written and non-empty, non-zero otherwise.

Run with the system python3: Playwright lives there, not in the engine venv.
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright


def parse_pair(text, name):
    try:
        a, b = (int(v) for v in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError(f"{name} must be 'a,b', got {text!r}")
    return a, b


def parse_quad(text, name):
    try:
        vals = [int(v) for v in text.split(",")]
        assert len(vals) == 4
    except (ValueError, AssertionError):
        raise argparse.ArgumentTypeError(f"{name} must be 'x,y,w,h', got {text!r}")
    return vals


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video", required=True, help="rendered video file")
    ap.add_argument("--seconds", required=True,
                    help="comma list of seconds, e.g. 1,4,5,7")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--viewport", default="1919x1497",
                    help="window size WxH, default 1919x1497")
    ap.add_argument("--crop", default=None,
                    help="video area inside the window as x,y,w,h")
    ap.add_argument("--resize", default=None,
                    help="frame size as W,H (needs --crop)")
    ap.add_argument("--label", default="", help="label for the report")
    args = ap.parse_args()

    video = Path(args.video).resolve()
    if not video.exists():
        print(f"video not found: {video}", file=sys.stderr)
        return 2
    seconds = [int(s) for s in args.seconds.split(",") if s.strip()]
    if not seconds:
        print("no seconds given", file=sys.stderr)
        return 2
    vw, vh = parse_pair(args.viewport.replace("x", ","), "--viewport")
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    crop = parse_quad(args.crop, "--crop") if args.crop else None
    resize = parse_pair(args.resize.replace("x", ","), "--resize") if args.resize else None
    if resize and not crop:
        print("--resize needs --crop", file=sys.stderr)
        return 2

    if crop:
        cx, cy, cw, ch = crop
        box_css = (f"left:{cx / vw * 100:.3f}%;top:{cy / vh * 100:.3f}%;"
                   f"width:{cw / vw * 100:.3f}%;aspect-ratio:{cw} / {ch};")
    else:
        box_css = "left:0;top:0;width:100%;height:100%;"

    uri = video.as_uri()
    shots_html = ""
    for sec in seconds:
        shots_html += (f'  <div class="shot" id="shot-{sec}s">'
                       f'<video src="{uri}#t={sec}" muted preload="auto">'
                       f'</video></div>\n')
    page_path = out / "player.html"
    page_path.write_text(f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Player pass</title>
<style>
  html, body {{ margin: 0; padding: 0; background: #000; width: 100%; height: 100%; overflow: hidden; }}
  .shot {{ display: none; position: absolute; {box_css} }}
  .shot:target {{ display: block; }}
  video {{ width: 100%; height: 100%; object-fit: fill; background: #000; display: block; }}
</style></head><body>
{shots_html}</body></html>
""")

    report = {"label": args.label, "video": str(video), "seconds": seconds,
              "viewport": [vw, vh], "crop": crop, "resize": resize, "shots": {}}
    failed = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": vw, "height": vh})
        for sec in seconds:
            shot = f"shot-{sec}s"
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
                path = out / f"shot-{sec}.png"
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
            entry = {"file": f"shot-{sec}.png", "bytes": size,
                     "current_time": info["currentTime"],
                     "mean_luma": lum}
            if crop and resize:
                frame = Image.open(path).convert("RGB")
                assert frame.size == (vw, vh), (sec, frame.size)
                cx, cy, cw, ch = crop
                frame = frame.crop((cx, cy, cx + cw, cy + ch)).resize(tuple(resize), Image.LANCZOS)
                fpath = out / f"frame-{sec}.png"
                frame.save(fpath)
                entry["frame"] = f"frame-{sec}.png"
                entry["frame_bytes"] = fpath.stat().st_size
            report["shots"][sec] = entry
            print(f"{sec}s: {entry}", flush=True)
        browser.close()

    (out / "player-pass-report.json").write_text(json.dumps(report, indent=1))
    if failed:
        print(f"FAILED seconds: {failed}", file=sys.stderr)
        return 1
    print(f"PLAYER PASS OK: {len(seconds)} shots in {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
