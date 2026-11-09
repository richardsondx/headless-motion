"""Defect taxonomy + log + banned-list lint for the headless motion checker.

Reads a checker report.json (full checker) or a light-report.json
(light SSIM/PSNR-only pass), classifies every failure/flag through
defects.json (12 classes, study section 5), appends one JSONL row per
failure to defects.jsonl, and writes defects-summary.json with counts
by class and by code plus worst frames.

Also lints a scene/config against banned.json BEFORE any render is
spent: `python3 defects.py lint --scene scene.json` exits 1 when the
scene repeats a previously confirmed default.

Usage:
  python3 defects.py classify --report <report.json> [--frames <frames.csv|light-frames.jsonl>]
                              [--taxonomy defects.json] --out-dir <dir>
  python3 defects.py lint --scene <scene.json> [--banned banned.json]
  python3 defects.py check-taxonomy [--taxonomy defects.json]

Every defects.jsonl row carries {class, code, frame, value, threshold,
evidence, suggested_fix}. The checker itself is never modified and
pred-v1 is never touched by this script.
"""
import argparse
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_TAXONOMY = HERE / "defects.json"
# banned.json lives at the engine project root (one level above src/).
DEFAULT_BANNED = HERE.parent.parent / "banned.json"


def load_json(path):
    return json.loads(Path(path).read_text())


def load_taxonomy(path=None):
    return load_json(path or DEFAULT_TAXONOMY)


def load_banned(path=None):
    return load_json(path or DEFAULT_BANNED)


def load_frames(path):
    """frames.csv (full checker) or light-frames.jsonl -> {frame: row dict}."""
    path = Path(path)
    out = {}
    if not path.exists():
        return out
    if path.suffix == ".jsonl":
        for line in path.read_text().splitlines():
            line = line.strip()
            if line:
                row = json.loads(line)
                out[int(row["frame"])] = row
    else:
        with open(path, newline="") as fh:
            for row in csv.DictReader(fh):
                out[int(row["frame"])] = row
    return out


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def evidence_still(report_dir, frame):
    """Worst-frame diff still for this frame, if the checker wrote one."""
    if frame is None:
        return None
    cand = Path(report_dir) / "worst" / f"frame-{int(frame):06d}-diff.png"
    return str(cand) if cand.exists() else None


def expand_failure(entry, taxonomy, frames, report_dir):
    """One checker failure/flag entry -> list of defect rows.

    Full-checker entries carry row={frame,value,threshold[,target]}.
    Light-report entries aggregate: frames=[...] + count, or
    rows=[{frame,target,...}]. Aggregated entries expand to one row per
    listed frame; the unlisted remainder is recorded in the summary's
    reported_count_by_code, never silently dropped.
    """
    code = entry.get("code")
    mapping = taxonomy.get("codes", {}).get(code)
    cls = mapping["class"] if mapping else None
    fix = mapping["suggested_fix"] if mapping else None
    rows = []

    def one(frame, value, threshold, extra=None):
        row = {
            "class": cls,
            "code": code,
            "frame": frame,
            "value": value,
            "threshold": threshold,
            "evidence": evidence_still(report_dir, frame),
            "suggested_fix": fix,
        }
        if extra:
            row.update(extra)
        if frame is not None and frame in frames:
            f = frames[frame]
            row.setdefault("frame_ssim", _num(f.get("ssim")))
            row.setdefault("frame_psnr", _num(f.get("psnr")))
            row.setdefault("frame_motion_err", _num(f.get("motion_err")))
        rows.append(row)

    r = entry.get("row") or {}
    if "rows" in entry:  # light MOTION_ERR_TARGET: rows=[{frame,target,motion_err}]
        for sub in entry["rows"]:
            one(sub.get("frame"), sub.get("motion_err"),
                entry.get("threshold", r.get("threshold")),
                {"target": sub.get("target")} if sub.get("target") else None)
    elif "frames" in entry:  # light FRAME_SSIM / HARD_FLOOR / MOTION_ERR
        for f in entry["frames"]:
            fr = frames.get(int(f), {})
            one(int(f), _num(fr.get("ssim")), entry.get("threshold"))
    else:
        extra = {"target": r["target"]} if r.get("target") else None
        one(r.get("frame", entry.get("frame")),
            r.get("value", entry.get("value")),
            r.get("threshold", entry.get("threshold")), extra)
    return rows


def classify_report(report, taxonomy, frames=None, report_dir=None):
    """Return (rows, summary) for a report dict. Rows cover failures;
    flags are classified in the summary's flag sections and also written
    as rows with kind='flag' so nothing is hidden."""
    frames = frames or {}
    report_dir = Path(report_dir) if report_dir else Path(".")
    rows, flag_rows = [], []
    reported = Counter()
    for entry in report.get("failures", []):
        reported[entry.get("code")] += 1
        rows.extend(expand_failure(entry, taxonomy, frames, report_dir))
    for entry in report.get("flags", []):
        reported[entry.get("code")] += 0  # flags are not failures; counted separately
        flag_rows.extend(expand_failure(
            {"code": entry.get("code"), "row": {
                "frame": entry.get("frame"),
                "value": entry.get("value"),
                "threshold": entry.get("threshold")}}, taxonomy, frames, report_dir))
    # Worst frames: report's own list, plus lowest-SSIM frames from frames data.
    worst = list(report.get("worst_frames") or [])
    if frames:
        by_ssim = sorted((f for f in frames.values() if _num(f.get("ssim")) is not None),
                         key=lambda f: _num(f["ssim"]))[:5]
        worst_from_frames = [int(f["frame"]) for f in by_ssim]
    else:
        worst_from_frames = []
    unclassified = sorted({r["code"] for r in rows + flag_rows if r["class"] is None})
    by_code = Counter(r["code"] for r in rows)
    by_class = Counter(r["class"] for r in rows if r["class"])
    summary = {
        "taxonomy_version": taxonomy.get("version"),
        "predicate": taxonomy.get("predicate"),
        "source_report": str(report_dir / "report.json") if report_dir else None,
        "segment": report.get("segment"),
        "verdict": report.get("verdict"),
        "means": report.get("means"),
        "total_failures": len(report.get("failures", [])),
        "total_defect_rows": len(rows),
        "total_flags": len(report.get("flags", [])),
        "by_code": dict(sorted(by_code.items())),
        "by_class": dict(sorted(by_class.items())),
        "by_flag_code": dict(sorted(Counter(r["code"] for r in flag_rows).items())),
        "by_flag_class": dict(sorted(Counter(r["class"] for r in flag_rows if r["class"]).items())),
        # reported_count_by_code counts report entries (1 per failure entry);
        # for aggregated light reports it also records entry['count'] where present.
        "reported_count_by_code": {
            code: sum(e.get("count") or len(e.get("rows", [])) or len(e.get("frames", [])) or 1
                      for e in report.get("failures", []) if e.get("code") == code)
            for code in sorted({e.get("code") for e in report.get("failures", [])})
        },
        "worst_frames": worst,
        "worst_frames_by_ssim": worst_from_frames,
        "unclassified_codes": unclassified,
    }
    return rows, flag_rows, summary


def write_outputs(rows, flag_rows, summary, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = out_dir / "defects.jsonl"
    with open(jsonl_path, "w") as fh:
        for row in rows:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
        for row in flag_rows:
            fh.write(json.dumps({**row, "kind": "flag"}, sort_keys=True) + "\n")
    summary_path = out_dir / "defects-summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    return jsonl_path, summary_path


# ---- banned-list lint -------------------------------------------------

def _get_field(obj, dotted):
    cur = obj
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None, False
    return cur, True


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _match_condition(scene, text, cond):
    """Evaluate one banned-entry condition against a scene.

    A condition is {field, op, value}. Ops: equals | contains | regex |
    missing | in | count_at_least (as before) plus lt | lte | gt | gte,
    which compare a JSON number against a numeric threshold. A numeric
    op never fires on a missing field or a non-number value, so 9 and
    9.42 both compare as numbers. Returns (hit, field, found).
    """
    field, op, want = cond.get("field", "*"), cond.get("op"), cond.get("value")
    if field == "*":
        found, present = text, True
    else:
        found, present = _get_field(scene, field)
    if op == "contains":
        hit = present and isinstance(found, str) and str(want).lower() in found.lower()
        if not hit and field == "*":
            hit = str(want).lower() in text.lower()
    elif op == "equals":
        hit = present and found == want
    elif op == "regex":
        hit = bool(re.search(str(want), str(found) if present else text,
                             re.IGNORECASE))
    elif op == "missing":
        hit = (not present) or found in (None, "", [], {})
    elif op == "in":
        hit = present and found in (want or [])
    elif op == "count_at_least":
        sub = (want or {}).get("substring", "")
        minimum = (want or {}).get("min", 2)
        hit = text.lower().count(str(sub).lower()) >= int(minimum)
    elif op in ("lt", "lte", "gt", "gte"):
        hit = (present and _is_number(found) and _is_number(want)
               and {"lt": found < want, "lte": found <= want,
                    "gt": found > want, "gte": found >= want}[op])
    else:
        hit = False
    return hit, field, found


def lint_scene(scene, banned):
    """Return list of violations; empty list means the scene passes lint.

    Each banned entry carries match={field, op, value} where op is one of
    equals | contains | regex | missing | in | count_at_least | lt | lte |
    gt | gte. count_at_least takes value={substring, min} and fires when the
    substring occurs at least min times in the serialised scene (i.e.
    the default is repeated, not used once with intent). lt/lte/gt/gte
    compare a JSON number against a numeric threshold; they never fire
    on a missing field or a non-number value.

    An entry may instead carry conditions=[{field, op, value}, ...]: it
    fires only when EVERY condition hits (conjunction). An entry with
    conditions ignores match; entries without conditions behave exactly
    as before.
    """
    violations = []
    text = json.dumps(scene, sort_keys=True)
    for entry in banned.get("entries", []):
        conditions = entry.get("conditions")
        if conditions:
            matched = [_match_condition(scene, text, c) for c in conditions]
            hit = all(h for h, _, _ in matched)
            field = "conditions"
            found = {f: (v if f != "*" else "matched in scene text")
                     for (_, f, v) in matched}
        else:
            m = entry.get("match", {})
            hit, field, found = _match_condition(scene, text, m)
            if field == "*":
                found = f"matched in scene text: {m.get('value')}"
        if hit:
            violations.append({
                "entry_id": entry.get("id"),
                "class": entry.get("class"),
                "pattern": entry.get("pattern"),
                "field": field,
                "found": found,
                "source_defect": entry.get("source_defect"),
                "fix": entry.get("fix"),
            })
    return violations


def cmd_classify(args):
    taxonomy = load_taxonomy(args.taxonomy)
    report = load_json(args.report)
    frames = load_frames(args.frames) if args.frames else {}
    rows, flag_rows, summary = classify_report(
        report, taxonomy, frames, report_dir=Path(args.report).parent)
    jsonl_path, summary_path = write_outputs(rows, flag_rows, summary, args.out_dir)
    print(f"classify: {summary['total_failures']} failures -> "
          f"{summary['total_defect_rows']} defect rows + "
          f"{summary['total_flags']} flags")
    print(f"  by_code: {summary['by_code']}")
    print(f"  by_class: {summary['by_class']}")
    print(f"  unclassified_codes: {summary['unclassified_codes']}")
    print(f"  wrote {jsonl_path} and {summary_path}")
    return 0 if not summary["unclassified_codes"] else 0


def cmd_lint(args):
    banned = load_banned(args.banned)
    scene = load_json(args.scene)
    violations = lint_scene(scene, banned)
    if violations:
        print(f"lint: REJECTED — {len(violations)} banned pattern(s) in {args.scene}:")
        for v in violations:
            print(f"  - {v['entry_id']} [{v['class']}] {v['pattern']} "
                  f"(field {v['field']}, found {v['found']!r})")
            print(f"    source: {v['source_defect']}; fix: {v['fix']}")
        print("lint: no render may start until every violation is fixed.")
        return 1
    print(f"lint: PASS — no banned pattern in {args.scene}")
    return 0


def cmd_check_taxonomy(args):
    taxonomy = load_taxonomy(args.taxonomy)
    codes = taxonomy.get("codes", {})
    classes = set(taxonomy.get("classes", []))
    bad = [c for c, m in codes.items() if m.get("class") not in classes]
    missing = [c for c, m in codes.items()
               if not all(k in m for k in ("class", "likely_causes", "scene_fields", "suggested_fix"))]
    print(f"taxonomy: {len(codes)} codes mapped, "
          f"{len(taxonomy.get('unclassified', []))} unclassified, "
          f"bad-class: {bad}, incomplete-entries: {missing}")
    return 0 if not bad and not missing else 1


def main(argv=None):
    ap = argparse.ArgumentParser(prog="defects")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("classify", help="classify a checker report into defects.jsonl + defects-summary.json")
    c.add_argument("--report", required=True)
    c.add_argument("--frames", default=None)
    c.add_argument("--taxonomy", default=None)
    c.add_argument("--out-dir", required=True)
    c.set_defaults(fn=cmd_classify)
    li = sub.add_parser("lint", help="lint a scene/config against banned.json before render")
    li.add_argument("--scene", required=True)
    li.add_argument("--banned", default=None)
    li.set_defaults(fn=cmd_lint)
    t = sub.add_parser("check-taxonomy", help="validate defects.json coverage")
    t.add_argument("--taxonomy", default=None)
    t.set_defaults(fn=cmd_check_taxonomy)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
