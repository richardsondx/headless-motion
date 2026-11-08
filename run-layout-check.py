"""Run the layer layout check: v4 vs real Seg4 opening, paired seconds 1/4/5/7.

Reuses the frames and the SSIM/PSNR/LPIPS/Delta E numbers from
verify-seg4/evidence/v4-vs-real-numbers.json (no LPIPS re-run, no
240-frame run). Adds layer-separated layout numbers from
src/checker/layout.py: ratios, border distances, zoom curve, pair gaps.

Real-side ground truth comes from verify-seg4/evidence/seg4-trace.json.
Segmentation is cross-checked against the trace before any v4 number
is trusted (see the "validation" section of the output).

Usage: ./run-layout-check.py [--out path] [--feel]
  --feel  ask for the DreamSim feel score; it reports "not run" because
          the weights are absent, and no download is attempted.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "src"))

from checker import color as _color  # noqa: E402
from checker import layout  # noqa: E402

EVID = HERE / "verify-seg4" / "evidence"
WORK = EVID / "work"
SECONDS = (1, 4, 5, 7)
V4_FILES = {1: EVID / "v4-f24.png", 4: WORK / "v4-4s.png",
            5: EVID / "v4-f120.png", 7: WORK / "v4-7s.png"}
TOL = {"position_ratio": 0.02, "border_ratio": 0.02,
       "zoom_ratio": 0.02, "pair_gap_ratio": 0.02}
PRED_V1_SEG4 = {"mean_ssim": 0.96, "mean_psnr_db": 35,
                "mean_lpips_max": 0.08, "flat_delta_e_max": 3}


def load(path):
    return np.array(Image.open(path).convert("RGB"))


def hex_rgb(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


def delta_es(a_hex, b_hex):
    """CIEDE2000 and CIE76 between two hex colours."""
    la = _color.rgb_to_lab(np.array(hex_rgb(a_hex), dtype=np.float64).reshape(1, 1, 3))[0, 0]
    lb = _color.rgb_to_lab(np.array(hex_rgb(b_hex), dtype=np.float64).reshape(1, 1, 3))[0, 0]
    return {"ciede2000": round(_color.ciede2000(la, lb), 2),
            "cie76": round(_color.cie76(la, lb), 2)}


def ratio_gap(a, b):
    """Euclidean gap between two [x, y] ratio points, or None."""
    if a is None or b is None:
        return None
    return round(float(np.hypot(a[0] - b[0], a[1] - b[1])), 4)


def check(value, tol):
    if value is None:
        return {"gap": None, "pass": None, "status": "unmeasurable"}
    return {"gap": value, "pass": bool(value <= tol),
            "status": "pass" if value <= tol else "fail"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(EVID / "v4-vs-real-layout.json"))
    ap.add_argument("--feel", action="store_true",
                    help="DreamSim feel score (reports not run; no download)")
    args = ap.parse_args()
    t_start = time.time()

    trace = json.loads((EVID / "seg4-trace.json").read_text())
    numbers = json.loads((EVID / "v4-vs-real-numbers.json").read_text())
    # Whole-second widths only; 0:03 has early/late variants, not used here.
    sudan_w = {int(k.split(":")[1]): v for k, v in
               trace["camera"]["sudan_width_px_1920x1080"].items() if "_" not in k}
    # Whole-second centres only; 0:03 has early/late variants, not used here.
    sudan_label = {int(k): v for k, v in
                   trace["labels"]["sudan"]["centre_1920x1080_by_second"].items()
                   if k.isdigit()}
    rsf_centre = {int(k): v for k, v in
                  trace["rsf_badge"]["centre_1920x1080_by_second"].items()
                  if k.isdigit()}
    rsf_size = {int(k): v for k, v in
                trace["rsf_badge"]["size_px_1920x1080_by_second"].items()
                if k.isdigit()}
    elf = trace["labels"]["el_fasher"]
    dot = trace["labels"]["el_fasher_dot"]
    october = trace["labels"]["october_2025"]

    pairs = {}
    validation = {"sudan_width_seg_vs_trace": {}, "rsf_bbox_seg_vs_trace": {},
                  "label_match_real": {}, "dot_found_real": {}}
    zoom_rows = []
    all_gaps = []

    for sec in SECONDS:
        real = load(WORK / f"real-{sec}s.png")
        v4 = load(V4_FILES[sec])
        assert real.shape == v4.shape == (1080, 1920, 3), (sec, real.shape, v4.shape)
        rseg = layout.segment_frame(real)
        vseg = layout.segment_frame(v4)
        prev = numbers["pairs"][str(sec)]

        # --- validation: does segmentation reproduce the trace on the real side?
        r_sudan_w = rseg["sudan"]["bbox_ratio"][2] if rseg["sudan"]["present"] else None
        t_sudan_w = sudan_w[sec] / 1920
        validation["sudan_width_seg_vs_trace"][sec] = {
            "segmented_ratio": r_sudan_w, "trace_ratio": round(t_sudan_w, 4),
            "gap": None if r_sudan_w is None else round(abs(r_sudan_w - t_sudan_w), 4)}
        if sec in rsf_centre and rseg["rsf"]["present"]:
            rw, rh = rsf_size[sec]
            tx0 = rsf_centre[sec][0] - rw / 2
            ty0 = rsf_centre[sec][1] - rh / 2
            rb = rseg["rsf"]["bbox"]
            validation["rsf_bbox_seg_vs_trace"][sec] = {
                "segmented_bbox": rb, "trace_bbox": [round(tx0), round(ty0),
                                                     round(tx0 + rw), round(ty0 + rh)],
                "max_edge_gap_px": max(abs(rb[0] - tx0), abs(rb[1] - ty0),
                                       abs(rb[2] - (tx0 + rw)), abs(rb[3] - (ty0 + rh)))}
        m = layout.match_label_near(real, sudan_label[sec])
        validation["label_match_real"][sec] = (
            None if m is None else {"bbox": m["bbox"], "centroid": [round(c, 1) for c in m["centroid"]],
                                    "trace_centre": sudan_label[sec],
                                    "centroid_gap_px": round(float(np.hypot(
                                        m["centroid"][0] - sudan_label[sec][0],
                                        m["centroid"][1] - sudan_label[sec][1])), 1)})

        # --- v4 labels: cluster the white text, name the clusters.
        clusters = layout.text_clusters(vseg["white_text"]["components"]) \
            if vseg["white_text"]["present"] else []
        names = layout.identify_labels(clusters)
        v4_sudan_label = names["sudan"]["centroid"] if names["sudan"] else None
        v4_elf_label = names["el_fasher"]["centroid"] if names["el_fasher"] else None
        v4_dot = layout.find_dot(v4, dot["centre_1920x1080"]) if sec == 7 else None
        if sec == 7:
            d = layout.find_dot(real, dot["centre_1920x1080"])
            validation["dot_found_real"][7] = (
                None if d is None else {"centroid": d["centroid"],
                                        "trace_centre": dot["centre_1920x1080"],
                                        "pixels": d["pixels"]})

        # --- layer checks (tolerance 0.02 unless noted).
        checks = {}
        # Sudan centroid + width + borders, segmented vs segmented.
        checks["sudan_centroid"] = check(
            ratio_gap(rseg["sudan"]["centroid_ratio"], vseg["sudan"]["centroid_ratio"]),
            TOL["position_ratio"])
        checks["sudan_width"] = check(
            None if not (rseg["sudan"]["present"] and vseg["sudan"]["present"]) else
            round(abs(rseg["sudan"]["bbox_ratio"][2] - vseg["sudan"]["bbox_ratio"][2]), 4),
            TOL["position_ratio"])
        for side in ("left", "right", "top", "bottom"):
            checks[f"sudan_border_{side}"] = check(
                None if not (rseg["sudan"]["present"] and vseg["sudan"]["present"]) else
                round(abs(rseg["sudan"]["border_ratio"][side]
                          - vseg["sudan"]["border_ratio"][side]), 4),
                TOL["border_ratio"])
        # Sudan colour is not comparable when v4's Sudan is merged with base.
        if "MERGED_WITH_BASE" in (vseg["sudan"].get("flags") or []):
            checks["sudan_colour"] = {"gap": None, "pass": None,
                                      "status": "not comparable (v4 Sudan merged with base)"}
        else:
            sudan_de = delta_es(rseg["sudan"]["median_hex"], vseg["sudan"]["median_hex"])
            checks["sudan_colour_ciede2000"] = {
                "value": sudan_de["ciede2000"],
                "pass": bool(sudan_de["ciede2000"] < PRED_V1_SEG4["flat_delta_e_max"]),
                "status": "pass" if sudan_de["ciede2000"] < 3 else "fail"}
            checks["sudan_colour_cie76"] = {
                "value": sudan_de["cie76"],
                "pass": bool(sudan_de["cie76"] < PRED_V1_SEG4["flat_delta_e_max"]),
                "status": "pass" if sudan_de["cie76"] < 3 else "fail"}
        # RSF badge: present in real at 4, 5, 7; absent at 1 in both.
        if sec in rsf_centre:
            if not vseg["rsf"]["present"]:
                checks["rsf_badge"] = {"gap": None, "pass": False,
                                       "status": "fail (v4 badge absent)"}
            else:
                checks["rsf_badge"] = check(
                    ratio_gap(rseg["rsf"]["centroid_ratio"], vseg["rsf"]["centroid_ratio"]),
                    TOL["position_ratio"])
        else:
            checks["rsf_badge"] = {"gap": None, "pass": None, "status": "absent in both"}
        # October 2025 title: real at 1s only, v4 never.
        if sec == 1:
            checks["october_title"] = {"gap": None, "pass": False,
                                       "status": "fail (v4 title absent)"} \
                if not vseg["october"]["present"] else check(
                    ratio_gap(rseg["october"]["centroid_ratio"],
                              vseg["october"]["centroid_ratio"]), TOL["position_ratio"])
        else:
            checks["october_title"] = {"gap": None, "pass": None, "status": "absent in both"}
        # Base colour: segmented medians, CIEDE2000 and CIE76 separately.
        base_de = delta_es(rseg["base"]["median_hex"], vseg["base"]["median_hex"])
        checks["base_colour_ciede2000"] = {
            "value": base_de["ciede2000"],
            "pass": bool(base_de["ciede2000"] < PRED_V1_SEG4["flat_delta_e_max"]),
            "status": "pass" if base_de["ciede2000"] < 3 else "fail"}
        checks["base_colour_cie76"] = {
            "value": base_de["cie76"],
            "pass": bool(base_de["cie76"] < PRED_V1_SEG4["flat_delta_e_max"]),
            "status": "pass" if base_de["cie76"] < 3 else "fail"}
        checks["base_colour"] = {"real_hex": rseg["base"]["median_hex"],
                                 "v4_hex": vseg["base"]["median_hex"]}

        # --- pair gaps (ratios of frame width).
        gaps = {}
        r_sudan_c = rseg["sudan"]["centroid"] if rseg["sudan"]["present"] else None
        v_sudan_c = vseg["sudan"]["centroid"] if vseg["sudan"]["present"] else None
        gaps["sudan_label_to_sudan_centroid"] = {
            "real": layout.pair_gap(sudan_label[sec], r_sudan_c, 1920),
            "v4": layout.pair_gap(v4_sudan_label, v_sudan_c, 1920)}
        g = gaps["sudan_label_to_sudan_centroid"]
        g["gap"] = check(
            None if g["real"] is None or g["v4"] is None else
            round(abs(g["real"]["dist_ratio"] - g["v4"]["dist_ratio"]), 4),
            TOL["pair_gap_ratio"])
        if sec == 7:
            bx1 = rsf_centre[7][0] + rsf_size[7][0] / 2
            by0 = rsf_centre[7][1] - rsf_size[7][1] / 2
            gaps["el_fasher_label_to_rsf_corner"] = {
                "real": layout.pair_gap(elf["centre_1920x1080"], [bx1, by0], 1920),
                "v4": None,
                "note": "v4 badge absent, gap undefined"}
            gaps["el_fasher_dot_to_label"] = {
                "real": layout.pair_gap(dot["centre_1920x1080"],
                                        elf["centre_1920x1080"], 1920),
                "v4": None,
                "note": "v4 dot absent (ring, not dot), gap undefined"}
            gaps["el_fasher_label_to_rsf_corner"]["gap"] = {
                "gap": None, "pass": False, "status": "fail (v4 badge absent)"}
            gaps["el_fasher_dot_to_label"]["gap"] = {
                "gap": None, "pass": False, "status": "fail (v4 dot absent)"}
        else:
            gaps["el_fasher_label_to_rsf_corner"] = {"real": None, "v4": None,
                                                     "note": "EL FASHER not visible yet"}
            gaps["el_fasher_dot_to_label"] = {"real": None, "v4": None,
                                              "note": "EL FASHER not visible yet"}

        # --- zoom curve: trace (real) vs segmented (v4).
        v_sudan_w = vseg["sudan"]["bbox_ratio"][2] if vseg["sudan"]["present"] else None
        zoom_rows.append({"second": sec, "real_ratio": round(t_sudan_w, 4),
                          "real_source": "trace", "v4_ratio": v_sudan_w,
                          "v4_source": "segmented teal region (MERGED_WITH_BASE)",
                          "gap": None if v_sudan_w is None else
                          round(abs(v_sudan_w - t_sudan_w), 4)})

        # --- existing numbers, reused from the numbers run (no re-run).
        # Note the numbers file marks present areas by the ABSENCE of a
        # "present": false flag, and the Delta E key is "delta_e".
        areas = prev["areas"]
        present_areas = {k: a for k, a in areas.items() if a.get("present", True)}
        worst_e = max((a["delta_e"] for a in present_areas.values()), default=None)
        worst_area = max(((a["delta_e"], k) for k, a in present_areas.items()),
                         default=(None, None))[1]
        cie76 = {k: delta_es(a["real_hex"], a["v4_hex"])
                 for k, a in present_areas.items()}
        existing = {"ssim": prev["ssim"], "psnr_db": prev["psnr_db"],
                    "lpips": prev["lpips"],
                    "worst_delta_e_ciede2000": worst_e, "worst_area": worst_area,
                    "delta_e_cie76_by_area": {k: v["cie76"] for k, v in cie76.items()},
                    "worst_delta_e_cie76": max((v["cie76"] for v in cie76.values()),
                                               default=None)}
        pred_pass = (prev["ssim"] >= PRED_V1_SEG4["mean_ssim"]
                     and prev["psnr_db"] >= PRED_V1_SEG4["mean_psnr_db"]
                     and prev["lpips"] <= PRED_V1_SEG4["mean_lpips_max"]
                     and (worst_e is not None and worst_e < PRED_V1_SEG4["flat_delta_e_max"]))
        layer_pass = all(c.get("pass") is True
                         for c in checks.values() if isinstance(c, dict) and "pass" in c
                         and c.get("status") not in ("unmeasurable", "absent in both",
                                                     "not comparable (v4 Sudan merged with base)"))
        # A check that fails by absence is a fail; unmeasurable/absent-both do not block.
        layer_fail = any(c.get("pass") is False for c in checks.values()
                         if isinstance(c, dict))
        layer_pass = (not layer_fail) and layer_pass
        for name, c in checks.items():
            if isinstance(c, dict) and c.get("gap") is not None:
                all_gaps.append((c["gap"], sec, name))
        for name, g in gaps.items():
            gc = g.get("gap") if isinstance(g.get("gap"), dict) else None
            if gc and gc.get("gap") is not None:
                all_gaps.append((gc["gap"], sec, f"pair_gap:{name}"))
        pairs[str(sec)] = {
            "real_file": f"verify-seg4/evidence/work/real-{sec}s.png",
            "v4_file": str(V4_FILES[sec]).replace(str(HERE) + "/", ""),
            "existing": existing,
            "layers": {
                "sudan": {"real": rseg["sudan"], "v4": vseg["sudan"]},
                "base": {"real": {k: v for k, v in rseg["base"].items() if k != "components"},
                         "v4": {k: v for k, v in vseg["base"].items() if k != "components"}},
                "rsf": {"real": rseg["rsf"], "v4": vseg["rsf"]},
                "october": {"real": rseg["october"], "v4": vseg["october"]},
                "v4_text_clusters": [
                    {"bbox": c["bbox"], "centroid": [round(x, 1) for x in c["centroid"]],
                     "n_components": c["n_components"], "pixels": c["pixels"]}
                    for c in clusters],
                "v4_labels_identified": {
                    "sudan": None if v4_sudan_label is None else [round(x, 1) for x in v4_sudan_label],
                    "el_fasher": None if v4_elf_label is None else [round(x, 1) for x in v4_elf_label],
                    "flags": names.get("flags", [])},
            },
            "checks": checks,
            "pair_gaps": gaps,
            "layer_pass": bool(layer_pass),
            "pred_v1_numbers_pass": bool(pred_pass),
            "pair_verdict": "CLONE" if (pred_pass and layer_pass) else "FAIL",
        }

    means = numbers["means_4_pairs"]
    worst5 = sorted(all_gaps, reverse=True)[:5]
    out = {
        "title": "v4 clone vs real Seg4 opening: layer layout check, 4 paired seconds",
        "date": "2026-11-07",
        "scope": "Paired stills at seconds 1, 4, 5, 7 only. NOT a 240-frame check.",
        "aspect_mapping": layout.aspect_mapping(),
        "tolerances": TOL,
        "predicate": ("pred-v1 seg4, FROZEN: mean SSIM >= 0.96, PSNR >= 35 dB, "
                      "LPIPS <= 0.08, flat colour Delta E < 3. No threshold changed."),
        "method": {
            "segmentation": ("Flat-colour masks (RGB euclidean, tolerances per layer) "
                             "on a stride-2 subsample, 4-connectivity, skimage.measure.label. "
                             "Sudan = largest teal component. RSF badge passes a "
                             "discriminator (interior, fill >= 0.25, aspect 0.7-1.4) so the "
                             "coral flood is not mistaken for a badge."),
            "real_side": ("Trace values are ground truth for label/badge/dot centres "
                          "and Sudan widths. Segmentation is validated against the trace "
                          "in the validation section, not trusted blind."),
            "v4_side": ("Labels are white-text clusters named by glyph count "
                        "(one cluster = SUDAN; two clusters, the 5-glyph one = SUDAN, "
                        "the other = EL FASHER). Sudan width is the segmented teal "
                        "region, flagged MERGED_WITH_BASE: v4 does not colour Sudan "
                        "differently from land, so the teal width is an upper bound on "
                        "the true Sudan width."),
            "existing_numbers": ("SSIM, PSNR, LPIPS and worst flat Delta E are reused "
                                 "from v4-vs-real-numbers.json, not re-run. CIE76 per area "
                                 "is recomputed from the same published hex medians."),
            "dreamsim": ("not run: weights absent, no download attempted. "
                         "Use --feel to ask; it still reports not run."),
        },
        "validation": validation,
        "pairs": pairs,
        "zoom_curve": zoom_rows,
        "composite": {
            "mean_ssim": means["ssim"], "mean_psnr_db": means["psnr_db"],
            "mean_lpips": means["lpips"],
            "layer_pass": False,
            "overall_verdict": "FAIL, 0 of 4 pairs pass pred-v1 Seg4.",
        },
        "worst_gaps": [{"gap": g, "second": s, "check": n} for g, s, n in worst5],
        "wall_time_s": round(time.time() - t_start, 1),
        "limits": numbers["limits"] + [
            "v4 Sudan is not colour-separable from v4 land, so the zoom and Sudan "
            "layout numbers use the teal-region width as an upper bound.",
            "Real y positions carry about +/-15 px uncertainty from the 1.845:1 to "
            "16:9 stretch (0.0139 as a ratio), inside the 0.02 tolerances.",
            "SUDAN label at 0:01 is a 35x6 px blob; label matching there is not reliable.",
        ],
    }
    if args.feel:
        out["method"]["dreamsim"] = "not run: weights absent, no download attempted."
    out_path = Path(args.out)
    text = json.dumps(out, indent=1)
    try:
        out_path.write_text(text)
        ok = out_path.stat().st_size > 0
    except OSError:
        ok = False
    if not ok:
        # EPERM write gate: the file may be 0 bytes. Print the full JSON
        # to stdout so it can be recovered with the file tools.
        print("LAYOUT_JSON_FALLBACK_BEGIN")
        print(text)
        print("LAYOUT_JSON_FALLBACK_END")
    print(f"wrote {args.out} in {out['wall_time_s']}s")
    print(f"overall: {out['composite']['overall_verdict']}")
    for g, s, n in worst5:
        print(f"worst gap {g} at {s}s: {n}")


if __name__ == "__main__":
    main()
