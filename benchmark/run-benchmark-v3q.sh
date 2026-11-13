#!/bin/bash
# After-benchmark v3: 3 scenes x 3 profiles, sequential, one row appended
# to benchmark/results-2026-11-08-v3q.jsonl immediately after each render,
# then the .json is regenerated from header + jsonl. A runtime restart
# loses at most the in-flight render; re-running this script resumes
# (rows already in the jsonl are skipped).
set -u
cd ~/workspace/headless-motion-engine
JSONL=benchmark/results-2026-11-08-v3q.jsonl
JSON=benchmark/results-2026-11-08-v3q.json
HEADER=benchmark/results-2026-11-08-v3q.header.json
touch "$JSONL"
regen() {
  python3 - "$HEADER" "$JSONL" "$JSON" <<'EOF'
import json, sys, os
header = json.load(open(sys.argv[1]))
rows = []
for line in open(sys.argv[2]):
    line = line.strip()
    if line: rows.append(json.loads(line))
header["runs"] = rows
tmp = sys.argv[3] + ".tmp"
with open(tmp, "w") as f:
    json.dump(header, f, indent=1)
    f.write("\n")
os.replace(tmp, sys.argv[3])
EOF
}
regen
for spec in "map-sample draft" "map-sample final" "map-sample final-max" "text-sample draft" "text-sample final" "text-sample final-max" "scene-min draft" "scene-min final" "scene-min final-max"; do
  set -- $spec
  scene=$1; profile=$2
  outdir="benchmark/runs/v3q-$scene-$profile"
  if grep -q "\"scene\": \"$scene\", \"profile\": \"$profile\"" "$JSONL" 2>/dev/null; then
    echo "SKIP $scene $profile (already in $JSONL)"
    continue
  fi
  load=$(uptime | sed 's/.*load average: \([0-9.]*\).*/\1/')
  t0=$(date +%s.%N)
  timeout 3600 node src/renderer/cli.mjs render "tests/fixtures/$scene.json" --profile "$profile" --out "$outdir" > "benchmark/runs/v3q-$scene-$profile.log" 2>&1
  code=$?
  t1=$(date +%s.%N)
  wall=$(python3 -c "print(round($t1-$t0,1))")
  python3 - "$scene" "$profile" "$wall" "$code" "$load" "$outdir" <<'EOF'
import json, sys, os, hashlib
scene, profile, wall, code, load, outdir = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6]
row = {"scene": scene, "profile": profile, "frames": 240, "wall_s": wall, "s_per_frame": round(wall/240, 3), "exit": code, "load_avg_1m": load, "out_dir": outdir}
video = os.path.join(outdir, "video.mp4")
rep = os.path.join(outdir, "render-report.json")
if os.path.exists(video):
    row["bytes"] = os.path.getsize(video)
    row["sha256"] = hashlib.sha256(open(video, "rb").read()).hexdigest()
if os.path.exists(rep):
    r = json.load(open(rep))
    row["map_cache"] = r.get("map_cache")
    row["dedup"] = r.get("dedup")
    row["frames_deduped"] = r.get("frames_deduped")
    row["frames_captured_unique"] = r.get("frames_captured_unique")
    row["capture_workers"] = r.get("capture_workers")
    row["ffmpeg_threads"] = r.get("ffmpeg_threads")
with open("benchmark/results-2026-11-08-v3q.jsonl", "a") as f:
    f.write(json.dumps(row) + "\n")
print("ROW", json.dumps(row))
EOF
  regen
  echo "DONE $scene $profile wall=$wall exit=$code"
done
echo "ALL DONE"
