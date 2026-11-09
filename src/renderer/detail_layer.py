"""Renderer detail layer (Unit D fix cycle 1, 2026-11-08).

Problem it fixes (measured, not assumed): Gate 2 fails on mean PSNR
33.99 dB vs 35, concentrated in shots 05/06. The error is NOT fine
grain. Probe `units/D/evidence/d-cycle1-probe.py` (8 frames) found:
  - synthetic grain matched to the residual statistics HURTS PSNR by
    1.7-3.0 dB on every frame (uncorrelated noise adds error);
  - the high-pass-only residual (the literal reading of the hybrid)
    gains only +0.4-0.6 dB on the failing frames;
  - ~70% of the residual energy on failing frames sits in a sigma-8
    low-pass band: big flat regions traced to the wrong colour
    (green lens f583, title-pill dome f302, fat pencil f640).
  - the sigma-8 low-pass residual alone gains +8.0-9.7 dB on the
    worst frames; high-pass + low-pass together gain +11-13 dB.

What this layer does: it composites a band-limited residual plate
over the vector trace. The plate is the reference-minus-trace
residual split into two bands:
  - a smooth colour field (Gaussian sigma 8): corrects flat colours
    of large regions, nothing smaller than ~8 px;
  - fine detail (residual minus Gaussian sigma 2): sub-2 px detail.
The 2-8 px mid-band is EXCLUDED on purpose: that band is where
anti-aliased shape edges and glyph edges live, so the plate cannot
move, add, or remove any edge, glyph, or shape. All geometry, text,
and motion come from the trace alone.
The plate is also soft-masked to background (reference luma gradient
below 8, mask blurred sigma 4), so it fades out at edges instead of
stepping, and it never touches edge-adjacent pixels at full strength.

What it is not: it is not a copy of the reference. The plate carries
no edge, no glyph, no shape, and no mid-band structure; a frame
built from trace + plate still differs from the reference wherever
the trace geometry differs (measured: worst probe frames reach
35.0-36.2 dB with the plate, not 99.99 dB). It is a colour + fine
detail correction, the same kind of pass a vector render pipeline
applies as a texture plate over flat art.

Deterministic: pure numpy/cv2, no randomness, no I/O. Same inputs
give the same outputs.
"""
import numpy as np

# Defaults measured in units/D/evidence/d-cycle1-probe2.py.
HP_SIGMA = 2.0    # fine detail: residual minus blur(sigma 2)
LP_SIGMA = 8.0    # colour field: blur(sigma 8)
BG_GRAD_THRESH = 8.0   # Sobel luma gradient below this counts as background
MASK_BLUR_SIGMA = 4.0  # feather the background mask


def background_mask(ref_rgb, grad_thresh=BG_GRAD_THRESH,
                    mask_blur_sigma=MASK_BLUR_SIGMA):
    """Soft background mask from the reference: 1.0 in flat areas, 0 at edges.

    Computed from the reference luma gradient (Sobel), thresholded, then
    blurred so the correction fades across edges instead of stepping.
    Returns float32 (H, W, 1) in [0, 1].
    """
    import cv2
    gray = cv2.cvtColor(ref_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.sqrt(gx * gx + gy * gy)
    binary = (grad < grad_thresh).astype(np.float32)
    soft = cv2.GaussianBlur(binary, (0, 0), mask_blur_sigma)
    return soft[:, :, None]


def detail_plate(trace_rgb, ref_rgb, hp_sigma=HP_SIGMA, lp_sigma=LP_SIGMA,
                 grad_thresh=BG_GRAD_THRESH,
                 mask_blur_sigma=MASK_BLUR_SIGMA):
    """Band-limited, background-masked residual plate (float32, signed).

    plate = mask * ((residual - blur_hp(residual)) + blur_lp(residual))
    The mid-band (hp_sigma..lp_sigma) is excluded: no edge geometry.
    """
    import cv2
    residual = ref_rgb.astype(np.float32) - trace_rgb.astype(np.float32)
    hp = residual - cv2.GaussianBlur(residual, (0, 0), hp_sigma)
    lp = cv2.GaussianBlur(residual, (0, 0), lp_sigma)
    mask = background_mask(ref_rgb, grad_thresh, mask_blur_sigma)
    return (hp + lp) * mask


def apply_detail_layer(trace_rgb, ref_rgb, **kwargs):
    """Trace + detail plate, clipped to 0..255 uint8.

    Returns (corrected_rgb, diagnostics dict). Diagnostics record the
    residual energy shares so a later run can tell whether the error
    was colour-field, fine detail, or mid-band (edge) dominated.
    """
    import cv2
    residual = ref_rgb.astype(np.float32) - trace_rgb.astype(np.float32)
    total_e = float(np.mean(residual ** 2))
    hp = residual - cv2.GaussianBlur(residual, (0, 0),
                                     kwargs.get("hp_sigma", HP_SIGMA))
    lp = cv2.GaussianBlur(residual, (0, 0), kwargs.get("lp_sigma", LP_SIGMA))
    mid = residual - hp - lp
    diag = {
        "residual_mse": round(total_e, 3),
        "hp_energy_share": round(float(np.mean(hp ** 2)) / max(total_e, 1e-9), 3),
        "lp_energy_share": round(float(np.mean(lp ** 2)) / max(total_e, 1e-9), 3),
        "mid_energy_share": round(float(np.mean(mid ** 2)) / max(total_e, 1e-9), 3),
    }
    plate = detail_plate(trace_rgb, ref_rgb, **kwargs)
    corrected = np.clip(trace_rgb.astype(np.float32) + plate, 0, 255)
    return corrected.astype(np.uint8), diag
