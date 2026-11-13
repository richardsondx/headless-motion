#!/usr/bin/env python3
"""Cut one photo out to a transparent PNG.

Proven method from the cutout probe (study/2026-11-09-cutout-probe.md).
Uses rembg with a cached onnx model. Never downloads a model.
Downscales the input to 768 px max before inference.
Full-resolution input killed the probe with out-of-memory, exit 137.
"""

import argparse
import hashlib
import json
import os
import sys

MAX_SIDE_DEFAULT = 768
MIN_FREE_MB_DEFAULT = 1200

# Model file spots, in the order rembg itself checks them.
# u2net lives in the old flat spot, ~/.u2net/u2net.onnx.
# u2net_human_seg lives under ~/.rembg/models/.
MODEL_PATHS = {
    "u2net": [
        os.path.expanduser("~/.rembg/models/u2net/u2net.onnx"),
        os.path.expanduser("~/.u2net/u2net.onnx"),
    ],
    "u2net_human_seg": [
        os.path.expanduser("~/.rembg/models/u2net_human_seg/u2net_human_seg.onnx"),
        os.path.expanduser("~/.u2net/u2net_human_seg.onnx"),
    ],
}


def find_model(name):
    """Return the first cached model file that exists, or None."""
    for path in MODEL_PATHS[name]:
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path
    return None


def free_mb():
    """Read available memory in MB from /proc/meminfo."""
    with open("/proc/meminfo", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    return 0


def alpha_fractions(image):
    """Return opaque, semi-transparent, and clear fractions of the alpha band."""
    alpha = image.getchannel("A")
    hist = alpha.histogram()
    total = sum(hist)
    opaque = sum(hist[250:]) / total
    semi = sum(hist[1:250]) / total
    clear = hist[0] / total
    return opaque, semi, clear


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Cut a photo out to a transparent PNG."
    )
    parser.add_argument("input", help="input photo path")
    parser.add_argument("output", help="output PNG path")
    parser.add_argument(
        "--model",
        choices=["auto", "u2net", "u2net_human_seg"],
        default="auto",
        help="model to use, or auto (default)",
    )
    parser.add_argument(
        "--person",
        action="store_true",
        help="subject is a person, use u2net_human_seg",
    )
    parser.add_argument(
        "--grayscale",
        action="store_true",
        help="write grey RGB channels, spread 0, keep alpha",
    )
    parser.add_argument(
        "--max-side",
        type=int,
        default=MAX_SIDE_DEFAULT,
        help="downscale the long side to this many px (default 768)",
    )
    parser.add_argument(
        "--min-free-mb",
        type=int,
        default=MIN_FREE_MB_DEFAULT,
        help="refuse to run below this much free memory (default 1200)",
    )
    args = parser.parse_args(argv)

    # Pick the model. People need the human-seg model.
    # Clean-background photos use plain u2net.
    if args.model == "auto":
        model = "u2net_human_seg" if args.person else "u2net"
    else:
        model = args.model

    # Refuse to run when the cached model file is missing.
    # rembg would download it in that case, and this tool never downloads.
    model_path = find_model(model)
    if model_path is None:
        print(f"error: cached model file for {model} is missing", file=sys.stderr)
        print("checked:", file=sys.stderr)
        for path in MODEL_PATHS[model]:
            print(f"  {path}", file=sys.stderr)
        print("refusing to run: this tool never downloads a model", file=sys.stderr)
        return 2

    # Refuse to run when free memory is too low for inference.
    available = free_mb()
    if available < args.min_free_mb:
        print(
            f"error: free memory {available} MB is below "
            f"{args.min_free_mb} MB, refusing to run",
            file=sys.stderr,
        )
        return 3

    from PIL import Image
    from rembg import new_session, remove

    try:
        image = Image.open(args.input).convert("RGB")
    except (OSError, ValueError) as exc:
        print(f"error: cannot read input photo: {exc}", file=sys.stderr)
        return 4

    input_size = image.size

    # Downscale before inference. This step is required, not optional.
    long_side = max(input_size)
    if long_side > args.max_side:
        scale = args.max_side / long_side
        new_size = (round(image.width * scale), round(image.height * scale))
        image = image.resize(new_size, Image.Resampling.LANCZOS)
    scaled_size = image.size

    os.environ.setdefault("OMP_NUM_THREADS", "2")
    session = new_session(model)
    cut = remove(image, session=session).convert("RGBA")

    if args.grayscale:
        grey = cut.convert("RGB").convert("L")
        r, g, b, alpha = cut.split()
        grey_rgb = Image.merge("RGB", (grey, grey, grey))
        cut = Image.merge("RGBA", (*grey_rgb.split(), alpha))

    cut.save(args.output, format="PNG")
    opaque, semi, clear = alpha_fractions(cut)

    report = {
        "input": args.input,
        "output": args.output,
        "model": model,
        "model_path": model_path,
        "input_size": list(input_size),
        "scaled_size": list(scaled_size),
        "output_size": list(cut.size),
        "grayscale": args.grayscale,
        "free_mb_before_run": available,
        "opaque_fraction": round(opaque, 4),
        "semi_transparent_fraction": round(semi, 4),
        "clear_fraction": round(clear, 4),
        "output_sha256": sha256_file(args.output),
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
