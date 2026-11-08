"""Blind gate: side-by-side videos and stills. Which side holds the render
is chosen by a seeded random draw per clip. The mapping goes only in
blind-key.json; the report and file names never reveal it.
The checker never writes human-gate.json; a person does."""
import hashlib
import json
import random
import subprocess
from pathlib import Path


def make_blind(cfg, render_path, ref_path, out_dir):
    out_dir = Path(out_dir) / "blind"
    out_dir.mkdir(parents=True, exist_ok=True)
    seed_src = cfg["id"] + "|" + hashlib.sha256(Path(render_path).read_bytes()).hexdigest()
    seed = int(hashlib.sha256(seed_src.encode()).hexdigest()[:12], 16)
    rng = random.Random(seed)
    render_left = rng.random() < 0.5
    left, right = (render_path, ref_path) if render_left else (ref_path, render_path)
    (out_dir / "blind-key.json").write_text(json.dumps(
        {"segment": cfg["id"], "render_left": render_left, "seed": seed}, indent=2) + "\n")
    fps = cfg["fps"]
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", left, "-i", right,
                    "-filter_complex", "[0:v][1:v]hstack=inputs=2[v]",
                    "-map", "[v]", "-c:v", "libx264", "-crf", "18",
                    str(out_dir / "sbs-1x.mp4")], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", left, "-i", right,
                    "-filter_complex", "[0:v]setpts=4*PTS[a];[1:v]setpts=4*PTS[b];[a][b]hstack=inputs=2[v]",
                    "-map", "[v]", "-c:v", "libx264", "-crf", "18",
                    str(out_dir / "sbs-0.25x.mp4")], check=True)
    for sec, f in ((1, 24), (5, 120), (9, 216)):
        f = min(f, 10 * fps - 1)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", left, "-i", right,
                        "-filter_complex",
                        f"[0:v]select='eq(n\\,{f})'[a];[1:v]select='eq(n\\,{f})'[b];[a][b]hstack=inputs=2[v]",
                        "-map", "[v]", "-frames:v", "1", "-vsync", "0",
                        str(out_dir / f"still-{sec}s.png")], check=True)
        for label in cfg.get("labels", []):
            x, y, w, h = label["rect"]
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", left, "-i", right,
                            "-filter_complex",
                            f"[0:v]crop={w}:{h}:{x}:{y},scale={w * 2}:{h * 2}:flags=lanczos[a];"
                            f"[1:v]crop={w}:{h}:{x}:{y},scale={w * 2}:{h * 2}:flags=lanczos[b];"
                            f"[a][b]hstack=inputs=2[v]",
                            "-map", "[v]", "-frames:v", "1", "-vsync", "0",
                            str(out_dir / f"crop-{label['id']}-{sec}s.png")], check=True)
    return {"render_left": render_left, "seed": seed}
