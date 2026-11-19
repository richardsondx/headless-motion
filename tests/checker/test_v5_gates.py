"""U4 tests: V5 perceptual gates on synthetic PIL images (exact
control, no renderer in the loop). Each gate must pass a clean input
and fail a dirty one, so a gate that always passes cannot hide here.
"""
import math

import numpy as np
import pytest
from PIL import Image, ImageDraw

from checker.v5_gates import (
    BAR_C0_DEG,
    c0_corner_audit,
    foot_slip_px,
    front_symmetry_iou,
    seam_leak_count,
    silhouette_iou,
)

W, H = 320, 500


def save(img, tmp_path, name):
    p = tmp_path / name
    img.save(p)
    return str(p)


def blank():
    return Image.new("RGB", (W, H), (255, 255, 255))


def disc_png(tmp_path, name, hole=False):
    img = blank()
    d = ImageDraw.Draw(img)
    d.ellipse([60, 100, 260, 400], fill=(0, 0, 0))
    if hole:
        d.ellipse([140, 220, 180, 260], fill=(255, 255, 255))
    return save(img, tmp_path, name)


def test_seam_leak_clean_disc_is_zero_and_holed_disc_is_one(tmp_path):
    assert seam_leak_count(disc_png(tmp_path, "clean.png"))["seam_leak_count"] == 0
    assert seam_leak_count(disc_png(tmp_path, "hole.png", hole=True))["seam_leak_count"] == 1


def foot_png(tmp_path, name, foot_cx):
    img = blank()
    d = ImageDraw.Draw(img)
    # Orange foot: 57 px wide, flat bottom at y 480, like Milo M22.
    d.rectangle([foot_cx - 28, 458, foot_cx + 28, 480], fill=(244, 143, 52))
    return save(img, tmp_path, name)


def test_foot_slip_zero_on_the_pin_and_measures_a_shift(tmp_path):
    box = [100, 440, 220, 490]
    # The synthetic foot has no turnout shear, so pass turnout_deg=0.
    on = foot_slip_px(foot_png(tmp_path, "on.png", 160), 160, box, scale=1.0, turnout_deg=0)
    assert on["foot_slip_px"] == 0.0
    off = foot_slip_px(foot_png(tmp_path, "off.png", 165), 160, box, scale=1.0, turnout_deg=0)
    assert abs(off["foot_slip_px"] - 5.0) < 0.6
    # The morph's known sole offset (toe forward, heel tucked) is
    # subtracted, not counted as slip: a foot 1 px forward by design
    # reads 0 slip when the caller passes expected_offset_fig=1.
    off2 = foot_slip_px(foot_png(tmp_path, "off2.png", 161), 160, box, scale=1.0,
                        expected_offset_fig=1.0, turnout_deg=0)
    assert abs(off2["foot_slip_px"]) < 0.6


def sym_png(tmp_path, name, asymmetric=False):
    img = blank()
    d = ImageDraw.Draw(img)
    # Two legs, symmetric about x=160, in the legs band y 380-480.
    d.rectangle([110, 380, 140, 480], fill=(244, 143, 52))
    d.rectangle([180, 380, 210, 480], fill=(244, 143, 52))
    if asymmetric:
        d.rectangle([180, 380, 230, 480], fill=(244, 143, 52))
    return save(img, tmp_path, name)


def test_front_symmetry_is_one_when_symmetric_and_drops_when_not(tmp_path):
    regions = [[100, 380, 220, 490]]
    sym = front_symmetry_iou(sym_png(tmp_path, "sym.png"), 160, regions)
    assert sym["front_symmetry_iou"] == pytest.approx(1.0, abs=0.01)
    asym = front_symmetry_iou(sym_png(tmp_path, "asym.png", asymmetric=True), 160, regions)
    assert asym["front_symmetry_iou"] < 0.94


def test_separability_same_pose_is_one_and_other_pose_is_low(tmp_path):
    a = disc_png(tmp_path, "a.png")
    b = disc_png(tmp_path, "b.png")
    assert silhouette_iou(a, b)["silhouette_iou"] == pytest.approx(1.0, abs=0.01)
    img = blank()
    d = ImageDraw.Draw(img)
    d.rectangle([140, 100, 180, 400], fill=(0, 0, 0))
    c = save(img, tmp_path, "c.png")
    assert silhouette_iou(a, c)["silhouette_iou"] < 0.78


def smooth_ellipse_d(cx, cy, rx, ry):
    k = 0.5522847498
    return (
        f"M {cx},{cy - ry} "
        f"C {cx + rx * k},{cy - ry} {cx + rx},{cy - ry * k} {cx + rx},{cy} "
        f"C {cx + rx},{cy + ry * k} {cx + rx * k},{cy + ry} {cx},{cy + ry} "
        f"C {cx - rx * k},{cy + ry} {cx - rx},{cy + ry * k} {cx - rx},{cy} "
        f"C {cx - rx},{cy - ry * k} {cx - rx * k},{cy - ry} {cx},{cy - ry} Z"
    )


def test_c0_audit_zero_on_a_smooth_ellipse_and_counts_a_sharp_join(tmp_path):
    assert c0_corner_audit([smooth_ellipse_d(160, 250, 64, 97)])["c0_corner_count"] == 0
    # Two cubics meeting at a right angle: a 90 deg tangent gap.
    corner = (
        "M 0,0 C 10,0 20,0 30,0 "
        "C 30,10 30,20 30,30 "
        "C 20,30 10,30 0,30 "
        "C 0,20 0,10 0,0 Z"
    )
    r = c0_corner_audit([corner])
    assert r["c0_corner_count"] >= 1
    assert r["corners"][0]["gap_deg"] >= BAR_C0_DEG
