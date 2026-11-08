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

  function apply(state) {
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
      el.style.transform =
        "scale(" + (s["transform.scale"] ?? 1) + ") rotate(" + (s["transform.rotation"] ?? 0) + "deg)";
      if (node.type === "text") {
        if (s["props.color"] !== undefined) el.style.color = resolveColor(s["props.color"]);
        if (s["props.text"] !== undefined && !node.props.kinetic) el.textContent = s["props.text"];
      } else if (node.type === "shape") {
        const kind = node.props.kind;
        if (kind === "rect" || kind === "ellipse") {
          if (s["props.fill"] !== undefined) el.style.backgroundColor = resolveColor(s["props.fill"]);
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
              if (s["props.fill"] !== undefined) path.setAttribute("fill", resolveColor(s["props.fill"]));
              if (s["props.stroke.color"] !== undefined) {
                path.setAttribute("stroke", resolveColor(s["props.stroke.color"]));
                path.setAttribute("stroke-width", String(s["props.stroke.width"] ?? 1));
              }
            }
          }
        }
      } else if (node.type === "image") {
        const img = el.querySelector("img");
        if (img && s["props.src"] !== undefined) img.setAttribute("src", s["props.src"]);
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
