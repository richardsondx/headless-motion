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
    if (p.kind === "rect" || p.kind === "ellipse") {
      const radius = p.kind === "ellipse" ? "50%" : (p.radius ?? 0) + "px";
      return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z};border-radius:${radius}"></div>`;
    }
    const d = p.d || "";
    return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z}"><svg width="${b.w}" height="${b.h}" viewBox="0 0 ${b.w} ${b.h}" style="overflow:visible"><path d="${esc(d)}" stroke-linejoin="round" stroke-linecap="round" /></svg></div>`;
  }
  if (node.type === "image") {
    const a = resolveAsset(sceneDir, node.props.src);
    const src = a.external ? a.url : a.path && existsSync(a.path) ? dataUri(a.path) : node.props.src;
    return `<div ${base}><img src="${esc(src)}" style="width:100%;height:100%;object-fit:${node.props.fit || "cover"};display:block" /></div>`;
  }
  // map and chart nodes: their module runtimes fill this div per frame.
  if (node.type === "map") {
    return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z}"><svg width="${b.w}" height="${b.h}" viewBox="0 0 ${b.w} ${b.h}"></svg><div class="map-labels" style="position:absolute;inset:0;overflow:visible"></div></div>`;
  }
  if (node.type === "chart") {
    return `<div ${base} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${node.z};color:#14213d"></div>`;
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
  if (errors.length) return { html: "", errors };

  const fontCss = scene.fonts
    .map((font) => {
      const a = resolveAsset(sceneDir, font.src);
      const url = a.external ? a.url : dataUri(a.path);
      return `@font-face{font-family:'${font.family}';font-weight:${font.weight};src:url(${url}) format('truetype');}`;
    })
    .join("\n");
  // Map nodes: embed the included Natural Earth countries, tokens, and
  // the map bundle (color + project + compile, imports stripped) so the
  // in-page runtime can draw the map per frame. Missing file is NE_MISSING.
  let mapData = null;
  let mapBundle = "";
  const mapNodes = scene.nodes.filter((n) => n.type === "map");
  if (mapNodes.length) {
    const geoPath = resolve(ROOT, "assets", "natural-earth", "ne_10m_admin_0_countries.geojson");
    if (!existsSync(geoPath)) {
      errors.push({ code: "NE_MISSING", path: "/nodes/map/props/geometry", message: "Natural Earth file not found: assets/natural-earth/ne_10m_admin_0_countries.geojson" });
    } else {
      const geo = JSON.parse(readFileSync(geoPath, "utf8"));
      const include = [...new Set(mapNodes.flatMap((n) => n.props.geometry.include || []))];
      const features = geo.features.filter((f) => include.includes(f.properties.ISO_A3));
      const missing = include.filter((iso) => !features.some((f) => f.properties.ISO_A3 === iso));
      if (missing.length) errors.push({ code: "NE_MISSING", path: "/nodes/map/props/geometry", message: `countries not in file: ${missing.join(",")}` });
      const tokens = JSON.parse(readFileSync(resolve(ROOT, "src", "map", "tokens.json"), "utf8"));
      mapData = { geo: { type: "FeatureCollection", features }, props: mapNodes[0].props, tokens, fps: scene.meta.fps, events: scene.events };
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:1920px;height:1080px;overflow:hidden;background:${bg}}#stage{position:relative;width:1920px;height:1080px;overflow:hidden;background:${bg}}${fontCss}</style></head><body><div id="stage">${scene.nodes.map((n) => nodeHtml(n, sceneDir, scene.palette)).join("")}</div><script>${gsap}</script><script>window.__hmeScene=${JSON.stringify(scene)};${testHang}</script>${mapScript}<script type="module">${evaluatorBundle()}\n${mapBundle}\n${textChartBundle}\n${runtime}\n${mapRuntime}\n${textRuntime}\n${chartRuntime}</script></body></html>`;
  return { html, errors };
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
