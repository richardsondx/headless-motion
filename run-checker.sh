#!/bin/sh
# Run the frame checker with the workspace venv (torch/lpips live there).
# Sets PYTHONPATH to this repo's src/ so the checker works without the
# system .pth file at /usr/local/lib/python3.12/dist-packages/
# headless-motion-engine.pth, which does not survive a VM replacement.
# Usage: ./run-checker.sh run --segment <cfg> --render <mp4> --ref <mp4> --out <dir>
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ ! -x "$HERE/.venv/bin/python" ]; then
  echo "missing $HERE/.venv/bin/python: create it with python3 -m venv .venv and install torch (CPU), lpips, scikit-image, numpy, pytest" >&2
  exit 2
fi
PYTHONPATH="$HERE/src" exec "$HERE/.venv/bin/python" -m checker "$@"
