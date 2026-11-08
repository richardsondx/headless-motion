"""Build ref-vs-v4 comparison sheet for Seg4. Reads only, writes one PNG."""
from PIL import Image, ImageDraw, ImageFont
import os

SNAP = "/home/hatch/workspace/.hatch-browser/snapshots/browser-task:d5ac3948-baa1-5449-be87-04f0d2cff1cc"
EVID = "/home/hatch/workspace/headless-motion-engine/verify-seg4/evidence"
OUT = os.path.join(EVID, "ref-vs-v4-sheet.png")

REFS = [
    ("REAL  0:01  October 2025, Sudan teal", "20261107T223659.250490710Z/look.3.png"),
    ("REAL  0:04  RSF badge lands", "20261107T223727.863904210Z/look.3.png"),
    ("REAL  0:07  EL FASHER, dot, no ring", "20261107T223332.051888320Z/look.3.png"),
]
V4S = [
    ("OURS v4  1s  coral flood, no title", "v4-f24.png"),
    ("OURS v4  5s  ring, wrong colours", "v4-f120.png"),
    ("OURS v4  9s  map held, real cuts at 0:08", "v4-f216.png"),
]

PLAYER = (185, 55, 1717, 885)  # x0, y0, x1, y1 in screenshot px
CELL_W, CELL_H, LABEL_H, GAP = 480, 270, 34, 12
TITLE_H = 54

try:
    font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 30)
    font_label = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 17)
except Exception:
    font_title = ImageFont.load_default()
    font_label = ImageFont.load_default()

def prep_ref(path):
    im = Image.open(path).crop(PLAYER)
    im.thumbnail((CELL_W, CELL_H))
    cell = Image.new("RGB", (CELL_W, CELL_H), (0, 0, 0))
    cell.paste(im, ((CELL_W - im.width) // 2, (CELL_H - im.height) // 2))
    return cell

def prep_v4(path):
    im = Image.open(path)
    im.thumbnail((CELL_W, CELL_H))
    cell = Image.new("RGB", (CELL_W, CELL_H), (0, 0, 0))
    cell.paste(im, ((CELL_W - im.width) // 2, (CELL_H - im.height) // 2))
    return cell

W = GAP * 4 + CELL_W * 3
H = TITLE_H + (CELL_H + LABEL_H) * 2 + GAP * 3
sheet = Image.new("RGB", (W, H), (24, 24, 24))
d = ImageDraw.Draw(sheet)
d.text((GAP, 12), "Seg4: real opening vs our v4 clone", fill=(255, 255, 255), font=font_title)

for row, items, prep in ((0, REFS, prep_ref), (1, V4S, prep_v4)):
    y = TITLE_H + row * (CELL_H + LABEL_H + GAP)
    for col, (label, fname) in enumerate(items):
        x = GAP + col * (CELL_W + GAP)
        path = os.path.join(SNAP, fname) if prep is prep_ref else os.path.join(EVID, fname)
        sheet.paste(prep(path), (x, y))
        d.rectangle([x, y + CELL_H, x + CELL_W, y + CELL_H + LABEL_H], fill=(0, 0, 0))
        d.text((x + 6, y + CELL_H + 8), label, fill=(255, 255, 255), font=font_label)

sheet.save(OUT)
print("wrote", OUT, sheet.size, os.path.getsize(OUT) // 1024, "KB")
