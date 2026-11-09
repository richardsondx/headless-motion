"""Numeric lint ops + regression scenes (Unit A, stage2-lint-gate-g2-2026-11-08-01).

Closes parent-run gap G1: the banned lint matched numbers by regex over
serialised text, so a scene with mid_lap_var as an integer (9, no decimal
point) slipped past the blur-back entry, and the default-ease entry named
only easeInOutCubic. The fix adds numeric-comparison ops (lt/lte/gt/gte)
and a `conditions` list (AND) to banned entries, and rewrites the two
entries to use them.

All scenes here are SYNTHETIC. Nothing here measures the Ananth clip.

Design under test (checker.defects.lint_scene):
- An entry carries either `match` (single condition, as before) or
  `conditions` (a list of conditions, ALL of which must hit). Existing
  single-match entries behave exactly as before.
- A condition is {field, op, value}. Numeric ops compare JSON numbers
  as numbers: 9 and 9.42 both compare against 100.0. A missing field or
  a non-number value never hits (a missing field is what the `missing`
  op is for).
- The blur-back entry is the conjunction: detail_structure == "absent"
  AND mid_lap_var < 100.0 AND mid_hf_ratio < 0.02 AND
  end_lap_var >= 100.0 — the S9 rule, with end sharpness judged by
  end_lap_var (S9 additionally checks end SSIM when one is supplied;
  the lint is the first gate, S9 is the backstop).
- The default-ease entry is the conjunction: camera_ease == "none" AND
  the scene names one of the 17 curved eases in src/scene/easing.mjs
  EASE_NAMES (the cubic-bezier catalogue the picker can fit). NOT
  covered: "hold" (a step, not a fitted curve) and "linear" (constant
  velocity, the no-easing baseline) — recorded as a gap in lint-proof.md.
"""

import json
from pathlib import Path

import pytest

from checker.defects import lint_scene

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parents[1]  # .../headless-motion-engine
SCENES = HERE.parents[2] / "handover-motion-lint-gate-g2" / "units" / "A"
BANNED_PATH = ENGINE / "banned.json"

CURVED_EASES = [
    "easeInSine", "easeOutSine", "easeInOutSine",
    "easeInQuad", "easeOutQuad", "easeInOutQuad",
    "easeInCubic", "easeOutCubic", "easeInOutCubic",
    "easeInQuart", "easeOutQuart", "easeInOutQuart",
    "easeInQuint", "easeOutQuint", "easeInOutQuint",
    "easeOutBack", "easeInOutBack",
]


def _banned(entries):
    return {"entries": entries}


def _ids(violations):
    return [v["entry_id"] for v in violations]


# ---- numeric ops, inline scenes (no files) ---------------------------


def test_lt_hits_integer_and_decimal():
    banned = _banned([{"id": "t", "class": "X", "pattern": "p",
                       "match": {"field": "v", "op": "lt", "value": 100.0}}])
    assert _ids(lint_scene({"v": 9}, banned)) == ["t"]
    assert _ids(lint_scene({"v": 9.42}, banned)) == ["t"]
    assert _ids(lint_scene({"v": 99.99}, banned)) == ["t"]


def test_lt_boundary_is_strict():
    banned = _banned([{"id": "t", "class": "X", "pattern": "p",
                       "match": {"field": "v", "op": "lt", "value": 100.0}}])
    assert lint_scene({"v": 100.0}, banned) == []
    assert lint_scene({"v": 100}, banned) == []
    assert lint_scene({"v": 747.32}, banned) == []


def test_gte_hits_boundary_and_above():
    banned = _banned([{"id": "t", "class": "X", "pattern": "p",
                       "match": {"field": "v", "op": "gte", "value": 100.0}}])
    assert _ids(lint_scene({"v": 100.0}, banned)) == ["t"]
    assert _ids(lint_scene({"v": 100}, banned)) == ["t"]
    assert _ids(lint_scene({"v": 1059.85}, banned)) == ["t"]
    assert lint_scene({"v": 99.99}, banned) == []
    assert lint_scene({"v": 9}, banned) == []


def test_lte_and_gt():
    banned = _banned([{"id": "t", "class": "X", "pattern": "p",
                       "match": {"field": "v", "op": "lte", "value": 100.0}}])
    assert _ids(lint_scene({"v": 100.0}, banned)) == ["t"]
    assert lint_scene({"v": 100.01}, banned) == []
    banned = _banned([{"id": "t", "class": "X", "pattern": "p",
                       "match": {"field": "v", "op": "gt", "value": 100.0}}])
    assert _ids(lint_scene({"v": 100.01}, banned)) == ["t"]
    assert lint_scene({"v": 100.0}, banned) == []


def test_numeric_op_never_fires_on_missing_or_non_number():
    banned = _banned([{"id": "t", "class": "X", "pattern": "p",
                       "match": {"field": "v", "op": "lt", "value": 100.0}}])
    assert lint_scene({}, banned) == []
    assert lint_scene({"v": "9.42"}, banned) == []
    assert lint_scene({"v": None}, banned) == []
    assert lint_scene({"v": True}, banned) == []
    assert lint_scene({"v": [9]}, banned) == []


def test_numeric_op_dotted_field():
    banned = _banned([{"id": "t", "class": "X", "pattern": "p",
                       "match": {"field": "a.b.c", "op": "lt", "value": 100.0}}])
    assert _ids(lint_scene({"a": {"b": {"c": 9}}}, banned)) == ["t"]
    assert lint_scene({"a": {"b": {}}}, banned) == []


# ---- conditions (AND) -------------------------------------------------


def test_conditions_all_must_hit():
    entry = {"id": "t", "class": "X", "pattern": "p", "conditions": [
        {"field": "a", "op": "equals", "value": "absent"},
        {"field": "b", "op": "lt", "value": 100.0},
        {"field": "c", "op": "gte", "value": 100.0},
    ]}
    scene = {"a": "absent", "b": 9.42, "c": 1059.85}
    assert _ids(lint_scene(scene, _banned([entry]))) == ["t"]
    assert lint_scene({**scene, "b": 747.32}, _banned([entry])) == []
    assert lint_scene({**scene, "a": "present"}, _banned([entry])) == []
    assert lint_scene({**scene, "c": 50.0}, _banned([entry])) == []
    assert lint_scene({"a": "absent", "b": 9}, _banned([entry])) == []


def test_single_match_entries_still_work():
    banned = _banned([{"id": "t", "class": "X", "pattern": "p",
                       "match": {"field": "a", "op": "equals", "value": "x"}}])
    assert _ids(lint_scene({"a": "x"}, banned)) == ["t"]
    assert lint_scene({"a": "y"}, banned) == []


# ---- file-based: real banned.json + regression scenes -----------------

@pytest.fixture(scope="module")
def banned():
    if not BANNED_PATH.exists() or not SCENES.exists():
        pytest.skip("banned.json or regression scenes absent")
    return json.loads(BANNED_PATH.read_text())


def _scene(name):
    return json.loads((SCENES / name).read_text())


def test_banned_json_shape(banned):
    assert len(banned["entries"]) == 12
    by_id = {e["id"]: e for e in banned["entries"]}
    blur = by_id["blur-back-resolve"]
    assert "conditions" in blur and len(blur["conditions"]) == 4
    assert {c["op"] for c in blur["conditions"]} <= {"equals", "lt", "gte"}
    ease = by_id["default-ease-on-static-timelapse"]
    assert "conditions" in ease and len(ease["conditions"]) == 2
    assert all(name in ease["pattern"] or name in json.dumps(ease)
               for name in ("easeOutQuint", "easeInOutCubic"))


def test_integer_fake_rejected(banned):
    v = lint_scene(_scene("scene-formal-fake-int.json"), banned)
    assert _ids(v) == ["blur-back-resolve"]


def test_decimal_fake_rejected(banned):
    for name in ("scene-formal-fake.json", "scene-blur-back.json"):
        assert _ids(lint_scene(_scene(name), banned)) == ["blur-back-resolve"]


def test_clean_scenes_pass(banned):
    assert lint_scene(_scene("scene-clean.json"), banned) == []
    assert lint_scene(_scene("scene-formal-clean.json"), banned) == []


def test_never_sharp_does_not_fire(banned):
    assert lint_scene(_scene("scene-never-sharp.json"), banned) == []


def test_ease_out_quint_timelapse_rejected(banned):
    v = lint_scene(_scene("scene-ease-outquint.json"), banned)
    assert _ids(v) == ["default-ease-on-static-timelapse"]


def test_ease_in_out_cubic_timelapse_still_rejected(banned):
    v = lint_scene(_scene("scene-default-ease.json"), banned)
    assert _ids(v) == ["default-ease-on-static-timelapse"]


def test_every_curved_ease_on_static_timelapse_rejected(banned):
    base = _scene("scene-ease-outquint.json")
    for name in CURVED_EASES:
        scene = json.loads(json.dumps(base))
        scene["timeline"]["tracks"][0]["ease"] = name
        assert _ids(lint_scene(scene, banned)) == \
            ["default-ease-on-static-timelapse"], name


def test_measured_ease_on_static_timelapse_passes(banned):
    assert lint_scene(_scene("scene-measured-ease-static.json"), banned) == []


def test_moving_clip_with_named_ease_passes(banned):
    assert lint_scene(_scene("scene-moving-ease.json"), banned) == []
    assert lint_scene(_scene("scene-moving-ease-outquint.json"), banned) == []


def test_pre_existing_entries_unchanged(banned):
    assert _ids(lint_scene(_scene("scene-existing.json"), banned)) == \
        ["generic-gradient-title"]
    assert _ids(lint_scene(_scene("scene-existing-fade.json"), banned)) == \
        ["everything-fading-in"]
