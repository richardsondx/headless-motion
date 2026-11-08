import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lintDir, blankComments } from "../../src/scene/lint-determinism.mjs";

const LINT = new URL("../../src/scene/lint-determinism.mjs", import.meta.url).pathname;
const ROOT = new URL("../../", import.meta.url).pathname;
const run = (dir) => spawnSync(process.execPath, [LINT, dir], { encoding: "utf8", cwd: ROOT });

test("src passes", () => {
  const r = run("src");
  assert.equal(r.stdout, "");
  assert.equal(r.status, 0);
});

test("a Math.random fixture exits 1 and prints file:line", () => {
  const r = run("tests/fixtures/lint");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^tests\/fixtures\/lint\/uses-math-random\.mjs:3 /);
});

test("each banned construct is caught", () => {
  const dir = join(ROOT, ".tmp", "lint-cases");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cases = {
    "a.mjs": ["const t = " + "Da" + "te.now();", "Date"],
    "b.mjs": ["const t = performance" + ".now();", "performance.now"],
    "c.mjs": ["const i = new Int" + "l.NumberFormat();", "Intl"],
    "d.mjs": ["n.toLocale" + "String();", "toLocaleString"],
    "e.mjs": ["setTime" + "out(f, 1);", "setTimeout"],
    "f.mjs": ["request" + "AnimationFrame(loop);", "requestAnimationFrame"],
    "g.css": [".a { anim" + "ation: spin 1s; }", "css-animation"],
    "h.css": [".a { trans" + "ition: all 1s; }", "css-transition"],
    "i.mjs": ["el.anim" + "ate([], 1);", "waapi"],
    "j.html": ["<vid" + "eo src=x>", "video-element"],
    "k.mjs": ["crypto.random" + "UUID();", "crypto.randomUUID"],
  };
  for (const [name, [body]] of Object.entries(cases)) writeFileSync(join(dir, name), body + "\n");
  const hits = lintDir(dir);
  for (const [name, [, rule]] of Object.entries(cases)) {
    assert.ok(hits.some((h) => h.file.endsWith(name) && h.rule === rule), `${name} should trip ${rule}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("comments are ignored, strings are not, line numbers survive", () => {
  const src = "// Math" + ".random\n/* Da" + "te\n */\nconst a = 1;\nconst b = 'Math" + ".random';\n";
  const blanked = blankComments(src);
  assert.equal(blanked.split("\n").length, src.split("\n").length);
  assert.ok(!blanked.split("\n").slice(0, 3).join("").includes("Math"));
  assert.ok(blanked.includes("'Math"));
});
