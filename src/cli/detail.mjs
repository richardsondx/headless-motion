// hme detail: scatter counted irregular shapes into a region.
//
// One command, one scatter, one JSON file listing every shape with
// form, centre, size, fill, and path points. The output is countable
// by a script without rendering: the proof's own check counts the
// shapes in the output file.
//
// Why this tool exists: the first-principles review of the style
// school roughs found the chain has no density method anywhere. The
// roughs' scene.json files are layer notes, not drawings, and the
// final agent must hand-place every shape, which is why batch 1 and
// batch 2 stayed sparse. Unit T measured the real frames and Unit B
// turned the counts into recipes. This tool turns a recipe into
// placed shapes: given a region, a palette, a count band, size bands,
// a seed, and a form split, it emits irregular blob paths that are
// reproducible from the seed.
//
// PRNG: mulberry32. The same seed and the same arguments produce
// byte-identical output: one seeded stream, consumed in a fixed
// order, no timestamps, no wall clock, no Math.random anywhere in
// the generation path. JSON is written with fixed key order and
// numbers rounded to 1 decimal.
//
// Shapes are irregular blob paths, not perfect circles or
// rectangles: each blob is a closed path with 6 to 10 control points
// whose radii vary around the nominal size, so the outline wobbles.
// Capsules are rounded-end bars at a random angle. Ring dots are a
// pale outline with a darker centre. Stars are 4-point sparkles.
//
// Presets: --preset m3-disc and --preset m2-lava fill in the Unit B
// recipes (recipe 1 and recipe 2) exactly as written, so a rework
// run needs only a seed. The generic flags below build any other
// scatter. A preset value is echoed in the output file, so the check
// can verify the run against the recipe it claims.
//
// Check: `hme detail --check <detail.json>` reads the tool's own
// output and reports shape count by form, size band coverage, colour
// coverage, and whether the count sits inside the requested band.
// Exit 0 when every group is in band, 1 when any group is out of
// band, 2 on usage error.
//
// Registration note: this module runs standalone
// (`node src/cli/detail.mjs ...`) and exports runDetail for the
// dispatcher. Wiring `hme detail` into src/cli/hme.mjs (one import,
// one COMMANDS entry, one dispatch branch) is a registry edit to an
// existing CLI file, which this unit was forbidden to touch, so it
// is left for the coordinator to approve in a later unit. The tool
// itself is complete without it.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "1.0.0";

export const USAGE = [
  "hme detail: Scatter counted irregular shapes into a region, reproducibly from a seed.",
  "",
  "Usage: hme detail [--preset <name>] [--region <spec>] [--palette <hex,...>] [--count <n|min-max>] [--size-bands <small:a-b,medium:c-d,large:e-f>] [--seed <n>] [--form <name|mix>] [--forms <form:n,...>] [--placement <rule>] [--out <file>]",
  "       hme detail --check <detail.json> [--out <check.json>]",
  "",
  "Presets (Unit B recipes, values echoed in the output):",
  "  m3-disc  Recipe 1, frame-03 disc: 45 to 55 small shapes in 6 forms, 8 spokes, centre group of 3.",
  "  m2-lava  Recipe 2, frame-02 lava and stars: lobes, channel web, patches, crescent speckles, stars.",
  "",
  "Options:",
  "  --region <spec>  Box x,y,w,h in frame px, or disc:cx,cy,r. Default: box 0,0,1280,720.",
  "  --palette <hex,...>  Fill colours, for example #FB3E3E,#FFDC0E,#B2FFFF. Every colour is used at least once when the count allows.",
  "  --count <n|min-max>  Exact count, or a band such as 45-55. A band picks its count from the seed.",
  "  --size-bands <spec>  small:a-b,medium:c-d,large:e-f in px across. Default small:12-20,medium:22-36,large:38-58.",
  "  --seed <n>  Integer seed. Same seed and same arguments give byte-identical output. Default 1.",
  "  --form <name>  One form for every shape: dot, capsule, ring-dot, blob, speckle, star, square, triangle, hexagon, disc, channel. Default mix.",
  "  --forms <form:n,...>  Exact form split, for example dot:25,capsule:13,ring-dot:12,disc:1,square:1,triangle:1. Overrides --form.",
  "  --placement <rule>  scattered-even, clustered, ring, grid, layered, network, web. Default scattered-even.",
  "  --out <file>  Write the scatter JSON here. Without it, the JSON goes to stdout.",
  "  --check <file>  Read a detail output file and report counts, band coverage, and colour coverage. No scatter is made.",
  "",
  "Forms: dot (wobble blob), capsule (rounded-end bar at a random angle), ring-dot (pale outline, darker centre), blob (large wobble blob), speckle (small wobble blob), star (4-point sparkle), square (rounded square), triangle (rounded triangle), hexagon, disc (large round blob), channel (winding polyline branch, width in the size band).",
  "Placement: scattered-even (even across 8 sectors), clustered (3 to 5 clusters), ring (on a ring band), grid (jittered grid), layered (rows by depth), network (tight jittered grid, one network id), web (branches from one shared root).",
  "",
  "Proof: on preset m3-disc with one seed, two runs give byte-identical files and the check reports 45 to 55 shapes in 6 forms, 8 spokes, centre group of 3. A different seed differs in bytes but stays in band. On preset m2-lava the check reports lobes 18 to 25, channel branches 8 to 12, speckles 60 to 75, stars 140 to 175 in three size bands.",
  "Verdict (--check): PASS when every group count sits inside its band, every named form is present, every named size band is present, and every palette colour is used. FAIL otherwise.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// mulberry32: a small seeded PRNG. State is one 32-bit integer.
// Next value is state advanced by 0x6D2B79F5, mixed, divided by 2^32.
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function parseHex(text) {
  const t = text.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(t)) return null;
  return t.toUpperCase();
}

export function parseRegion(text) {
  if (text.startsWith("disc:")) {
    const parts = text.slice(5).split(",").map((p) => Number(p.trim()));
    if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
    const [cx, cy, r] = parts;
    if (r < 1) return null;
    return { kind: "disc", cx, cy, r, x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
  }
  const parts = text.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  const [x, y, w, h] = parts;
  if (w < 1 || h < 1) return null;
  return { kind: "box", x, y, w, h, cx: x + w / 2, cy: y + h / 2, r: Math.min(w, h) / 2 };
}

export function parseCount(text) {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n < 1 ? null : { min: n, max: n };
  }
  const m = text.match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min < 1 || max < min) return null;
  return { min, max };
}

export function parseSizeBands(text) {
  const bands = {};
  for (const part of text.split(",")) {
    const m = part.trim().match(/^([a-z]+):(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const [, name, lo, hi] = m;
    const a = Number(lo);
    const b = Number(hi);
    if (a < 1 || b < a) return null;
    bands[name] = { min: a, max: b };
  }
  if (Object.keys(bands).length === 0) return null;
  return bands;
}

export function parseForms(text) {
  const split = {};
  let total = 0;
  for (const part of text.split(",")) {
    const m = part.trim().match(/^([a-z-]+):(\d+)$/);
    if (!m) return null;
    const [, form, n] = m;
    if (!FORMS.includes(form)) return null;
    split[form] = Number(n);
    total += Number(n);
  }
  if (total < 1) return null;
  return { split, total };
}

export const FORMS = ["dot", "capsule", "ring-dot", "blob", "speckle", "star", "square", "triangle", "hexagon", "disc", "channel"];

export const PLACEMENTS = ["scattered-even", "clustered", "ring", "grid", "layered", "network", "web"];

export const DEFAULT_SIZE_BANDS = {
  small: { min: 12, max: 20 },
  medium: { min: 22, max: 36 },
  large: { min: 38, max: 58 },
};

// The two Unit B recipes, copied exactly as written. No band changed.
export const PRESETS = {
  "m3-disc": {
    description: "Recipe 1, frame-03 disc (Unit B). 45 to 55 small shapes in 6 forms, 8 spokes, centre group of 3.",
    groups: [
      {
        name: "disc-scatter",
        region: { kind: "disc", cx: 639, cy: 359, r: 310, x: 329, y: 49, w: 620, h: 620 },
        palette: ["#FB3E3E", "#FFDC0E", "#B2FFFF", "#B0B7FE", "#FB804F", "#F0B0A0"],
        count: { min: 45, max: 55 },
        forms: { dot: 25, capsule: 13, "ring-dot": 12, disc: 1, square: 1, triangle: 1 },
        size_bands: {
          small: { min: 12, max: 20 },
          medium: { min: 22, max: 36 },
          large: { min: 38, max: 58 },
        },
        capsule: { length: { min: 30, max: 58 }, width: { min: 16, max: 24 } },
        ring_dot: { min: 14, max: 22 },
        placement: "scattered-even",
        inner_exclusion_r: 95,
        outer_margin: 25,
      },
      {
        name: "spokes",
        region: { kind: "disc", cx: 639, cy: 359, r: 310, x: 329, y: 49, w: 620, h: 620 },
        palette: ["#9EEFFA"],
        count: { min: 8, max: 8 },
        forms: { spoke: 8 },
        size_bands: { spoke: { min: 186, max: 186 } },
        placement: "spokes",
      },
      {
        name: "centre-group",
        region: { kind: "disc", cx: 639, cy: 359, r: 310, x: 329, y: 49, w: 620, h: 620 },
        palette: ["#B2FFFF", "#FB3E3E", "#FFDC0E"],
        count: { min: 3, max: 3 },
        forms: { hexagon: 1, disc: 1, triangle: 1 },
        size_bands: {
          hexagon: { min: 130, max: 130 },
          disc: { min: 80, max: 80 },
          triangle: { min: 40, max: 40 },
        },
        placement: "centre",
      },
    ],
  },
  "m2-lava": {
    description: "Recipe 2, frame-02 lava and stars (Unit B). Lobes, channel web, patches, crescent speckles, stars.",
    groups: [
      {
        name: "crust-lobes",
        region: { kind: "disc", cx: 639, cy: 358, r: 255, x: 384, y: 103, w: 510, h: 510 },
        palette: ["#850C25"],
        count: { min: 18, max: 25 },
        forms: { blob: 0 },
        size_bands: { lobe: { min: 40, max: 150 } },
        placement: "network",
        network_id: "lava-network",
      },
      {
        name: "channel-web",
        region: { kind: "disc", cx: 639, cy: 358, r: 255, x: 384, y: 103, w: 510, h: 510 },
        palette: ["#FE7E00", "#FC3900"],
        count: { min: 8, max: 12 },
        forms: { channel: 0 },
        size_bands: { channel: { min: 15, max: 45 } },
        placement: "web",
        network_id: "lava-network",
      },
      {
        name: "mid-patches",
        region: { kind: "disc", cx: 639, cy: 358, r: 255, x: 384, y: 103, w: 510, h: 510 },
        palette: ["#DB141E"],
        count: { min: 8, max: 12 },
        forms: { blob: 0 },
        size_bands: { patch: { min: 20, max: 60 } },
        placement: "scattered-even",
        inner_exclusion_r: 0,
        outer_margin: 15,
      },
      {
        name: "crescent-speckles",
        region: { kind: "box", x: 800, y: 130, w: 94, h: 460, cx: 847, cy: 360, r: 47 },
        palette: ["#EB3148"],
        count: { min: 60, max: 75 },
        forms: { speckle: 0 },
        size_bands: { speckle: { min: 6, max: 14 } },
        placement: "scattered-even",
        inner_exclusion_r: 0,
        outer_margin: 4,
      },
      {
        name: "stars",
        region: { kind: "box", x: 0, y: 0, w: 1280, h: 720, cx: 640, cy: 360, r: 360 },
        palette: ["#FFFFFF", "#BFD9FF"],
        count: { min: 140, max: 175 },
        forms: { dot: 0, star: 0 },
        size_bands: {
          small: { min: 3, max: 6 },
          medium: { min: 6, max: 9 },
          large: { min: 10, max: 16 },
        },
        placement: "field-outside-disc",
        exclude_disc: { cx: 639, cy: 358, r: 345 },
      },
    ],
  },
};

// One irregular closed blob path around a centre. n control points,
// angles spread evenly with jitter, radii wobbling around the nominal
// radius. Returns [[x, y], ...] rounded to 1 decimal.
function blobPath(rand, cx, cy, radius, n) {
  const pts = [];
  const start = rand() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = start + (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.5;
    const r = radius * (0.72 + rand() * 0.56);
    pts.push([round1(cx + Math.cos(a) * r), round1(cy + Math.sin(a) * r)]);
  }
  return pts;
}

// A polygon with one point per corner plus one midpoint per edge,
// each jittered, so a square or triangle reads as a hand-drawn
// shape, not a perfect polygon.
function polyPath(rand, cx, cy, radius, corners) {
  const pts = [];
  const start = rand() * Math.PI * 2;
  for (let i = 0; i < corners; i++) {
    const a0 = start + (i / corners) * Math.PI * 2;
    const a1 = start + ((i + 1) / corners) * Math.PI * 2;
    const r0 = radius * (0.85 + rand() * 0.3);
    pts.push([round1(cx + Math.cos(a0) * r0), round1(cy + Math.sin(a0) * r0)]);
    const am = (a0 + a1) / 2;
    const rm = radius * (0.85 + rand() * 0.3);
    pts.push([round1(cx + Math.cos(am) * rm), round1(cy + Math.sin(am) * rm)]);
  }
  return pts;
}

// A capsule outline: two semicircular ends joined by straight sides,
// each end drawn with 4 points plus jitter. dir is the bar axis,
// perp is across it. The + end semicircle faces +dir, the - end
// faces -dir. Returns the 8 outline points and the angle in degrees.
function capsulePath(rand, cx, cy, length, width) {
  const angle = rand() * Math.PI;
  const half = Math.max(0, (length - width) / 2);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const px = -dy;
  const py = dx;
  const r = width / 2;
  const pts = [];
  const endPts = (sx, sy, sign) => {
    for (let k = 0; k < 4; k++) {
      const t = -Math.PI / 2 + (k / 3) * Math.PI;
      const wob = r * (0.9 + rand() * 0.2);
      const ox = (Math.cos(t) * px + Math.sin(t) * dx * sign) * wob;
      const oy = (Math.cos(t) * py + Math.sin(t) * dy * sign) * wob;
      pts.push([round1(cx + sx + ox), round1(cy + sy + oy)]);
    }
  };
  endPts(dx * half, dy * half, 1);
  endPts(-dx * half, -dy * half, -1);
  return { path: pts, angle: round1((angle * 180) / Math.PI) };
}

// A 4-point sparkle: 8 points alternating outer and inner radius.
function starPath(rand, cx, cy, size) {
  const outer = size / 2;
  const inner = size * 0.18;
  const start = rand() * Math.PI * 2;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = start + (i / 8) * Math.PI * 2;
    const r = i % 2 === 0 ? outer * (0.9 + rand() * 0.2) : inner * (0.9 + rand() * 0.2);
    pts.push([round1(cx + Math.cos(a) * r), round1(cy + Math.sin(a) * r)]);
  }
  return pts;
}

// Pick a size band for one shape. Bands cycle in a seeded shuffle so
// every named band is present when the count allows, roughly in
// small 50, medium 30, large 20 shares.
function bandCycle(rand, count, bandNames) {
  const order = [];
  const shares = { small: 0.5, medium: 0.3, large: 0.2 };
  const names = bandNames.length ? bandNames : ["small", "medium", "large"];
  for (const name of names) {
    const share = shares[name] ?? 1 / names.length;
    const n = Math.max(1, Math.round(count * share));
    for (let i = 0; i < n; i++) order.push(name);
  }
  while (order.length < count) order.push(names[Math.floor(rand() * names.length)]);
  const trimmed = order.slice(0, count);
  for (let i = trimmed.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [trimmed[i], trimmed[j]] = [trimmed[j], trimmed[i]];
  }
  return trimmed;
}

// Colour assignment: each palette colour is used once first (seeded
// shuffle), then the rest are seeded picks. Guarantees full colour
// coverage whenever the count is at least the palette size.
function colourCycle(rand, count, palette) {
  const first = [...palette];
  for (let i = first.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [first[i], first[j]] = [first[j], first[i]];
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(i < first.length ? first[i] : palette[Math.floor(rand() * palette.length)]);
  }
  return out;
}

// Place one centre by the named rule. Returns {x, y} or null when
// the rule cannot place it after its tries.
function placeCentre(rand, placement, region, opts, placed) {
  const { innerR = 0, outerMargin = 0, sector = 0, clusterCentres = null } = opts;
  const cx = region.cx;
  const cy = region.cy;
  const rMax = region.kind === "disc" ? region.r - outerMargin : Math.min(region.w, region.h) / 2;
  const inDisc = (x, y) => {
    if (region.kind !== "disc") return x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h;
    const d = Math.hypot(x - cx, y - cy);
    return d >= innerR && d <= rMax;
  };
  const farEnough = (x, y, minGap) => {
    if (!placed) return true;
    for (const p of placed) {
      if (Math.hypot(x - p.x, y - p.y) < minGap) return false;
    }
    return true;
  };
  for (let attempt = 0; attempt < 40; attempt++) {
    let x;
    let y;
    if (placement === "scattered-even" || placement === "network") {
      const a0 = sector * (Math.PI / 4);
      const a = a0 + rand() * (Math.PI / 4);
      const rr = region.kind === "disc"
        ? innerR + Math.sqrt(rand()) * (rMax - innerR)
        : 0;
      if (region.kind === "disc") {
        x = cx + Math.cos(a) * rr;
        y = cy + Math.sin(a) * rr;
      } else {
        x = region.x + rand() * region.w;
        y = region.y + rand() * region.h;
      }
    } else if (placement === "ring") {
      const a = rand() * Math.PI * 2;
      const rr = rMax * (0.8 + rand() * 0.2);
      x = cx + Math.cos(a) * rr;
      y = cy + Math.sin(a) * rr;
    } else if (placement === "clustered") {
      const c = clusterCentres[Math.floor(rand() * clusterCentres.length)];
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * (region.kind === "disc" ? region.r * 0.3 : 60);
      x = c.x + Math.cos(a) * rr;
      y = c.y + Math.sin(a) * rr;
    } else if (placement === "grid") {
      // Jittered grid: shape i sits in cell i of a grid over the
      // region, cols picked so the grid is roughly square.
      const total = opts.total ?? 1;
      const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
      const cellW = region.w / cols;
      const rows = Math.ceil(total / cols);
      const cellH = region.h / rows;
      const col = (opts.index ?? 0) % cols;
      const row = Math.floor((opts.index ?? 0) / cols);
      x = region.x + col * cellW + cellW * (0.2 + rand() * 0.6);
      y = region.y + row * cellH + cellH * (0.2 + rand() * 0.6);
    } else if (placement === "layered") {
      // Rows by depth: shape i sits in layer i mod 4, one horizontal
      // band per layer, near to far from the bottom band up.
      const total = opts.total ?? 1;
      void total;
      const layer = (opts.index ?? 0) % 4;
      const bandH = region.h / 4;
      x = region.x + rand() * region.w;
      y = region.y + (3 - layer) * bandH + rand() * bandH;
    } else {
      x = region.x + rand() * region.w;
      y = region.y + rand() * region.h;
    }
    if (!inDisc(x, y)) continue;
    if (!farEnough(x, y, opts.minGap ?? 0)) continue;
    return { x: round1(x), y: round1(y) };
  }
  return null;
}

// Build one shape object at a centre. The caller owns placement,
// band, and colour. Path points are box-free absolute px.
function buildShape(rand, id, group, form, centre, size, sizeBand, fill, extra = {}) {
  const radius = size / 2;
  const base = {
    id,
    group,
    form,
    centre: { x: centre.x, y: centre.y },
    size: round1(size),
    size_band: sizeBand,
    fill,
  };
  if (form === "capsule") {
    const length = extra.length ?? size;
    const width = extra.width ?? size * 0.4;
    const { path, angle } = capsulePath(rand, centre.x, centre.y, length, width);
    return { ...base, size: round1(length), length: round1(length), width: round1(width), angle, path };
  }
  if (form === "star") {
    return { ...base, path: starPath(rand, centre.x, centre.y, size) };
  }
  if (form === "square") {
    return { ...base, path: polyPath(rand, centre.x, centre.y, radius, 4) };
  }
  if (form === "triangle") {
    return { ...base, path: polyPath(rand, centre.x, centre.y, radius, 3) };
  }
  if (form === "hexagon") {
    return { ...base, path: polyPath(rand, centre.x, centre.y, radius, 6) };
  }
  if (form === "ring-dot") {
    const innerFill = extra.centre_fill;
    const innerSize = round1(size * 0.45);
    return {
      ...base,
      centre_fill: innerFill,
      inner_size: innerSize,
      path: blobPath(rand, centre.x, centre.y, radius, 6 + Math.floor(rand() * 3)),
    };
  }
  if (form === "channel") {
    return { ...base, width: round1(extra.width ?? 25), path: extra.path ?? [] };
  }
  if (form === "spoke") {
    return { ...base, path: extra.path ?? [] };
  }
  const n = form === "speckle" ? 6 : 6 + Math.floor(rand() * 5);
  return { ...base, path: blobPath(rand, centre.x, centre.y, radius, n) };
}

// One winding branch from near the root outward, 5 to 8 segments.
function channelBranch(rand, root, region, width) {
  const angle = rand() * Math.PI * 2;
  const pts = [[round1(root.x), round1(root.y)]];
  let a = angle;
  let x = root.x;
  let y = root.y;
  const steps = 5 + Math.floor(rand() * 4);
  const stepLen = (region.r * 0.85) / steps;
  for (let i = 0; i < steps; i++) {
    a += (rand() - 0.5) * 0.9;
    x += Math.cos(a) * stepLen * (0.7 + rand() * 0.6);
    y += Math.sin(a) * stepLen * (0.7 + rand() * 0.6);
    const d = Math.hypot(x - region.cx, y - region.cy);
    if (d > region.r - 5) break;
    pts.push([round1(x), round1(y)]);
  }
  const end = pts[pts.length - 1];
  void width;
  return { path: pts, centre: { x: end[0], y: end[1] } };
}

// Generate one group of shapes from one seeded stream. The stream
// is consumed in a fixed order: count, band cycle, colour cycle,
// then per shape: centre, size, path. Nothing else reads the stream.
function generateGroup(rand, group, prefix) {
  const count = group.count.min === group.count.max
    ? group.count.min
    : group.count.min + Math.floor(rand() * (group.count.max - group.count.min + 1));
  const shapes = [];
  const region = group.region;
  const palette = group.palette;

  if (group.placement === "spokes") {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const len = group.size_bands.spoke.min;
      const x0 = region.cx + Math.cos(a) * 95;
      const y0 = region.cy + Math.sin(a) * 95;
      const x1 = region.cx + Math.cos(a) * (95 + len);
      const y1 = region.cy + Math.sin(a) * (95 + len);
      const w = 3;
      const px = -Math.sin(a) * w;
      const py = Math.cos(a) * w;
      shapes.push({
        id: `${prefix}-spoke-${i + 1}`,
        group: group.name,
        form: "spoke",
        centre: { x: round1((x0 + x1) / 2), y: round1((y0 + y1) / 2) },
        size: len,
        size_band: "spoke",
        fill: palette[0],
        angle: round1((a * 180) / Math.PI),
        path: [
          [round1(x0 + px), round1(y0 + py)],
          [round1(x1 + px), round1(y1 + py)],
          [round1(x1 - px), round1(y1 - py)],
          [round1(x0 - px), round1(y0 - py)],
        ],
      });
    }
    return { shapes, count };
  }

  if (group.placement === "centre") {
    const specs = [
      { form: "hexagon", size: group.size_bands.hexagon.min, fill: palette[0] },
      { form: "disc", size: group.size_bands.disc.min, fill: palette[1] },
      { form: "triangle", size: group.size_bands.triangle.min, fill: palette[2] },
    ];
    specs.forEach((s, i) => {
      shapes.push(buildShape(rand, `${prefix}-centre-${i + 1}`, group.name, s.form, { x: region.cx, y: region.cy }, s.size, s.form, s.fill));
    });
    return { shapes, count: shapes.length };
  }

  if (group.placement === "web") {
    const root = { x: region.cx + round1((rand() - 0.5) * 40), y: region.cy + round1((rand() - 0.5) * 40) };
    for (let i = 0; i < count; i++) {
      const width = round1(group.size_bands.channel.min + rand() * (group.size_bands.channel.max - group.size_bands.channel.min));
      const branch = channelBranch(rand, root, region, width);
      const len = round1(Math.hypot(branch.centre.x - root.x, branch.centre.y - root.y));
      shapes.push({
        id: `${prefix}-channel-${i + 1}`,
        group: group.name,
        form: "channel",
        centre: branch.centre,
        size: len,
        size_band: "channel",
        fill: palette[i % palette.length],
        width,
        path: branch.path,
        network_id: group.network_id,
      });
    }
    return { shapes, count };
  }

  if (group.placement === "network") {
    // Tight jittered grid inside the disc, spacing 50 px, lobe sizes
    // 55 to 150 px, so neighbours overlap by construction. The tool
    // does not run a pixel connectivity check: "one joined network"
    // is a placement property here, not a verified pixel fact. See
    // the proof for the stated limit.
    const spacing = 50;
    const cells = [];
    for (let gx = region.x + spacing / 2; gx < region.x + region.w; gx += spacing) {
      for (let gy = region.y + spacing / 2; gy < region.y + region.h; gy += spacing) {
        if (Math.hypot(gx - region.cx, gy - region.cy) < region.r - 20) cells.push({ x: gx, y: gy });
      }
    }
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    const picked = cells.slice(0, count);
    const colours = colourCycle(rand, count, palette);
    picked.forEach((cell, i) => {
      const cx = round1(cell.x + (rand() - 0.5) * 20);
      const cy = round1(cell.y + (rand() - 0.5) * 20);
      const size = round1(55 + rand() * (group.size_bands.lobe.max - 55));
      const shape = buildShape(rand, `${prefix}-lobe-${i + 1}`, group.name, "blob", { x: cx, y: cy }, size, "lobe", colours[i]);
      shape.network_id = group.network_id;
      shapes.push(shape);
    });
    return { shapes, count };
  }

  // General scatter group: form split, size bands, colours, placement.
  let formList = [];
  if (group.forms) {
    const entries = Object.entries(group.forms);
    const fixed = entries.filter(([, n]) => n > 0);
    const zero = entries.filter(([, n]) => n === 0);
    if (fixed.length) {
      // The recipe split totals 53, but the picked count may be any
      // number in the band. Scale the split to the picked count:
      // singletons (the large disc, square, triangle) stay at 1,
      // the rest scale in proportion, and the largest form absorbs
      // the rounding so the list sums to the count exactly. A plain
      // slice would silently drop forms when the count is below 53.
      const total = fixed.reduce((a, [, n]) => a + n, 0);
      const singles = fixed.filter(([, n]) => n === 1);
      const scaled = fixed.filter(([, n]) => n > 1);
      const rest = count - singles.length;
      const scaledTotal = scaled.reduce((a, [, n]) => a + n, 0);
      const scaledCounts = scaled.map(([form, n]) => [form, Math.max(1, Math.round((n / scaledTotal) * rest))]);
      let sum = scaledCounts.reduce((a, [, n]) => a + n, 0) + singles.length;
      let bi = 0;
      while (sum !== count) {
        const [form, n] = scaledCounts[bi % scaledCounts.length];
        if (sum < count) { scaledCounts[bi % scaledCounts.length] = [form, n + 1]; sum++; }
        else if (n > 1) { scaledCounts[bi % scaledCounts.length] = [form, n - 1]; sum--; }
        bi++;
        if (bi > 1000) break;
      }
      void total;
      for (const [form, n] of [...scaledCounts, ...singles]) {
        for (let i = 0; i < n; i++) formList.push(form);
      }
    } else if (zero.length) {
      // Count band with no fixed split: share the count across the
      // named forms. The m2 stars group uses its own split below.
      formList = null;
    }
  }
  if (formList === null) {
    if (group.name === "stars") {
      const small = Math.round(count * 0.6);
      const medium = Math.round(count * 0.25);
      const large = count - small - medium;
      const bands = [];
      for (let i = 0; i < small; i++) bands.push({ form: "dot", band: "small" });
      for (let i = 0; i < medium; i++) bands.push({ form: "dot", band: "medium" });
      for (let i = 0; i < large; i++) bands.push({ form: "star", band: "large" });
      for (let i = bands.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [bands[i], bands[j]] = [bands[j], bands[i]];
      }
      const colours = colourCycle(rand, count, palette);
      const placed = [];
      bands.forEach((b, i) => {
        const band = group.size_bands[b.band];
        const size = round1(band.min + rand() * (band.max - band.min));
        let centre = null;
        for (let attempt = 0; attempt < 40 && !centre; attempt++) {
          const x = round1(group.region.x + rand() * group.region.w);
          const y = round1(group.region.y + rand() * group.region.h);
          const ex = group.exclude_disc;
          if (ex && Math.hypot(x - ex.cx, y - ex.cy) < ex.r) continue;
          centre = { x, y };
        }
        if (!centre) centre = { x: group.region.x + 10, y: group.region.y + 10 };
        placed.push(centre);
        shapes.push(buildShape(rand, `${prefix}-star-${i + 1}`, group.name, b.form, centre, size, b.band, colours[i]));
      });
      return { shapes, count };
    }
    const names = Object.entries(group.forms ?? {}).filter(([, n]) => n === 0).map(([f]) => f);
    if (!names.length) return { shapes, count: 0 };
    formList = [];
    const per = Math.floor(count / names.length);
    names.forEach((form) => { for (let i = 0; i < per; i++) formList.push(form); });
    while (formList.length < count) formList.push(names[0]);
  }
  // Seeded shuffle of the form order, so forms spread across sectors.
  for (let i = formList.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [formList[i], formList[j]] = [formList[j], formList[i]];
  }
  const bandNames = Object.keys(group.size_bands).filter((b) => ["small", "medium", "large"].includes(b));
  // Dots draw their band from a seeded cycle so every named band is
  // present. Every other form gets its size from its own rule, and
  // its band is derived from that size, so the band a shape reports
  // always matches the size it carries.
  const dotBands = bandNames.length ? bandCycle(rand, count, bandNames) : formList.map(() => Object.keys(group.size_bands)[0]);
  const bandForSize = (size) => {
    if (!bandNames.length) return Object.keys(group.size_bands)[0];
    for (const name of bandNames) {
      const b = group.size_bands[name];
      if (size >= b.min && size <= b.max) return name;
    }
    let best = bandNames[0];
    let bestD = Infinity;
    for (const name of bandNames) {
      const b = group.size_bands[name];
      const d = size < b.min ? b.min - size : size - b.max;
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  };
  const colours = colourCycle(rand, count, palette);
  const clusterCentres = group.placement === "clustered"
    ? Array.from({ length: 4 }, () => ({ x: round1(region.x + rand() * region.w), y: round1(region.y + rand() * region.h) }))
    : null;
  const placed = [];
  formList.forEach((form, i) => {
    const band = group.size_bands[dotBands[i]] ?? group.size_bands[Object.keys(group.size_bands)[0]];
    let size;
    if (form === "dot") size = round1(band.min + rand() * (band.max - band.min));
    else if (form === "disc" && group.name === "disc-scatter") size = 60;
    else if (form === "square") size = 30;
    else if (form === "triangle" && group.name === "disc-scatter") size = 34;
    else if (form === "ring-dot" && group.ring_dot) size = round1(group.ring_dot.min + rand() * (group.ring_dot.max - group.ring_dot.min));
    else size = round1(band.min + rand() * (band.max - band.min));
    const bandName = bandForSize(size);
    const sector = i % 8;
    const centre = placeCentre(rand, group.placement, region, {
      innerR: group.inner_exclusion_r ?? 0,
      outerMargin: group.outer_margin ?? 0,
      sector,
      clusterCentres,
      minGap: size * 0.4,
      index: i,
      total: count,
    }, placed) ?? { x: region.cx, y: region.cy };
    placed.push(centre);
    const extra = {};
    if (form === "capsule" && group.capsule) {
      extra.length = round1(group.capsule.length.min + rand() * (group.capsule.length.max - group.capsule.length.min));
      extra.width = round1(group.capsule.width.min + rand() * (group.capsule.width.max - group.capsule.width.min));
      size = extra.length;
    }
    if (form === "ring-dot") {
      const dark = palette.filter((c) => c !== colours[i]);
      extra.centre_fill = dark[Math.floor(rand() * dark.length)] ?? colours[i];
    }
    shapes.push(buildShape(rand, `${prefix}-${i + 1}`, group.name, form, centre, size, bandForSize(size), colours[i], extra));
  });
  return { shapes, count };
}

export function generateScatter(request) {
  const rand = mulberry32(request.seed);
  const groups = [];
  const shapes = [];
  request.groups.forEach((group, gi) => {
    const { shapes: made } = generateGroup(rand, group, `g${gi + 1}`);
    groups.push({
      name: group.name,
      region: group.region,
      palette: group.palette,
      count_band: group.count,
      count: made.length,
      forms: group.forms ?? null,
      size_bands: group.size_bands,
      placement: group.placement,
      shapes: made.length,
    });
    shapes.push(...made);
  });
  return {
    tool: "hme detail",
    version: VERSION,
    seed: request.seed,
    preset: request.preset ?? null,
    description: request.description ?? null,
    groups,
    shapes,
  };
}

// The check: reads the tool's own output and reports, per group,
// count by form, size band coverage, colour coverage, and whether
// the count sits inside the requested band. No hand-made file.
export function checkScatter(doc) {
  const perGroup = [];
  let pass = true;
  for (const group of doc.groups ?? []) {
    const shapes = (doc.shapes ?? []).filter((s) => s.group === group.name);
    const byForm = {};
    for (const s of shapes) byForm[s.form] = (byForm[s.form] ?? 0) + 1;
    const bandNames = Object.keys(group.size_bands ?? {});
    const bandsPresent = {};
    for (const b of bandNames) bandsPresent[b] = shapes.some((s) => s.size_band === b);
    const coloursUsed = {};
    for (const c of group.palette ?? []) {
      coloursUsed[c] = shapes.some((s) => s.fill === c || s.centre_fill === c);
    }
    const missingColours = Object.entries(coloursUsed).filter(([, used]) => !used).map(([c]) => c);
    const missingBands = bandNames.filter((b) => !bandsPresent[b]);
    const namedForms = group.forms ? Object.keys(group.forms).filter((f) => group.forms[f] > 0) : [...new Set(shapes.map((s) => s.form))];
    const missingForms = namedForms.filter((f) => !(byForm[f] > 0));
    const inBand = shapes.length >= group.count_band.min && shapes.length <= group.count_band.max;
    const groupPass = inBand && missingBands.length === 0 && missingColours.length === 0 && missingForms.length === 0;
    if (!groupPass) pass = false;
    perGroup.push({
      group: group.name,
      count: shapes.length,
      count_band: group.count_band,
      in_band: inBand,
      count_by_form: byForm,
      size_bands: bandsPresent,
      missing_size_bands: missingBands,
      colour_coverage: coloursUsed,
      missing_colours: missingColours,
      missing_forms: missingForms,
      pass: groupPass,
    });
  }
  return { tool: "hme detail check", seed: doc.seed ?? null, preset: doc.preset ?? null, pass, groups: perGroup };
}

function writeJsonOut(doc, outPath) {
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(resolve(outPath), text);
    return outPath;
  }
  process.stdout.write(text);
  return null;
}

// Run `hme detail ...` or `node src/cli/detail.mjs ...`.
// Returns the process exit code: 0 ok or PASS, 1 FAIL, 2 usage error.
// Never prints a stack trace.
export async function runDetail(argv) {
  let checkPath = null;
  let presetName = null;
  let regionText = null;
  let paletteText = null;
  let countText = null;
  let sizeBandsText = null;
  let seed = 1;
  let formText = "mix";
  let formsText = null;
  let placement = "scattered-even";
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      if (i + 1 >= argv.length) {
        console.error(`hme detail: ${flag} needs a value`);
        console.error(USAGE);
        return null;
      }
      return argv[++i];
    };
    if (a === "--check") { checkPath = need(a); if (checkPath === null) return 2; }
    else if (a === "--preset") { presetName = need(a); if (presetName === null) return 2; }
    else if (a === "--region") { regionText = need(a); if (regionText === null) return 2; }
    else if (a === "--palette") { paletteText = need(a); if (paletteText === null) return 2; }
    else if (a === "--count") { countText = need(a); if (countText === null) return 2; }
    else if (a === "--size-bands") { sizeBandsText = need(a); if (sizeBandsText === null) return 2; }
    else if (a === "--seed") {
      const v = need(a); if (v === null) return 2;
      seed = Number(v);
      if (!Number.isInteger(seed)) { console.error("hme detail: --seed needs a whole number"); console.error(USAGE); return 2; }
    }
    else if (a === "--form") { formText = need(a); if (formText === null) return 2; }
    else if (a === "--forms") { formsText = need(a); if (formsText === null) return 2; }
    else if (a === "--placement") { placement = need(a); if (placement === null) return 2; }
    else if (a === "--out") { outPath = need(a); if (outPath === null) return 2; }
    else if (a === "--help" || a === "-h") { process.stdout.write(USAGE); return 0; }
    else if (a.startsWith("--")) { console.error(`hme detail: unknown option "${a}"`); console.error(USAGE); return 2; }
    else { console.error(`hme detail: unexpected argument "${a}"`); console.error(USAGE); return 2; }
  }

  if (checkPath) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(resolve(checkPath), "utf8"));
    } catch (err) {
      console.error(`hme detail: cannot read ${checkPath}: ${err.message}`);
      return 2;
    }
    if (doc.tool !== "hme detail" || !Array.isArray(doc.shapes) || !Array.isArray(doc.groups)) {
      console.error("hme detail: --check needs a detail output file (tool hme detail, with shapes and groups)");
      return 2;
    }
    const report = checkScatter(doc);
    writeJsonOut(report, outPath);
    if (!outPath) {
      for (const g of report.groups) {
        console.error(`${g.pass ? "PASS" : "FAIL"} ${g.group}: ${g.count} shapes, band ${g.count_band.min}-${g.count_band.max}, in band: ${g.in_band}`);
      }
    }
    return report.pass ? 0 : 1;
  }

  let request;
  if (presetName) {
    const preset = PRESETS[presetName];
    if (!preset) {
      console.error(`hme detail: unknown preset "${presetName}", want m3-disc or m2-lava`);
      console.error(USAGE);
      return 2;
    }
    request = { seed, preset: presetName, description: preset.description, groups: preset.groups };
  } else {
    if (!regionText || !paletteText || !countText) {
      console.error("hme detail: without --preset, --region, --palette, and --count are all required");
      console.error(USAGE);
      return 2;
    }
    const region = parseRegion(regionText);
    if (!region) { console.error(`hme detail: bad --region "${regionText}", want x,y,w,h or disc:cx,cy,r`); console.error(USAGE); return 2; }
    const palette = paletteText.split(",").map(parseHex);
    if (palette.some((c) => c === null)) { console.error(`hme detail: bad --palette "${paletteText}", want hex colours like #FB3E3E`); console.error(USAGE); return 2; }
    const count = parseCount(countText);
    if (!count) { console.error(`hme detail: bad --count "${countText}", want a number or min-max`); console.error(USAGE); return 2; }
    const sizeBands = sizeBandsText ? parseSizeBands(sizeBandsText) : DEFAULT_SIZE_BANDS;
    if (!sizeBands) { console.error(`hme detail: bad --size-bands "${sizeBandsText}", want small:a-b,medium:c-d,large:e-f`); console.error(USAGE); return 2; }
    if (!PLACEMENTS.includes(placement)) { console.error(`hme detail: bad --placement "${placement}", want one of ${PLACEMENTS.join(", ")}`); console.error(USAGE); return 2; }
    let forms = null;
    if (formsText) {
      const parsed = parseForms(formsText);
      if (!parsed) { console.error(`hme detail: bad --forms "${formsText}", want form:n,...`); console.error(USAGE); return 2; }
      forms = parsed.split;
    } else if (formText !== "mix") {
      if (!FORMS.includes(formText)) { console.error(`hme detail: bad --form "${formText}", want one of ${FORMS.join(", ")} or mix`); console.error(USAGE); return 2; }
      forms = { [formText]: 0 };
    } else {
      forms = { dot: 0 };
    }
    request = {
      seed,
      preset: null,
      description: null,
      groups: [{
        name: "scatter",
        region,
        palette,
        count,
        forms,
        size_bands: sizeBands,
        placement,
        inner_exclusion_r: 0,
        outer_margin: 0,
      }],
    };
  }
  const doc = generateScatter(request);
  const written = writeJsonOut(doc, outPath);
  if (written) console.error(`hme detail: wrote ${doc.shapes.length} shapes to ${written}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runDetail(process.argv.slice(2));
}
