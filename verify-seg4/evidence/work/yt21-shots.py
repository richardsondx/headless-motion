"""Screenshot the yt21 control shots with the system Python (Playwright
lives there, not in the engine venv). Page was written by recalibrate.py.
Run: python3 yt21-shots.py
"""
from pathlib import Path

from playwright.sync_api import sync_playwright

WORK = Path("/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence/work")
PAGE = WORK / "control-player-yt21.html"
SHOTS = WORK / "control-shots"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1919, "height": 1497})
    for sec in (1, 4, 5, 7):
        shot = f"yt21-{sec}s"
        page.goto(PAGE.as_uri() + "#" + shot, wait_until="load")
        page.wait_for_timeout(1500)
        try:
            page.wait_for_function(
                """([shot, target]) => {
                    const v = document.getElementById(shot).querySelector('video');
                    return v && v.readyState >= 2 && Math.abs(v.currentTime - target) < 0.15;
                }""", arg=[shot, sec], timeout=15000)
        except Exception:
            print(f"{shot}: seek wait timed out", flush=True)
        page.wait_for_timeout(500)
        path = SHOTS / f"control-{shot}.png"
        page.screenshot(path=str(path), full_page=False)
        print(f"{shot}: bytes={path.stat().st_size}", flush=True)
    browser.close()
print("YT21 SHOTS DONE", flush=True)
