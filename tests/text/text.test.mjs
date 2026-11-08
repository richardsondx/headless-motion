import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kineticState, splitText } from "../../src/text/kinetic.mjs";
import { pillPadding, pillPasses } from "../../src/text/pill.mjs";
import { lintText } from "../../src/text/lint-text.mjs";
import { loadScene } from "../../src/scene/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const LINT = resolve(ROOT, "src", "text", "lint-text.mjs");

function runLint(file) {
  return new Promise((resolveP) => {
    execFile("node", [LINT, file], { cwd: ROOT }, (err, stdout) => resolveP({ code: err ? err.code : 0, stdout }));
  });
}

const K = { start: 0, duration: 24, stagger: 2, split: "char", ease: "easeOutCubic", from: { y: 40, opacity: 0, scale: 1 } };

describe("kinetic", () => {
  it("splits chars and words", () => {
    assert.deepEqual(splitText("AB", "char"), ["A", "B"]);
    assert.deepEqual(splitText("a b", "word"), ["a", " ", "b"]);
  });
  it("starts at from, ends at rest", () => {
    const s0 = kineticState(K, "AB", 0);
    assert.equal(s0[0].y, 40);
    assert.equal(s0[0].opacity, 0);
    const sEnd = kineticState(K, "AB", 30);
    assert.equal(sEnd[0].y, 0);
    assert.equal(sEnd[0].opacity, 1);
    assert.equal(sEnd[0].done, true);
  });
  it("staggers the second unit", () => {
    const s = kineticState(K, "AB", 4);
    assert.ok(s[1].y > s[0].y, "second char lags the first");
  });
});

describe("pill", () => {
  it("pads 12/6/9 at 1080p", () => {
    assert.deepEqual(pillPadding(), { vertical: 12, horizontal: 6, gap: 9 });
  });
  it("white on navy clears 7:1", () => {
    assert.equal(pillPasses("#14213d"), true);
    assert.equal(pillPasses("#c6ad7a"), false);
  });
});

function baseScene() {
  return {
    fonts: [{ family: "FixtureSans", weight: 700 }],
    nodes: [
      { id: "pill", type: "shape", props: { fill: "#14213d" } },
      { id: "t", type: "text", parent: null, props: { text: "HI", font: { family: "FixtureSans", weight: 700, size: 48, fill: "#ffffff" }, ground: "pill" } },
    ],
  };
}

describe("lint-text", () => {
  it("text-sample is clean", () => {
    const scene = loadScene("tests/fixtures/text-sample.json");
    assert.deepEqual(lintText(scene).errors, []);
  });
  it("flags Anton small, back ease outside stamp, naked map text", () => {
    const s = baseScene();
    s.nodes[1].props.font.family = "Anton";
    s.nodes[1].props.font.size = 24;
    s.nodes[1].props.kinetic = { start: 0, duration: 12, ease: "easeOutBack", mode: "default" };
    s.nodes.push({ id: "m", type: "map", props: {} });
    s.nodes.push({ id: "lab", type: "text", parent: "m", props: { text: "X", font: { family: "FixtureSans", weight: 700, size: 48, fill: "#ffffff" } } });
    const codes = lintText(s).errors.map((e) => e.code);
    for (const c of ["ANTON_SMALL", "OVERSHOOT_OUTSIDE_STAMP", "NAKED_TEXT", "SCREEN_LABEL_ON_MAP", "THUMB_SMALL"]) assert.ok(codes.includes(c), "missing " + c);
  });
  it("flags low contrast", () => {
    const s = baseScene();
    s.nodes[0].props.fill = "#f4f1ea";
    const codes = lintText(s).errors.map((e) => e.code);
    assert.ok(codes.includes("CONTRAST"));
  });
  it("text-sample lint CLI exits 0", async () => {
    const r = await runLint(resolve(ROOT, "tests", "fixtures", "text-sample.json"));
    assert.equal(r.code, 0, r.stdout);
  });
  it("each text-bad fixture exits 1 with its code", async () => {
    const dir = resolve(ROOT, "tests", "fixtures", "text-bad");
    for (const name of readdirSync(dir).sort()) {
      const code = name.replace(".json", "");
      const r = await runLint(resolve(dir, name));
      assert.equal(r.code, 1, `${code} should exit 1, got ${r.code}: ${r.stdout}`);
      assert.ok(r.stdout.includes(code), `${code} output should name ${code}, got: ${r.stdout}`);
    }
  });
});
