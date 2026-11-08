"""Fail-fast stages S0-S7 against pred-v1. No threshold is ever lowered."""
import hashlib
import json
import os
from pathlib import Path

import numpy as np

from . import color as _color
from . import events as _events
from . import layout as _layout
from . import metrics as _metrics
from . import motion as _motion
from . import text as _text
from .decode import decode_frames, probe

HERE = Path(__file__).resolve().parent


class PredicateTampered(Exception):
    pass


class CheckError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def load_predicate():
    data = (HERE / "predicate.json").read_bytes()
    want = (HERE / "predicate.sha256").read_text().strip()
    if hashlib.sha256(data).hexdigest() != want:
        raise PredicateTampered("PREDICATE_TAMPERED")
    return json.loads(data)


def _row(frame, ssim, psnr, lpips, motion_err, shift_x, shift_y):
    return {"frame": frame, "ssim": round(ssim, 4), "psnr": round(psnr, 2),
            "lpips": None if lpips is None else round(lpips, 4),
            "motion_err": round(motion_err, 2),
            "shift_x": round(shift_x, 2), "shift_y": round(shift_y, 2)}


def run_check(cfg, render_path, ref_path, out_dir, full=False, diagnose_offset=False):
    pred = load_predicate()
    seg = cfg["id"]
    fps = cfg["fps"]
    expected_frames = round(10 * fps)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stages = []
    result = {"segment": seg, "verdict": None, "stages": stages,
              "stages_run": [], "frames": [], "means": {},
              "failures": [], "flags": [], "notes": []}

    def stage(name):
        s = {"stage": name, "status": "pass", "rows": []}
        stages.append(s)
        result["stages_run"].append(name)
        return s

    def fail(s, code, message, row):
        s["status"] = "fail"
        s["rows"].append(row)
        result["failures"].append({"code": code, "message": message, "row": row})

    # S0 shape
    s0 = stage("S0")
    rprobe, fprobe = probe(render_path), probe(ref_path)
    if abs(fprobe["fps"] - fps) > 0.01:
        raise CheckError("FPS_MISMATCH", f"reference fps is {fprobe['fps']}, segment needs {fps}")
    if fprobe["width"] != 1920 or fprobe["height"] != 1080:
        result["notes"].append("REF_RESIZED")
    profile = None
    for cand in (Path(render_path).parent / "render-report.json",
                 Path(render_path).parent.parent / "render-report.json"):
        if cand.exists():
            profile = json.loads(cand.read_text()).get("profile")
            break
    if profile != "final":
        fail(s0, "NOT_FINAL", f"render profile is {profile}, need final",
             {"value": profile, "threshold": "final", "comparator": "=="})
        result["verdict"] = "NOT_FINAL"
        return result
    if rprobe["frames"] != expected_frames or fprobe["frames"] < expected_frames:
        fail(s0, "FAIL", f"render frames {rprobe['frames']}, ref frames {fprobe['frames']}, need {expected_frames}",
             {"value": rprobe["frames"], "threshold": expected_frames, "comparator": "=="})
        result["verdict"] = "FAIL"
        return result
    if rprobe["width"] != 1920 or rprobe["height"] != 1080:
        fail(s0, "FAIL", f"render is {rprobe['width']}x{rprobe['height']}, need 1920x1080",
             {"value": [rprobe["width"], rprobe["height"]], "threshold": [1920, 1080], "comparator": "=="})
        result["verdict"] = "FAIL"
        return result

    ref = decode_frames(ref_path, 1920, 1080, start=cfg.get("ref_start_frame", 0), count=expected_frames)
    render = decode_frames(render_path, 1920, 1080, count=expected_frames)

    if diagnose_offset:
        best = None
        for off in range(-6, 7):
            idx = [i for i in (0, 60, 120, 180, 239) if 0 <= i + off < len(ref)]
            diffs = [float(np.mean(np.abs(_metrics.luma(render[i].astype(float))
                                          - _metrics.luma(ref[i + off].astype(float))))) for i in idx]
            mean = float(np.mean(diffs))
            if best is None or mean < best[1]:
                best = (off, mean)
        result["notes"].append(f"best offset {best[0]} frames (mean luma diff {best[1]:.2f})")

    # S1 colour
    s1 = stage("S1")
    for region in cfg.get("flat_regions", []):
        rect = region["rect"]
        for f in region["frames"]:
            ref_lab = _color.median_lab(ref[f], rect)
            ren_lab = _color.median_lab(render[f], rect)
            d2000 = _color.ciede2000(ref_lab, ren_lab)
            d76 = _color.cie76(ref_lab, ren_lab)
            # Is the reference region actually flat?
            lab_all = _color.rgb_to_lab(ref[f][rect[1]:rect[1] + rect[3], rect[0]:rect[0] + rect[2]].reshape(-1, 3))
            p95 = float(np.percentile(np.sqrt(np.sum((lab_all - ref_lab) ** 2, axis=1)), 95))
            if p95 > pred["flat_roi_p95_delta_e_max"]:
                fail(s1, "ROI_NOT_FLAT", f"region {region['id']} frame {f}: ref p95 Delta E {p95:.2f} over 2",
                     {"region": region["id"], "frame": f, "value": round(p95, 2), "threshold": 2, "comparator": "<="})
                continue
            if d2000 > pred["flat_delta_e_max"] or d76 > pred["flat_delta_e_max"]:
                fail(s1, "COLOR_FAIL", f"region {region['id']} frame {f}: Delta E2000 {d2000:.2f}, CIE76 {d76:.2f} over 3",
                     {"region": region["id"], "frame": f, "value": round(max(d2000, d76), 2), "threshold": 3, "comparator": "<="})
    if s1["status"] == "fail" and not full:
        result["verdict"] = "FAIL"
        return result

    # S2 events
    s2 = stage("S2")
    for ev in cfg.get("events", []):
        ref_e = _events.frame_diff_energy(ref, ev["rect"], ev["window"])
        ren_e = _events.frame_diff_energy(render, ev["rect"], ev["window"])
        if not ref_e or not ren_e:
            continue
        ref_peak = max(ref_e, key=lambda t: t[1])
        ren_peak = max(ren_e, key=lambda t: t[1])
        if ren_peak[1] < pred["event_peak_ratio_min"] * ref_peak[1] or abs(ren_peak[0] - ref_peak[0]) > pred["event_peak_frame_max"]:
            fail(s2, "EVENT_MISSING", f"event {ev['id']}: render peak {ren_peak[1]:.2f} at f{ren_peak[0]}, ref {ref_peak[1]:.2f} at f{ref_peak[0]}",
                 {"event": ev["id"], "value": round(ren_peak[1] / max(ref_peak[1], 1e-9), 2), "threshold": 0.5, "comparator": ">="})
    if s2["status"] == "fail" and not full:
        result["verdict"] = "FAIL"
        return result

    # S3 text
    s3 = stage("S3")
    for label in cfg.get("labels", []):
        rect = label["rect"]
        for f in label["frames"]:
            ref_box = _text.ink_box(_metrics.luma(ref[f]), rect)
            ren_box = _text.ink_box(_metrics.luma(render[f]), rect)
            shift = _text.box_shift(ref_box, ren_box)
            iou = _text.box_iou(ref_box, ren_box)
            if shift is not None and shift > pred["text_shift_px_max"]:
                fail(s3, "TEXT_SHIFT", f"label {label['id']} frame {f}: edge shift {shift}px over 2",
                     {"label": label["id"], "frame": f, "value": shift, "threshold": 2, "comparator": "<="})
            if iou < pred["label_iou_min"]:
                fail(s3, "LABEL_WRONG_PLACE", f"label {label['id']} frame {f}: ink IoU {iou:.2f} under 0.5",
                     {"label": label["id"], "frame": f, "value": round(iou, 2), "threshold": 0.5, "comparator": ">="})
            cs = _text.crop_ssim_2x(ref[f], render[f], rect)
            if cs < pred["crop_ssim_min"]:
                result["flags"].append({"code": "FONT_SWAP_SUSPECT", "label": label["id"], "frame": f,
                                        "value": round(cs, 3), "threshold": 0.9, "comparator": ">="})
    if s3["status"] == "fail" and not full:
        result["verdict"] = "FAIL"
        return result

    # S4 motion + S5 SSIM/PSNR, per frame
    s4 = stage("S4")
    s5 = stage("S5")
    unmeasurable = []
    worst = []
    for f in range(expected_frames):
        ref_l = _metrics.luma(ref[f])
        ren_l = _metrics.luma(render[f])
        shift = _motion.phase_shift(ref_l, ren_l)
        if shift is None:
            unmeasurable.append(f)
            sy, sx, err = 0.0, 0.0, 0.0
        else:
            sy, sx = shift
            err = float(np.hypot(sy, sx))
        prev_err = result["frames"][-1]["motion_err"] if result["frames"] else 0.0
        if err >= pred["motion_err_px_max"]:
            fail(s4, "MOTION_ERR", f"frame {f}: shift {err:.2f}px over 2",
                 {"frame": f, "value": round(err, 2), "threshold": 2, "comparator": "<"})
        if result["frames"] and abs(err - prev_err) > pred["motion_jump_px_max"]:
            fail(s4, "MOTION_JUMP", f"frame {f}: motion jump {abs(err - prev_err):.2f}px over 4",
                 {"frame": f, "value": round(abs(err - prev_err), 2), "threshold": 4, "comparator": "<="})
        for target in cfg.get("targets", []):
            x, y, w, h = target["rect"]
            tsh = _motion.phase_shift(ref_l[y:y + h, x:x + w], ren_l[y:y + h, x:x + w])
            if tsh is None:
                unmeasurable.append(f)
            elif float(np.hypot(*tsh)) >= pred["motion_err_px_max"]:
                fail(s4, "MOTION_ERR", f"frame {f} target {target['id']}: shift {float(np.hypot(*tsh)):.2f}px over 2",
                     {"frame": f, "target": target["id"], "value": round(float(np.hypot(*tsh)), 2), "threshold": 2, "comparator": "<"})
        ssim = _metrics.ssim_frame(ref_l, ren_l)
        psnr = _metrics.psnr_frame(ref[f], render[f])
        result["frames"].append(_row(f, ssim, psnr, None, err, sx, sy))
        worst.append((ssim, f))
        if ssim < pred["per_frame_ssim_min"]:
            code = "HARD_FLOOR" if ssim < pred["hard_floor_ssim"] else "FRAME_SSIM"
            fail(s5, code, f"frame {f}: SSIM {ssim:.3f} under 0.90" + (" (below 0.85 floor)" if ssim < 0.85 else ""),
                 {"frame": f, "value": round(ssim, 3), "threshold": 0.9, "comparator": ">="})
    if unmeasurable:
        s4["status"] = "incomplete"
        result["flags"].append({"code": "UNMEASURABLE", "frames": unmeasurable[:10], "count": len(unmeasurable)})
    if s4["status"] == "fail" and not full:
        result["verdict"] = "FAIL"
        return result
    ssims = [r["ssim"] for r in result["frames"]]
    psnrs = [r["psnr"] for r in result["frames"]]
    result["means"] = {"ssim": round(float(np.mean(ssims)), 4), "psnr": round(float(np.mean(psnrs)), 2)}
    if result["means"]["ssim"] < pred["mean_ssim"][seg]:
        fail(s5, "MEAN_SSIM", f"mean SSIM {result['means']['ssim']} under {pred['mean_ssim'][seg]}",
             {"value": result["means"]["ssim"], "threshold": pred["mean_ssim"][seg], "comparator": ">="})
    if result["means"]["psnr"] < pred["mean_psnr_db"][seg]:
        fail(s5, "MEAN_PSNR", f"mean PSNR {result['means']['psnr']}dB under {pred['mean_psnr_db'][seg]}dB",
             {"value": result["means"]["psnr"], "threshold": pred["mean_psnr_db"][seg], "comparator": ">="})
    result["worst_frames"] = [f for _, f in sorted(worst)[:5]]
    if s5["status"] == "fail" and not full:
        result["verdict"] = "FAIL"
        return result

    # S6 LPIPS: alex net, inputs scaled to [-1, 1], mean over frames.
    # If the weights cannot load, the verdict is INCOMPLETE, never a skip.
    s6 = stage("S6")
    try:
        import lpips
        import torch
        loss_fn = lpips.LPIPS(net="alex")
        scores = []
        for f in range(expected_frames):
            a = torch.from_numpy(ref[f].astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
            b = torch.from_numpy(render[f].astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
            with torch.no_grad():
                scores.append(float(loss_fn(a, b).item()))
        mean_lpips = float(np.mean(scores))
        result["means"]["lpips"] = round(mean_lpips, 4)
        for r in result["frames"]:
            r["lpips"] = round(scores[r["frame"]], 4)
        if mean_lpips > pred["mean_lpips_max"][seg]:
            fail(s6, "MEAN_LPIPS", f"mean LPIPS {mean_lpips:.3f} over {pred['mean_lpips_max'][seg]}",
                 {"value": round(mean_lpips, 3), "threshold": pred["mean_lpips_max"][seg], "comparator": "<="})
    except Exception as e:
        s6["status"] = "incomplete"
        result["flags"].append({"code": "LPIPS_UNAVAILABLE", "message": f"LPIPS weights cannot load ({type(e).__name__}); torch/lpips is not installed here"})

    # S7 map (segment 4 only)
    if cfg.get("map"):
        s7 = stage("S7")
        report_path = out_dir.parent / "g8-g9-report.json"
        if not report_path.exists():
            fail(s7, "MAP_REPORT_MISSING", f"no g8-g9 report at {report_path}",
                 {"value": None, "threshold": "report present", "comparator": "=="})
        else:
            rep = json.loads(report_path.read_text())
            if rep.get("g8", {}).get("failures") or rep.get("g9", {}).get("failures"):
                fail(s7, "MAP_GATE_FAIL", "G8 or G9 report has failures",
                     {"value": rep, "threshold": "no failures", "comparator": "=="})
        if s7["status"] == "fail" and not full:
            result["verdict"] = "FAIL"
            return result

    # S8 layout (informational only). Runs only when cfg sets "layout_check".
    # It never adds failures and never changes the verdict; it records
    # layer-layout gap rows for the configured seconds.
    if cfg.get("layout_check"):
        s8 = stage("S8")
        lc = cfg["layout_check"]
        for sec in lc.get("seconds", []):
            fidx = int(sec * fps)
            if fidx < len(ref) and fidx < len(render):
                for row in _layout.stage_rows(
                        ref[fidx], render[fidx], sec,
                        lc.get("expected", {}).get(str(sec), {}),
                        lc.get("tolerances", {})):
                    s8["rows"].append(row)
        s8["status"] = "info"

    if result["failures"]:
        result["verdict"] = "FAIL"
    elif any(s["status"] == "incomplete" for s in stages) or result["flags"]:
        result["verdict"] = "INCOMPLETE"
    else:
        gate = out_dir / "human-gate.json"
        if not gate.exists():
            result["verdict"] = "PENDING_HUMAN"
        elif json.loads(gate.read_text()).get("passed") is True:
            result["verdict"] = "PASS"
        else:
            result["verdict"] = "FAIL"
    return result
