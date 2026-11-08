"""sRGB to Lab, CIE76 and CIEDE2000. Pure numpy, D65 white point."""
import numpy as np


def _srgb_to_xyz(rgb):
    v = rgb.astype(np.float64) / 255.0
    v = np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    return v @ m.T


def rgb_to_lab(rgb):
    xyz = _srgb_to_xyz(rgb)
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, xyz ** (1 / 3), 7.787 * xyz + 16 / 116)
    lab = np.empty_like(f)
    lab[..., 0] = 116 * f[..., 1] - 16
    lab[..., 1] = 500 * (f[..., 0] - f[..., 1])
    lab[..., 2] = 200 * (f[..., 1] - f[..., 2])
    return lab


def cie76(a, b):
    return float(np.sqrt(np.sum((a - b) ** 2)))


def ciede2000(a, b):
    l1, a1, b1 = a
    l2, a2, b2 = b
    c1 = np.hypot(a1, b1)
    c2 = np.hypot(a2, b2)
    cbar = (c1 + c2) / 2
    g = 0.5 * (1 - np.sqrt(cbar ** 7 / (cbar ** 7 + 25 ** 7)))
    ap1, ap2 = a1 * (1 + g), a2 * (1 + g)
    cp1, cp2 = np.hypot(ap1, b1), np.hypot(ap2, b2)
    hp1 = np.degrees(np.arctan2(b1, ap1)) % 360
    hp2 = np.degrees(np.arctan2(b2, ap2)) % 360
    dl = l2 - l1
    dc = cp2 - cp1
    if cp1 * cp2 == 0:
        dh = 0.0
    else:
        dh = hp2 - hp1
        if dh > 180:
            dh -= 360
        elif dh < -180:
            dh += 360
    dh = 2 * np.sqrt(cp1 * cp2) * np.sin(np.radians(dh) / 2)
    lbar = (l1 + l2) / 2
    cbarp = (cp1 + cp2) / 2
    if cp1 * cp2 == 0:
        hbar = hp1 + hp2
    elif abs(hp1 - hp2) <= 180:
        hbar = (hp1 + hp2) / 2
    elif hp1 + hp2 < 360:
        hbar = (hp1 + hp2 + 360) / 2
    else:
        hbar = (hp1 + hp2 - 360) / 2
    t = (1 - 0.17 * np.cos(np.radians(hbar - 30)) + 0.24 * np.cos(np.radians(2 * hbar))
         + 0.32 * np.cos(np.radians(3 * hbar + 6)) - 0.20 * np.cos(np.radians(4 * hbar - 63)))
    dt = 30 * np.exp(-((hbar - 275) / 25) ** 2)
    rc = 2 * np.sqrt(cbarp ** 7 / (cbarp ** 7 + 25 ** 7))
    sl = 1 + 0.015 * (lbar - 50) ** 2 / np.sqrt(20 + (lbar - 50) ** 2)
    sc = 1 + 0.045 * cbarp
    sh = 1 + 0.015 * cbarp * t
    rt = -np.sin(np.radians(2 * dt)) * rc
    return float(np.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dh / sh) ** 2 + rt * (dc / sc) * (dh / sh)))


def median_lab(frame, rect):
    x, y, w, h = rect
    region = frame[y:y + h, x:x + w]
    lab = rgb_to_lab(region.reshape(-1, 3))
    return np.median(lab, axis=0)
