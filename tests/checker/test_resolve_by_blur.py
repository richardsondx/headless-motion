"""Stage S9 RESOLVE_BY_BLUR tests (Unit B, stage2-coarse-fine-2026-11-08-01).

The pair is SYNTHETIC (Unit A working pair, 480x270, 188 frames each,
same final still). Nothing here measures the Ananth clip.

Rule under test (checker.stages.check_progressive_resolve): fire
RESOLVE_BY_BLUR iff detail_structure is "absent" AND the mid-third
medians are under threshold (lap_var < 100.0, hf_ratio < 0.02) AND
the end is sharp (end lap_var >= 100.0, and end SSIM > 0.95 when one
is supplied). A true resolve passes; a blur-back fake fails even
though its end frame matches the final still (end SSIM 0.9987 fake
vs 0.9986 true — end similarity alone cannot separate them).

Core assertions use inline profiles with the exact Unit A medians, so
they do not depend on files outside this repo. One file-based test
also checks the real Unit A profile sections (skipped if absent).
"""
import copy
import hashlib
import json
from pathlib import Path

import pytest

from checker import defects as _defects
from checker.stages import check_progressive_resolve, run_check, stage_s9

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parents[1]  # .../headless-motion-engine
PROFILE = (HERE.parents[2] / "handover-motion-coarse-fine" / "units" / "A"
           / "reference-profile-progressive-resolve.json")
CFG = json.loads((HERE / "fixtures" / "seg3-test.json").read_text())
REF = str(HERE / "fixtures" / "ref.mp4")


def _pr(detail, mid_lap, mid_hf, end_lap, camera_ease="none"):
    return {
        "detail_structure": detail,
        "detail_structure_mid_frames": {
            "frames": "62-125 (middle third)",
            "median_lap_var": mid_lap,
            "median_hf_ratio": mid_hf,
            "per_frame": [{"frame": 63, "lap_var": mid_lap,
                           "detail_structure": detail}],
        },
        "end_state": {"frame": 186, "lap_var": end_lap},
        "camera_ease": camera_ease,
        "camera": {"camera_move_detected": False, "camera_ease": camera_ease,
                   "ease_fitted": False, "picker_invoked": False},
    }


# Exact Unit A medians: true mid lap_var 747.32 / hf 0.1300, end 1059.79;
# fake mid lap_var 9.42 / hf 0.0018, end 1059.85.
TRUE_PR = _pr("present", 747.32, 0.1300, 1059.79)
FAKE_PR = _pr("absent", 9.42, 0.0018, 1059.85)


def test_taxonomy_maps_resolve_by_blur():
    taxonomy = _defects.load_taxonomy()
    entry = taxonomy["codes"]["RESOLVE_BY_BLUR"]
    assert entry["class"] == "RENDER ARTEFACTS"
    assert entry["kind"] == "failure"
    assert entry["stage"] == "S9"
    for key in ("likely_causes", "scene_fields", "source", "suggested_fix"):
        assert entry[key]
    assert taxonomy["coverage"]["codes_unclassified"] == 0
    assert _defects.cmd_check_taxonomy(
        type("A", (), {"taxonomy": None})()) == 0


def test_s9_true_passes_fake_fails():
    _, failure_true, res_true = stage_s9(TRUE_PR)
    assert res_true["verdict"] == "pass"
    assert res_true["code"] is None
    assert failure_true is None
    _, failure_fake, res_fake = stage_s9(FAKE_PR)
    assert res_fake["verdict"] == "fail"
    assert res_fake["code"] == "RESOLVE_BY_BLUR"
    assert failure_fake["code"] == "RESOLVE_BY_BLUR"


def test_s9_with_end_ssim_true_passes_fake_fails():
    # Measured end SSIM vs the shared final still (units/B/run_s9.py):
    # true 0.9986, fake 0.9987 — both over 0.95, so end similarity
    # cannot separate them; only mid detail does.
    assert check_progressive_resolve(TRUE_PR, end_ssim=0.9986)["verdict"] == "pass"
    assert check_progressive_resolve(FAKE_PR, end_ssim=0.9987)["verdict"] == "fail"


def test_s9_never_sharp_does_not_fire():
    # Absent mid detail but a soft end is not a blur-back; it is a
    # different failure (unresolved), so RESOLVE_BY_BLUR must not fire.
    soft = _pr("absent", 9.42, 0.0018, 50.0)
    assert check_progressive_resolve(soft)["verdict"] == "pass"
    assert check_progressive_resolve(soft, end_ssim=0.5000)["verdict"] == "pass"
    # Sharp end but present mid detail is a true resolve.
    assert check_progressive_resolve(TRUE_PR, end_ssim=0.9986)["verdict"] == "pass"


def test_s9_records_no_ease():
    for pr in (TRUE_PR, FAKE_PR):
        res = check_progressive_resolve(pr)
        assert res["camera_ease"] == "none"
        assert res["ease_fitted"] is False
        assert res["picker_invoked"] is False
        assert res["no_ease_ok"] is True


def test_s9_rejects_pair_profile_without_which():
    # A true+fake pair is not one video; the caller must pick one.
    with pytest.raises(ValueError):
        check_progressive_resolve({"true": TRUE_PR, "fake": FAKE_PR})


@pytest.mark.skipif(not PROFILE.exists(), reason="Unit A profile not present")
def test_s9_real_unit_a_profile_sections():
    data = json.loads(PROFILE.read_text())
    pr = data["progressive_resolve"]
    assert check_progressive_resolve(pr["true"])["verdict"] == "pass"
    assert check_progressive_resolve(pr["fake"])["verdict"] == "fail"
    assert check_progressive_resolve(pr["fake"], end_ssim=0.9987)["code"] == "RESOLVE_BY_BLUR"


def test_predicate_still_frozen():
    pred_bytes = (ENGINE / "src" / "checker" / "predicate.json").read_bytes()
    assert hashlib.sha256(pred_bytes).hexdigest().startswith("1a315dd6eb1b4afc")
    assert json.loads(pred_bytes)["version"] == "pred-v1"


def test_run_check_opt_in_s9_fake_fails(tmp_path):
    # Full checker on the existing identical fixture, with S9 opted in
    # via cfg (fake profile). Slow: one full run_check, including the
    # S6 LPIPS attempt, on a shared machine that is currently running
    # several other Handover runs — allow minutes, not seconds. This
    # is the integration proof that S9 is a real stage in run_check.
    # The true-pass side of the wiring is covered by the direct
    # stage_s9 tests above and by units/B/run_s9.py.
    cfg = copy.deepcopy(CFG)
    cfg["progressive_resolve"] = {"path": str(PROFILE), "which": "fake"}
    r = run_check(cfg, str(HERE / "fixtures" / "identical" / "video.mp4"),
                  REF, tmp_path / "check-fake")
    assert "S9" in r["stages_run"]
    assert r["verdict"] == "FAIL"
    assert any(f["code"] == "RESOLVE_BY_BLUR" for f in r["failures"])
