// In-page runtime. This file is NOT imported by Node. compile.mjs reads this
// file as text and inlines it into page.html after the evaluator bundle and
// the inlined GSAP script, in one <script type="module">. It must not use
// imports, Date, Math.random, timers, CSS animation, or network.
// It exposes window.__hme = { ready, frameCount, seek(f), waiters, state }.
// Differences from the HyperFrames composition contract (see compile.mjs):
// HyperFrames uses data-* attributes and window.__timelines with its CLI
// render. Here the evaluator drives every frame through apply(), and the
// seek loop is owned by render.mjs, so the adapter can prove determinism.
window.__hme = (() => {
  const fps = window.__hmeScene.meta.fps;
  const duration = window.__hmeScene.meta.duration;
  const scene = window.__hmeScene;
  const palette = scene.palette;
  const tl = gsap.timeline({ paused: true, defaults: { ease: "none" } });
  tl.to({}, { duration: duration / fps });
  gsap.ticker.lagSmoothing(0);
  window.__timelines = window.__timelines || {};
  window.__timelines.main = tl;

  const stage = document.getElementById("stage");
  const els = {};
  for (const el of stage.querySelectorAll("[data-node]")) els[el.dataset.node] = el;

  function resolveColor(v) {
    if (typeof v !== "string") return v;
    if (v.startsWith("#")) return v;
    const e = palette[v];
    return e ? (typeof e === "string" ? e : e.color) : v;
  }

  function hexToRgba(hex, alpha) {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex || "");
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    return "rgba(" + ((v >> 16) & 255) + ", " + ((v >> 8) & 255) + ", " + (v & 255) + ", " + alpha + ")";
  }

  // CSS filter for a shape node's glow and/or soft, from sampled state.
  // "" when the node has neither, so flat nodes keep today's output.
  // Mirrors shapeFilterCss in compile.mjs (glow drop-shadow first, then
  // soft blur), so the per-frame value equals the compiled static value
  // when nothing is animated. Gradient stops are static in v1 and are
  // never touched here; only glow radius/intensity and soft radius move.
  function shapeFilterCss(s, node) {
    const p = node.props;
    const parts = [];
    if (p.glow) {
      const radius = s["props.glow.radius"] ?? p.glow.radius;
      const intensity = s["props.glow.intensity"] ?? p.glow.intensity;
      const color = resolveColor(s["props.glow.color"] !== undefined ? s["props.glow.color"] : p.glow.color);
      parts.push("drop-shadow(0 0 " + radius + "px " + hexToRgba(color, intensity) + ")");
    }
    if (p.soft) {
      const radius = s["props.soft.radius"] ?? p.soft.radius;
      parts.push("blur(" + radius + "px)");
    }
    return parts.join(" ");
  }

  // CSS filter for an image node's filter, from sampled state.
  // "" when the node has no filter and no track sets one, so
  // unfiltered images keep today's output. Mirrors imageFilterCss
  // in compile.mjs (grayscale first, then blur), so the per-frame
  // value equals the compiled static value when nothing moves.
  // The <img> is created once at compile time and only its src
  // attribute is swapped per frame, so setting style.filter here
  // survives every seek.
  function imageFilterCss(s, node) {
    const p = node.props;
    const gray = s["props.filter.grayscale"] ?? (p.filter && p.filter.grayscale);
    const blur = s["props.filter.blur"] ?? (p.filter && p.filter.blur);
    const parts = [];
    if (gray !== undefined) parts.push("grayscale(" + gray + ")");
    if (blur !== undefined) parts.push("blur(" + blur + "px)");
    return parts.join(" ");
  }

  // Per-frame glow/soft for an SVG shape node: update the compiled
  // filter's primitives (feGaussianBlur stdDeviation = soft radius,
  // feDropShadow stdDeviation = glow radius, flood-opacity = intensity).
  // No-op when the node has neither glow nor soft (no filter exists).
  function applySvgFilter(s, node, svg) {
    const p = node.props;
    if (!p.glow && !p.soft) return;
    const filterEl = svg.querySelector("filter");
    if (!filterEl) return;
    if (p.soft) {
      const blur = filterEl.querySelector("feGaussianBlur");
      if (blur) blur.setAttribute("stdDeviation", String(s["props.soft.radius"] ?? p.soft.radius));
    }
    if (p.glow) {
      const drop = filterEl.querySelector("feDropShadow");
      if (drop) {
        drop.setAttribute("stdDeviation", String(s["props.glow.radius"] ?? p.glow.radius));
        drop.setAttribute("flood-opacity", String(s["props.glow.intensity"] ?? p.glow.intensity));
        if (s["props.glow.color"] !== undefined) drop.setAttribute("flood-color", resolveColor(s["props.glow.color"]));
      }
    }
  }

  // Same points-to-d compiler as compile.mjs, for the per-frame d
  // update below. Numbers go through fmtNum (4 decimals), so frame 0
  // matches the compiled static d exactly when the scale is 1.
  function fmtNum(n) {
    return String(Number(Number(n).toFixed(4)));
  }

  function pointsToD(points, closed) {
    if (!Array.isArray(points) || points.length === 0) return "";
    const pt = (p) => fmtNum(p[0]) + " " + fmtNum(p[1]);
    const parts = ["M " + pt(points[0].anchor)];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const anchor = pt(cur.anchor);
      if (cur.command === "cubic") {
        parts.push("C " + pt(prev.out || prev.anchor) + " " + pt(cur.in || cur.anchor) + " " + anchor);
      } else if (cur.command === "smooth") {
        parts.push("S " + pt(cur.in || cur.anchor) + " " + anchor);
      } else {
        parts.push("L " + anchor);
      }
    }
    if (closed) parts.push("Z");
    return parts.join(" ");
  }

  function apply(state) {
    // Scene camera: scale the whole stage about the camera center.
    // screen = zoom * (p - center) + center, written as translate +
    // scale + translate, mirroring the map camera's affine transform
    // on its layer group. Untouched when the scene has no camera, so
    // no-camera renders are unchanged. Text and stroke widths scale
    // with the stage; that is the intended camera behaviour.
    const cam = state.camera;
    if (cam) {
      const z = cam.zoom ?? 1;
      const cx = cam.center ? cam.center[0] : scene.meta.width / 2;
      const cy = cam.center ? cam.center[1] : scene.meta.height / 2;
      if (z !== 1 || cx !== scene.meta.width / 2 || cy !== scene.meta.height / 2) {
        // Origin 0 0: the default 50% 50% origin would shift the
        // explicit translates, so the fixed point would move.
        stage.style.transformOrigin = "0px 0px";
        stage.style.transform =
          "translate(" + fmtNum(cx) + "px, " + fmtNum(cy) + "px) scale(" + fmtNum(z) + ") translate(" + fmtNum(-cx) + "px, " + fmtNum(-cy) + "px)";
      } else {
        stage.style.transformOrigin = "";
        stage.style.transform = "";
      }
    }
    for (const node of scene.nodes) {
      const el = els[node.id];
      if (!el) continue;
      const s = state[node.id];
      if (!s) continue;
      const vis = s.visible;
      el.style.display = vis ? "" : "none";
      if (!vis) continue;
      const x = (node.box.x || 0) + (s["transform.x"] || 0);
      const y = (node.box.y || 0) + (s["transform.y"] || 0);
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.opacity = String(s["transform.opacity"] ?? 1);
      // Non-uniform scale: scaleX and scaleY are effective values
      // from the evaluator (they fall back to the uniform scale).
      // A path node with points carries its scale in the points
      // themselves (see the shape branch below), so it never gets a
      // CSS scale as well: that would scale twice. Any other node
      // scales in CSS, about the anchor when one is set, else the
      // centre, which is the CSS default origin. When the scale is
      // uniform and no anchor is set, this string is byte-identical
      // to the old one.
      const sx = s["transform.scaleX"] ?? s["transform.scale"] ?? 1;
      const sy = s["transform.scaleY"] ?? s["transform.scale"] ?? 1;
      const rot = s["transform.rotation"] ?? 0;
      const hasPoints =
        node.type === "shape" &&
        node.props.kind !== "rect" &&
        node.props.kind !== "ellipse" &&
        Array.isArray(s["props.points"]) &&
        s["props.points"].length > 0 &&
        Array.isArray(s["props.points"][0].anchor);
      const pointsScaled = hasPoints && (sx !== 1 || sy !== 1);
      if (pointsScaled) {
        el.style.transform = "rotate(" + rot + "deg)";
      } else if (sx !== sy || s["transform.anchorX"] !== undefined || s["transform.anchorY"] !== undefined) {
        const ax = s["transform.anchorX"] ?? (node.box.w || 0) / 2;
        const ay = s["transform.anchorY"] ?? (node.box.h || 0) / 2;
        el.style.transformOrigin = ax + "px " + ay + "px";
        el.style.transform = "scale(" + sx + ", " + sy + ") rotate(" + rot + "deg)";
      } else {
        el.style.transform = "scale(" + (s["transform.scale"] ?? 1) + ") rotate(" + rot + "deg)";
      }
      if (node.type === "text") {
        if (s["props.color"] !== undefined) el.style.color = resolveColor(s["props.color"]);
        if (s["props.text"] !== undefined && !node.props.kinetic) el.textContent = s["props.text"];
      } else if (node.type === "shape") {
        const kind = node.props.kind;
        if (kind === "rect" || kind === "ellipse") {
          // Per-frame box size: the sampled box.w and box.h land on
          // the div, so a box.w track grows the rect on screen. The
          // sampled value falls back to the static box, so a rect
          // with no box track keeps exactly its compiled size.
          // Points shapes never reach this branch: their size lives
          // in the SVG path and viewBox, not the div.
          el.style.width = (s["box.w"] ?? node.box.w ?? 0) + "px";
          el.style.height = (s["box.h"] ?? node.box.h ?? 0) + "px";
          // A gradient fill is a background image in the compiled HTML.
          // The sampled fill is an object for gradient nodes, so
          // s["props.fill"] is undefined there; the node-fill guard below
          // is a second lock: never paint a flat backgroundColor over a
          // compiled gradient. Flat nodes behave exactly as before.
          if (s["props.fill"] !== undefined && typeof node.props.fill !== "object") el.style.backgroundColor = resolveColor(s["props.fill"]);
          const filter = shapeFilterCss(s, node);
          if (filter) el.style.filter = filter;
          if (s["props.stroke.color"] !== undefined) {
            el.style.borderColor = resolveColor(s["props.stroke.color"]);
            el.style.borderWidth = (s["props.stroke.width"] ?? 0) + "px";
            el.style.borderStyle = "solid";
          }
        } else {
          const svg = el.querySelector("svg");
          if (svg) {
            const path = svg.querySelector("path,line,polyline,polygon");
            if (path) {
              // Per-frame d: the sampled points list (morphed by the
              // evaluator, deformed, then scaled about the anchor
              // here) compiles to d on every frame. This is what
              // makes a morph visible: frame 0 alone is static.
              if (hasPoints) {
                let pts = s["props.points"];
                if (sx !== 1 || sy !== 1) {
                  const ax = s["transform.anchorX"] ?? (node.box.w || 0) / 2;
                  const ay = s["transform.anchorY"] ?? (node.box.h || 0) / 2;
                  pts = scalePoints(pts, sx, sy, ax, ay);
                }
                path.setAttribute("d", pointsToD(pts, s["props.closed"] ?? node.props.closed));
              }
              // Same gradient guard as divs: a gradient fill is
              // fill="url(#grad-...)" in the compiled HTML and the sampled
              // fill is an object, so a flat fill is never painted over it.
              if (s["props.fill"] !== undefined && typeof node.props.fill !== "object") path.setAttribute("fill", resolveColor(s["props.fill"]));
              if (s["props.stroke.color"] !== undefined) {
                path.setAttribute("stroke", resolveColor(s["props.stroke.color"]));
                path.setAttribute("stroke-width", String(s["props.stroke.width"] ?? 1));
              }
            }
            applySvgFilter(s, node, svg);
          }
        }
      } else if (node.type === "image") {
        const img = el.querySelector("img");
        if (img) {
          if (s["props.src"] !== undefined && !String(img.getAttribute("src") || "").startsWith("data:")) img.setAttribute("src", s["props.src"]);
          // A track can add a filter to a node that has none in its
          // props, so the sampled keys count too, not just p.filter.
          if (node.props.filter || s["props.filter.grayscale"] !== undefined || s["props.filter.blur"] !== undefined) {
            img.style.filter = imageFilterCss(s, node);
          }
        }
      }
      // map and chart nodes are owned by their module runtimes, which read
      // the same sampled state and register waiters below.
    }
  }

  const waiters = [];
  if (window.__hmeTestHangWaiter) waiters.push(() => new Promise(() => {}));
  let lastState = null;

  async function seek(f) {
    tl.pause();
    tl.time(f / fps, false);
    if (Math.abs(tl.time() * fps - f) >= 1e-6) {
      const err = new Error("SEEK_MISMATCH frame " + f);
      err.code = "SEEK_MISMATCH";
      throw err;
    }
    const state = sampleScene(scene, f);
    lastState = state;
    apply(state);
    for (const w of waiters) {
      // No timers in page code (prompt 02): the timeout is counted in
      // requestAnimationFrame ticks, about 5 s at 60 fps.
      let ticks = 0;
      const timeout = (async () => {
        while (ticks < 300) {
          await new Promise((r) => requestAnimationFrame(r));
          ticks++;
        }
        const e = new Error("MODULE_WAIT_TIMEOUT frame " + f);
        e.code = "MODULE_WAIT_TIMEOUT";
        throw e;
      })();
      await Promise.race([w(f, state), timeout]);
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return state;
  }

  const ready = (async () => {
    await document.fonts.ready;
    for (const font of scene.fonts) {
      // document.fonts.check only reports fonts already loaded. A font
      // nothing has used yet (map labels are built by the map runtime,
      // after ready) would report false, so load each declared font first.
      try {
        await document.fonts.load(font.weight + " 16px '" + font.family + "'");
      } catch (e) {
        const err = new Error("FONT_MISSING " + font.family + " " + font.weight);
        err.code = "FONT_MISSING";
        throw err;
      }
      const ok = document.fonts.check(font.weight + " 16px '" + font.family + "'");
      if (!ok) {
        const err = new Error("FONT_MISSING " + font.family + " " + font.weight);
        err.code = "FONT_MISSING";
        throw err;
      }
    }
  })();

  return {
    ready,
    frameCount: duration,
    seek,
    waiters,
    get state() {
      return lastState;
    },
  };
})();
