// G8 contrast gate. Pure: takes sampled frame states and tokens, returns
// { pass, failures: [{ code, frame, detail }] }. The gate never changes;
// a failing token is adjusted in tokens.json, not here.
import { contrastRatio, luminance } from "../shared/color.mjs";

const PILL = "#14213D";
const TEXT = "#FFFFFF";
const BARE_TEXT = "#14213D";
const CASING = "#14213D";

export function checkG8(states, tokens) {
  const failures = [];
  for (const state of states) {
    const f = state.frame;
    for (const label of state.labels) {
      if (!label.visible) continue;
      if (label.ground === null || label.ground === "none") {
        failures.push({ code: "NAKED_LABEL", frame: f, detail: `label ${label.id} has no ground` });
        continue;
      }
      // bare labels render navy text on their declared ground, at the same 7:1 bar.
      const text = label.mode === "bare" ? BARE_TEXT : TEXT;
      const ratio = contrastRatio(text, label.ground);
      if (ratio < 7) failures.push({ code: "G8_TEXT", frame: f, detail: `label ${label.id} text on ${label.ground} ${ratio.toFixed(2)}:1, needs 7:1` });
    }
    for (const route of state.routes) {
      if (!route.active && route.progress === 0) continue;
      const line = route.lineColor || tokens.light.signalRed;
      const lands = state.countries.map((c) => c.displayFill);
      for (const land of lands) {
        const raw = contrastRatio(line, land);
        if (raw < 3) {
          const cased = contrastRatio(line, CASING);
          if (cased < 3) failures.push({ code: "G8_LINE_NO_CASING", frame: f, detail: `route ${route.id} ${line} on ${land} ${raw.toFixed(2)}:1, on casing ${cased.toFixed(2)}:1, needs 3:1` });
        }
      }
    }
    const baseFill = state.baseFill || tokens.light.tanLand;
    const floods = [...new Set(state.countries.filter((c) => c.fill !== baseFill).map((c) => c.fill))];
    for (let i = 0; i < floods.length; i++) {
      for (let j = i + 1; j < floods.length; j++) {
        const d = Math.abs(luminance(floods[i]) - luminance(floods[j]));
        if (d < 0.08) failures.push({ code: "G8_FLOOD", frame: f, detail: `floods ${floods[i]} and ${floods[j]} differ by ${d.toFixed(3)} luminance, needs 0.08` });
      }
    }
  }
  return { pass: failures.length === 0, failures };
}
