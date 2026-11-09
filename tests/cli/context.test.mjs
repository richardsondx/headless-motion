// Fast tests for `hme context`. None of these run a video: the
// command only reads JSON reports and the scene file, so the real
// sources are read at run time and checked against their values.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBar,
  buildCeiling,
  buildHarrisRules,
  buildSceneSchema,
  buildSceneState,
  buildLastCheck,
  buildContextReport,
  readContextParts,
  OPEN_GAPS,
} from "../../src/cli/context.mjs";
import { validateInsight } from "../../src/cli/hme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");
const run = (args) => spawnSync(process.execPath, [HME, ...args], { encoding: "utf8" });

test("context --help prints usage and exits 0", () => {
  const r = run(["context", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("hme context"));
  assert.ok(r.stdout.includes("Usage: hme context [--scene <scene.json>] [--out <report.json>]"));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr + r.stdout), "help must not print a stack trace");
});

test("context with an unknown option is a usage error", () => {
  const r = run(["context", "--nope"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('unknown option "--nope"'));
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), "must not print a stack trace");
});

test("context with a missing scene file exits 2 and says so in the report", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-context-"));
  const out = join(dir, "context.json");
  const r = run(["context", "--scene", "no-such-scene.json", "--out", out]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes("missing source"));
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.numbers.scene_state.missing, true);
  assert.ok(report.numbers.scene_state.note.includes("no-such-scene.json"));
  assert.ok(report.numbers.missing.length > 0);
});

test("readContextParts reads the real sources: bar, ceiling, scene, last verdict", () => {
  const parts = readContextParts(join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json"));
  assert.deepEqual(parts.missing, []);
  // Bar matches predicate.json.
  assert.equal(parts.bar.version, "pred-v1");
  assert.equal(parts.bar.ssim_mean_min, 0.96);
  assert.equal(parts.bar.psnr_db_min, 35);
  assert.equal(parts.bar.lpips_mean_max, 0.08);
  assert.equal(parts.bar.flat_delta_e_max, 3);
  assert.equal(parts.bar.g8_text_ratio_min, 7);
  assert.equal(parts.bar.g9_hold_after_label_s, 1.2);
  // Ceiling matches control-ceiling.json.
  assert.equal(parts.control_ceiling.clean.ssim, 0.9708);
  assert.equal(parts.control_ceiling.clean.psnr_db, 38.11);
  assert.equal(parts.control_ceiling.clean.lpips, 0.0425);
  assert.equal(parts.control_ceiling.clean.worst_delta_e, 1.99);
  assert.equal(parts.control_ceiling.youtube_like_crf28.ssim, 0.9346);
  assert.equal(parts.control_ceiling.youtube_like_crf21.ssim, 0.9608);
  assert.ok(parts.control_ceiling.meaning.includes("about 0.96"));
  // Scene state matches the v5 scene file.
  assert.equal(parts.scene_state.frames, 192);
  assert.equal(parts.scene_state.fps, 24);
  assert.equal(parts.scene_state.node_count, 9);
  assert.equal(parts.scene_state.track_count, 16);
  assert.deepEqual(parts.scene_state.nodes.map((n) => n.id), [
    "map", "title-october", "label-sudan", "badge-rsf", "rifle-rsf",
    "badge-rsf-text", "label-fasher", "dot-fasher", "halo-fasher",
  ]);
  assert.equal(parts.scene_state.key_settings.subjectStroke, false);
  assert.equal(parts.scene_state.key_settings.borderStroke, false);
  assert.equal(parts.scene_state.key_settings.rifle_node_present, true);
  // Last verdict matches u2-compare.json.
  assert.equal(parts.last_check.verdict, "FAIL");
  assert.equal(parts.last_check.means.ssim_mean, 0.7941);
  assert.equal(parts.last_check.means.psnr_mean, 20.21);
  assert.equal(parts.last_check.means.lpips_mean, 0.6312);
  assert.equal(parts.last_check.map_only_means.ssim_mean, 0.7975);
  assert.equal(parts.last_check.map_only_means.psnr_mean, 20.41);
  assert.equal(parts.last_check.cut.frame, 186);
  assert.equal(parts.last_check.cut.second, 7.75);
  assert.equal(parts.last_check.corrections.length, 3);
  // Badge timing comes from the full-192 findings, not hardcoded.
  assert.equal(parts.last_check.badge.early_s, 0.75);
  assert.deepEqual([parts.last_check.badge.real.x, parts.last_check.badge.real.y], [966, 594]);
  assert.deepEqual([parts.last_check.badge.ours.x, parts.last_check.badge.ours.y], [864, 634]);
  // Harris rules and schema are present and non-empty.
  assert.ok(parts.harris_rules.registers.includes("Two registers"));
  assert.ok(parts.harris_rules.tokens.lines.subjectPx.join(",").includes("4"));
  assert.deepEqual(parts.scene_schema.node_types, ["text", "shape", "image", "map", "chart", "particle"]);
  assert.ok(parts.scene_schema.top_level_required.includes("nodes"));
  // Open gaps cover the eight missing dimensions.
  assert.deepEqual(parts.open_gaps.map((g) => g.gap), [
    "zoom velocity", "contour shape", "vignette", "grain over time",
    "z-order", "type beyond the box", "sub-second event timing", "calibration",
  ]);
  assert.ok(parts.open_gaps.every((g) => g.needs.length > 0));
});

test("buildLastCheck falls back to full192-report.json and says so", () => {
  const full192 = JSON.parse(readFileSync(join(ROOT, "verify-seg4", "evidence", "work", "full-192", "full192-report.json"), "utf8"));
  const last = buildLastCheck(null, full192, "u2-compare.json", "full192-report.json");
  assert.equal(last.verdict, "FAIL");
  assert.equal(last.means.ssim_mean, 0.7941);
  assert.equal(last.map_only_means.ssim_mean, 0.7975);
  assert.equal(last.cut.frame, 186);
  assert.ok(last.source_note.includes("falls back"));
  assert.equal(last.source, "full192-report.json");
});

test("buildLastCheck with neither report carries a missing note", () => {
  const last = buildLastCheck(null, null, "u2-compare.json", "full192-report.json");
  assert.equal(last.missing, true);
  assert.ok(last.note.includes("u2-compare.json"));
});

test("buildContextReport output passes the insight validator", () => {
  const parts = readContextParts(join(ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json"));
  const report = buildContextReport(parts);
  assert.equal(report.verdict.status, "FAIL");
  assert.equal(report.verdict.failed_bar, "SSIM >= 0.96 (pred-v1)");
  assert.equal(report.context.thresholds.ssim, 0.96);
  assert.equal(report.context.control_ceiling.ssim, 0.9708);
  assert.equal(report.corrections.length, 1);
  assert.equal(report.corrections[0].element, "badge-rsf");
  assert.deepEqual(report.corrections[0].shift_px, { dx: 102, dy: -40 });
  for (const key of ["bar", "control_ceiling", "harris_rules", "scene_schema", "scene_state", "last_check", "open_gaps"]) {
    assert.ok(report.numbers[key] !== null && report.numbers[key] !== undefined, `${key} must be present`);
    assert.ok(Object.keys(report.numbers[key]).length > 0, `${key} must be non-empty`);
  }
  assert.ok(report.numbers.open_gaps.length === 8);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("context CLI writes one JSON with all six parts plus gaps", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-context-"));
  const out = join(dir, "context.json");
  const r = run(["context", "--out", out]);
  // Exit 1: the last check failed, and the context verdict follows it.
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.numbers.scene_state.frames, 192);
  assert.equal(report.numbers.last_check.means.ssim_mean, 0.7941);
  assert.equal(report.numbers.control_ceiling.clean.ssim, 0.9708);
  assert.equal(report.numbers.bar.ssim_mean_min, 0.96);
  assert.equal(report.numbers.open_gaps.length, 8);
  assert.deepEqual(report.numbers.missing, []);
  const { valid, errors } = validateInsight(report);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("buildBar and buildCeiling carry a missing note when the source is gone", () => {
  const bar = buildBar(null, "no-such-predicate.json");
  assert.equal(bar.missing, true);
  assert.ok(bar.note.includes("no-such-predicate.json"));
  const ceiling = buildCeiling(null, "no-such-ceiling.json");
  assert.equal(ceiling.missing, true);
  const harris = buildHarrisRules(null, "no-such-tokens.json");
  assert.equal(harris.missing, true);
  const schema = buildSceneSchema(null, "no-such-schema.json");
  assert.equal(schema.missing, true);
  const state = buildSceneState(null, "no-such-scene.json");
  assert.equal(state.missing, true);
});

test("OPEN_GAPS names all eight missing dimensions", () => {
  assert.equal(OPEN_GAPS.length, 8);
  assert.ok(OPEN_GAPS.some((g) => g.gap === "calibration"));
  assert.ok(OPEN_GAPS.some((g) => g.gap === "zoom velocity"));
});
