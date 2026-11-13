"""Cutout tests: build a synthetic flat sheet in memory and check
the chroma-key rule, the border-only flood, the speck drop, the
neck split and the fringe clamp. Run: python3 tests/rig/cutout.test.py
No model, no network, no cv2. Pillow + numpy only.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src" / "rig"))

import numpy as np
from PIL import Image

import cutout

GREEN = (0, 177, 64)
SKIN = (244, 164, 96)
SHIRT = (43, 45, 66)


def make_sheet(path):
    """400x300 green sheet, one armless figure: round head on a
    narrow neck over a wide body, plus a small green island inside
    the body (a dark-green patch that must NOT leak) and a 3 px speck.
    """
    img = Image.new("RGB", (400, 300), GREEN)
    px = img.load()
    # Head: circle centre (200,70) r 45.
    for y in range(300):
        for x in range(400):
            if (x - 200) ** 2 + (y - 70) ** 2 <= 45 ** 2:
                px[x, y] = SKIN
    # Neck: x 190-210, y 110-140.
    for y in range(110, 141):
        for x in range(190, 211):
            px[x, y] = SKIN
    # Body: x 140-260, y 140-280.
    for y in range(140, 281):
        for x in range(140, 261):
            px[x, y] = SHIRT
    # Dark green patch inside the body: G-max(R,B) is 60 here, over
    # 40, so a naive key would eat it. Border flood must not reach it.
    for y in range(200, 220):
        for x in range(180, 200):
            px[x, y] = (0, 90, 30)
    # Speck: 3x3 skin square far from the figure.
    for y in range(20, 23):
        for x in range(20, 23):
            px[x, y] = SKIN
    img.save(path)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        sheet = Path(tmp) / "sheet.png"
        make_sheet(sheet)
        out = Path(tmp) / "out"
        report = cutout.cutout(str(sheet), str(out), chroma="green")
        rgba = np.array(Image.open(out / "sheet-cut.png"))
        alpha = rgba[:, :, 3]
        assert report["chroma"] == "green", report
        assert len(report["figures"]) == 1, report["figures"]
        assert report["specks_dropped"] == 1, report
        # Border is transparent, figure centre is opaque.
        assert alpha[0, 0] == 0, "border must be keyed out"
        assert alpha[70, 200] == 255, "head centre must stay opaque"
        assert alpha[200, 200] == 255, "body centre must stay opaque"
        # The dark-green patch inside the body must NOT leak.
        assert alpha[210, 190] == 255, "inner green patch must not be keyed (border-only rule)"
        # The speck must be gone.
        assert alpha[21, 21] == 0, "speck must be dropped"
        # Neck found in the narrow band, between head and body.
        neck = report["figures"][0]["neck_y"]
        assert neck is not None and 110 <= neck <= 140, f"neck {neck} outside 110-140"
        # Sockets measured at neck + 12% of figure height.
        sockets = report["figures"][0]["sockets"]
        assert sockets is not None, "sockets must be measured"
        assert sockets["left"]["x"] < 200 < sockets["right"]["x"], sockets
        # Head / body split files exist; body top rows are inpainted.
        assert (out / "sheet-head.png").exists()
        assert (out / "sheet-body.png").exists()
        body = np.array(Image.open(out / "sheet-body.png"))
        assert body[neck, 200, 3] == 255, "body top row under the head must be inpainted opaque"
        # Eye boxes are null, not invented.
        assert report["eye_boxes"] is None
        assert report["skin_rgb"] is None
        print("cutout tests PASS")
        print(f"neck_y={neck} sockets={sockets} figures={len(report['figures'])}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
