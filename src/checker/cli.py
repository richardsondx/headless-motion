"""CLI: python -I -m checker run --segment <cfg> --render <mp4> --ref <mp4>
--out out/<seg>/check [--full] [--diagnose-offset]

Time checks: python -I -m checker timechecks --ledger <ledger.json>
--plan <plan.json> [--render <mp4> | --frames-dir <dir>] --out <report.json>

Exit codes: 0 verdict PASS or PENDING_HUMAN or INCOMPLETE, 1 FAIL,
2 usage/decode error, 7 PREDICATE_TAMPERED.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

from .blind import make_blind
from .decode import decode_frames
from .report import write_reports
from .stages import CheckError, PredicateTampered, run_check
from .timechecks import run_timechecks


def _load_frames_dir(frames_dir):
    """Load sorted PNG frames from a directory as RGB arrays."""
    from PIL import Image
    frames = []
    for path in sorted(Path(frames_dir).glob("*.png")):
        frames.append(np.array(Image.open(path).convert("RGB")))
    if not frames:
        raise CheckError("NO_FRAMES", f"no PNG frames in {frames_dir}")
    return frames


def cmd_timechecks(args):
    ledger = json.loads(Path(args.ledger).read_text())
    plan = json.loads(Path(args.plan).read_text())
    frames = None
    if args.render:
        frames = decode_frames(args.render, ledger["frame_width"],
                               ledger["frame_height"])
    elif args.frames_dir:
        frames = _load_frames_dir(args.frames_dir)
    report = run_timechecks(ledger, frames, plan)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(f"{report['plan']} {report['verdict']}")
    for check in report["checks"]:
        print(f"  {check['check']}: {check['verdict']} {check.get('message', '')}")
    return 0 if report["verdict"] == "pass" else 1


def main(argv=None):
    ap = argparse.ArgumentParser(prog="checker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run")
    run.add_argument("--segment", required=True)
    run.add_argument("--render", required=True)
    run.add_argument("--ref", required=True)
    run.add_argument("--out", required=True)
    run.add_argument("--full", action="store_true")
    run.add_argument("--diagnose-offset", action="store_true")
    tc = sub.add_parser("timechecks")
    tc.add_argument("--ledger", required=True)
    tc.add_argument("--plan", required=True)
    tc.add_argument("--render")
    tc.add_argument("--frames-dir")
    tc.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "timechecks":
        try:
            return cmd_timechecks(args)
        except CheckError as e:
            print(e.code, e.message, file=sys.stderr)
            return 2
    cfg = json.loads(Path(args.segment).read_text())
    try:
        result = run_check(cfg, args.render, args.ref, args.out,
                           full=args.full, diagnose_offset=args.diagnose_offset)
    except PredicateTampered:
        print("PREDICATE_TAMPERED", file=sys.stderr)
        return 7
    except CheckError as e:
        print(e.code, e.message, file=sys.stderr)
        return 2
    # Reports need the decoded frames for worst diffs.
    n = 10 * cfg["fps"]
    ref = decode_frames(args.ref, 1920, 1080, start=cfg.get("ref_start_frame", 0), count=n)
    render = decode_frames(args.render, 1920, 1080, count=n)
    write_reports(result, ref, render, args.out)
    make_blind(cfg, args.render, args.ref, args.out)
    print(f"{result['segment']} {result['verdict']} stages={','.join(result['stages_run'])}")
    for f in result["failures"]:
        print(f"  {f['code']}: {f['message']}")
    for fl in result["flags"]:
        print(f"  FLAG {fl['code']}: {fl.get('message', '')}")
    return 0 if result["verdict"] in ("PASS", "PENDING_HUMAN", "INCOMPLETE") else 1


if __name__ == "__main__":
    raise SystemExit(main())
