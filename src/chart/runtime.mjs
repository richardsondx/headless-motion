// In-page chart runtime: builds chart node DOM once, then updates values
// from the pure chart modules on every seek. Bar slots come from
// barraceState, never from a per-frame sort.
import { countupText } from "./countup.mjs";
import { barraceState } from "./barrace.mjs";
import { barState } from "./bar.mjs";

const cscene = window.__hmeScene;
if (cscene) {
  const chartNodes = cscene.nodes.filter((n) => n.type === "chart");
  const built = new Map();
  for (const node of chartNodes) {
    const el = document.querySelector('[data-node="' + node.id + '"]');
    if (!el) continue;
    const p = node.props;
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.justifyContent = "center";
    if (p.kind === "countup") {
      const span = document.createElement("div");
      span.style.fontFamily = "'" + (cscene.fonts[0]?.family || "sans-serif") + "'";
      span.style.fontWeight = "700";
      span.style.fontSize = Math.round((node.box?.h || 80) * 0.6) + "px";
      span.style.lineHeight = "1";
      el.appendChild(span);
      built.set(node.id, { kind: "countup", span });
    } else if (p.kind === "bar" || p.kind === "barrace") {
      const rows = p.kind === "bar" ? Object.keys(p.values) : [...new Set(p.rows.flatMap((r) => Object.keys(r.values)))];
      const rowEls = rows.map((name) => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "12px";
        row.style.margin = "4px 0";
        const label = document.createElement("div");
        label.textContent = name;
        label.style.width = "120px";
        label.style.textAlign = "right";
        const bar = document.createElement("div");
        bar.style.height = "28px";
        bar.style.background = "#14213d";
        const val = document.createElement("div");
        val.style.minWidth = "80px";
        row.appendChild(label);
        row.appendChild(bar);
        row.appendChild(val);
        el.appendChild(row);
        return { name, row, bar, val };
      });
      built.set(node.id, { kind: p.kind, rowEls });
    }
  }
  window.__hme.waiters.push(async (frame) => {
    for (const node of chartNodes) {
      const b = built.get(node.id);
      if (!b) continue;
      const p = node.props;
      if (b.kind === "countup") {
        b.span.textContent = countupText(p, frame);
      } else if (b.kind === "bar") {
        const state = barState(p.values);
        for (const s of state) {
          const r = b.rowEls.find((x) => x.name === s.name);
          if (!r) continue;
          r.bar.style.width = (s.width * 400).toFixed(1) + "px";
          r.val.textContent = String(s.value);
        }
      } else if (b.kind === "barrace") {
        const state = barraceState(p, frame);
        const max = Math.max(1, ...state.map((s) => s.value));
        for (const s of state) {
          const r = b.rowEls.find((x) => x.name === s.name);
          if (!r) continue;
          r.bar.style.width = ((s.value / max) * 400).toFixed(1) + "px";
          r.val.textContent = s.label;
          r.row.style.order = String(Math.round(s.slot * 100));
        }
      }
    }
  });
}
