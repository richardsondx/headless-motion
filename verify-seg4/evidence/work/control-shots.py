"""Control screenshots, local route.

Opens the local control player page (file://) in Playwright Chromium at the
exact 1919x1497 window the reference screenshots used, seeks each of the 8
shots via its URL fragment, and takes a full-window PNG per shot.

Writes to verify-seg4/evidence/work/control-shots/<shot>.png. Verifies each
file is non-empty (the exec write gate can produce 0-byte files) and retries
a shot once. Prints currentTime and mean luminance per shot so a blank or
wrong frame is visible in the log.
"""
import os
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

WORK = Path("/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence/work")
PAGE = WORK / "control-player.html"
OUT = WORK / "control-shots"
OUT.mkdir(parents=True, exist_ok=True)

SHOTS = [
    ("clean-1s", 1), ("clean-4s", 4), ("clean-5s", 5), ("clean-7s", 7),
    ("yt-1s", 1), ("yt-4s", 4), ("yt-5s", 5), ("yt-7s", 7),
]

def shot_once(page, shot, target):
    url = PAGE.as_uri() + "#" + shot
    page.goto(url, wait_until="load")
    page.wait_for_timeout(1500)
    # Wait until the visible video has data and sits at the target second.
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
    path = OUT / f"control-{shot}.png"
    page.screenshot(path=str(path), full_page=False)
    size = path.stat().st_size if path.exists() else 0
    lum = None
    if size > 0:
        lum = round(sum(Image.open(path).convert("L").resize((64, 64)).getdata()) / 4096, 1)
    print(f"{shot}: {info} bytes={size} mean_luma={lum}", flush=True)
    return size > 0 and info["readyState"] >= 2

def main():
    failed = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1919, "height": 1497})
        for shot, target in SHOTS:
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
    print("ALL 8 SHOTS OK", flush=True)

if __name__ == "__main__":
    main()
