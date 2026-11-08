"""Decode helpers: ffprobe for shape and fps, ffmpeg for RGB frames."""
import json
import subprocess

import numpy as np


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames,codec_name",
         "-show_entries", "format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    num, den = (float(x) for x in s["r_frame_rate"].split("/"))
    fps = num / den
    frames = int(s["nb_frames"]) if s.get("nb_frames") else round(float(j["format"]["duration"]) * fps)
    return {"width": s["width"], "height": s["height"], "fps": fps,
            "frames": frames, "codec": s["codec_name"]}


def decode_frames(path, width, height, start=0, count=None):
    """Decode to RGB24 frames, each a (H, W, 3) uint8 array."""
    filt = "scale=in_range=tv:in_color_matrix=bt709,format=rgb24"
    args = ["ffmpeg", "-v", "error", "-i", path]
    if start:
        args += ["-vf", f"select='gte(n\\,{start})'", "-vsync", "0"]
    args += ["-vf", filt, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    if count is not None:
        args += ["-frames:v", str(count)]
    proc = subprocess.run(args, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"DECODE_FAIL {path}: {proc.stderr.decode()[:400]}")
    buf = proc.stdout
    n = len(buf) // (width * height * 3)
    arr = np.frombuffer(buf[: n * width * height * 3], dtype=np.uint8)
    return arr.reshape(n, height, width, 3)
