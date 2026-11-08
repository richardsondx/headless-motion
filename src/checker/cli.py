"""CLI: python -I -m checker run --segment <cfg> --render <mp4> --ref <mp4>
--out out/<seg>/check [--full] [--diagnose-offset]

Exit codes: 0 verdict PASS or PENDING_HUMAN or INCOMPLETE, 1 FAIL,
2 usage/decode error, 7 PREDICATE_TAMPERED.
"""
import argparse
import json
import sys
from pathlib import Path

from .blind import make_blind
from .decode import decode_frames
from .report import write_reports
from .stages import CheckError, PredicateTampered, run_check


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
    args = ap.parse_args(argv)
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
