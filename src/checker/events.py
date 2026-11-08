"""Event checks: frame-difference energy inside a rect over a window."""
import numpy as np

from .metrics import luma


def frame_diff_energy(frames, rect, window):
    """Per-frame mean absolute luma difference inside rect, over the window."""
    x, y, w, h = rect
    f0, f1 = window
    energies = []
    prev = None
    for f in range(f0, f1 + 1):
        cur = luma(frames[f][y:y + h, x:x + w])
        if prev is not None:
            energies.append((f, float(np.mean(np.abs(cur - prev)))))
        prev = cur
    return energies
