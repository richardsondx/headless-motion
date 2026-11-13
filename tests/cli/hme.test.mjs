import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, validateInsight, writeInsightReport } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "src", "cli", "insight-schema.json"), "utf8"));
const NAMES = COMMANDS.map((c) => c.name);
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });

test("hme --help lists all 28 commands", () => {
  assert.deepEqual([...NAMES].sort(), ["blur-grain", "colour", "compare", "composition", "context", "contour", "control", "diagnose", "export", "extract", "fix", "fonts", "frame-style", "gates", "gradient", "layering", "ledger", "mcp", "path", "player-pass", "render", "rig", "timing", "trace", "type", "validate", "vignette", "zoom-velocity"]);
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  for (const name of NAMES) assert.ok(r.stdout.includes(name), `--help is missing ${name}`);
});

for (const cmd of COMMANDS) {
  test(`${cmd.name} --help prints its arguments and exits 0`, () => {
    const r = run([cmd.name, "--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`hme ${cmd.name}`), "help must name the command");
    assert.ok(r.stdout.includes("Usage:"), "help must show usage");
    assert.ok(!r.stderr.includes("Error"), "help must not print an error");
    assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
  });
}

// Commands with no module yet still report "not implemented yet".
// Compare is implemented (U2), context is implemented (U5),
// diagnose and extract are implemented (U3), control and
// player-pass are implemented (U4), fonts is implemented (U8),
// trace is implemented (U7), mcp is implemented (U6), and render,
// validate, and gates are implemented (U11); their own
// files cover the no-argument case instead. Colour, contour, and
// vignette are implemented too, so they are excluded for the same
// reason, and layering is implemented as well. Zoom-velocity is
// implemented too, so it is excluded for the same reason. Timing is
// implemented too, so it is excluded for the same reason. Ledger is
// implemented too, so it is excluded for the same reason. Rig and fix
// are implemented too, so they are excluded for the same reason. Gradient is
// implemented too (Unit G), so it is excluded for the same reason. Type has a stub
// module (T1): its own test file covers the no-argument case, and a
// real measurement run reports "not implemented yet" only after its
// arguments validate. (mcp reads stdin, so a
// bare `hme mcp` with no input waits for requests instead of
// exiting; it is not a placeholder and must not be tested that way.)
for (const cmd of COMMANDS.filter((c) => !["compare", "context", "diagnose", "extract", "control", "player-pass", "fonts", "trace", "mcp", "render", "validate", "gates", "blur-grain", "colour", "contour", "vignette", "layering", "type", "zoom-velocity", "timing", "ledger", "rig", "fix", "path", "gradient", "composition", "export", "frame-style"].includes(c.name))) {
  test(`${cmd.name} without --help says not implemented yet and exits 2`, () => {
    const r = run([cmd.name]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("not implemented yet"), `stderr was: ${r.stderr}`);
    assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
  });
}

test("unknown command exits 2 without a stack trace", () => {
  const r = run(["nope"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('unknown command "nope"'));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr));
});

test("no arguments prints help and exits 2", () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("Commands:"));
});

test("insight schema validates the badge sample report", () => {
  assert.equal(SCHEMA.examples.length, 1);
  const sample = SCHEMA.examples[0];
  assert.equal(sample.corrections[0].element, "badge-rsf");
  assert.equal(sample.corrections[0].kind, "timing");
  assert.equal(sample.corrections[0].at_s, 5.0);
  assert.deepEqual(sample.corrections[0].ours, { x: 864, y: 634, px: 29406 });
  assert.deepEqual(sample.corrections[0].real, { x: 966, y: 594, px: 15200 });
  assert.deepEqual(sample.corrections[0].shift_px, { dx: 102, dy: -40 });
  assert.ok(sample.corrections[0].fix.includes("0.75 s later"));
  assert.equal(sample.corrections[0].source, "hme compare, frame 120");
  const { valid, errors } = validateInsight(sample);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("validator rejects bad reports", () => {
  const sample = SCHEMA.examples[0];
  assert.equal(validateInsight(null).valid, false);
  assert.equal(validateInsight({}).valid, false);
  const badStatus = structuredClone(sample);
  badStatus.verdict.status = "MAYBE";
  assert.equal(validateInsight(badStatus).valid, false);
  const failNoBar = structuredClone(sample);
  failNoBar.verdict.failed_bar = null;
  assert.equal(validateInsight(failNoBar).valid, false);
  const noFix = structuredClone(sample);
  delete noFix.corrections[0].fix;
  assert.equal(validateInsight(noFix).valid, false);
  const noNext = structuredClone(sample);
  noNext.next = "";
  assert.equal(validateInsight(noNext).valid, false);
});

test("writeInsightReport writes a file and returns 1 on FAIL, 0 on PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-test-"));
  try {
    const sample = SCHEMA.examples[0];
    const out = join(dir, "report.json");
    assert.equal(writeInsightReport(sample, out), 1);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), sample);
    const pass = structuredClone(sample);
    pass.verdict = { status: "PASS", failed_bar: null };
    pass.corrections = [];
    assert.equal(writeInsightReport(pass, join(dir, "pass.json")), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json has a bin entry for hme", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.bin.hme, "src/cli/hme.mjs");
});
