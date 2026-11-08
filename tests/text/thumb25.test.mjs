// Prompt 04 check 6: thumbnail stills at 25% (480x270) from the draft render
// of the text sample, with each text node's ink-box height measured on the
// still: at least 9 px unless the node is thumbnailExempt.
// The stills are regenerated from out/text-sample-final/run-a/video.mp4
// (draft, 240 frames) on every run, so they can never go stale.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const VIDEO = resolve(ROOT, "out", "text-sample-final", "run-a", "video.mp4");
const OUT = resolve(ROOT, "out", "text-sample", "thumb25");
const FRAMES = [60, 120, 180];

function run(cmd, args) {
  return new Promise((resolveP, rejectP) => {
    execFile(cmd, args, (err, stdout, stderr) => (err ? rejectP(new Error(stderr || err.message)) : resolveP(stdout)));
  });
}

/** Rows in the cropped box that contain near-white ink; height in px. */
async function inkHeight(pngPath, box) {
  const { data, info } = await sharp(pngPath).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const x0 = Math.round(box.x * 0.25), y0 = Math.round(box.y * 0.25);
  const x1 = Math.round((box.x + box.w) * 0.25), y1 = Math.round((box.y + box.h) * 0.25);
  let first = null, last = null;
  for (let y = y0; y < y1; y++) {
    let ink = false;
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * info.channels;
      if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] > 180) { ink = true; break; }
    }
    if (ink) { if (first === null) first = y; last = y; }
  }
  return first === null ? 0 : last - first + 1;
}

test("thumb25 stills: each text node measures at least 9 px tall", async () => {
  assert.ok(existsSync(VIDEO), `draft render missing: ${VIDEO} (render the text sample at draft first)`);
  mkdirSync(OUT, { recursive: true });
  const scene = loadScene(resolve(ROOT, "tests", "fixtures", "text-sample.json"));
  const textNodes = scene.nodes.filter((n) => n.type === "text" && !n.props.thumbnailExempt);
  assert.ok(textNodes.length > 0, "no text nodes to measure");
  for (const f of FRAMES) {
    const png = resolve(OUT, `thumb-${String(f).padStart(6, "0")}.png`);
    await run("ffmpeg", ["-v", "error", "-y", "-i", VIDEO, "-vf", `select=eq(n\\,${f}),scale=480:270:flags=area`, "-frames:v", "1", png]);
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 480, "still width");
    assert.equal(meta.height, 270, "still height");
    for (const node of textNodes) {
      const h = await inkHeight(png, node.box);
      assert.ok(h >= 9, `${node.id} ink height ${h}px at frame ${f}, floor is 9px at 25%`);
    }
  }
});
