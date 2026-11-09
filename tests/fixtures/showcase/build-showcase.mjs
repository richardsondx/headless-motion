// Build the two derived showcase scenes:
// 1. showcase-map-flight.json: seg4-scene-clone-v6 (192f) retimed to 120f.
//    Every event frame, visible window, and timeline key is scaled by
//    120/192 so the camera knots, label tracks, badge pop, and EL FASHER
//    fade stay in sync with each other. Font and rifle paths are rewritten
//    for the showcase folder depth.
// 2. showcase-character-rig.json: proof rig expanded into the staged base
//    scene with expandRig, so the arm/eye/brow tracks are the rig's own
//    pivot math, not hand-written numbers.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expandRig } from "../../../src/rig/expand.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const SCALE = 120 / 192;
const sc = (f) => Math.round(f * SCALE);

// --- 1. map ---
const v6 = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/seg4-scene-clone-v6.json"), "utf8"));
v6.meta.id = "showcase-map-flight";
v6.meta.duration = 120;
v6.meta.notes = "Showcase 1, 5s. Search Party style map, retimed from seg4-scene-clone-v6 (192f, 8s) by scaling every event, visible window, and timeline key by 120/192, so camera knots, SUDAN label track, RSF badge pop, and EL FASHER fade stay in sync. Honest note: no opening video of fUrNOVjWUVM was ever obtained (see verify-seg4/refs/PROVENANCE.md); v6 was measured against the internal trace, not a real video.";
v6.events = v6.events.filter((e) => e.id !== "cut").map((e) => ({ ...e, f: sc(e.f) }));
for (const font of v6.fonts) font.src = font.src.replace(/^fonts\//, "../fonts/");
for (const node of v6.nodes) {
  if (node.visible) {
    node.visible.in = sc(node.visible.in);
    node.visible.out = Math.min(120, sc(node.visible.out));
  }
  if (node.type === "image" && typeof node.props.src === "string") {
    node.props.src = node.props.src.replace(/^\.\.\/\.\.\/verify-seg4\//, "../../../verify-seg4/");
  }
}
for (const track of v6.timeline) {
  track.keys = track.keys.map((k) => ({ ...k, f: sc(k.f) }));
}
writeFileSync(resolve(HERE, "showcase-map-flight.json"), JSON.stringify(v6, null, 2) + "\n");
console.log(`map: ${v6.events.length} events, ${v6.nodes.length} nodes, ${v6.timeline.length} tracks, duration ${v6.meta.duration}`);

// --- 2. rig ---
const rig = JSON.parse(readFileSync(resolve(HERE, "rig-alcohol-man.json"), "utf8"));
const kf = JSON.parse(readFileSync(resolve(HERE, "rig-showcase-keyframes.json"), "utf8"));
const base = JSON.parse(readFileSync(resolve(HERE, "showcase-character-rig-base.json"), "utf8"));
const { scene, summary } = expandRig(rig, kf, base);
writeFileSync(resolve(HERE, "showcase-character-rig.json"), JSON.stringify(scene, null, 2) + "\n");
console.log(`rig: poses ${summary.posesApplied}, keys written ${summary.keysWritten}, tracks touched ${summary.tracksTouched}`);
