// hme extract: pull one colour's dark shape out of a frame as an RGBA PNG.
//
// Promotes verify-seg4/evidence/work/extract-rifle.py into a tool
// command. The work is Python (numpy, scipy, Pillow), so this module
// spawns the engine venv Python with a small driver on stdin. Nothing
// here reimplements connected-component labelling in JavaScript.
// Nothing is hardcoded to a video, a segment, or a frame count: the
// frame and the colour come from the arguments.
//
// Method, matching extract-rifle.py exactly:
// - Find the region of the given colour: pixels within --dist-min of
//   the colour, largest connected component. Its bbox is the crop.
//   (For the Seg4 rifle this is the RSF badge.)
// - Inside the crop, mask pixels more than --dist-min from the colour
//   with luma below --luma-max, then clear the --exclude rect
//   (in crop coordinates, with its origin at the crop's top-left
//   corner). Take the largest connected component of that mask.
// - Write an RGBA PNG sized to the crop: the original crop colours,
//   opaque where the shape is, transparent elsewhere. Pixel copy
//   only, no tracing, so the output keeps the original shading.
//
// The JSON report in the insight format goes to stdout. The PNG goes
// to --out, which is required: the PNG is the point of the command.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

// Defaults from extract-rifle.py: distance 50 from badge orange,
// luma under 150 (so white text is excluded).
export const DEFAULT_DIST_MIN = 50;
export const DEFAULT_LUMA_MAX = 150;

export const USAGE = [
  "hme extract: Extract pixels of one colour from a frame, plus the largest part.",
  "",
  "Usage: hme extract <frame.png> --colour <hex> --out <png>",
  "",
  "Arguments:",
  "  <frame.png>  Path to the frame image.",
  "",
  "Options:",
  "  --colour <hex>  Colour to find, for example #CC4726. Required.",
  "  --out <file>  Write the RGBA PNG here. Required. The JSON report goes to stdout.",
  "  --luma-max <n>  Keep only pixels below this luma. Default 150.",
  "  --dist-min <n>  Colour distance that counts as not-the-colour. Default 50.",
  "  --exclude <x,y,w,h>  Rect to clear, in crop coordinates. For example",
  "                       0,131,160,35 clears the text zone at the bottom of the crop.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// Parse a #RRGGBB colour into [r, g, b]. Returns null when it is not one.
export function parseHex(text) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(text).trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Parse an "x,y,w,h" rect into {x, y, w, h}. Returns null when it is not one.
export function parseRect(text) {
  const parts = String(text).split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  const [x, y, w, h] = parts;
  return { x, y, w, h };
}

// Build the insight report from the driver output. Pure function,
// tested without any frame.
export function buildInsightReport(measured, { frame, colour, outPath }) {
  const n = measured.opaque_pixels;
  const status = n > 0 ? "PASS" : "FAIL";
  const box = measured.region_bbox;
  return {
    verdict: {
      status,
      failed_bar: status === "PASS" ? null : "At least one opaque pixel in the extracted shape",
      detail: status === "PASS"
        ? `Found ${n} opaque pixels of the dark shape inside the ${colour} region at (${box.x}, ${box.y}), ${box.w}x${box.h}.`
        : `No opaque pixels found for ${colour} in ${frame}.`,
    },
    numbers: {
      frame,
      colour,
      dist_min: measured.dist_min,
      luma_max: measured.luma_max,
      exclude: measured.exclude,
      region_bbox: measured.region_bbox,
      opaque_pixels: n,
      rifle_bbox: measured.rifle_bbox,
      mask_pixels: measured.mask_pixels,
      components: measured.components,
      output: outPath,
    },
    corrections: [],
    context: {
      thresholds: { dist_min: measured.dist_min, luma_max: measured.luma_max },
      control_ceiling: null,
      meaning: status === "PASS"
        ? `The shape is the largest connected dark component inside the largest ${colour} region, with the exclude rect cleared. Pixel copy only, so the shading is the original shading.`
        : `No dark shape was found inside the ${colour} region. Check the colour and the frame.`,
    },
    next: "hme diagnose ref-frame.png ours-frame.png --scene <scene.json>",
    limits: [
      "The crop is the largest region of the given colour in the frame. When the colour appears in more than one place, only the largest region is used.",
      "The shape is the largest connected dark component inside that region. Shading and compression noise can join it or split it.",
      "The exclude rect is in crop coordinates, with its origin at the crop's top-left corner.",
      "Pixel copy only: no tracing, so the output keeps the original shading and does not invent an outline.",
    ],
  };
}

// The Python driver. It finds the colour region, masks the dark
// shape inside it, keeps the largest component, writes the RGBA PNG,
// and prints exactly one JSON object to stdout.
const DRIVER = `
import json
import sys
from pathlib import Path

FRAME, OUT, SRC = sys.argv[1], sys.argv[2], sys.argv[3]
COLOUR = sys.argv[4]
DIST_MIN = float(sys.argv[5])
LUMA_MAX = float(sys.argv[6])
EXCLUDE = sys.argv[7] or ""
sys.path.insert(0, SRC)
import numpy as np
from PIL import Image
from scipy import ndimage

rgb = tuple(int(COLOUR[i:i + 2], 16) for i in (1, 3, 5))
im = np.asarray(Image.open(FRAME).convert("RGB")).astype(float)
target = np.array(rgb, dtype=float)
dist = np.sqrt(((im - target) ** 2).sum(axis=2))
near = dist <= DIST_MIN
lab, n = ndimage.label(near)
if n == 0:
    raise RuntimeError(f"no pixels near {COLOUR} in {FRAME}")
sizes = ndimage.sum_labels(near, lab, range(1, n + 1))
k = int(np.argmax(sizes)) + 1
ys, xs = np.where(lab == k)
x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
crop = im[y0:y1, x0:x1]
d = np.sqrt(((crop - target) ** 2).sum(axis=2))
luma = 0.2126 * crop[:, :, 0] + 0.7152 * crop[:, :, 1] + 0.0722 * crop[:, :, 2]
mask = (d > DIST_MIN) & (luma < LUMA_MAX)
exclude = None
if EXCLUDE:
    ex, ey, ew, eh = (int(v) for v in EXCLUDE.split(","))
    exclude = {"x": ex, "y": ey, "w": ew, "h": eh}
    mask[max(0, ey):ey + eh, max(0, ex):ex + ew] = False
lab2, n2 = ndimage.label(mask)
if n2 == 0:
    raise RuntimeError(f"no dark shape found inside the {COLOUR} region")
sizes2 = ndimage.sum_labels(mask, lab2, range(1, n2 + 1))
r = int(np.argmax(sizes2)) + 1
shape = lab2 == r
rys, rxs = np.where(shape)
rgba = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
rgba[:, :, :3] = crop.astype(np.uint8)
rgba[:, :, 3] = np.where(shape, 255, 0)
Path(OUT).parent.mkdir(parents=True, exist_ok=True)
Image.fromarray(rgba, "RGBA").save(OUT)
print(json.dumps({
    "frame": FRAME, "colour": COLOUR, "dist_min": DIST_MIN, "luma_max": LUMA_MAX,
    "exclude": exclude,
    "region_bbox": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0},
    "opaque_pixels": int(shape.sum()),
    "rifle_bbox": {"x0": int(rxs.min()), "y0": int(rys.min()),
                   "x1": int(rxs.max()), "y1": int(rys.max()),
                   "w": int(rxs.max() - rxs.min() + 1),
                   "h": int(rys.max() - rys.min() + 1)},
    "mask_pixels": int(mask.sum()), "components": int(n2),
    "output": OUT,
}))
`;

function runDriver(framePath, outPath, colour, distMin, lumaMax, excludeText) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      VENV_PYTHON,
      ["-", framePath, outPath, SRC_DIR, colour, String(distMin), String(lumaMax), excludeText],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", (err) => rejectPromise(new Error(`could not start ${VENV_PYTHON}: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        rejectPromise(new Error(`extract measurement failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`extract measurement returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
    child.stdin.end(DRIVER);
  });
}

// Run `hme extract <frame.png> --colour <hex> --out <png>`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runExtract(argv) {
  const positionals = [];
  let colourArg = null;
  let outPath = null;
  let lumaMax = DEFAULT_LUMA_MAX;
  let distMin = DEFAULT_DIST_MIN;
  let excludeText = "";
  let exclude = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--colour") {
      if (i + 1 >= argv.length) {
        console.error("hme extract: --colour needs a hex colour");
        console.error(USAGE);
        return 2;
      }
      colourArg = argv[++i];
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme extract: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a === "--luma-max") {
      if (i + 1 >= argv.length) {
        console.error("hme extract: --luma-max needs a number");
        console.error(USAGE);
        return 2;
      }
      lumaMax = Number(argv[++i]);
      if (!Number.isFinite(lumaMax)) {
        console.error("hme extract: --luma-max needs a number");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--dist-min") {
      if (i + 1 >= argv.length) {
        console.error("hme extract: --dist-min needs a number");
        console.error(USAGE);
        return 2;
      }
      distMin = Number(argv[++i]);
      if (!Number.isFinite(distMin)) {
        console.error("hme extract: --dist-min needs a number");
        console.error(USAGE);
        return 2;
      }
    } else if (a === "--exclude") {
      if (i + 1 >= argv.length) {
        console.error("hme extract: --exclude needs a rect as x,y,w,h");
        console.error(USAGE);
        return 2;
      }
      excludeText = argv[++i];
      exclude = parseRect(excludeText);
      if (!exclude) {
        console.error(`hme extract: --exclude needs a rect as x,y,w,h, got "${excludeText}"`);
        console.error(USAGE);
        return 2;
      }
    } else if (a.startsWith("--")) {
      console.error(`hme extract: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme extract: needs one frame, <frame.png>");
    console.error(USAGE);
    return 2;
  }
  if (!colourArg) {
    console.error("hme extract: --colour is required");
    console.error(USAGE);
    return 2;
  }
  if (!parseHex(colourArg)) {
    console.error(`hme extract: --colour needs a hex colour like #CC4726, got "${colourArg}"`);
    console.error(USAGE);
    return 2;
  }
  if (!outPath) {
    console.error("hme extract: --out is required");
    console.error(USAGE);
    return 2;
  }
  const [frameArg] = positionals;
  const framePath = resolve(frameArg);
  if (!existsSync(framePath)) {
    console.error(`hme extract: no such file: ${frameArg}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme extract: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  try {
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    const measured = await runDriver(framePath, resolve(outPath), colourArg, distMin, lumaMax, excludeText);
    const report = buildInsightReport(measured, { frame: frameArg, colour: colourArg, outPath: resolve(outPath) });
    return writeInsightReport(report, null);
  } catch (err) {
    console.error(`hme extract: ${err.message}`);
    return 2;
  }
}
