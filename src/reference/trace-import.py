#!/usr/bin/env python3
"""Convert a traced SVG (one <path> per flat colour layer) into engine scene nodes.

Each SVG path becomes one shape node of kind "path": the SVG path data
becomes the node `d`, the SVG fill becomes the node fill, coordinates are
rebased to box-local px, and document order becomes the stacking order
(node `z`). No engine file is changed and the scene schema is untouched.

Why the converter exists: VTracer turns a flat illustration crop into
stacked SVG paths, but the engine renders scene JSON, not SVG. This file
bridges the two without touching the renderer.

Usage:
    python trace-import.py monster-trace.svg --out monster-scene.json
    python trace-import.py monster-trace.svg --out -   # scene JSON on stdout
    python trace-import.py skulls-trace.svg --out skulls-scene.json \\
        --crop 275,215 --source-size 640x360

Placement: the source crop sits at (--crop x, y) inside a source frame of
--source-size. The scene stage is 1920x1080, so coordinates scale by
1920 / source-width (3.0 for a 640x360 source). Pass --scale to override
the computed scale, and --origin-x / --origin-y to place the crop
directly in stage px instead of deriving it from --crop.

Fallback note: if a trace renders below SSIM 0.90, this converter is not
the fix. The named fallbacks are Potrace one-mask-per-colour first, then
a pixel cutout through the existing image node.
"""

import argparse
import json
import math
import re
import sys
import xml.etree.ElementTree as ET

STAGE_W = 1920
STAGE_H = 1080

# Minimal CSS named-colour table, for fills a tracer may emit as names.
# Hex fills (what VTracer emits) never touch this table.
NAMED_COLOURS = {
    "black": "#000000", "white": "#ffffff", "red": "#ff0000",
    "green": "#008000", "blue": "#0000ff", "yellow": "#ffff00",
    "orange": "#ffa500", "purple": "#800080", "pink": "#ffc0cb",
    "brown": "#a52a2a", "gray": "#808080", "grey": "#808080",
    "cyan": "#00ffff", "aqua": "#00ffff", "magenta": "#ff00ff",
    "fuchsia": "#ff00ff", "lime": "#00ff00", "navy": "#000080",
    "teal": "#008080", "olive": "#808000", "maroon": "#800000",
    "silver": "#c0c0c0",
}

HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
RGB_RE = re.compile(
    r"^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})"
    r"(?:\s*,\s*([0-9.]+))?\s*\)$"
)
TOKEN_RE = re.compile(
    r"[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?"
)
# How many coordinate pairs each command consumes per segment.
PAIR_COUNTS = {"M": 1, "L": 1, "C": 3, "S": 2, "Q": 2, "T": 1, "A": 1}


class TraceImportError(Exception):
    """Input the converter cannot map to scene nodes. Exit code 2."""


def fmt(n):
    """Short decimal: 3 places max, no trailing zeros, -0 becomes 0."""
    s = f"{round(float(n), 3):.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def normalise_fill(raw, where):
    """Map an SVG fill to a schema-legal fill: hex, 'none', or a palette name."""
    if raw is None:
        return "#000000"  # SVG default fill is black.
    v = raw.strip()
    if v == "none":
        return "none"
    if v.startswith("url("):
        raise TraceImportError(
            f"{where}: gradient fill {v!r} has no scene equivalent; "
            "trace with flat colours or use the pixel cutout fallback"
        )
    m = HEX_RE.match(v)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return "#" + h.upper()
    m = RGB_RE.match(v)
    if m:
        r, g, b = (int(m.group(i)) for i in (1, 2, 3))
        if max(r, g, b) > 255:
            raise TraceImportError(f"{where}: out-of-range fill {v!r}")
        return f"#{r:02X}{g:02X}{b:02X}"
    low = v.lower()
    if low in NAMED_COLOURS:
        return NAMED_COLOURS[low]
    if re.match(r"^[A-Za-z][A-Za-z0-9_-]*$", v):
        # A palette name the scene author defines; pass through unchanged.
        return v
    raise TraceImportError(f"{where}: fill {v!r} cannot map to a scene fill")


def parse_transform(text):
    """Return a 6-tuple affine (a, b, c, d, e, f) for translate/scale/matrix.

    SVG applies x' = a*x + c*y + e, y' = b*x + d*y + f. Only the forms
    VTracer and plain group nesting emit are supported; anything else is
    an explicit error, not a silent drop.
    """
    if not text:
        return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    result = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    for name, args in re.findall(r"(\w+)\(([^)]*)\)", text):
        nums = [float(x) for x in re.split(r"[,\s]+", args.strip()) if x]
        if name == "translate":
            if len(nums) == 1:
                nums.append(0.0)
            if len(nums) != 2:
                raise TraceImportError(f"bad translate transform: {text!r}")
            m = (1.0, 0.0, 0.0, 1.0, nums[0], nums[1])
        elif name == "scale":
            if len(nums) == 1:
                nums.append(nums[0])
            if len(nums) != 2:
                raise TraceImportError(f"bad scale transform: {text!r}")
            m = (nums[0], 0.0, 0.0, nums[1], 0.0, 0.0)
        elif name == "matrix":
            if len(nums) != 6:
                raise TraceImportError(f"bad matrix transform: {text!r}")
            m = tuple(nums)
        else:
            raise TraceImportError(
                f"unsupported transform {name!r} in {text!r}; "
                "flatten it to translate/scale/matrix first"
            )
        result = compose(result, m)
    return result


def compose(m1, m2):
    """Affine composition: apply m2 first, then m1 (SVG list order)."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def apply_affine(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def tokenise_d(d):
    """Split path data into (command, [numbers]) segments, commas ignored."""
    tokens = TOKEN_RE.findall(d.replace(",", " "))
    segments = []
    cur_cmd = None
    cur_nums = []
    for tok in tokens:
        if tok.isalpha():
            if cur_cmd is not None:
                segments.append((cur_cmd, cur_nums))
            cur_cmd = tok
            cur_nums = []
        else:
            if cur_cmd is None:
                raise TraceImportError(f"path data starts with a number: {d[:60]!r}")
            cur_nums.append(float(tok))
    if cur_cmd is not None:
        segments.append((cur_cmd, cur_nums))
    return segments


def normalise_segments(segments, where):
    """Rewrite path data as absolute M/L/C/Q/A/Z segments.

    H/V become L, S/T expand to C/Q with the reflected control point, and
    relative commands become absolute. Tracking the current point is what
    makes the later affine bake exact for every command form.
    """
    out = []
    cx = cy = 0.0
    sx = sy = 0.0
    px = py = None  # previous cubic control point, for S reflection
    qx = qy = None  # previous quadratic control point, for T reflection
    for cmd, nums in segments:
        upper = cmd.upper()
        rel = cmd.islower()
        if upper == "Z":
            out.append(("Z", []))
            cx, cy = sx, sy
            px = py = qx = qy = None
            continue
        if upper == "A":
            if len(nums) % 7:
                raise TraceImportError(f"{where}: arc segment needs 7 numbers")
            for i in range(0, len(nums), 7):
                rx, ry, rot, large, sweep, x, y = nums[i:i + 7]
                if rel:
                    x += cx
                    y += cy
                out.append(("A", [rx, ry, rot, large, sweep, x, y]))
                cx, cy = x, y
            px = py = qx = qy = None
            continue
        need = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2}[upper]
        if len(nums) % need:
            raise TraceImportError(
                f"{where}: {cmd} segment has {len(nums)} numbers, "
                f"not a multiple of {need}"
            )
        for i in range(0, len(nums), need):
            chunk = nums[i:i + need]
            if upper == "M":
                x, y = chunk
                if rel:
                    x += cx
                    y += cy
                out.append(("M", [x, y]))
                cx, cy = sx, sy = x, y
                # Extra M pairs are implicit lineto pairs.
                upper = "L"
                rel = False
            elif upper == "H":
                x = chunk[0] + (cx if rel else 0.0)
                out.append(("L", [x, cy]))
                cx = x
            elif upper == "V":
                y = chunk[0] + (cy if rel else 0.0)
                out.append(("L", [cx, y]))
                cy = y
            elif upper == "L":
                x, y = chunk
                if rel:
                    x += cx
                    y += cy
                out.append(("L", [x, y]))
                cx, cy = x, y
            elif upper == "C":
                x1, y1, x2, y2, x, y = chunk
                if rel:
                    x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy
                out.append(("C", [x1, y1, x2, y2, x, y]))
                px, py = x2, y2
                qx = qy = None
                cx, cy = x, y
            elif upper == "S":
                x2, y2, x, y = chunk
                if rel:
                    x2 += cx; y2 += cy; x += cx; y += cy
                if px is None:
                    x1, y1 = cx, cy
                else:
                    x1, y1 = 2 * cx - px, 2 * cy - py
                out.append(("C", [x1, y1, x2, y2, x, y]))
                px, py = x2, y2
                qx = qy = None
                cx, cy = x, y
            elif upper == "Q":
                x1, y1, x, y = chunk
                if rel:
                    x1 += cx; y1 += cy; x += cx; y += cy
                out.append(("Q", [x1, y1, x, y]))
                qx, qy = x1, y1
                px = py = None
                cx, cy = x, y
            elif upper == "T":
                x, y = chunk
                if rel:
                    x += cx; y += cy
                if qx is None:
                    x1, y1 = cx, cy
                else:
                    x1, y1 = 2 * cx - qx, 2 * cy - qy
                out.append(("Q", [x1, y1, x, y]))
                qx, qy = x1, y1
                px = py = None
                cx, cy = x, y
            else:
                raise TraceImportError(f"{where}: unsupported path command {cmd!r}")
    return out


def bake_segments(segments, m, where):
    """Apply the affine transform to absolute segments, return (d, bbox).

    Bbox uses control points, which bound every cubic and quadratic curve,
    so the box always contains the rendered path.
    """
    a, b, c, d, e, f = m
    uniform = math.isclose(abs(a), abs(d)) and math.isclose(b, 0.0) and math.isclose(c, 0.0)
    parts = []
    min_x = min_y = math.inf
    max_x = max_y = -math.inf

    def point(x, y):
        nonlocal min_x, min_y, max_x, max_y
        x2, y2 = apply_affine(m, x, y)
        min_x = min(min_x, x2)
        min_y = min(min_y, y2)
        max_x = max(max_x, x2)
        max_y = max(max_y, y2)
        return x2, y2

    for cmd, nums in segments:
        if cmd == "Z":
            parts.append("Z")
            continue
        if cmd == "A":
            rx, ry, rot, large, sweep, x, y = nums
            if not uniform:
                raise TraceImportError(
                    f"{where}: arc under a non-uniform transform cannot "
                    "be baked exactly; flatten the arc first"
                )
            x2, y2 = point(x, y)
            scale = abs(a)
            parts.append(
                "A" + " ".join([fmt(rx * scale), fmt(ry * scale), fmt(rot),
                                fmt(large), fmt(sweep), fmt(x2), fmt(y2)])
            )
            continue
        # Every other command is a flat list of x,y pairs.
        moved = []
        for i in range(0, len(nums), 2):
            x2, y2 = point(nums[i], nums[i + 1])
            moved.extend([x2, y2])
        parts.append(cmd + " ".join(fmt(v) for v in moved))
    if min_x == math.inf:
        raise TraceImportError(f"{where}: path has no coordinates")
    return " ".join(parts), (min_x, min_y, max_x, max_y)


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def collect_paths(elem, matrix, out):
    """Walk the SVG tree in document order, accumulating group transforms."""
    own = parse_transform(elem.get("transform", ""))
    m = compose(matrix, own)
    if local_name(elem.tag) == "path":
        out.append((elem, m))
    for child in elem:
        collect_paths(child, m, out)


def parse_length(value, default):
    if value is None:
        return default
    v = value.strip().lower().removesuffix("px")
    try:
        return float(v)
    except ValueError:
        return default


def convert(svg_path, *, scale, origin_x, origin_y, scene_id, duration, seed):
    try:
        root = ET.parse(svg_path).getroot()
    except (ET.ParseError, OSError) as exc:
        raise TraceImportError(f"cannot read {svg_path}: {exc}") from exc
    if local_name(root.tag) != "svg":
        raise TraceImportError(f"{svg_path}: root element is not <svg>")
    found = []
    collect_paths(root, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), found)
    if not found:
        raise TraceImportError(f"{svg_path}: no <path> elements found")
    canvas_w = parse_length(root.get("width"), None)
    canvas_h = parse_length(root.get("height"), None)

    nodes = []
    ground = "#000000"
    all_min_x = all_min_y = math.inf
    all_max_x = all_max_y = -math.inf
    for index, (elem, matrix) in enumerate(found):
        where = f"path {index} in {svg_path}"
        d_raw = elem.get("d", "").strip()
        if not d_raw:
            raise TraceImportError(f"{where}: empty d attribute")
        segments = normalise_segments(tokenise_d(d_raw), where)
        d_abs, (bx0, by0, bx1, by1) = bake_segments(segments, matrix, where)
        all_min_x = min(all_min_x, bx0)
        all_min_y = min(all_min_y, by0)
        all_max_x = max(all_max_x, bx1)
        all_max_y = max(all_max_y, by1)
        # Rebase to box-local coords in source units, then scale once.
        w_src = bx1 - bx0
        h_src = by1 - by0
        box = {
            "x": round(origin_x + bx0 * scale, 2),
            "y": round(origin_y + by0 * scale, 2),
            "w": round(max(w_src * scale, 1.0), 2),
            "h": round(max(h_src * scale, 1.0), 2),
        }
        # Shift the baked path by (-bx0, -by0) in source units, then scale.
        shifted = shift_and_scale(d_abs, -bx0, -by0, scale)
        props = {"kind": "path", "d": shifted,
                 "fill": normalise_fill(elem.get("fill"), where)}
        stroke = elem.get("stroke")
        if stroke and stroke.strip() != "none":
            width = elem.get("stroke-width")
            try:
                sw = float(width) if width else 1.0
            except ValueError:
                raise TraceImportError(f"{where}: bad stroke-width {width!r}") from None
            props["stroke"] = {
                "color": normalise_fill(stroke, where),
                "width": round(max(sw * scale, 0.0), 2),
            }
        node = {
            "id": f"trace-{index:03d}",
            "type": "shape",
            "parent": None,
            "z": index,
            "box": box,
            "props": props,
        }
        opacity = 1.0
        for attr in ("opacity", "fill-opacity"):
            raw = elem.get(attr)
            if raw is not None:
                try:
                    opacity *= float(raw)
                except ValueError:
                    raise TraceImportError(f"{where}: bad {attr} {raw!r}") from None
        if opacity < 1.0:
            node["transform"] = {"opacity": round(max(opacity, 0.0), 3)}
        nodes.append(node)
        if index == 0 and canvas_w and canvas_h:
            area = w_src * h_src
            if area >= 0.99 * canvas_w * canvas_h:
                ground = props["fill"] if props["fill"] != "none" else "#000000"

    if canvas_w is None:
        canvas_w = all_max_x - all_min_x
    if canvas_h is None:
        canvas_h = all_max_y - all_min_y
    scene = {
        "schema": "hme.scene/1.0",
        "meta": {
            "id": scene_id,
            "fps": 24,
            "width": STAGE_W,
            "height": STAGE_H,
            "duration": duration,
            "seed": seed,
            "register": "dark",
            "notes": (
                f"Converted from {svg_path} by src/reference/trace-import.py: "
                f"{len(nodes)} paths, scale {scale}, origin "
                f"({origin_x}, {origin_y}) stage px."
            ),
        },
        "fonts": [],
        "palette": {"ground": ground},
        "nodes": nodes,
        "timeline": [],
        "events": [],
    }
    return scene, {
        "paths": len(nodes),
        "canvas": (canvas_w, canvas_h),
        "ground": ground,
        "bbox": (all_min_x, all_min_y, all_max_x, all_max_y),
    }


def shift_and_scale(d_abs, dx, dy, scale):
    """Shift baked absolute path data by (dx, dy), then scale all coords.

    Only M/L/C/Q/A commands reach here (normalise_segments output), so
    every number after a command letter is an x,y pair except the arc
    radii/flags, which scale without shifting.
    """
    segments = tokenise_d(d_abs)
    parts = []
    for cmd, nums in segments:
        if cmd == "Z":
            parts.append("Z")
            continue
        if cmd == "A":
            rx, ry, rot, large, sweep, x, y = nums
            parts.append("A" + " ".join([
                fmt(rx * scale), fmt(ry * scale), fmt(rot), fmt(large),
                fmt(sweep), fmt((x + dx) * scale), fmt((y + dy) * scale),
            ]))
            continue
        moved = []
        for i in range(0, len(nums), 2):
            moved.append(fmt((nums[i] + dx) * scale))
            moved.append(fmt((nums[i + 1] + dy) * scale))
        parts.append(cmd + " ".join(moved))
    return " ".join(parts)


def clean_id(text):
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-")
    return cleaned or "trace-import"


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="trace-import.py",
        description=(
            "Convert a traced SVG into engine scene JSON: one shape node "
            "of kind 'path' per SVG path, stacked in document order."
        ),
    )
    parser.add_argument("svg", help="traced SVG file, e.g. monster-trace.svg")
    parser.add_argument("--out", required=True,
                        help="scene JSON path, or - for stdout")
    parser.add_argument("--crop", default="445,25",
                        help="source crop origin x,y in source px "
                             "(default 445,25, the monster crop)")
    parser.add_argument("--source-size", default="640x360",
                        help="source frame size WxH; scale is 1920/W "
                             "(default 640x360)")
    parser.add_argument("--scale", type=float, default=None,
                        help="override the computed coordinate scale")
    parser.add_argument("--origin-x", type=float, default=None,
                        help="crop origin in stage px; overrides --crop x")
    parser.add_argument("--origin-y", type=float, default=None,
                        help="crop origin in stage px; overrides --crop y")
    parser.add_argument("--id", default=None,
                        help="scene meta id (default: SVG file stem)")
    parser.add_argument("--duration", type=int, default=24,
                        help="scene duration in frames (default 24)")
    parser.add_argument("--seed", type=int, default=1337,
                        help="scene seed (default 1337)")
    args = parser.parse_args(argv)

    try:
        crop_x, crop_y = (float(v) for v in args.crop.split(","))
    except ValueError:
        parser.error("--crop needs the form x,y")
    try:
        src_w, src_h = (float(v) for v in args.source_size.lower().split("x"))
    except ValueError:
        parser.error("--source-size needs the form WxH")
    if src_w <= 0 or src_h <= 0:
        parser.error("--source-size needs positive dimensions")
    scale = args.scale if args.scale is not None else STAGE_W / src_w
    if scale <= 0:
        parser.error("--scale needs a positive number")
    if args.scale is None and not math.isclose(STAGE_H / src_h, scale, rel_tol=1e-9):
        parser.error(
            f"--source-size {args.source_size} scales x by {scale:.4f} "
            f"but y by {STAGE_H / src_h:.4f}; pass --scale to choose one"
        )
    origin_x = args.origin_x if args.origin_x is not None else crop_x * scale
    origin_y = args.origin_y if args.origin_y is not None else crop_y * scale
    scene_id = clean_id(args.id if args.id is not None
                        else args.svg.rsplit("/", 1)[-1].rsplit(".", 1)[0])

    try:
        scene, info = convert(
            args.svg, scale=scale, origin_x=origin_x, origin_y=origin_y,
            scene_id=scene_id, duration=args.duration, seed=args.seed,
        )
    except TraceImportError as exc:
        print(f"trace-import: {exc}", file=sys.stderr)
        return 2
    text = json.dumps(scene, indent=2) + "\n"
    if args.out == "-":
        sys.stdout.write(text)
    else:
        try:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
        except OSError as exc:
            print(f"trace-import: cannot write {args.out}: {exc}", file=sys.stderr)
            return 2
    print(
        f"trace-import: {info['paths']} paths -> {len(scene['nodes'])} nodes, "
        f"canvas {info['canvas'][0]:g}x{info['canvas'][1]:g} source px, "
        f"scale {scale:g}, origin ({origin_x:g}, {origin_y:g}) stage px, "
        f"ground {info['ground']}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
