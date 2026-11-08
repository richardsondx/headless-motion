// In-page kinetic text runtime: splits text nodes with props.kinetic
// into per-unit spans once, then sets each span's transform and opacity
// from kineticState on every seek. Layout is measured once after fonts
// load; animation never changes layout, only transform and opacity.
import { kineticState, splitText } from "./kinetic.mjs";

const scene = window.__hmeScene;
if (scene) {
  const kineticNodes = scene.nodes.filter((n) => n.type === "text" && n.props.kinetic);
  const spans = new Map();
  for (const node of kineticNodes) {
    const el = document.querySelector('[data-node="' + node.id + '"]');
    if (!el) continue;
    const units = splitText(node.props.text, node.props.kinetic.split || "char");
    el.textContent = "";
    const list = [];
    for (const unit of units) {
      if (unit === " " || unit === "\n") {
        el.appendChild(document.createTextNode(unit));
        list.push(null);
        continue;
      }
      const s = document.createElement("span");
      s.textContent = unit;
      s.style.display = "inline-block";
      s.style.willChange = "transform,opacity";
      el.appendChild(s);
      list.push(s);
    }
    spans.set(node.id, list);
  }
  window.__hme.waiters.push(async (frame) => {
    for (const node of kineticNodes) {
      const list = spans.get(node.id);
      if (!list) continue;
      const states = kineticState(node.props.kinetic, node.props.text, frame);
      let si = 0;
      for (let i = 0; i < states.length; i++) {
        const el = list[i];
        if (!el) continue;
        const st = states[i];
        el.style.transform = "translateY(" + st.y.toFixed(2) + "px) scale(" + st.scale.toFixed(3) + ")";
        el.style.opacity = st.opacity.toFixed(3);
        si++;
      }
    }
  });
}
