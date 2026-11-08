#!/usr/bin/env python3
"""Measure flat-region palette from a frame image. 21x21 median samples.
Usage: measure-palette.py <image> <x,y,label> ...
Prints label, hex. No eyeballed hexes: every number comes from the pixels.
"""
import sys
from PIL import Image

def med(img, x, y, s=21):
    px = []
    for dy in range(-s // 2, s // 2 + 1, 3):
        for dx in range(-s // 2, s // 2 + 1, 3):
            xx = min(max(x + dx, 0), img.width - 1)
            yy = min(max(y + dy, 0), img.height - 1)
            px.append(img.getpixel((xx, yy)))
    px.sort()
    c = px[len(px) // 2]
    return "#%02X%02X%02X" % c[:3]

if __name__ == "__main__":
    img = Image.open(sys.argv[1]).convert("RGB")
    print(f"{sys.argv[1]} {img.size}")
    for spec in sys.argv[2:]:
        x, y, label = spec.rsplit(",", 2) if spec.count(",") == 2 else (None, None, spec)
        # spec format: label:x,y
        label, xy = spec.split(":", 1)
        x, y = map(int, xy.split(","))
        print(f"{label} {med(img, x, y)}")
