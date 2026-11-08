#!/usr/bin/env python3
"""Build a STYLE comparison sheet (not a pixel-clone sheet).

Left: the video's maxres thumbnail (the only verified frame of this video we hold).
Right: clone stills at 1s / 5s / 9s, same scale.
Every cell is labelled with its source. The thumbnail is a title card, not an
opening frame, so this sheet proves register / palette / typography direction,
never a pixel match. A pixel-clone sheet needs the opening reference video;
see refs/PROVENANCE.md.
Usage: build-style-sheet.py <thumb.jpg> <still1.png> <still5.png> <still9.png> <out.png>
"""
import sys
from PIL import Image, ImageDraw

thumb, s1, s5, s9, out = sys.argv[1:6]
CELL_W, CELL_H = 960, 540

def load(p, label):
    im = Image.open(p).convert("RGB").resize((CELL_W, CELL_H))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, CELL_W, 34], fill=(20, 33, 61))
    d.text((10, 8), label, fill=(255, 255, 255))
    return im

rows = [
    (load(thumb, "REF: video thumbnail (title card, NOT opening frame)"), load(s1, "CLONE v4: 1s")),
    (load(thumb, "REF: video thumbnail (title card, NOT opening frame)"), load(s5, "CLONE v4: 5s")),
    (load(thumb, "REF: video thumbnail (title card, NOT opening frame)"), load(s9, "CLONE v4: 9s")),
]
sheet = Image.new("RGB", (CELL_W * 2, CELL_H * 3), (255, 255, 255))
for i, (l, r) in enumerate(rows):
    sheet.paste(l, (0, i * CELL_H))
    sheet.paste(r, (CELL_W, i * CELL_H))
sheet.save(out)
print(f"wrote {out} {sheet.size}")
