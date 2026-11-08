"""Checker tests. The slow CLI tests run the full checker on 3 fps,
30-frame synthetic clips (10 s at 3 fps). Each takes ~25 s."""
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from checker import color as _color
from checker import metrics as _metrics
from checker import motion as _motion
from checker.stages import load_predicate, run_check

FIX = Path(__file__).resolve().parent / "fixtures"
CFG = json.loads((FIX / "seg3-test.json").read_text())
REF = str(FIX / "ref.mp4")


def run(name, out, full=False):
    return run_check(CFG, str(FIX / name / "video.mp4"), REF, out, full=full)


def test_predicate_values_match_prompt_05():
    pred = load_predicate()
    assert pred["version"] == "pred-v1"
    assert pred["mean_ssim"] == {"seg1": 0.98, "seg2": 0.98, "seg3": 0.95, "seg4": 0.96}
    assert pred["mean_psnr_db"] == {"seg1": 38, "seg2": 38, "seg3": 35, "seg4": 35}
    assert pred["mean_lpips_max"] == {"seg1": 0.05, "seg2": 0.05, "seg3": 0.08, "seg4": 0.08}
    assert pred["per_frame_ssim_min"] == 0.9
    assert pred["hard_floor_ssim"] == 0.85
    assert pred["flat_delta_e_max"] == 3
    assert pred["motion_err_px_max"] == 2
    assert pred["motion_jump_px_max"] == 4
    assert pred["text_shift_px_max"] == 2
    assert pred["label_iou_min"] == 0.5
    assert pred["g8_text_ratio_min"] == 7
    assert pred["g8_line_ratio_min"] == 3
    assert pred["g9_hold_after_label_s"] == 1.2


def test_ssim_and_psnr_identical():
    a = np.zeros((64, 64, 3), dtype=np.uint8)
    a[10:30, 10:30] = 200
    la = _metrics.luma(a)
    assert _metrics.ssim_frame(la, la) == pytest.approx(1.0, abs=1e-6)
    assert _metrics.psnr_frame(a, a) == 100.0


def test_phase_shift_measures_a_known_shift():
    base = np.zeros((64, 64), dtype=np.float32)
    base[20:40, 20:40] = 100.0
    shifted = np.roll(base, shift=(0, 3), axis=1)
    sy, sx = _motion.phase_shift(base, shifted)
    assert abs(sx - 3) < 0.1
    assert abs(sy) < 0.1


def test_ciede2000_sanity():
    navy = np.array([20.0, 33.0, 61.0])
    assert _color.ciede2000(navy, navy) == pytest.approx(0.0)
    off = np.array([37.0, 53.0, 92.0])
    assert _color.ciede2000(navy, off) > 3


def test_identical_clips_pass_automatic_stages(tmp_path):
    r = run("identical", tmp_path / "check")
    assert r["verdict"] == "INCOMPLETE"  # LPIPS weights cannot load here
    assert r["means"]["ssim"] == pytest.approx(1.0, abs=0.01)
    assert r["means"]["psnr"] == 100.0
    assert r["stages_run"] == ["S0", "S1", "S2", "S3", "S4", "S5", "S6"]
    assert any(f["code"] == "LPIPS_UNAVAILABLE" for f in r["flags"])
    assert r["failures"] == []


def test_3px_label_shift_gives_text_shift_and_motion_err(tmp_path):
    r = run("shifted", tmp_path / "check", full=True)
    codes = [f["code"] for f in r["failures"]]
    assert "TEXT_SHIFT" in codes
    assert "MOTION_ERR" in codes


def test_flat_fill_off_by_5_delta_e_gives_color_fail(tmp_path):
    r = run("coloroff", tmp_path / "check")
    assert r["verdict"] == "FAIL"
    assert r["stages_run"] == ["S0", "S1"]  # fail-fast stops at S1
    assert any(f["code"] == "COLOR_FAIL" for f in r["failures"])


def test_one_bad_frame_fails_the_frame_rule(tmp_path):
    r = run("onebad", tmp_path / "check", full=True)
    assert r["means"]["ssim"] > 0.95  # mean still high
    assert any(f["code"] in ("FRAME_SSIM", "HARD_FLOOR") for f in r["failures"])


def test_removed_event_gives_event_missing(tmp_path):
    r = run("noevent", tmp_path / "check")
    assert any(f["code"] == "EVENT_MISSING" for f in r["failures"])


def test_label_moved_40px_gives_label_wrong_place(tmp_path):
    r = run("movedlabel", tmp_path / "check")
    assert any(f["code"] == "LABEL_WRONG_PLACE" for f in r["failures"])


def test_draft_render_gives_not_final(tmp_path):
    r = run("draft", tmp_path / "check")
    assert r["verdict"] == "NOT_FINAL"
    assert r["stages_run"] == ["S0"]


def test_two_runs_give_byte_identical_report(tmp_path):
    from checker.report import write_reports
    from checker.decode import decode_frames
    r1 = run("identical", tmp_path / "a")
    r2 = run("identical", tmp_path / "b")
    ref = decode_frames(REF, 1920, 1080, count=30)
    render = decode_frames(str(FIX / "identical" / "video.mp4"), 1920, 1080, count=30)
    write_reports(r1, ref, render, tmp_path / "a")
    write_reports(r2, ref, render, tmp_path / "b")
    assert (tmp_path / "a" / "report.json").read_bytes() == (tmp_path / "b" / "report.json").read_bytes()


def test_predicate_tamper_exits_7(tmp_path):
    src = Path(__file__).resolve().parents[2] / "src" / "checker"
    copy = tmp_path / "checker"
    shutil.copytree(src, copy)
    p = copy / "predicate.json"
    data = json.loads(p.read_text())
    data["mean_ssim"]["seg3"] = 0.5
    p.write_text(json.dumps(data))
    env = {"PATH": "/usr/bin:/bin", "SYSTEMROOT": ""}
    # No -I here: isolated mode ignores PYTHONPATH, and this test needs
    # the copied (tampered) package to win over the installed one.
    proc = subprocess.run(
        [sys.executable, "-m", "checker", "run",
         "--segment", str(FIX / "seg3-test.json"),
         "--render", str(FIX / "identical" / "video.mp4"),
         "--ref", REF, "--out", str(tmp_path / "check")],
        capture_output=True, text=True, cwd=tmp_path, env={**env, "PYTHONPATH": str(tmp_path)})
    assert proc.returncode == 7
    assert "PREDICATE_TAMPERED" in proc.stderr
