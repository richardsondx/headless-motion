// In-page particle runtime. Inlined by the renderer compile step after
// the bundled particle code (random + particles, imports stripped) and
// after the renderer runtime, in one <script type="module">, and only when
// a particle node is present. No imports, no network, no timers.
// Draws one particle node's SVG per frame and registers a waiter so the
// renderer's seek loop waits for the draw. Positions come from
// evaluateParticles (src/scene/particles.mjs), a pure function of
// (seed, node id, sampled props, frame), so the drawn frame always matches
// the evaluator for the same frame. Sampled props come from the seek state
// (sampleScene), which flattens area to dotted keys, so the area object is
// rebuilt here, the same way the U3 test does. Circle particles are not
// clamped back into the area: their drift out of it is the cloud motion
// the proof measures. The stage clips at the scene edge.
// Colours come from the scene palette by shape (foam for bubbles, spark
// for stars, cloud for circles, each falling back to white); the particle
// schema has no colour prop. The star is a computed 4-point polygon
// (existing SVG polygon kind, D4), oriented by the evaluator's rotation.
(function () {
  const pscene = window.__hmeScene;
  if (!pscene) return;
  const pnodes = pscene.nodes.filter((n) => n.type === "particle");
  if (!pnodes.length) return;
  const NS = "http://www.w3.org/2000/svg";
  const palette = pscene.palette || {};
  const fps = pscene.meta.fps ?? 24;
  const seed = pscene.meta.seed;

  function paletteColor(key, fallback) {
    const e = palette[key];
    if (typeof e === "string") return e;
    if (e && typeof e.color === "string") return e.color;
    return fallback;
  }

  function colorFor(shape) {
    if (shape === "star") return paletteColor("spark", "#ffffff");
    if (shape === "circle") return paletteColor("cloud", paletteColor("foam", "#ffffff"));
    return paletteColor("foam", "#ffffff");
  }

  // 4-point star polygon points, in scene px. Outer radius is size / 2,
  // inner radius 0.4 of that; vertices alternate outer/inner every 45
  // degrees, starting at the top, turned by the evaluator's rotation.
  function starPoints(p) {
    const r = p.size / 2;
    const inner = r * 0.4;
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const rad = ((p.rotation - 90 + i * 45) * Math.PI) / 180;
      const d = i % 2 === 0 ? r : inner;
      pts.push((p.x + d * Math.cos(rad)).toFixed(3) + "," + (p.y + d * Math.sin(rad)).toFixed(3));
    }
    return pts.join(" ");
  }

  function drawNode(node, frame, state) {
    const el = document.querySelector('[data-node="' + node.id + '"]');
    if (!el) return;
    const svg = el.querySelector("svg");
    if (!svg) return;
    const s = (state && state[node.id]) || null;
    const props = s
      ? {
          count: s["props.count"],
          size: s["props.size"],
          speed: s["props.speed"],
          direction: s["props.direction"],
          lifetime: s["props.lifetime"],
          shape: s["props.shape"],
          area: {
            x: s["props.area.x"],
            y: s["props.area.y"],
            w: s["props.area.w"],
            h: s["props.area.h"],
          },
        }
      : node.props;
    const parts = evaluateParticles(seed, node.id, props, frame, fps);
    svg.innerHTML = "";
    for (const p of parts) {
      if (p.shape === "star") {
        const poly = document.createElementNS(NS, "polygon");
        poly.setAttribute("points", starPoints(p));
        poly.setAttribute("fill", colorFor(p.shape));
        poly.setAttribute("opacity", String(p.opacity));
        svg.appendChild(poly);
      } else {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", String(p.x));
        c.setAttribute("cy", String(p.y));
        c.setAttribute("r", String(p.size / 2));
        c.setAttribute("fill", colorFor(p.shape));
        c.setAttribute("opacity", String(p.opacity));
        svg.appendChild(c);
      }
    }
  }

  window.__hme.waiters.push(async (frame, state) => {
    for (const node of pnodes) drawNode(node, frame, state);
  });
})();
