# Benchmarks

Recent results for Headless Motion, measured November 8, 2026, against the frozen bar (pred-v1: mean SSIM at least 0.95, every frame at least 0.90, PSNR at least 35 dB, LPIPS at most 0.08, flat colour under 3 Delta E, motion under 2 px, text shift under 2 px).

"Claimed" means the generator measured it and the independent verifier and judge have not confirmed it yet. "Judge confirmed" means they recomputed it and agreed.

Full method, history, and how to run the benchmark live in `benchmark/README.md`.

| Test | SSIM | PSNR | LPIPS | Verdict |
| --- | --- | --- | --- | --- |
| Seg3 baseline, old code-drawn rebuild | 0.686 | 9.96 dB | 0.656 | Fail, judge confirmed |
| Seg3 single-frame VTracer trace | 0.967 | 26.09 dB | 0.156 | Trace only, judge confirmed |
| Seg3 flow warp, 1 frame apart | 0.999 | 52.93 dB | 0.0004 | Warp only, judge confirmed |
| Ozempic clone, Gate 1, first 10 s, v8 | 0.994 | 39.80 dB | 0.015 | Claimed pass, standard profile |
| Ozempic clone, Gate 2, first 30 s, v8 | 0.993 | 37.39 dB | 0.015 | Claimed pass, standard profile |
| Ozempic clone, Gate 3, full 75 s, light check | 0.990 | 37.86 dB | Unmeasured | Light check only, LPIPS still running |
| Seg4 map clone, v5, 192 frames | 0.794 | 20.21 dB | 0.631 | Fail, measured |
| Seg4 map clone, v6, 192 frames | 0.996 | 41.13 dB | 0.025 | Pass, agent-measured, LPIPS every 8th frame |

Before and after, on the same Ozempic clone: Gate 1 went from v1 SSIM 0.903 and PSNR 17.78 dB, with 105 frames below the floor, to v8 SSIM 0.994 and PSNR 39.80 dB, with 0 frames below the floor. Gate 2 went from PSNR 33.99 dB, failing by 1.01 dB, to 37.39 dB in v8. The Seg4 map retest with the new tools passed on every bar: SSIM 0.794 to 0.996, PSNR 20.21 dB to 41.13 dB, LPIPS 0.631 to 0.025, and the badge at 5.0 s went from 170.9 px off to 0.1 px off. That clone is trace-based, not a code-drawn scene, so it proves the teardown to trace to check pipeline.

## Pass bar per segment

A clone passes only if it meets every number in its segment's bar. The bar is frozen as pred-v1, so it cannot move.

| Segment | SSIM | PSNR | LPIPS | Flat colour |
| --- | --- | --- | --- | --- |
| Kurzgesagt 1 and 2 | 0.98 | 38 dB | 0.05 | under 3 Delta E |
| TED-Ed glue vs tape | 0.95 | 35 dB | 0.08 | under 3 Delta E |
| Search Party map | 0.96 | 35 dB | 0.08 | under 3 Delta E |

- **Example fail:** the TED-Ed baseline scored SSIM 0.686 against its 0.95 bar.
