// Text lint: readability and motion rules that the schema cannot see.
// Runs on a scene object. Returns { errors: [{ code, path, message }] }.
// No rendering, no fonts on disk: geometry comes from the scene props.
// CLI: node src/text/lint-text.mjs <scene.json> exits 0 clean, 1 on errors.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contrastRatio } from "../shared/color.mjs";

const BACK_EASES = new Set(["easeOutBack", "easeInOutBack", "easeInBack"]);

export function lintText(scene) {
  const errors = [];
  const nodes = new Map(scene.nodes.map((n) => [n.id, n]));
  const byId = (id) => nodes.get(id);
  const resolveFill = (node) => {
    if (!node) return null;
    if (node.props?.fill) return node.props.fill;
    if (node.props?.font?.fill) return node.props.font.fill;
    return null;
  };
  for (const node of scene.nodes) {
    if (node.type !== "text") continue;
    const p = node.props;
    const path = "/nodes/" + node.id + "/props";
    const parent = node.parent ? byId(node.parent) : null;
    const fontSize = p.font?.size ?? 0;
    // Never on terrain, an image or a gradient without a ground.
    if (!p.ground && parent && (parent.type === "map" || parent.type === "image")) {
      errors.push({ code: "NAKED_TEXT", path, message: "text sits on a " + parent.type + " node without a ground" });
    }
    // Contrast against the resolved ground fill.
    if (p.ground) {
      const ground = byId(p.ground);
      const gf = resolveFill(ground);
      const tf = p.font?.fill;
      if (gf && tf) {
        const ratio = contrastRatio(tf, gf);
        if (ratio < 7) errors.push({ code: "CONTRAST", path, message: "text on ground ratio " + ratio.toFixed(2) + " below 7:1" });
      }
    }
    // Anton rules: never small, never on geography.
    if (p.font?.family === "Anton") {
      if (fontSize < 40) errors.push({ code: "ANTON_SMALL", path, message: "Anton at " + fontSize + "px, floor is 40px" });
      if (parent?.type === "map" || p.anchor?.geo) {
        errors.push({ code: "ANTON_GEOGRAPHY", path, message: "Anton is a headline face, never on geography" });
      }
    }
    // A label under 36 px at 1080p is unreadable at thumbnail size.
    if (fontSize > 0 && fontSize < 36 && !p.thumbnailExempt) {
      errors.push({ code: "THUMB_SMALL", path, message: "text at " + fontSize + "px, floor is 36px unless thumbnailExempt" });
    }
    // A map label needs a geographic anchor.
    if (parent?.type === "map" && !p.anchor?.geo) {
      errors.push({ code: "SCREEN_LABEL_ON_MAP", path, message: "map label without a geographic anchor" });
    }
    // Back easing overshoots: only a stamp may use it.
    const k = p.kinetic;
    if (k && BACK_EASES.has(k.ease) && k.mode !== "stamp") {
      errors.push({ code: "OVERSHOOT_OUTSIDE_STAMP", path: path + "/kinetic", message: k.ease + " overshoots outside stamp mode" });
    }
    // Font must be declared in the scene.
    if (p.font?.family && !scene.fonts.some((f) => f.family === p.font.family)) {
      errors.push({ code: "FONT_MISSING", path, message: "font not in scene fonts: " + p.font.family });
    }
  }
  return { errors };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node src/text/lint-text.mjs <scene.json>"); process.exitCode = 2; }
  else {
    const scene = JSON.parse(readFileSync(file, "utf8"));
    const { errors } = lintText(scene);
    for (const e of errors) console.log(`${e.code} ${e.path} ${e.message}`);
    process.exitCode = errors.length ? 1 : 0;
  }
}
