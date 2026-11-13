#!/usr/bin/env python3
"""Build the frame 184 Flare vs Sunburst 3-panel comparison.
Left Reference (frame 184), middle GPT Image 2.6 Flare, right GPT Image 2.6 Sunburst.
Title "Frame 184. Flare vs Sunburst. Same prompt." Dark #1B073B background.
Panels fit into 768x512 cells, letterboxed, nothing cropped.
Usage: python3 build_grid_flare_vs_sunburst.py
"""
from PIL import Image, ImageDraw, ImageFont

OUT = "/home/hatch/workspace/handover-frame-style-prompt-fix6/frame184-comparison/"
BG = (27, 7, 59)
WHITE = (255, 255, 255)
LIGHT = (208, 221, 245)

W, H = 2400, 688
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


def main():
    grid = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(grid)
    d.text((MARGIN, TITLE_Y), "Frame 184. Flare vs Sunburst. Same prompt.",
           font=font(44), fill=WHITE)

    ref = Image.open("/home/hatch/workspace/handover-frame-style-prompt-fix2/reference-frame-shot3.png").convert("RGB")
    spark = Image.open(OUT + "muse-spark-frame184.png").convert("RGB")
    sunburst = Image.open(OUT + "gpt-image-2.6-sunburst-frame184.png").convert("RGB")

    panels = [
        (ref, "REFERENCE", "Kurzgesagt frame 184"),
        (spark, "GPT IMAGE 2.6 FLARE", "$0.034"),
        (sunburst, "GPT IMAGE 2.6 SUNBURST", "$0.034"),
    ]
    xs = [MARGIN, MARGIN + CELL_W + GAP, MARGIN + 2 * (CELL_W + GAP)]
    y = 100
    f_name = font(32)
    f_desc = font(24, bold=False)
    for i, (img, name, desc) in enumerate(panels):
        x = xs[i]
        d.text((x, y), name, font=f_name, fill=WHITE)
        dw = d.textlength(desc, font=f_desc)
        d.text((x + CELL_W - dw, y + 6), desc, font=f_desc, fill=LIGHT)
        cell = fit_into(img, CELL_W, CELL_H)
        grid.paste(cell, (x, y + LABEL_H + LABEL_GAP))

    out_path = OUT + "comparison-flare-vs-sunburst-frame184.png"
    grid.save(out_path)
    print("saved", out_path, grid.size)


if __name__ == "__main__":
    main()
