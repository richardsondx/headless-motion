// In-page map runtime. Inlined by the renderer compile step after the
// bundled map code (color + project + compile, imports stripped) and after
// the renderer runtime, in one <script type="module">. No imports, no
// network, no timers. Draws the map node's SVG and label pills per frame
// and registers a waiter so the renderer's seek loop waits for the draw.
// Deviation from prompt 03, stated here: MapLibre GL JS is not used. It
// needs WebGL, which this headless path disables, and a WebGL canvas
// breaks deterministic per-frame SHA hashing. Geometry is real Natural
// Earth GeoJSON, drawn as SVG through the one projection in project.mjs.
(function () {
  const data = window.__hmeMapData;
  if (!data) return;
  const tokens = data.tokens;
  const scale = 1.5; // tokenScale: 1280 grid to 1920
  const node = document.querySelector('[data-node="map"]');
  if (!node) return;
  const svg = node.querySelector("svg");
  const labelLayer = node.querySelector(".map-labels");
  const NS = "http://www.w3.org/2000/svg";
  const geo = data.geo.features;
  const geoKey = (data.props.geometry && data.props.geometry.key) || "ISO_A3";
  const byIso = new Map(geo.map((f) => [f.properties[geoKey], f]));

  // Build static SVG structure once.
  svg.innerHTML = "";
  const register = (data.props && data.props.register) || "dark";
  const fontFamily = (tokens.type && tokens.type.family) || "Montserrat";
  const water = document.createElementNS(NS, "rect");
  water.setAttribute("width", "1920");
  water.setAttribute("height", "1080");
  water.setAttribute("fill", register === "dark" ? (tokens.dark.waterBase || tokens.dark.waterMeasuredThumb || tokens.dark.water) : (tokens.light.water || "#c7d8e2"));
  svg.appendChild(water);
  // Dark register only, constant finish (Harris skill): film grain over the
  // whole comp plus a slight edge vignette, both static and deterministic.
  // They never change during events, so the dim reads as attention, not a filter change.
  // Grain is a seeded 256x256 noise tile generated ONCE per page load on a
  // canvas and tiled as an SVG pattern. Cycle-1 fix: the first version used
  // an feTurbulence filter on a full-frame rect, which Chrome re-rendered at
  // 3840x2160 every frame; the draft render died at frame 202 of 240 after
  // 600 s. A static tile costs nothing per frame.
  let grainEl = null;
  let vigEl = null;
  if (register === "dark") {
    const defs = document.createElementNS(NS, "defs");
    const grad = document.createElementNS(NS, "radialGradient");
    grad.setAttribute("id", "hme-vignette");
    grad.setAttribute("cx", "50%");
    grad.setAttribute("cy", "50%");
    grad.setAttribute("r", "75%");
    const stop0 = document.createElementNS(NS, "stop");
    stop0.setAttribute("offset", "60%");
    stop0.setAttribute("stop-color", "#000000");
    stop0.setAttribute("stop-opacity", "0");
    const stop1 = document.createElementNS(NS, "stop");
    stop1.setAttribute("offset", "100%");
    stop1.setAttribute("stop-color", "#000000");
    stop1.setAttribute("stop-opacity", "0.28");
    grad.appendChild(stop0);
    grad.appendChild(stop1);
    defs.appendChild(grad);
    const pat = document.createElementNS(NS, "pattern");
    pat.setAttribute("id", "hme-grain-pat");
    pat.setAttribute("width", "256");
    pat.setAttribute("height", "256");
    pat.setAttribute("patternUnits", "userSpaceOnUse");
    const tile = document.createElement("canvas");
    tile.width = 256;
    tile.height = 256;
    const tctx = tile.getContext("2d");
    const imgData = tctx.createImageData(256, 256);
    let seed = 4;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = Math.floor(rnd() * 255);
      imgData.data[i] = v; imgData.data[i + 1] = v; imgData.data[i + 2] = v; imgData.data[i + 3] = 255;
    }
    tctx.putImageData(imgData, 0, 0);
    const tileImg = document.createElementNS(NS, "image");
    tileImg.setAttribute("width", "256");
    tileImg.setAttribute("height", "256");
    tileImg.setAttribute("href", tile.toDataURL("image/png"));
    pat.appendChild(tileImg);
    defs.appendChild(pat);
    svg.appendChild(defs);
    const grain = document.createElementNS(NS, "rect");
    grain.setAttribute("width", "1920");
    grain.setAttribute("height", "1080");
    grain.setAttribute("fill", "url(#hme-grain-pat)");
    grain.setAttribute("opacity", String(tokens.dark.grainOpacity ?? 0.06));
    grain.setAttribute("pointer-events", "none");
    svg.appendChild(grain);
    grainEl = grain;
    const vig = document.createElementNS(NS, "rect");
    vig.setAttribute("width", "1920");
    vig.setAttribute("height", "1080");
    vig.setAttribute("fill", "url(#hme-vignette)");
    vig.setAttribute("pointer-events", "none");
    svg.appendChild(vig);
    vigEl = vig;
  }
  // Layer cache: country geometry is drawn once at the reference camera
  // (compile-time, widest view) inside one group. Per frame drawMap only
  // sets an affine transform on that group (cameraMatrix, exact: the
  // projection is affine) instead of re-projecting every vertex. The
  // group is never re-painted for a transform-only change; fills and
  // strokes update only when they change. vector-effect keeps stroke
  // widths in screen px under the transform. Off when
  // window.__hmeMapData.mapCache is false (HME_MAP_CACHE=0 or a singular
  // matrix), in which case drawMap re-projects every frame as before.
  const cacheOn = Boolean(data.mapCache && data.refCam);
  const refCam = data.refCam || null;
  const baseG = document.createElementNS(NS, "g");
  baseG.setAttribute("id", "hme-map-base");
  svg.appendChild(baseG);
  const paths = new Map();
  for (const feature of geo) {
    const iso = feature.properties[geoKey];
    const casing = document.createElementNS(NS, "path");
    const main = document.createElementNS(NS, "path");
    casing.setAttribute("vector-effect", "non-scaling-stroke");
    main.setAttribute("vector-effect", "non-scaling-stroke");
    casing.setAttribute("fill", "none");
    casing.setAttribute("stroke", register === "dark" ? "#182022" : "#14213d");
    baseG.appendChild(casing);
    baseG.appendChild(main);
    paths.set(iso, { feature, main, casing });
  }
  if (cacheOn) {
    for (const [iso, entry] of paths) {
      const d = geoPath(entry.feature.geometry.coordinates, refCam, 1920, 1080);
      entry.main.setAttribute("d", d);
      entry.casing.setAttribute("d", d);
    }
  }
  const prevPaint = new Map();
  const routeGroup = document.createElementNS(NS, "g");
  svg.appendChild(routeGroup);
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("r", String(8 * scale));
  dot.setAttribute("fill", tokens.light.signalRed);
  dot.setAttribute("stroke", "#ffffff");
  dot.setAttribute("stroke-width", "2");
  svg.appendChild(dot);
  const leaderGroup = document.createElementNS(NS, "g");
  svg.appendChild(leaderGroup);
  const labelEls = new Map();
  for (const label of data.props.labels || []) {
    const el = document.createElement("div");
    el.className = "map-label";
    el.textContent = label.text;
    el.style.cssText = "position:absolute;transform:translate(-50%,-50%);background:#14213d;color:#fff;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;padding:12px 6px;white-space:nowrap;";
    labelLayer.appendChild(el);
    labelEls.set(label.id, el);
  }
  const badgeEls = new Map();
  for (const badge of data.props.badges || []) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:absolute;transform:translate(-50%,-50%);text-align:center;";
    const hex = document.createElement("div");
    hex.style.cssText = "display:inline-block;background:#14213d;padding:10px 16px;clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);";
    const dotMark = document.createElement("div");
    dotMark.style.cssText = "width:14px;height:14px;border-radius:50%;background:#fff;margin:0 auto;";
    hex.appendChild(dotMark);
    const bar = document.createElement("div");
    bar.textContent = badge.label;
    bar.style.cssText = "background:#14213d;color:#fff;font-weight:700;font-family:'Montserrat',sans-serif;letter-spacing:0.06em;font-size:28px;padding:4px 8px;margin-top:6px;";
    wrap.appendChild(hex);
    if (badge.label) wrap.appendChild(bar); // empty label: marker only, the name rides on a label pill
    labelLayer.appendChild(wrap);
    badgeEls.set(badge.id, wrap);
  }

  function drawMap(f, sampleState) {
    const state = computeMapState(data.props, f, data.fps, tokens, geo, data.events);
    const cam = state.camera;
    // The map node's own transform must be identity for the cached base
    // group: its matrix is computed in stage coords. Any scene transform
    // (scale/rotation/offset) falls back to per-frame re-projection.
    const nodeState = sampleState && sampleState.map;
    const nodeMoved = Boolean(
      nodeState &&
      ((nodeState["transform.scale"] ?? 1) !== 1 ||
        (nodeState["transform.rotation"] ?? 0) !== 0 ||
        (nodeState["transform.x"] ?? 0) !== 0 ||
        (nodeState["transform.y"] ?? 0) !== 0),
    );
    let useCache = cacheOn && !nodeMoved;
    if (useCache) {
      const m = cameraMatrix(refCam, cam);
      if (m) baseG.setAttribute("transform", "matrix(" + m.map((v) => v.toFixed(4)).join(" ") + ")");
      else useCache = false; // singular frame: re-project this frame
    }
    for (const [iso, entry] of paths) {
      const c = state.countries.find((c2) => c2.iso === iso);
      if (!c) continue;
      const isSubject = state.focus && state.focus.subject === iso;
      if (!useCache) {
        const d = geoPath(entry.feature.geometry.coordinates, cam, 1920, 1080);
        entry.main.setAttribute("d", d);
        entry.casing.setAttribute("d", d);
      }
      // Fills and strokes update only when they change (focus/dim windows);
      // geometry never changes under the cache.
      const prev = prevPaint.get(iso) || {};
      const fill = c.displayFill;
      // subjectStroke false (focus event) means the reference has no outline:
      // the subject then paints exactly like any other country.
      // borderStroke false (map props) means the reference has no country
      // borders at all: every country paints as a flat fill with no line.
      const strokeOn = isSubject && state.focus.subjectStroke !== false;
      const borderOn = state.borderStroke !== false;
      const baseStroke = borderOn ? (register === "dark" ? tokens.dark.baseBorder || "#9AB8B2" : "#14213d") : "none";
      const stroke = strokeOn ? tokens.light.signalRed : baseStroke;
      const sw = strokeOn ? 7 : (borderOn ? 2 : 0);
      const csw = strokeOn ? 11 : 0;
      if (prev.fill !== fill) { entry.main.setAttribute("fill", fill); prev.fill = fill; }
      if (prev.stroke !== stroke) { entry.main.setAttribute("stroke", stroke); prev.stroke = stroke; }
      if (prev.sw !== sw) { entry.main.setAttribute("stroke-width", String(sw)); prev.sw = sw; }
      if (prev.csw !== csw) { entry.casing.setAttribute("stroke-width", String(csw)); prev.csw = csw; }
      prevPaint.set(iso, prev);
    }
    routeGroup.innerHTML = "";
    for (const route of state.routes) {
      if (route.progress <= 0) continue;
      const pts = route.drawn.map((pt) => projectPoint(pt[0], pt[1], cam));
      // Casing first: a 1.5 px-token dark underlay (3 px at 1080p) under the
      // whole route, so the red line clears G8 against every land it crosses.
      const casingPath = document.createElementNS(NS, "path");
      casingPath.setAttribute("d", "M" + pts.map((p) => p.map((v) => v.toFixed(1)).join(" ")).join(" L"));
      casingPath.setAttribute("stroke", "#14213d");
      casingPath.setAttribute("stroke-width", "8");
      casingPath.setAttribute("stroke-linecap", "round");
      casingPath.setAttribute("fill", "none");
      if (route.dashed) casingPath.setAttribute("stroke-dasharray", "10 8");
      routeGroup.appendChild(casingPath);
      const segs = pts.length - 1;
      for (let i = 0; i < segs; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", "M" + a.map((v) => v.toFixed(1)).join(" ") + " L" + b.map((v) => v.toFixed(1)).join(" "));
        p.setAttribute("stroke", route.lineColor || tokens.light.signalRed);
        p.setAttribute("stroke-width", String((5 - (3 * i) / segs).toFixed(1)));
        p.setAttribute("stroke-linecap", "round");
        p.setAttribute("fill", "none");
        if (route.dashed) p.setAttribute("stroke-dasharray", "10 8");
        routeGroup.appendChild(p);
      }
      const head = projectPoint(route.head[0], route.head[1], cam);
      dot.setAttribute("cx", String(head[0].toFixed(1)));
      dot.setAttribute("cy", String(head[1].toFixed(1)));
      dot.style.display = route.active ? "" : "none";
    }
    if (!state.routes.some((r) => r.progress > 0)) dot.style.display = "none";
    leaderGroup.innerHTML = "";
    for (const label of state.labels) {
      const el = labelEls.get(label.id);
      if (!el) continue;
      el.style.display = label.visible ? "" : "none";
      if (!label.visible) continue;
      const [x, y] = label.screen;
      const oy = (label.mode === "leader" || label.mode === "bare") ? (label.dy ?? -70) : 0; // dy is a scene value in px; default -70 keeps the pill just above its point.
      const ox = (label.mode === "leader" || label.mode === "bare") ? (label.dx ?? 0) : 0; // dx is a scene value in px; offsets the pill sideways, the leader then runs to the pill centre (hidden under the pill).
      if (label.mode === "leader") {
        const line = document.createElementNS(NS, "path");
        line.setAttribute("d", "M" + x.toFixed(1) + " " + y.toFixed(1) + " L" + (x + ox).toFixed(1) + " " + (y + oy + (ox ? 0 : 40)).toFixed(1)); // dashed leader ends at the pill bottom (pill is ~78 px tall, half ~40)
        line.setAttribute("stroke", "#14213d");
        line.setAttribute("stroke-width", "3");
        line.setAttribute("stroke-dasharray", "6 4");
        line.setAttribute("fill", "none");
        leaderGroup.appendChild(line);
        const pin = document.createElementNS(NS, "circle");
        pin.setAttribute("cx", x.toFixed(1));
        pin.setAttribute("cy", y.toFixed(1));
        pin.setAttribute("r", "9");
        pin.setAttribute("fill", "#14213d");
        pin.setAttribute("stroke", "#ffffff");
        pin.setAttribute("stroke-width", "3");
        leaderGroup.appendChild(pin);
      }
      el.style.left = x + ox + "px";
      el.style.top = y + oy + "px";
      el.style.fontSize = "48px";
      el.style.fontFamily = "'" + fontFamily + "', sans-serif";
      // bare mode: caps text only, navy on the declared ground, no pill.
      if (label.mode === "bare") { el.style.background = "transparent"; el.style.color = "#14213d"; }
    }
    for (const badge of state.badges) {
      const el = badgeEls.get(badge.id);
      if (!el) continue;
      el.style.display = badge.visible ? "" : "none";
      if (!badge.visible) continue;
      el.style.left = badge.screen[0] + "px";
      el.style.top = badge.screen[1] + "px";
    }
    // Grain and vignette stay on top of the countries and routes, and stay
    // constant: re-appending moves them to the end of the SVG each frame.
    if (grainEl) svg.appendChild(grainEl);
    if (vigEl) svg.appendChild(vigEl);
  }

  window.__hme.waiters.push(async (f, state) => {
    drawMap(f, state);
  });
  drawMap(0, null);
})();
