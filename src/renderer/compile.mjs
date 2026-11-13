// Scene -> page.html. Differences from the HyperFrames composition way:
// 1. HyperFrames composes with data-* attributes and window.__timelines and
//    renders through its CLI. This adapter drives every frame from the
//    evaluator (sampleScene) through window.__hme.seek(f), so the same
//    scene and profile give the same bytes, and a test can compare the DOM
//    state with the evaluator frame by frame.
// 2. GSAP is inlined from local node_modules, never from a CDN.
// 3. Fonts and images are embedded as data: URIs. No network at render.
// 4. No Studio, preview, or publish step. Output is page.html + MP4.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateScene, loadScene } from "../scene/validate.mjs";
import { computeMapState } from "../map/compile.mjs";
import { cameraMatrix } from "../map/project.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const MIME = { ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Resolve a scene-relative local path against the scene file's directory. */
export function resolveAsset(sceneDir, src) {
  if (/^https?:\/\//.test(src)) return { url: src, external: true };
  const p = resolve(sceneDir, src);
  return { path: p, url: null, external: false };
}

function dataUri(path) {
  return `data:${MIME[extname(path).toLowerCase()] || "application/octet-stream"};base64,${readFileSync(path).toString("base64")}`;
}

/** Inline the evaluator bundle: easing + evaluate, with the import removed. */
function evaluatorBundle() {
  const easing = readFileSync(resolve(ROOT, "src/scene/easing.mjs"), "utf8");
  const evaluate = readFileSync(resolve(ROOT, "src/scene/evaluate.mjs"), "utf8").replace(
    /import \{ ease \} from "\.\/easing\.mjs";\n/,
    "",
  );
  return easing + "\n" + evaluate;
}

function resolvePalette(v, palette) {
  if (typeof v !== 'string' || v.startsWith('#')) return v;
  const e = palette[v];
  return e ? (typeof e === 'string' ? e : e.color) : v;
}

/** Format a number without float noise: 33.300000000000004 -> "33.3". */
function fmtNum(n) {
  return String(Number(Number(n).toFixed(4)));
}

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || "");
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

/**
 * Compile a points list to SVG path data. The first point is M. Each
 * later point draws the segment that arrives at it: line is L, cubic is
 * C with the previous point's out-handle and this point's in-handle,
 * smooth is S with this point's in-handle. A null handle reads as its
 * own anchor. closed appends Z. Numbers go through fmtNum. No
 * Math.random, no Date, no locale: the same list gives the same d.
 */
export function pointsToD(points, closed) {
  if (!Array.isArray(points) || points.length === 0) return "";
  const pt = (p) => `${fmtNum(p[0])} ${fmtNum(p[1])}`;
  const parts = [`M ${pt(points[0].anchor)}`];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const anchor = pt(cur.anchor);
    if (cur.command === "cubic") {
      parts.push(`C ${pt(prev.out || prev.anchor)} ${pt(cur.in || cur.anchor)} ${anchor}`);
    } else if (cur.command === "smooth") {
      parts.push(`S ${pt(cur.in || cur.anchor)} ${anchor}`);
    } else {
      parts.push(`L ${anchor}`);
    }
  }
  if (closed) parts.push("Z");
  return parts.join(" ");
}

/** A gradient stop as a CSS color: hex as-is at alpha 1, rgba() otherwise. */
function stopCss(stop, palette) {
  const color = resolvePalette(stop.color, palette);
  const alpha = stop.alpha ?? 1;
  return alpha === 1 ? color : hexToRgba(color, alpha);
}

/**
 * CSS background for a gradient fill, or null when fill is not a gradient.
 * Linear: angle in degrees, CSS convention (0 = to top, 90 = to right).
 * Radial: ellipse of radii r*w, r*h px centred at (cx, cy) — the px form
 * of the SVG objectBoundingBox radial (r is a fraction of the box, so the
 * SVG circle in unit space is an ellipse rx=r*w, ry=r*h on a non-square
 * box). Chromium 1248 drops `circle <percentage>` (computed
 * backgroundImage is `none`), so the size must be in px. Verified
 * empirically in Chromium 1248 (radial-probe): the ellipse form matches
 * the SVG radialGradient to max channel diff 1 on square, wide (400x200)
 * and tall (200x400) boxes; `circle r*sqrt(w^2+h^2)/sqrt(2)` differs by
 * up to 63 on non-square boxes. On a square box the ellipse reduces to
 * `circle r*w px` (224px for r=0.7, 320px). Absent / flat fills return
 * null, so flat nodes keep today's output. `box` is the node box {w, h}.
 */
function gradientCss(grad, palette, box) {
  if (!grad || typeof grad !== "object") return null;
  const stops = (grad.stops || []).map((s) => `${stopCss(s, palette)} ${fmtNum(s.at * 100)}%`).join(", ");
  if (grad.type === "linear") return `linear-gradient(${grad.angle}deg, ${stops})`;
  if (grad.type === "radial") {
    const cx = fmtNum(grad.cx * 100);
    const cy = fmtNum(grad.cy * 100);
    const w = box && box.w > 0 ? box.w : 0;
    const h = box && box.h > 0 ? box.h : 0;
    if (w && h) return `radial-gradient(ellipse ${fmtNum(grad.r * w)}px ${fmtNum(grad.r * h)}px at ${cx}% ${cy}%, ${stops})`;
    return `radial-gradient(circle at ${cx}% ${cy}%, ${stops})`;
  }
  return null;
}

/**
 * CSS filter for a shape node's glow and/or soft. "" when neither, so flat
 * nodes get no filter property at all. Glow is a drop-shadow halo (radius
 * px, colour at intensity alpha); soft blurs the shape itself.
 */
function shapeFilterCss(p, palette) {
  const parts = [];
  if (p.glow) parts.push(`drop-shadow(0 0 ${p.glow.radius}px ${hexToRgba(resolvePalette(p.glow.color, palette), p.glow.intensity)})`);
  if (p.soft) parts.push(`blur(${p.soft.radius}px)`);
  return parts.join(" ");
}

/**
 * CSS filter for an image node's filter. "" when none, so unfiltered
 * images keep today's output byte-identical. Grayscale first, then
 * blur, the same order the shape builder uses (drop-shadow then blur).
 */
function imageFilterCss(p) {
  const f = p.filter;
  if (!f) return "";
  const parts = [];
  if (f.grayscale !== undefined) parts.push(`grayscale(${fmtNum(f.grayscale)})`);
  if (f.blur !== undefined) parts.push(`blur(${fmtNum(f.blur)}px)`);
  return parts.join(" ");
}

/**
 * SVG <filter> for a shape node's glow and/or soft. "" when neither.
 * stdDeviation is the radius in px (the CSS blur()/drop-shadow() mapping:
 * the blur radius is the Gaussian stdDeviation). The filter region is
 * expanded so a halo/blur is not clipped at the shape box. With both,
 * the shape is blurred first, then the halo is drawn from the blurred
 * shape (feDropShadow composites its input over its shadow).
 */
function shapeSvgFilter(node, palette) {
  const p = node.props;
  if (!p.glow && !p.soft) return "";
  const id = esc(node.id);
  const ops = [];
  if (p.soft) ops.push(`<feGaussianBlur in="SourceGraphic" stdDeviation="${p.soft.radius}" result="soft"/>`);
  if (p.glow) {
    const color = resolvePalette(p.glow.color, palette);
    const src = p.soft ? "soft" : "SourceGraphic";
    ops.push(`<feDropShadow in="${src}" dx="0" dy="0" stdDeviation="${p.glow.radius}" flood-color="${esc(color)}" flood-opacity="${p.glow.intensity}"/>`);
  }
  return `<filter id="fx-${id}" x="-100%" y="-100%" width="300%" height="300%">${ops.join("")}</filter>`;
}

/**
 * SVG <defs> for one shape node's gradient fill and glow/soft filter.
 * "" when the node has neither, so flat path nodes keep today's output.
 * Linear angles use the CSS convention (0 = to top, 90 = to right),
 * converted to objectBoundingBox x1/y1/x2/y2; radial uses cx/cy/r as
 * objectBoundingBox fractions, as validated by the schema.
 */
function shapeSvgDefs(node, palette) {
  const p = node.props;
  const parts = [];
  if (p.fill && typeof p.fill === "object") {
    const g = p.fill;
    const stops = (g.stops || []).map((s) => {
      const color = resolvePalette(s.color, palette);
      return `<stop offset="${fmtNum(s.at * 100)}%" stop-color="${esc(color)}" stop-opacity="${s.alpha ?? 1}"/>`;
    }).join("");
    if (g.type === "linear") {
      const rad = (g.angle * Math.PI) / 180;
      const dx = Math.sin(rad);
      const dy = -Math.cos(rad);
      parts.push(`<linearGradient id="grad-${esc(node.id)}" x1="${fmtNum(0.5 - dx / 2)}" y1="${fmtNum(0.5 - dy / 2)}" x2="${fmtNum(0.5 + dx / 2)}" y2="${fmtNum(0.5 + dy / 2)}">${stops}</linearGradient>`);
    } else if (g.type === "radial") {
      parts.push(`<radialGradient id="grad-${esc(node.id)}" cx="${fmtNum(g.cx)}" cy="${fmtNum(g.cy)}" r="${fmtNum(g.r)}">${stops}</radialGradient>`);
    }
  }
  const filter = shapeSvgFilter(node, palette);
  if (filter) parts.push(filter);
  return parts.length ? `<defs>${parts.join("")}</defs>` : "";
}

/**
 * Polygon `d` is "x,y x,y ..." points per the schema, but an SVG <path>
 * needs M/L/Z commands; the raw points string draws nothing (the browser
 * reports "Expected moveto path command"). Convert at compile time.
 * A string that does not parse as points passes through unchanged, so
 * malformed input fails exactly as before.
 */
function polygonToPath(d) {
  const pts = String(d || "").trim().split(/\s+/).filter(Boolean);
  if (pts.length < 2) return d;
  const ok = pts.every((pt) => /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(pt));
  if (!ok) return d;
  return `M ${pts[0]} L ${pts.slice(1).join(" L ")} Z`;
}

function nodeHtml(node, sceneDir, palette) {
  const b = node.box || { x: 0, y: 0, w: 0, h: 0 };
  const base = `data-node="${esc(node.id)}"`;
  if (node.type === "text") {
    const f = node.props.font;
    const color = node.props.color;
    return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z};font-family:'${esc(f.family)}';font-weight:${f.weight};font-size:${f.size}px;letter-spacing:${f.letterSpacing ?? 0}px;line-height:${f.lineHeight ?? 1.2};color:${esc(resolvePalette(color, palette))};text-align:${node.props.align || "left"};font-kerning:normal;text-rendering:geometricPrecision;white-space:pre-wrap">${esc(node.props.text)}</div>`;
  }
  if (node.type === "shape") {
    const p = node.props;
    // A points list wins over d when present. d stays as the fallback
    // for traced scenes. Compile here so every path kind shares it.
    const pointsD = p.points ? pointsToD(p.points, p.closed) : null;
    if (p.kind === "rect" || p.kind === "ellipse") {
      const radius = p.kind === "ellipse" ? "50%" : (p.radius ?? 0) + "px";
      // Gradient / glow / soft are appended only when present; with none
      // of them this string is byte-identical to the pre-change output.
      const extra = [];
      const bg = gradientCss(p.fill, palette, b);
      if (bg) extra.push(`background:${bg}`);
      const filter = shapeFilterCss(p, palette);
      if (filter) extra.push(`filter:${filter}`);
      const tail = extra.length ? `;${extra.join(";")}` : "";
      return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z};border-radius:${radius}${tail}"></div>`;
    }
    // Polygon d is "x,y x,y ..." points (schema); SVG path data needs
    // M/L/Z, so convert at compile time. Path kind keeps its raw d.
    const d = p.kind === "polygon" ? polygonToPath(p.d || "") : p.d || "";
    // Gradient defs / filter refs are added only when present; with none
    // of them this string is byte-identical to the pre-change output.
    const defs = shapeSvgDefs(node, palette);
    const fillAttr = p.fill && typeof p.fill === "object" && (p.fill.type === "linear" || p.fill.type === "radial") ? ` fill="url(#grad-${esc(node.id)})"` : "";
    const filterAttr = p.glow || p.soft ? ` filter="url(#fx-${esc(node.id)})"` : "";
    return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z}"><svg width="${b.w}" height="${b.h}" viewBox="0 0 ${b.w} ${b.h}" style="overflow:visible">${defs}<path d="${esc(pointsD ?? d)}" stroke-linejoin="round" stroke-linecap="round"${fillAttr}${filterAttr} /></svg></div>`;
  }
  if (node.type === "image") {
    const a = resolveAsset(sceneDir, node.props.src);
    const src = a.external ? a.url : a.path && existsSync(a.path) ? dataUri(a.path) : node.props.src;
    const filter = imageFilterCss(node.props);
    const filterAttr = filter ? `;filter:${filter}` : "";
    return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z}"><img src="${esc(src)}" style="width:100%;height:100%;object-fit:${node.props.fit || "cover"};display:block${filterAttr}" /></div>`;
  }
  // map and chart nodes: their module runtimes fill this div per frame.
  if (node.type === "map") {
    return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z}"><svg width="${b.w}" height="${b.h}" viewBox="0 0 ${b.w} ${b.h}"></svg><div class="map-labels" style="position:absolute;inset:0;overflow:visible"></div></div>`;
  }
  if (node.type === "chart") {
    return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z};color:#14213d"></div>`;
  }
  // Particle nodes: their module runtime fills this SVG per frame. The
  // SVG covers the whole 1920x1080 stage (the stage is that size in the
  // compiled page) and is shifted back by the node box, so particle x/y,
  // which are scene px, land in the right place whatever the box is.
  if (node.type === "particle") {
    return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z}"><svg width="1920" height="1080" viewBox="0 0 1920 1080" style="position:absolute;left:${-b.x}px;top:${-b.y}px;overflow:visible"></svg></div>`;
  }
  return `<div ${base}></div>`;
}

/**
 * @param {object} scene validated scene
 * @param {string} sceneDir directory the scene file lives in, for asset paths
 * @returns {{html:string, errors:{code:string,path:string,message:string}[]}}
 */
export function compileScene(scene, sceneDir) {
  const errors = [];
  for (const font of scene.fonts) {
    const a = resolveAsset(sceneDir, font.src);
    if (!a.external && !existsSync(a.path)) {
      errors.push({ code: "FONT_MISSING", path: `/fonts/${font.family}`, message: `font file not found: ${font.src}` });
    }
  }
  for (const node of scene.nodes) {
    if (node.type !== "image") continue;
    const a = resolveAsset(sceneDir, node.props.src);
    if (!a.external && !existsSync(a.path)) {
      errors.push({ code: "ASSET_MISSING", path: `/nodes/${node.id}/props/src`, message: `image file not found: ${node.props.src}` });
    }
  }
  // Text and chart nodes: bundle the pure modules plus the in-page
  // runtimes. The runtimes run after the renderer runtime, so they can
  // register waiters on window.__hme.
  let textChartBundle = "";
  let textRuntime = "";
  let chartRuntime = "";
  const hasKinetic = scene.nodes.some((n) => n.type === "text" && n.props.kinetic);
  const hasChart = scene.nodes.some((n) => n.type === "chart");
  if (hasKinetic || hasChart) {
    const strip = (file) => readFileSync(resolve(ROOT, file), "utf8").split("\n").filter((l) => !l.startsWith("import ")).join("\n");
    const parts = [];
    if (hasKinetic) parts.push(strip("src/text/kinetic.mjs"));
    if (hasChart) parts.push(strip("src/chart/countup.mjs"), strip("src/chart/barrace.mjs"), strip("src/chart/bar.mjs"));
    textChartBundle = parts.join("\n");
    if (hasKinetic) textRuntime = strip("src/text/runtime.mjs");
    if (hasChart) chartRuntime = strip("src/chart/runtime.mjs");
  }
  // Particle nodes: bundle the pure evaluator (random + particles, imports
  // stripped; fmt comes from the evaluator bundle above) plus the in-page
  // runtime, only when a particle node is present, the same conditional
  // pattern as map and chart. Scenes without particles compile exactly as
  // before: no particle code is inlined and the HTML is unchanged.
  let particleBundle = "";
  let particleRuntime = "";
  const hasParticle = scene.nodes.some((n) => n.type === "particle");
  if (hasParticle) {
    const strip = (file) => readFileSync(resolve(ROOT, file), "utf8").split("\n").filter((l) => !l.startsWith("import ")).join("\n");
    particleBundle = strip("src/scene/random.mjs") + "\n" + strip("src/scene/particles.mjs");
    particleRuntime = strip("src/particle/runtime.mjs");
  }
  if (errors.length) return { html: "", errors };

  const fontCss = scene.fonts
    .map((font) => {
      const a = resolveAsset(sceneDir, font.src);
      const url = a.external ? a.url : dataUri(a.path);
      return `@font-face{font-family:'${font.family}';font-weight:${font.weight};src:url(${url}) format('truetype');}`;
    })
    .join("\n");
  // Map nodes: embed the included Natural Earth geometry (countries by
  // default, or the file named in props.geometry.countries, e.g. the US
  // states file), tokens, and the map bundle so the in-page runtime can
  // draw the map per frame. Missing file is NE_MISSING.
  let mapData = null;
  let mapBundle = "";
  const mapNodes = scene.nodes.filter((n) => n.type === "map");
  if (mapNodes.length) {
    const geoRel = (mapNodes[0].props.geometry && mapNodes[0].props.geometry.countries) || "assets/natural-earth/ne_10m_admin_0_countries.geojson";
    const geoKey = (mapNodes[0].props.geometry && mapNodes[0].props.geometry.key) || "ISO_A3";
    const geoPath = resolve(ROOT, geoRel);
    if (!existsSync(geoPath)) {
      errors.push({ code: "NE_MISSING", path: "/nodes/map/props/geometry", message: `Natural Earth file not found: ${geoRel}` });
    } else {
      const geo = JSON.parse(readFileSync(geoPath, "utf8"));
      const include = [...new Set(mapNodes.flatMap((n) => n.props.geometry.include || []))];
      const features = geo.features.filter((f) => include.includes(f.properties[geoKey]));
      const missing = include.filter((iso) => !features.some((f) => f.properties[geoKey] === iso));
      if (missing.length) errors.push({ code: "NE_MISSING", path: "/nodes/map/props/geometry", message: `countries not in file: ${missing.join(",")}` });
      const tokens = JSON.parse(readFileSync(resolve(ROOT, "src", "map", "tokens.json"), "utf8"));
      mapData = { geo: { type: "FeatureCollection", features }, props: mapNodes[0].props, tokens, fps: scene.meta.fps, events: scene.events };
      // Layer cache reference: the widest camera (min zoom) across all
      // frames. Country paths are drawn once at this camera and mapped per
      // frame with cameraMatrix (exact: the projection is affine). The
      // cache is off when HME_MAP_CACHE=0 or when any frame's matrix is
      // singular (e.g. pitch 90 collapses a dimension).
      let refCam = null;
      let mapCache = false;
      if (process.env.HME_MAP_CACHE !== "0") {
        const cams = [];
        for (let f = 0; f < scene.meta.duration; f++) {
          cams.push(computeMapState(mapNodes[0].props, f, scene.meta.fps, tokens, features, scene.events).camera);
        }
        refCam = cams.reduce((best, c) => (c.zoom < best.zoom ? c : best), cams[0]);
        mapCache = cams.every((c) => cameraMatrix(refCam, c) !== null);
        if (!mapCache) refCam = null;
      }
      mapData.refCam = refCam;
      mapData.mapCache = mapCache;
      const strip = (file) => readFileSync(resolve(ROOT, file), "utf8").split("\n").filter((l) => !l.startsWith("import ")).join("\n");
      mapBundle = strip("src/shared/color.mjs") + "\n" + strip("src/map/project.mjs") + "\n" + strip("src/map/compile.mjs");
    }
  }
  if (errors.length) return { html: "", errors };

  const ground = scene.palette.ground;
  const bg = typeof ground === "string" ? ground : ground && ground.color ? ground.color : "#000000";
  const gsap = readFileSync(resolve(ROOT, "node_modules/gsap/dist/gsap.min.js"), "utf8");
  const runtime = readFileSync(resolve(HERE, "runtime.mjs"), "utf8");
  const testHang = process.env.HME_TEST_HANG_WAITER === "1" ? "window.__hmeTestHangWaiter=true;" : "";
  const mapRuntime = mapData ? readFileSync(resolve(HERE, "..", "map", "runtime.mjs"), "utf8") : "";
  const mapScript = mapData ? `<script>window.__hmeMapData=${JSON.stringify(mapData)};</script>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:1920px;height:1080px;overflow:hidden;background:${bg}}#stage{position:relative;width:1920px;height:1080px;overflow:hidden;background:${bg}}${fontCss}</style></head><body><div id="stage">${scene.nodes.map((n) => nodeHtml(n, sceneDir, scene.palette)).join("")}</div><script>${gsap}</script><script>window.__hmeScene=${JSON.stringify(scene)};${testHang}</script>${mapScript}<script type="module">${evaluatorBundle()}\n${mapBundle}\n${textChartBundle}\n${particleBundle ? particleBundle + "\n" : ""}${runtime}\n${mapRuntime}\n${textRuntime}\n${chartRuntime}${particleRuntime ? "\n" + particleRuntime : ""}</script></body></html>`;
  return { html, errors, mapCache: mapData ? mapData.mapCache : false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  const out = process.argv[3];
  if (!file || !out) {
    console.error("usage: node src/renderer/compile.mjs <scene.json> <page.html>");
    process.exitCode = 2;
  } else {
    const scene = loadScene(file);
    const { errors } = validateScene(scene);
    if (errors.length) {
      for (const e of errors) console.log(`${e.code} ${e.path} ${e.message}`);
      process.exitCode = 1;
    } else {
      const { html, errors: cErr } = compileScene(scene, dirname(resolve(file)));
      if (cErr.length) {
        for (const e of cErr) console.log(`${e.code} ${e.path} ${e.message}`);
        process.exitCode = 2;
      } else {
        const { writeFileRetry, mkdirRetry } = await import("./retry.mjs");
        mkdirRetry(dirname(resolve(out)), { recursive: true });
        writeFileRetry(resolve(out), html);
        console.log(`OK ${scene.meta.id} ${html.length} bytes`);
      }
    }
  }
}
