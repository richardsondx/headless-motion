"""Unit tests for the layer layout check (checker/layout.py).

Synthetic flat frames with known boxes must return exact known ratios.
No real frames, no models, no network.
"""
import numpy as np
import pytest

from checker import layout

W, H = 1920, 1080


def frame_with(rects):
    """Build a frame: base land colour, then flat rects (rgb, x0, y0, x1, y1)."""
    f = np.zeros((H, W, 3), dtype=np.uint8)
    f[:] = layout.PALETTE["base"]
    for rgb, x0, y0, x1, y1 in rects:
        f[y0:y1, x0:x1] = rgb
    return f


def test_ratio_math_exact():
    # Teal rect at (100, 200)-(300, 400), stride-aligned. Stride-2 samples
    # are x 100..298 and y 200..398, so the centroid is (199, 299).
    f = frame_with([(layout.PALETTE["sudan"], 100, 200, 300, 400)])
    seg = layout.segment_frame(f)
    s = seg["sudan"]
    assert s["present"] is True
    assert s["bbox"] == [100, 200, 300, 400]
    # Ratios are rounded to 4 decimals in the module, so compare to 1e-4.
    assert s["centroid_ratio"] == [pytest.approx(199 / W, abs=1e-4),
                                   pytest.approx(299 / H, abs=1e-4)]
    assert s["bbox_ratio"] == [pytest.approx(100 / W, abs=1e-4), pytest.approx(200 / H, abs=1e-4),
                               pytest.approx(200 / W, abs=1e-4), pytest.approx(200 / H, abs=1e-4)]
    assert s["area_ratio"] == pytest.approx(200 * 200 / (W * H), abs=1e-4)
    assert s["border_ratio"] == {"left": pytest.approx(100 / W, abs=1e-4),
                                 "right": pytest.approx((W - 300) / W, abs=1e-4),
                                 "top": pytest.approx(200 / H, abs=1e-4),
                                 "bottom": pytest.approx((H - 400) / H, abs=1e-4)}
    assert s["median_hex"] == "#143C34"
    assert s["flags"] == []


def test_aspect_mapping_known_points():
    # Player rect corners map to frame corners (x1/y1 are last pixels,
    # so the far corner lands ~1.3 px short of 1920x1080).
    assert layout.map_real_to_1080(185, 55) == pytest.approx((0, 0), abs=0.01)
    assert layout.map_real_to_1080(1717, 885) == pytest.approx((1920, 1080), abs=2)
    # Trace SUDAN centre at 0:01, screenshot (1009, 570) -> 1080 space (1032, 669).
    x, y = layout.map_real_to_1080(1009, 570)
    assert x == pytest.approx(1032, abs=1)
    assert y == pytest.approx(669, abs=1)
    m = layout.aspect_mapping()
    assert m["real_aspect"] == pytest.approx(1.845, abs=0.001)
    assert m["render_aspect"] == pytest.approx(16 / 9, abs=0.001)


def test_segmentation_synthetic_layers():
    f = frame_with([
        (layout.PALETTE["sudan"], 500, 300, 900, 700),
        (layout.PALETTE["rsf"], 1000, 500, 1132, 636),  # 132x136 compact square
        (layout.PALETTE["october"], 100, 100, 300, 120),
    ])
    # Five white glyph bars for a SUDAN label, 28 px wide each.
    for i in range(5):
        f[800:832, 600 + i * 40: 600 + i * 40 + 28] = (255, 255, 255)
    seg = layout.segment_frame(f)
    assert seg["sudan"]["bbox"] == [500, 300, 900, 700]
    assert seg["sudan"]["median_hex"] == "#143C34"
    assert seg["rsf"]["present"] is True
    assert seg["rsf"]["bbox"] == [1000, 500, 1132, 636]
    assert seg["rsf"]["median_hex"] == "#CC4726"
    assert seg["october"]["present"] is True
    assert seg["october"]["bbox"] == [100, 100, 300, 120]
    clusters = layout.text_clusters(seg["white_text"]["components"])
    assert len(clusters) == 1
    assert clusters[0]["n_components"] == 5
    assert clusters[0]["bbox"] == [600, 800, 788, 832]
    names = layout.identify_labels(clusters)
    assert names["sudan"] is clusters[0]
    assert names["el_fasher"] is None


def test_rsf_discriminator_rejects_flood():
    # Wide flat orange frame, not touching the edge: flood, not a badge.
    # Fill is about 0.14, below the 0.25 minimum, and aspect is 2.46.
    f = frame_with([(layout.PALETTE["rsf"], 936, 100, 1900, 492)])
    f[120:472, 952:1880] = layout.PALETTE["base"]
    seg = layout.segment_frame(f)
    assert seg["rsf"]["present"] is False
    assert "REJECTED_BY_DISCRIMINATOR" in seg["rsf"]["flags"]
    assert seg["rsf"]["discriminator"]["fill"] < layout.RSF_FILL_MIN


def test_merged_sudan_flagged():
    # Teal wider than 40% of the frame is the whole map, not Sudan.
    f = frame_with([(layout.PALETTE["sudan"], 100, 100, 1800, 900)])
    seg = layout.segment_frame(f)
    assert seg["sudan"]["present"] is True
    assert "MERGED_WITH_BASE" in seg["sudan"]["flags"]


def test_pair_gap_exact():
    # pair_gap rounds to 4 decimals, so compare with a 1e-4 window.
    g = layout.pair_gap((783, 646), (850, 638), 1920)
    assert g["dx_ratio"] == pytest.approx(67 / 1920, abs=1e-4)
    assert g["dy_ratio"] == pytest.approx(-8 / 1920, abs=1e-4)
    assert g["dist_ratio"] == pytest.approx(((67 ** 2 + 8 ** 2) ** 0.5) / 1920, abs=1e-4)
    assert layout.pair_gap(None, (850, 638), 1920) is None
    assert layout.pair_gap((783, 646), None, 1920) is None


def test_gap_check_tolerance():
    assert layout.gap_check(0.078, 0.080, 0.02) == {"gap": 0.002, "pass": True, "status": "pass"}
    assert layout.gap_check(0.078, 0.455, 0.02)["status"] == "fail"
    assert layout.gap_check(0.078, None, 0.02)["status"] == "unmeasurable"


def test_find_dot_synthetic():
    f = frame_with([])
    f[640:652, 777:789] = (255, 255, 255)  # 12x12 bright dot at (783, 646)
    dot = layout.find_dot(f, (783, 646))
    assert dot is not None
    assert dot["centroid"] == pytest.approx([782.5, 645.5], abs=1.0)
    assert dot["pixels"] == 144
    # Empty frame: no dot.
    assert layout.find_dot(frame_with([]), (783, 646)) is None


def test_match_label_near_synthetic():
    f = frame_with([])
    for i in range(5):
        f[500:532, 900 + i * 40: 900 + i * 40 + 28] = (255, 255, 255)
    m = layout.match_label_near(f, (984, 528))
    assert m is not None
    assert m["bbox"] == [900, 500, 1088, 532]
    assert m["n_components"] == 5
    # Far from the label: nothing matches.
    assert layout.match_label_near(f, (100, 100)) is None


def test_stages_unchanged_without_layout_check(tmp_path):
    """run_check with no layout_check key: no S8 stage, same verdict path."""
    import json
    from pathlib import Path

    from checker.stages import run_check

    fix = Path(__file__).resolve().parent / "fixtures"
    cfg = json.loads((fix / "seg3-test.json").read_text())
    assert "layout_check" not in cfg
    res = run_check(cfg, str(fix / "identical" / "video.mp4"),
                    str(fix / "ref.mp4"), tmp_path)
    assert "S8" not in res["stages_run"]
    assert res["stages_run"] == ["S0", "S1", "S2", "S3", "S4", "S5", "S6"]
    assert res["failures"] == []
    # Verdict depends on the environment: LPIPS loads under the venv
    # (S6 passes, verdict PENDING_HUMAN) but not under system python
    # (S6 incomplete, verdict INCOMPLETE). Either is the pre-change
    # behaviour for this fixture; the regression proof is the stages list.
    assert res["verdict"] in ("INCOMPLETE", "PENDING_HUMAN")


def test_text_clusters_stray_does_not_split_label():
    # "EL FASHER" style: a 121 px space inside the label, plus a stray
    # speck between two letters in x-order but on another baseline.
    comps = [
        {"n": 500, "bbox": [816, 274, 843, 306], "centroid": [829.0, 290.0]},
        {"n": 500, "bbox": [964, 272, 992, 306], "centroid": [978.0, 289.0]},
        {"n": 144, "bbox": [950, 530, 970, 550], "centroid": [960.0, 540.0]},
        {"n": 500, "bbox": [1001, 273, 1028, 305], "centroid": [1014.0, 289.0]},
    ]
    clusters = layout.text_clusters(comps)
    labels = [c for c in clusters if c["n_components"] >= 3]
    assert len(labels) == 1
    assert labels[0]["bbox"] == [816, 272, 1028, 306]
    assert labels[0]["n_components"] == 3
    # One label cluster is named SUDAN (the documented rule).
    names = layout.identify_labels(clusters)
    assert names["sudan"] is labels[0]
    assert names["el_fasher"] is None
    assert names["flags"] == []
