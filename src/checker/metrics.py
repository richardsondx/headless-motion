"""SSIM on Rec.709 luma (Gaussian sigma 1.5) and PSNR on RGB, numpy only.

scikit-image is not installed here, so SSIM is implemented directly:
the standard 11x11 Gaussian window, C1 and C2 from the original paper.
"""
import numpy as np

_REC709 = np.array([0.2126, 0.7152, 0.0722])


def luma(rgb):
    return rgb.astype(np.float32) @ _REC709.astype(np.float32)


def _gaussian_kernel(sigma=1.5, size=11):
    x = np.arange(size) - size // 2
    k = np.exp(-(x ** 2) / (2 * sigma ** 2))
    return k / k.sum()


def _blur(img, kernel):
    out = img.copy()
    for axis in (0, 1):
        acc = np.zeros_like(out)
        r = len(kernel) // 2
        padded = np.pad(out, [(r, r), (0, 0)] if axis == 0 else [(0, 0), (r, r)], mode="reflect")
        for i, w in enumerate(kernel):
            acc += w * (padded[i:i + out.shape[axis]] if axis == 0 else padded[:, i:i + out.shape[axis]])
        out = acc
    return out


def ssim_frame(a_luma, b_luma):
    k = _gaussian_kernel()
    mu_a = _blur(a_luma, k)
    mu_b = _blur(b_luma, k)
    mu_a2, mu_b2, mu_ab = mu_a * mu_a, mu_b * mu_b, mu_a * mu_b
    var_a = _blur(a_luma * a_luma, k) - mu_a2
    var_b = _blur(b_luma * b_luma, k) - mu_b2
    cov = _blur(a_luma * b_luma, k) - mu_ab
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ssim_map = ((2 * mu_ab + c1) * (2 * cov + c2)
                / ((mu_a2 + mu_b2 + c1) * (var_a + var_b + c2)))
    return float(ssim_map.mean())


def psnr_frame(a, b):
    mse = float(np.mean((a.astype(np.float32) - b.astype(np.float32)) ** 2))
    if mse == 0:
        return 100.0
    return min(100.0, 10 * np.log10(255.0 ** 2 / mse))
