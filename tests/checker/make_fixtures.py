"""Seeded synthetic fixtures for the frame checker. Frames are drawn with
PIL (exact control, no filter-expression quirks) and piped to ffmpeg.

Run: python tests/checker/make_fixtures.py
"""
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures"
FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
W, H, FPS, FRAMES = 1920, 1080, 3, 30
PAPER = (244, 241, 234)
NAVY = (20, 33, 61)
NAVY_OFF = (37, 53, 92)
RED = (230, 57, 70)


def draw_frame(f, *, navy=NAVY, square_x=None, label_x=200, g_x=900, black=False):
    img = Image.new("RGB", (W, H), (0, 0, 0) if black else PAPER)
    if black:
        return img
    d = ImageDraw.Draw(img)
    d.rectangle([200, 200, 600, 400], fill=navy)
    x = 800 if square_x is None else square_x
    d.rectangle([x, 500, x + 120, 620], fill=RED)
    font = ImageFont.truetype(FONT, 96)
    d.text((label_x, 650), "GLUE", font=font, fill=(255, 255, 255))
    d.text((g_x, 650), "G", font=font, fill=(255, 255, 255))
    return img


def encode(out_path, frames):
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-frames:v", str(FRAMES), "-c:v", "libx264", "-pix_fmt", "yuv420p",
           "-crf", "18", str(out_path)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for img in frames:
        proc.stdin.write(img.tobytes())
    proc.stdin.close()
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {out_path}")


def report(out_dir, profile):
    (out_dir / "render-report.json").write_text(json.dumps({"profile": profile}) + "\n")


def clip(name, frames, profile="final"):
    d = OUT / name
    d.mkdir(parents=True, exist_ok=True)
    encode(d / "video.mp4", frames)
    report(d, profile)


def base_frames(**kw):
    return [draw_frame(f, square_x=800 + 2 * f, **kw) for f in range(FRAMES)]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    encode(OUT / "ref.mp4", base_frames())
    clip("identical", base_frames())
    clip("shifted", base_frames(label_x=203))
    clip("coloroff", base_frames(navy=NAVY_OFF))
    clip("noevent", [draw_frame(f, square_x=800) for f in range(FRAMES)])
    clip("movedlabel", base_frames(g_x=940))
    frames = base_frames()
    frames[15] = draw_frame(15, black=True)
    clip("onebad", frames)
    clip("draft", base_frames(), profile="draft")
    cfg = {
        "id": "seg3", "ref_start_frame": 0, "fps": FPS,
        "flat_regions": [{"id": "navy-box", "rect": [200, 200, 400, 200], "frames": [0, 15, 29]}],
        "events": [{"id": "square-move", "rect": [780, 480, 280, 160], "window": [5, 25]}],
        "labels": [{"id": "glue", "rect": [180, 630, 340, 140], "frames": [0, 15, 29], "text": "GLUE"},
                     {"id": "g", "rect": [880, 630, 120, 140], "frames": [0, 15, 29], "text": "G"}],
        "targets": [{"id": "glue-target", "rect": [180, 630, 340, 140], "frames": [0, 15, 29]}],
    }
    (OUT / "seg3-test.json").write_text(json.dumps(cfg, indent=2) + "\n")
    print("fixtures written to", OUT)


if __name__ == "__main__":
    main()
