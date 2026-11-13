"""Tests for checker.timechecks: trajectory, saturation, scale over time.

Synthetic cases only. The rising element rises 13 px, the reference
Trump photo rise measured from f01 to f09. The grayscale region has
mean channel spread 3.2, the reference Trump face spread. The color
region has mean channel spread 19, the color still spread. The
push-in is 5 percent, the camera run marker growth 400 to 420 px.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from checker.timechecks import (  # noqa: E402
    SATURATION_GRAYSCALE_MAX,
    SCALE_RATIO_BAR,
    TRAJECTORY_BAR_PX,
    check_saturation,
    check_scale,
    check_trajectory,
    measure_marker_growth,
    run_timechecks,
)


def _row(frame, element_id, centre, bbox, zoom=1.0):
    return {"frame": frame, "element_id": element_id,
            "centre_px": list(centre), "bbox_px": list(bbox),
            "camera": {"zoom_ratio": zoom}, "visible": True}


def _ledger(rows):
    return {"schema": "hme.ledger/1.0", "rows": rows}


def _rising_ledger():
    # Centre rises 13 px: y 500 at frame 0, y 487 at frame 8.
    return _ledger([_row(0, "photo", (500, 500), (450, 400, 550, 600)),
                    _row(8, "photo", (500, 487), (450, 387, 550, 587))])


def _static_ledger():
    return _ledger([_row(0, "photo", (500, 500), (450, 400, 550, 600)),
                    _row(8, "photo", (500, 500), (450, 400, 550, 600))])


def _trajectory_entry():
    return {"check": "trajectory", "element_id": "photo",
            "window": {"start_frame": 0, "end_frame": 8},
            "planned_displacement": [0, -13],
            "source": "reference frames f01 to f09: Trump photo centroid "
                      "moves up 13 px"}


def test_trajectory_rising_element_passes():
    result = check_trajectory(_rising_ledger(), _trajectory_entry())
    assert result["verdict"] == "pass"
    assert result["measured_displacement"] == [0, -13]
    assert result["component_errors_px"] == [0, 0]
    assert result["bar_px"] == TRAJECTORY_BAR_PX == 2.0


def test_trajectory_static_element_fails():
    result = check_trajectory(_static_ledger(), _trajectory_entry())
    assert result["verdict"] == "fail"
    assert result["measured_displacement"] == [0, 0]
    assert result["component_errors_px"] == [0, 13]


def test_trajectory_wrong_direction_fails():
    rows = _ledger([_row(0, "photo", (500, 500), (450, 400, 550, 600)),
                    _row(8, "photo", (500, 513), (450, 413, 550, 613))])
    result = check_trajectory(rows, _trajectory_entry())
    assert result["verdict"] == "fail"
    assert result["measured_displacement"] == [0, 13]


def test_trajectory_missing_element_fails():
    result = check_trajectory(_ledger([]), _trajectory_entry())
    assert result["verdict"] == "fail"
    assert "no ledger row" in result["message"]


def test_trajectory_points_shape_carries_warning():
    entry = dict(_trajectory_entry(), points_shape=True)
    result = check_trajectory(_rising_ledger(), entry)
    assert result["verdict"] == "pass"
    assert "points-shape" in result["warning"]
    assert "21 px" in result["warning"]


def _gray_frame(value=138, spread=3):
    # Mean channel spread near 3.2: R 138, G 135, B 138.
    frame = np.zeros((40, 40, 3), dtype=np.uint8)
    frame[:, :, 0] = 138
    frame[:, :, 1] = 135
    frame[:, :, 2] = 138
    return frame


def _color_frame():
    # Mean RGB 129.3, 134.7, 148.3, spread 19: the color still.
    frame = np.zeros((40, 40, 3), dtype=np.uint8)
    frame[:, :, 0] = 129
    frame[:, :, 1] = 135
    frame[:, :, 2] = 148
    return frame


def _saturation_entry(treatment):
    return {"check": "saturation", "region": [0, 0, 40, 40],
            "treatment": treatment,
            "window": {"start_frame": 0, "end_frame": 8},
            "source": "reference frames f01 to f09: Trump face mean RGB "
                      "138.5, 135.4, 138.6, spread 3.2"}


def _frames():
    frames = [None] * 9
    frames[0] = _gray_frame()
    frames[4] = _gray_frame()
    frames[8] = _gray_frame()
    return frames


def test_saturation_grayscale_region_passes():
    result = check_saturation(_frames(), _saturation_entry("grayscale"))
    assert result["verdict"] == "pass"
    assert result["measured_mean_spread"] == pytest.approx(3.0, abs=0.1)
    assert result["measured_mean_spread"] <= SATURATION_GRAYSCALE_MAX


def test_saturation_color_region_fails_grayscale():
    frames = [None] * 9
    frames[0] = _color_frame()
    frames[4] = _color_frame()
    frames[8] = _color_frame()
    result = check_saturation(frames, _saturation_entry("grayscale"))
    assert result["verdict"] == "fail"
    assert result["measured_mean_spread"] == pytest.approx(19.0, abs=0.1)


def test_saturation_color_region_passes_color():
    frames = [None] * 9
    frames[0] = _color_frame()
    frames[4] = _color_frame()
    frames[8] = _color_frame()
    result = check_saturation(frames, _saturation_entry("color"))
    assert result["verdict"] == "pass"
    assert result["measured_mean_spread"] == pytest.approx(19.0, abs=0.1)


def test_saturation_grayscale_region_fails_color():
    result = check_saturation(_frames(), _saturation_entry("color"))
    assert result["verdict"] == "fail"


def _scale_element_ledger(start_w, end_w):
    return _ledger([
        _row(0, "photo", (500, 500), (450, 400, 450 + start_w, 600)),
        _row(8, "photo", (500, 500), (450, 400, 450 + end_w, 600))])


def _scale_entry(kind="element"):
    entry = {"check": "scale", "kind": kind,
             "window": {"start_frame": 0, "end_frame": 8},
             "planned_ratio": 1.05,
             "source": "camera run: marker grows 400 to 420 px, "
                       "exactly 5.000 percent"}
    if kind == "element":
        entry["element_id"] = "photo"
    return entry


def test_scale_five_percent_push_in_passes():
    result = check_scale(_scale_element_ledger(400, 420), _scale_entry())
    assert result["verdict"] == "pass"
    assert result["measured_ratio"] == pytest.approx(1.05, abs=0.001)
    assert result["measurement_source"] == "ledger-bbox-width"


def test_scale_static_element_fails():
    result = check_scale(_scale_element_ledger(400, 400), _scale_entry())
    assert result["verdict"] == "fail"
    assert result["measured_ratio"] == pytest.approx(1.00, abs=0.001)


def test_scale_camera_ledger_zoom_passes():
    rows = _ledger([_row(0, "photo", (500, 500), (450, 400, 550, 600), zoom=1.0),
                    _row(8, "photo", (500, 500), (450, 400, 550, 600), zoom=1.05)])
    result = check_scale(rows, _scale_entry(kind="camera"))
    assert result["verdict"] == "pass"
    assert result["measured_ratio"] == pytest.approx(1.05, abs=0.001)
    assert result["measurement_source"] == "ledger-camera-zoom-ratio"
    assert "ledger_camera_gap" in result


def test_scale_static_camera_fails():
    rows = _ledger([_row(0, "photo", (500, 500), (450, 400, 550, 600), zoom=1.0),
                    _row(8, "photo", (500, 500), (450, 400, 550, 600), zoom=1.0)])
    result = check_scale(rows, _scale_entry(kind="camera"))
    assert result["verdict"] == "fail"
    assert result["measured_ratio"] == pytest.approx(1.00, abs=0.001)


def test_scale_camera_pixel_marker_growth():
    # Marker growth 400 to 420 px, the camera run measurement.
    result = check_scale(_static_ledger(), _scale_entry(kind="camera"),
                         marker_growth=(400.0, 420.0))
    assert result["verdict"] == "pass"
    assert result["measured_ratio"] == pytest.approx(1.05, abs=0.001)
    assert result["measurement_source"] == "pixel-marker-growth"
    result_static = check_scale(_static_ledger(), _scale_entry(kind="camera"),
                                marker_growth=(400.0, 400.0))
    assert result_static["verdict"] == "fail"
    assert result_static["measured_ratio"] == pytest.approx(1.00, abs=0.001)


def _marker_frame(marker_x, marker_y):
    frame = np.zeros((200, 600, 3), dtype=np.uint8)
    frame[:, :, :] = 16
    frame[marker_y - 10:marker_y + 10, marker_x - 10:marker_x + 10] = 232
    return frame


def test_measure_marker_growth_five_percent():
    marker = {"centre": [100, 100],
              "window": {"start_frame": 0, "end_frame": 8},
              "luma_threshold": 100,
              "search_rects": {"start": [450, 80, 60, 40],
                               "end": [470, 80, 60, 40]}}
    frames = [None] * 9
    frames[0] = _marker_frame(500, 100)
    frames[8] = _marker_frame(520, 100)
    start_px, end_px, ratio = measure_marker_growth(frames, marker)
    assert start_px == pytest.approx(400.0, abs=1.0)
    assert end_px == pytest.approx(420.0, abs=1.0)
    assert ratio == pytest.approx(1.05, abs=SCALE_RATIO_BAR)


def test_run_timechecks_pass_and_fail_reports():
    plan = {"clip": "synthetic-pass",
            "checks": [_trajectory_entry(),
                       _saturation_entry("grayscale"),
                       _scale_entry()]}
    report = run_timechecks(_rising_ledger(), _frames(), plan)
    # Scale entry reads the rising ledger, whose bbox width is static,
    # so the pass plan fails on scale only. Rebuild with a growing box.
    assert report["checks"][0]["verdict"] == "pass"
    assert report["checks"][1]["verdict"] == "pass"
    assert report["checks"][2]["verdict"] == "fail"
    assert report["verdict"] == "fail"
    growing = _ledger([
        _row(0, "photo", (500, 500), (450, 400, 850, 600)),
        _row(8, "photo", (500, 487), (450, 387, 870, 587))])
    report = run_timechecks(growing, _frames(), plan)
    assert report["verdict"] == "pass"
    assert [c["verdict"] for c in report["checks"]] == ["pass", "pass", "pass"]
    fail_plan = {"clip": "synthetic-fail",
                 "checks": [_trajectory_entry(),
                            _saturation_entry("grayscale"),
                            _scale_entry()]}
    report = run_timechecks(_static_ledger(), _frames(), fail_plan)
    assert report["verdict"] == "fail"


def test_run_timechecks_no_frames_saturation_fails():
    plan = {"clip": "no-frames",
            "checks": [_saturation_entry("grayscale")]}
    report = run_timechecks(_rising_ledger(), None, plan)
    assert report["verdict"] == "fail"
    assert "no rendered frames" in report["checks"][0]["message"]
