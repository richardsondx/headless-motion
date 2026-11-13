#!/usr/bin/env python3
"""Chroma-key cutout for flat-vector character sheets.

Cut a character sheet drawn on a solid flat green (#00B140) or
magenta (#FF00FF) background into transparent sprites, and measure
the rig the headless rig needs. This is the infographic rig's
cutout rule, not the photo cutout in tools/cutout.py (U2Net, for
photos). Flat sheets have a solid flat background, so a colour rule
plus border flood is the right tool, and it runs on Pillow + numpy
only, with no model download and no cv2.

Rules, from the spec:
- Background is every border-connected pixel with, for green,
  G - max(R,B) over 40 and within 110 of the median border green.
  For magenta the mirror rule is min(R,B) - G over 40 and within
  110 of the median border magenta. Key only from the border, or
  dark clothes inside the figure leak.
- Add a 2 px soft alpha band and clamp G to max(R,B) + 6 inside it,
  which kills the fringe. (For magenta, clamp min(R,B) to G + 6.)
- Group the pieces by figure and drop specks. Name every sprite,
  and write a named contact sheet.

Head split (armless front figures become puppets):
- Split the head at the neck: the narrowest alpha row under the
  head, searched in the top 15-45% of the largest figure, accepted
  only when it is under 75% of the widest head row above it.
- Inpaint the hole under the head from the body's own colours: the
  top rows of the body sprite are filled with the median colour of
  the body's top 5 opaque rows, so a nod never shows a gap.
- Shoulder sockets are measured, not guessed: at neck + 12% of
  figure height, the leftmost and rightmost opaque pixels.
- Eye boxes, skin RGB and sleeve RGB are NOT measured here. The
  alpha channel alone cannot tell an eye from a dark patch, and
  this tool does not invent them. The report says null for those
  fields, with the reason, instead of a made-up box.

Usage:
  python3 src/rig/cutout.py INPUT.png --out-dir DIR [--chroma green|magenta|auto]
Writes DIR/<stem>-cut.png (RGBA), DIR/<stem>-rig.json,
DIR/<stem>-head.png and DIR/<stem>-body.png when a neck is found,
one DIR/<stem>-figure-NN.png per figure, and
DIR/<stem>-contact-sheet.png. Exit 0 on success, 1 on a bad input,
2 on usage. Deterministic: same input bytes give same output bytes
for the PNGs up to the PNG encoder, and identical rig JSON.
"""
import argparse
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def dilate4(mask):
    """One 4-neighbour dilation of a bool array."""
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out


def border_connected(candidate):
    """Flood from every border pixel through candidate pixels only.

    Vectorised dilation loop: the region grows 1 px per pass, so a
    1920 px image needs at most ~1000 passes in the worst case and
    far fewer in practice (the background touches the border).
    """
    h, w = candidate.shape
    region = np.zeros_like(candidate)
    region[0, :] = candidate[0, :]
    region[-1, :] = candidate[-1, :]
    region[:, 0] |= candidate[:, 0]
    region[:, -1] |= candidate[:, -1]
    while True:
        grown = dilate4(region) & candidate & ~region
        if not grown.any():
            return region
        region |= grown


def label_components(mask):
    """Label 4-connected components of a bool mask.

    Returns (labels int array, count). One dilation loop per
    component; sheets hold a handful of figures, so this stays fast.
    """
    labels = np.zeros(mask.shape, dtype=np.int32)
    remaining = mask.copy()
    count = 0
    while remaining.any():
        count += 1
        ys, xs = np.nonzero(remaining)
        seed = np.zeros_like(mask)
        seed[ys[0], xs[0]] = True
        region = seed.copy()
        while True:
            grown = dilate4(region) & remaining & ~region
            if not grown.any():
                break
            region |= grown
        labels[region] = count
        remaining &= ~region
    return labels, count


def median_border_rgb(rgb):
    border = np.concatenate([
        rgb[0, :, :], rgb[-1, :, :], rgb[:, 0, :], rgb[:, -1, :],
    ])
    return np.median(border, axis=0)


def chroma_candidate(rgb, chroma):
    """Background-candidate mask plus the median border colour."""
    med = median_border_rgb(rgb)
    r = rgb[:, :, 0].astype(np.int32)
    g = rgb[:, :, 1].astype(np.int32)
    b = rgb[:, :, 2].astype(np.int32)
    if chroma == "green":
        score = g - np.maximum(r, b)
        within = (
            (np.abs(g - med[1]) <= 110)
            & (np.abs(r - med[0]) <= 110)
            & (np.abs(b - med[2]) <= 110)
        )
    else:
        score = np.minimum(r, b) - g
        within = (
            (np.abs(r - med[0]) <= 110)
            & (np.abs(g - med[1]) <= 110)
            & (np.abs(b - med[2]) <= 110)
        )
    return (score > 40) & within, med


def detect_chroma(rgb):
    """Auto pick green or magenta by which border median is closer."""
    med = median_border_rgb(rgb)
    green = np.array([0, 177, 64], dtype=float)
    magenta = np.array([255, 0, 255], dtype=float)
    d_green = float(np.sum((med - green) ** 2))
    d_magenta = float(np.sum((med - magenta) ** 2))
    return "green" if d_green <= d_magenta else "magenta"


def soft_band(alpha_bg, radius=2):
    """Foreground pixels within `radius` px of keyed background."""
    band = alpha_bg.copy()
    for _ in range(radius):
        band = dilate4(band)
    return band & ~alpha_bg


def measure_figure(alpha, label_mask):
    """Neck row, sockets and bbox for one figure's alpha mask."""
    ys, xs = np.nonzero(label_mask)
    if len(ys) == 0:
        return None
    top, bottom = int(ys.min()), int(ys.max())
    left, right = int(xs.min()), int(xs.max())
    height = bottom - top + 1
    widths = []
    for y in range(top, bottom + 1):
        row = label_mask[y, :]
        widths.append(int(row.sum()))
    widths = np.array(widths)
    # Neck search: top 15-45% of the figure.
    lo = int(height * 0.15)
    hi = int(height * 0.45)
    neck = None
    if hi > lo:
        zone = widths[lo:hi]
        rel = int(np.argmin(zone))
        neck_y = top + lo + rel
        head_max = int(widths[: lo + rel].max()) if lo + rel > 0 else 0
        if head_max > 0 and int(zone[rel]) < 0.75 * head_max:
            neck = neck_y
    sockets = None
    if neck is not None:
        sy = min(bottom, neck + int(height * 0.12))
        row = np.nonzero(label_mask[sy, :])[0]
        if len(row):
            sockets = {
                "left": {"x": int(row.min()), "y": int(sy)},
                "right": {"x": int(row.max()), "y": int(sy)},
            }
    return {
        "bbox": {"x": left, "y": top, "w": right - left + 1, "h": height},
        "neck_y": neck,
        "sockets": sockets,
        "median_rgb": None,
    }


def cutout(input_path, out_dir, chroma="auto"):
    img = Image.open(input_path).convert("RGB")
    rgb = np.array(img)
    h, w, _ = rgb.shape
    if chroma == "auto":
        chroma = detect_chroma(rgb)
    candidate, med = chroma_candidate(rgb, chroma)
    background = border_connected(candidate)
    foreground = ~background
    alpha = np.where(foreground, 255, 0).astype(np.uint8)
    # 2 px soft band: half alpha, and clamp the chroma channel so
    # the fringe cannot stay green / magenta.
    band = soft_band(background, radius=2)
    alpha[band] = 128
    rgb_out = rgb.copy()
    if chroma == "green":
        cap = np.maximum(rgb[:, :, 0], rgb[:, :, 2]).astype(np.int32) + 6
        g = rgb[:, :, 1].astype(np.int32)
        rgb_out[:, :, 1] = np.where(band, np.minimum(g, cap), g).astype(np.uint8)
    else:
        cap = rgb[:, :, 1].astype(np.int32) + 6
        for ch in (0, 2):
            c = rgb[:, :, ch].astype(np.int32)
            rgb_out[:, :, ch] = np.where(band, np.minimum(c, cap), c).astype(np.uint8)
    # Group by figure, drop specks: under 200 px, or under 0.5% of
    # the largest figure, whichever is smaller in absolute px.
    labels, ncomp = label_components(foreground)
    areas = [(int((labels == i).sum()), i) for i in range(1, ncomp + 1)]
    areas.sort(reverse=True)
    largest = areas[0][0] if areas else 0
    speck_max = min(200, int(0.005 * largest))
    kept = []
    dropped = 0
    for area, idx in areas:
        if area <= speck_max:
            dropped += 1
            alpha[labels == idx] = 0
            continue
        kept.append((area, idx))
    kept.sort(reverse=True)
    rgba = np.dstack([rgb_out, alpha])
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(input_path).stem
    Image.fromarray(rgba, "RGBA").save(out / f"{stem}-cut.png")
    figures = []
    for n, (area, idx) in enumerate(kept, start=1):
        mask = labels == idx
        sprite = np.zeros((h, w, 4), dtype=np.uint8)
        sprite[mask] = rgba[mask]
        ys, xs = np.nonzero(mask)
        crop = sprite[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]
        Image.fromarray(crop, "RGBA").save(out / f"{stem}-figure-{n:02d}.png")
        meas = measure_figure(alpha, mask)
        # Median RGB of the figure's opaque pixels.
        px = rgb[mask]
        meas["median_rgb"] = [int(v) for v in np.median(px, axis=0)] if len(px) else None
        figures.append({
            "name": f"figure-{n:02d}",
            "file": f"{stem}-figure-{n:02d}.png",
            "area_px": area,
            "bbox": meas["bbox"],
            "neck_y": meas["neck_y"],
            "sockets": meas["sockets"],
            "median_rgb": meas["median_rgb"],
        })
    # Head / body split for the largest figure, when a neck was found.
    head_file = body_file = None
    neck_y = figures[0]["neck_y"] if figures else None
    if figures and neck_y is not None:
        mask = labels == kept[0][1]
        head = np.zeros((h, w, 4), dtype=np.uint8)
        head[:neck_y, :] = rgba[:neck_y, :]
        head[~mask] = 0
        body = np.zeros((h, w, 4), dtype=np.uint8)
        body[neck_y:, :] = rgba[neck_y:, :]
        body[~mask] = 0
        # Inpaint the hole under the head: fill the top 8 body rows
        # inside the body bbox with the median colour of the body's
        # top 5 opaque rows, so a nod never shows a gap.
        ys, xs = np.nonzero(mask[neck_y:, :])
        if len(ys):
            top_rows = rgb[neck_y: neck_y + 5, :][mask[neck_y: neck_y + 5, :]]
            fill = np.median(top_rows, axis=0) if len(top_rows) else np.array([0, 0, 0])
            bx0, bx1 = int(xs.min()), int(xs.max())
            for y in range(neck_y, min(h, neck_y + 8)):
                row_mask = mask[y, bx0: bx1 + 1]
                body[y, bx0: bx1 + 1, 0:3][row_mask] = fill
                body[y, bx0: bx1 + 1, 3][row_mask] = 255
        Image.fromarray(head, "RGBA").save(out / f"{stem}-head.png")
        Image.fromarray(body, "RGBA").save(out / f"{stem}-body.png")
        head_file, body_file = f"{stem}-head.png", f"{stem}-body.png"
    # Named contact sheet: sprites on white, name + size under each.
    sheet = Image.new("RGB", (max(320, w), h + 60), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    sheet.paste(Image.fromarray(rgba, "RGBA"), (0, 0), Image.fromarray(rgba, "RGBA"))
    y = h + 8
    for f in figures:
        draw.text((8, y), f"{f['name']}  {f['bbox']['w']}x{f['bbox']['h']}  area {f['area_px']} px", fill=(0, 0, 0))
        y += 16
    sheet.save(out / f"{stem}-contact-sheet.png")
    report = {
        "input": str(input_path),
        "size": {"w": int(w), "h": int(h)},
        "chroma": chroma,
        "median_border_rgb": [int(v) for v in med],
        "background_px": int(background.sum()),
        "foreground_px": int(foreground.sum()),
        "figures": figures,
        "specks_dropped": dropped,
        "head_file": head_file,
        "body_file": body_file,
        "cut_file": f"{stem}-cut.png",
        "contact_sheet": f"{stem}-contact-sheet.png",
        # Not measured by this tool; see the header. Null, not invented.
        "eye_boxes": None,
        "eye_boxes_reason": "alpha alone cannot tell an eye from a dark patch",
        "skin_rgb": None,
        "skin_rgb_reason": "no skin detector in this tool",
        "sleeve_rgb": None,
        "sleeve_rgb_reason": "no sleeve detector in this tool",
    }
    with open(out / f"{stem}-rig.json", "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
        fh.write("\n")
    return report


def main(argv):
    ap = argparse.ArgumentParser(description="Chroma-key cutout for flat-vector character sheets.")
    ap.add_argument("input", help="sheet image on solid green #00B140 or magenta #FF00FF")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--chroma", choices=["green", "magenta", "auto"], default="auto")
    args = ap.parse_args(argv)
    if not Path(args.input).exists():
        print(f"CUTOUT_INPUT_MISSING {args.input}", file=sys.stderr)
        return 1
    report = cutout(args.input, args.out_dir, args.chroma)
    print(json.dumps({
        "chroma": report["chroma"],
        "figures": len(report["figures"]),
        "specks_dropped": report["specks_dropped"],
        "neck_y": report["figures"][0]["neck_y"] if report["figures"] else None,
        "cut_file": report["cut_file"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
