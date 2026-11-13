#!/usr/bin/env python3
"""Build the frame 184 2x2 comparison grid.
Top-left Reference (frame 184), top-right GPT Image 2.6 Flare, bottom-left Terra 6.1,
bottom-right Fable 5.2.
Title "Frame 184. Same prompt. Four models." Dark #1B073B background.
Panels fit into 768x512 cells, letterboxed, nothing cropped.
Usage: python3 build_grid_frame184.py
"""
from PIL import Image, ImageDraw, ImageFont

OUT = "/home/hatch/workspace/handover-frame-style-prompt-fix6/frame184-comparison/"
BG = (27, 7, 59)
WHITE = (255, 255, 255)
LIGHT = (208, 221, 245)
MUTED = (150, 150, 180)
ORANGE = (231, 115, 58)

W, H = 1608, 1320
CELL_W, CELL_H = 768, 512
MARGIN = 24
GAP = 24
TITLE_Y = 28
LABEL_H = 44
LABEL_GAP = 8


def font(size, bold=True):
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
                 else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                 "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf" if bold
                 else "/usr/share/fonts/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def fit_into(img, w, h):
    """Letterbox img into w x h on the dark background, nothing cropped."""
    iw, ih = img.size
    scale = min(w / iw, h / ih)
    nw, nh = max(1, int(iw * scale)), max(1, int(ih * scale))
    resized = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (w, h), BG)
    canvas.paste(resized, ((w - nw) // 2, (h - nh) // 2))
    return canvas


def unavailable_panel():
    """Fable 5.2 panel: no image was generated, credits exhausted."""
    panel = Image.new("RGB", (CELL_W, CELL_H), (38, 17, 75))
    d = ImageDraw.Draw(panel)
    d.rectangle([2, 2, CELL_W - 3, CELL_H - 3], outline=MUTED, width=2)
    f_big = font(40)
    f_mid = font(28)
    f_small = font(22, bold=False)
    d.text((CELL_W // 2, 120), "FABLE 5.2", font=f_big, fill=WHITE, anchor="mm")
    d.text((CELL_W // 2, 175), "UNAVAILABLE", font=f_mid, fill=ORANGE, anchor="mm")
    lines = [
        "OpenRouter credits exhausted.",
        "Used $335.04 of $335 in credits.",
        "The model 402d at 800 max tokens.",
        "No image was generated.",
    ]
    y = 240
    for line in lines:
        d.text((CELL_W // 2, y), line, font=f_small, fill=LIGHT, anchor="mm")
        y += 36
    return panel


def main():
    grid = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(grid)
    d.text((MARGIN, TITLE_Y), "Frame 184. Same prompt. Four models.",
           font=font(44), fill=WHITE)

    ref = Image.open("/home/hatch/workspace/handover-frame-style-prompt-fix2/reference-frame-shot3.png").convert("RGB")
    spark = Image.open(OUT + "muse-spark-frame184.png").convert("RGB")
    terra = Image.open(OUT + "terra-6.1-frame184.png").convert("RGB")
    fable = Image.open(OUT + "fable-5.2-frame184.png").convert("RGB")

    panels = [
        (ref, "REFERENCE", "Kurzgesagt frame 184"),
        (spark, "GPT IMAGE 2.6 FLARE", "$0.034"),
        (terra, "TERRA 6.1", "SVG text model  \u00b7  $0.013"),
        (fable, "FABLE 5.2", "SVG text model  \u00b7  $0.21"),
    ]
    xs = [MARGIN, MARGIN + CELL_W + GAP]
    ys = [100, 100 + LABEL_H + LABEL_GAP + CELL_H + GAP]
    f_name = font(32)
    f_desc = font(24, bold=False)
    for i, (img, name, desc) in enumerate(panels):
        x = xs[i % 2]
        y = ys[i // 2]
        d.text((x, y), name, font=f_name, fill=WHITE)
        dw = d.textlength(desc, font=f_desc)
        d.text((x + CELL_W - dw, y + 6), desc, font=f_desc, fill=LIGHT)
        cell = fit_into(img, CELL_W, CELL_H)
        grid.paste(cell, (x, y + LABEL_H + LABEL_GAP))

    out_path = OUT + "comparison-4grid-frame184.png"
    grid.save(out_path)
    print("saved", out_path, grid.size)


if __name__ == "__main__":
    main()
