"""Deterministic report: report.json has no timestamps, so two runs on
the same inputs give a byte-identical file. The time goes in report.md."""
import csv
import datetime
import json
from pathlib import Path

import numpy as np


def write_reports(result, ref, render, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "segment": result["segment"],
        "verdict": result["verdict"],
        "stages_run": result["stages_run"],
        "stages": result["stages"],
        "means": result["means"],
        "failures": result["failures"],
        "flags": result["flags"],
        "notes": result["notes"],
        "worst_frames": result.get("worst_frames", []),
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    with open(out_dir / "frames.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["frame", "ssim", "psnr", "lpips", "motion_err", "shift_x", "shift_y"])
        w.writeheader()
        for row in result["frames"]:
            w.writerow(row)
    # Worst-frame diff PNGs, absolute difference amplified 3x.
    worst_dir = out_dir / "worst"
    worst_dir.mkdir(exist_ok=True)
    for f in result.get("worst_frames", []):
        diff = np.abs(ref[f].astype(int) - render[f].astype(int))
        diff = np.clip(diff * 3, 0, 255).astype(np.uint8)
        from PIL import Image
        Image.fromarray(diff).save(worst_dir / f"frame-{f:06d}-diff.png")
    now = datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    lines = [f"# Check {result['segment']} — {result['verdict']}", "", f"Run at {now}.", "",
             f"Means: SSIM {result['means'].get('ssim')}, PSNR {result['means'].get('psnr')} dB, LPIPS {result['means'].get('lpips')}.", ""]
    for s in result["stages"]:
        lines.append(f"## {s['stage']}: {s['status']}")
        for row in s["rows"]:
            lines.append(f"- {row}")
        lines.append("")
    for fail in result["failures"]:
        lines.append(f"FAIL {fail['code']}: {fail['message']}")
    for flag in result["flags"]:
        lines.append(f"FLAG {flag['code']}: {flag.get('message', flag)}")
    (out_dir / "report.md").write_text("\n".join(lines) + "\n")
    return report
