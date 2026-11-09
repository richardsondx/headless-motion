"""Overlay-match CLI: the programmatic onion skin.

Usage:
  .venv/bin/python run-overlay-check.py \
      --real <real frame png> --ours <our render png> \
      --out <output dir> [--label <name>]

Writes three files into --out:
  overlay.png: the 50/50 blend of the two frames.
  diff.png: the per-channel absolute difference, amplified 4x.
  overlay-report.json: mean difference, per-layer differences,
    per-element shift vectors with overlap before and after shifting,
    and a plain-words corrections list.

Paths come from the arguments only. Nothing here hardcodes a version
or a segment. Exit 0 when all three files are written and verified,
non-zero with a clear message otherwise.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "src"))

from checker import overlay  # noqa: E402


def load_png(path):
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"no such file: {path}")
    return np.array(Image.open(p).convert("RGB"))


def write_png(path, arr):
    Image.fromarray(arr).save(path)
    if not Path(path).is_file() or Path(path).stat().st_size == 0:
        raise OSError(f"write failed or empty file: {path}")


def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, indent=1) + "\n")
    if not Path(path).is_file() or Path(path).stat().st_size == 0:
        raise OSError(f"write failed or empty file: {path}")


def main():
    ap = argparse.ArgumentParser(description="Overlay match: real vs ours.")
    ap.add_argument("--real", required=True, help="real reference frame (PNG)")
    ap.add_argument("--ours", required=True, help="our render frame (PNG)")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--label", default="overlay check",
                    help="title recorded in the report")
    args = ap.parse_args()

    try:
        real = load_png(args.real)
        ours = load_png(args.ours)
    except (FileNotFoundError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if real.shape != ours.shape:
        print(f"error: frames differ in shape: real {real.shape}, "
              f"ours {ours.shape}", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(f"error: cannot create output dir {args.out}: {e}", file=sys.stderr)
        return 2

    try:
        blend = overlay.blend_overlay(real, ours)
        diff = overlay.amplified_diff(real, ours)
        report = overlay.overlay_report(real, ours, label=args.label)
        report["files"] = {"real": args.real, "ours": args.ours,
                           "overlay_png": str(out_dir / "overlay.png"),
                           "diff_png": str(out_dir / "diff.png"),
                           "report_json": str(out_dir / "overlay-report.json")}
        write_png(out_dir / "overlay.png", blend)
        write_png(out_dir / "diff.png", diff)
        write_json(out_dir / "overlay-report.json", report)
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 3

    print(f"wrote {out_dir / 'overlay.png'}")
    print(f"wrote {out_dir / 'diff.png'}")
    print(f"wrote {out_dir / 'overlay-report.json'}")
    print(f"mean absolute difference: {report['mean_abs_diff']}")
    for line in report["corrections"]:
        print(f"correction: {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
