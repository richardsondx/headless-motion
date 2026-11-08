"""Phase correlation on luma, numpy FFT, 20x upsampled refinement.

Equivalent in spirit to skimage.registration.phase_cross_correlation
with upsample_factor=20, which is not installed here. The shift is the
translation of the render relative to the reference, in pixels.
"""
import numpy as np


def phase_shift(ref_luma, render_luma, upsample=20):
    """Return (shift_y, shift_x) in pixels, or None when unmeasurable."""
    a = ref_luma - ref_luma.mean()
    b = render_luma - render_luma.mean()
    if a.std() < 1e-6 or b.std() < 1e-6:
        return None
    fa = np.fft.fft2(a)
    fb = np.fft.fft2(b)
    # conj(ref) * render: the peak sits at the render's shift from the ref.
    cross = np.conj(fa) * fb
    mag = np.abs(cross)
    if mag.max() < 1e-12:
        return None
    safe = np.where(mag > 1e-12, mag, 1.0)
    cross = np.where(mag > 1e-12, cross / safe, 0.0)
    corr = np.fft.ifft2(cross).real
    y0, x0 = np.unravel_index(np.argmax(corr), corr.shape)
    h, w = corr.shape
    # Integer peak as a signed shift.
    sy = y0 if y0 <= h // 2 else y0 - h
    sx = x0 if x0 <= w // 2 else x0 - w
    # 20x refinement around the integer peak: evaluate the inverse DFT
    # of the cross-power spectrum at fractional positions (Guizar-Sicairos).
    up = upsample
    region = 1.5  # pixels around the peak
    size = int(np.ceil(region * up))
    offs = (np.arange(size) - size // 2) / up
    # Integer frequency indices, not signed fftfreq: the signed form adds a
    # phase ramp that moves the peak at fractional positions.
    ky = np.exp(2j * np.pi * (sy + offs)[:, None] * np.arange(h)[None, :] / h)
    kx = np.exp(2j * np.pi * (sx + offs)[None, :] * np.arange(w)[:, None] / w)
    refined = ky @ cross @ kx
    iy, ix = np.unravel_index(np.argmax(np.abs(refined)), refined.shape)
    return float(sy + offs[iy]), float(sx + offs[ix])
