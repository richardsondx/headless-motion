#!/bin/bash
# v5 verification driver: run AFTER out/seg4-final-v5/run-a/video.mp4 lands.
# 1. Extracts v5 stills at seconds 1, 4, 5, 7 (frames 24/96/120/168 at 24 fps).
# 2. Measures SSIM/PSNR/LPIPS/Delta E vs the real frames -> v5-vs-real-numbers.json.
# 3. Runs the layer layout check -> v5-vs-real-layout.json, with the CLONE/FAIL verdict.
# The render must exist first; this script exits non-zero if it does not.
set -e
cd ~/workspace/headless-motion-engine
V=out/seg4-final-v5/run-a/video.mp4
W=verify-seg4/evidence/work
E=verify-seg4/evidence
test -s "$V" || { echo "MISSING: $V (render has not landed yet)"; exit 1; }
ffmpeg -y -v error -i "$V" -vf "select=eq(n\,24)"  -frames:v 1 "$W/v5-1s.png"
ffmpeg -y -v error -i "$V" -vf "select=eq(n\,96)"  -frames:v 1 "$W/v5-4s.png"
ffmpeg -y -v error -i "$V" -vf "select=eq(n\,120)" -frames:v 1 "$W/v5-5s.png"
ffmpeg -y -v error -i "$V" -vf "select=eq(n\,168)" -frames:v 1 "$W/v5-7s.png"
.venv/bin/python "$W/measure-v5.py" > "$E/v5-vs-real-numbers.json"
.venv/bin/python run-layout-check-v5.py --out "$E/v5-vs-real-layout.json"
echo "v5 check done: $E/v5-vs-real-numbers.json and $E/v5-vs-real-layout.json"
