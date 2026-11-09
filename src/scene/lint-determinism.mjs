// Scans a directory for constructs that make a frame depend on anything but (scene, frame).
// Comments are blanked before matching. This file is skipped: it has to name the banned tokens.
// Scoping, from the spec wording:
//   timers: banned except in the Node-side render harness (render.mjs, cli.mjs, retry.mjs); "inside evaluators".
//   requestAnimationFrame: banned except runtime.mjs, where it only flushes paint after a seek.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const EXTENSIONS = /\.(mjs|js|cjs|html|css)$/;
const HARNESS_FILES = ["render.mjs", "cli.mjs", "retry.mjs"];
const RAF_FILES = ["runtime.mjs"];

const word = (w) => new RegExp(`\\b${w}\\b`);
export const RULES = [
  { id: "Date", re: word("Date"), skip: HARNESS_FILES },
  { id: "performance.now", re: /\bperformance\s*\.\s*now\b/, skip: HARNESS_FILES },
  { id: "Math.random", re: /\bMath\s*\.\s*random\b/ },
  { id: "crypto.randomUUID", re: /\brandomUUID\b/ },
  { id: "Intl", re: word("Intl") },
  { id: "toLocaleString", re: /\btoLocale\w*String\b/ },
  { id: "requestAnimationFrame", re: word("requestAnimationFrame"), skip: RAF_FILES },
  { id: "setTimeout", re: /\bsetTimeout\b/, skip: HARNESS_FILES },
  { id: "setInterval", re: /\bsetInterval\b/, skip: HARNESS_FILES },
  { id: "css-animation", re: /(^|[\s;{"'])animation(-\w+)?\s*:|@keyframes/ },
  { id: "css-transition", re: /(^|[\s;{"'])transition(-\w+)?\s*:/ },
  { id: "waapi", re: /\.\s*animate\s*\(|\bgetAnimations\b|\bnew\s+Animation\b/ },
  { id: "video-element", re: /<video\b/i },
];

/** Replace comments with spaces, keep newlines, leave strings alone. */
export function blankComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") out += (i++, " ");
    } else if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) out += src[i++] === "\n" ? "\n" : " ";
      out += "  ";
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") out += src[i++];
        if (c !== "`" && src[i] === "\n") break;
        out += src[i++];
      }
      out += src[i] ?? "";
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** @returns {{file:string,line:number,rule:string,text:string}[]} */
export function lintDir(dir) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (name === "node_modules") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (EXTENSIONS.test(name) && resolve(full) !== SELF) lintFile(full, hits);
    }
  };
  const lintFile = (file, out) => {
    const original = readFileSync(file, "utf8").split("\n");
    const cleaned = blankComments(original.join("\n")).split("\n");
    cleaned.forEach((line, idx) => {
      for (const rule of RULES) {
        if (rule.skip && rule.skip.includes(basename(file))) continue;
        if (rule.re.test(line)) out.push({ file, line: idx + 1, rule: rule.id, text: original[idx].trim() });
      }
    });
  };
  if (statSync(dir).isDirectory()) walk(dir);
  else lintFile(dir, hits);
  return hits;
}

function main(argv) {
  const dir = argv[2];
  if (!dir) {
    console.error("usage: node src/scene/lint-determinism.mjs <dir>");
    return 2;
  }
  const hits = lintDir(dir);
  for (const h of hits) console.log(`${h.file}:${h.line} ${h.rule} ${h.text}`);
  return hits.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv);
