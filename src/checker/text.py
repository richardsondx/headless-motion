"""Label checks: ink box from Otsu on luma, shift, overlap, 2x crop SSIM."""
import numpy as np

from .metrics import ssim_frame


def otsu_threshold(luma):
    hist, _ = np.histogram(luma, bins=256, range=(0, 255))
    hist = hist.astype(np.float64)
    total = hist.sum()
    if total == 0:
        return 128
    p = hist / total
    omega = np.cumsum(p)
    mu = np.cumsum(p * np.arange(256))
    mu_t = mu[-1]
    valid = (omega > 0) & (omega < 1)
    with np.errstate(divide="ignore", invalid="ignore"):
        sigma_b2 = np.where(valid, (mu_t * omega - mu) ** 2 / (omega * (1 - omega)), 0)
    return int(np.argmax(sigma_b2))


def ink_box(luma_frame, rect):
    """Bounding box of the label ink inside rect, as [x0,y0,x1,y1].

    Ink is the minority side of the Otsu threshold: dark text on a light
    ground, or light text on a darker ground. The ground is the majority.
    """
    x, y, w, h = rect
    region = luma_frame[y:y + h, x:x + w]
    thr = otsu_threshold(region)
    dark = region < thr
    ink = dark if dark.sum() <= (~dark).sum() else ~dark
    if not ink.any():
        return None
    ys, xs = np.where(ink)
    return [int(x + xs.min()), int(y + ys.min()), int(x + xs.max()), int(y + ys.max())]


def box_iou(a, b):
    if a is None or b is None:
        return 0.0
    x0 = max(a[0], b[0])
    y0 = max(a[1], b[1])
    x1 = min(a[2], b[2])
    y1 = min(a[3], b[3])
    inter = max(0, x1 - x0 + 1) * max(0, y1 - y0 + 1)
    area_a = (a[2] - a[0] + 1) * (a[3] - a[1] + 1)
    area_b = (b[2] - b[0] + 1) * (b[3] - b[1] + 1)
    return inter / (area_a + area_b - inter)


def box_shift(a, b):
    """Largest edge shift in px between two boxes."""
    if a is None or b is None:
        return None
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]), abs(a[3] - b[3]))


def crop_ssim_2x(ref_rgb, render_rgb, rect):
    """SSIM of the rect upscaled 2x with Lanczos (Pillow), luma only."""
    from PIL import Image
    x, y, w, h = rect
    def crop(frame):
        img = Image.fromarray(frame[y:y + h, x:x + w]).resize((w * 2, h * 2), Image.LANCZOS)
        return np.asarray(img)
    a = crop(ref_rgb)
    b = crop(render_rgb)
    from .metrics import luma
    return ssim_frame(luma(a), luma(b))
