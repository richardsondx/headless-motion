// hme fix: apply an insight report's corrections to a scene and
// write a new scene file, plus an insight report of what happened.
//
// The shell only: read the report and the scene, pick a translator
// per correction kind, apply, run the gate, write. Values come from
// the report numbers plus the scene only; the prose fix string is
// never parsed.
//
// Translators (src/cli/fix/): timing (warp table), position
// (shift_px), text (cap heights and letter gaps from numbers.labels).
// Every other kind is refused with a named reason (refuse.mjs);
// a translator that throws refuses that correction with the
// translator's message, and the scene it was working on is
// untouched, because every translator is pure.
//
// Text dispatch needs care, because the type report's
// numbers.labels entries are keyed by label slug ('el-fasher',
// 'october') while corrections name the scene node id
// ('label-fasher', 'title-october'). Mapping, in order, for one
// element (see labelCandidates): the element id itself, the
// slugified node text, the slugified first word of the text, and
// the slugified text with a trailing numeric token (a year)
// stripped. So 'EL FASHER' maps to 'el-fasher' by full text, and
// 'October 2025' maps to 'october' by first word. There is no
// cleaner mapping in type.mjs to reuse: it hardcodes the two
// labels and finds nodes by exact text (sceneTextNode), so the
// fixer must do the slug lookup itself. When no numbers entry is
// found the correction is refused with a named reason.
//
// A text correction also names no sub-kind: it can be a font-size
// fix (cap-height ratio outside 0.9-1.1, the type.mjs gate) or a
// letterSpacing fix (median gap differs by at least 2 px, the
// type.mjs gate). When exactly one target exists it is applied;
// when neither exists, or both exist, the correction is refused
// with a named reason rather than guessed. A second text
// correction for the same element and the same target (the type
// report names a second, uncomputable 'wider face' correction for
// EL FASHER) is refused as already applied, so the size fix is
// never applied twice.
//
// Gate: diff old vs new, asserting only the intended paths
// changed (the allowed set is built per correction from the
// scene before it is applied, never from the actual diff), plus
// in-memory validate (0 errors, 0 determinism hits). A failed
// gate writes no file. The fixer never overwrites an existing
// scene file.
//
// Exit codes: 0 a file was written and the gate passed (or, on
// --dry-run, the plan passes the gate); 1 the gate failed or
// every correction was refused (no file written); 2 usage error
// or an input file cannot be read.
//
// Design: ~/workspace/handover-motion-fixer/design-first-principles.md
// (rebuilt design, command wiring).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { applyTimingFix, rigidMotionGroup } from "./fix/timing.mjs";
import { applyPositionFix } from "./fix/position.mjs";
import { applyTextSizeFix, applyLetterSpacingFix } from "./fix/text.mjs";
import { refuseCorrection } from "./fix/refuse.mjs";
import { checkDiff, runGate, validateNewScene } from "./fix/gate.mjs";
import { writeInsightReport } from "./hme.mjs";

export const USAGE = [
  "hme fix: Apply an insight report's corrections to a scene and write a new scene file.",
  "",
  "Usage: hme fix --report <report.json> --scene <scene.json> --out <new-scene.json> [--report-out <report.json>] [--dry-run]",
  "",
  "Options:",
  "  --report <file>  Insight report JSON (corrections[] plus numbers). Required.",
  "  --scene <file>  Scene file to fix. Required.",
  "  --out <file>  Where to write the fixed scene. Required. Never overwrites an existing file.",
  "  --report-out <file>  Write the JSON report here. Without it, the report goes to stdout. Not written on --dry-run.",
  "  --dry-run  Print the planned edits (the insight report) to stdout and write no file.",
  "",
  "Exit codes: 0 a file was written and the gate passed (or, on --dry-run, the plan passes the gate); 1 the gate failed or every correction was refused (no file written); 2 usage error or an input file cannot be read.",
  "",
  "Values come from the report numbers plus the scene only; the prose fix string is never parsed.",
].join("\n") + "\n";

/** Slugify label text: "EL FASHER" -> "el-fasher". */
export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Candidate numbers.labels keys for one scene element, in lookup
 * order: the element id itself, the slugified node text, the
 * slugified first word of the text, and the slugified text with a
 * trailing numeric token (a year, e.g. "October 2025") stripped.
 */
export function labelCandidates(scene, elementId) {
  const candidates = [];
  const push = (c) => { if (c && !candidates.includes(c)) candidates.push(c); };
  push(elementId);
  const node = Array.isArray(scene?.nodes) ? scene.nodes.find((n) => n.id === elementId) : null;
  const text = node?.props?.text;
  if (typeof text === "string" && text.length > 0) {
    push(slugify(text));
    push(slugify(text.trim().split(/\s+/)[0]));
    const stripped = text.replace(/\s+\d+\s*$/, "");
    if (stripped !== text) push(slugify(stripped));
  }
  return candidates;
}

/**
 * Find the numbers.labels entry for one element.
 * @returns {{ slug: string|null, entry: object|null, candidates: string[] }}
 */
export function findLabelEntry(labels, scene, elementId) {
  const candidates = labelCandidates(scene, elementId);
  if (labels && typeof labels === "object") {
    for (const c of candidates) {
      if (Object.prototype.hasOwnProperty.call(labels, c)) {
        return { slug: c, entry: labels[c], candidates };
      }
    }
  }
  return { slug: null, entry: null, candidates };
}

/**
 * The computable text targets in one numbers.labels entry, using
 * the type.mjs gates: a font-size target when the cap-height ratio
 * (ours / ref) sits outside 0.9-1.1, a letterSpacing target when
 * the median letter gap differs by at least 2 px. Flat (non
 * {ref, ours}) values name no target.
 * @returns {{ size: { capRef, capOurs, ratio }|null, spacing: { refGap, oursGap }|null }}
 */
export function textTargets(entry) {
  if (!entry || typeof entry !== "object" || entry.measured === false) {
    return { size: null, spacing: null };
  }
  const caps = entry.cap_height_px;
  const gaps = entry.gap_median_px;
  let size = null;
  if (
    caps && typeof caps === "object"
    && typeof caps.ref === "number" && typeof caps.ours === "number" && caps.ref !== 0
  ) {
    const ratio = caps.ours / caps.ref;
    if (Number.isFinite(ratio) && (ratio < 0.9 || ratio > 1.1)) {
      size = { capRef: caps.ref, capOurs: caps.ours, ratio };
    }
  }
  let spacing = null;
  if (
    gaps && typeof gaps === "object"
    && typeof gaps.ref === "number" && typeof gaps.ours === "number"
    && Math.abs(gaps.ref - gaps.ours) >= 2
  ) {
    spacing = { refGap: gaps.ref, oursGap: gaps.ours };
  }
  return { size, spacing };
}

function refusal(correction, reason) {
  return {
    element: correction?.element ?? null,
    kind: correction?.kind ?? null,
    at_s: typeof correction?.at_s === "number" ? correction.at_s : null,
    reason,
    source: typeof correction?.source === "string" ? correction.source : null,
  };
}

function appliedEntry(correction, change) {
  return {
    element: correction.element,
    kind: correction.kind,
    at_s: correction.at_s,
    change,
    source: correction.source,
  };
}

/** Node index of an element in the working scene, or -1. */
function nodeIndex(scene, elementId) {
  return Array.isArray(scene?.nodes) ? scene.nodes.findIndex((n) => n.id === elementId) : -1;
}

/** Track indices of a node in the working scene timeline. */
function trackIndices(scene, nodeId) {
  const out = [];
  (scene.timeline ?? []).forEach((t, i) => { if (t.node === nodeId) out.push(i); });
  return out;
}

/**
 * Apply one applicable correction. Returns { scene, change,
 * allowedPaths } on success, or { refused: reason } when the
 * correction cannot be computed (the working scene is untouched).
 * Throws only when a translator throws; the caller turns that
 * into a refusal with the translator's message.
 */
function applyOne(working, correction, numbers, appliedText) {
  const element = correction.element;
  if (correction.kind === "timing") {
    const group = rigidMotionGroup(working, element);
    const allowedPaths = new Set();
    for (const nodeId of group) {
      const ni = nodeIndex(working, nodeId);
      if (ni >= 0) {
        allowedPaths.add(`nodes[${ni}].visible.in`);
        allowedPaths.add(`nodes[${ni}].visible.out`);
      }
      for (const ti of trackIndices(working, nodeId)) {
        (working.timeline[ti].keys ?? []).forEach((_k, ki) => {
          allowedPaths.add(`timeline[${ti}].keys[${ki}].f`);
        });
      }
    }
    const beforeFrames = [...new Set(
      working.timeline.filter((t) => t.node === element).flatMap((t) => t.keys.map((k) => k.f)),
    )].sort((a, b) => a - b);
    const beforeNode = working.nodes.find((n) => n.id === element);
    const next = applyTimingFix(working, numbers.warp_table, element);
    const afterFrames = [...new Set(
      next.timeline.filter((t) => t.node === element).flatMap((t) => t.keys.map((k) => k.f)),
    )].sort((a, b) => a - b);
    const afterNode = next.nodes.find((n) => n.id === element);
    if (
      JSON.stringify(beforeFrames) === JSON.stringify(afterFrames)
      && beforeNode?.visible?.in === afterNode?.visible?.in
      && beforeNode?.visible?.out === afterNode?.visible?.out
    ) {
      return { refused: `timing warp moves no keyframe for ${element}: every interpolated delay rounds to 0 frames` };
    }
    const companions = group.filter((g) => g !== element);
    const viIn = (n) => (n?.visible ? n.visible.in : null);
    const viOut = (n) => (n?.visible ? n.visible.out : null);
    const change = `${element}${companions.length ? ` (+ ${companions.join(", ")})` : ""} timeline keys ${beforeFrames.join(",")} -> ${afterFrames.join(",")}; visible.in ${viIn(beforeNode)} -> ${viIn(afterNode)}, visible.out ${viOut(beforeNode)} -> ${viOut(afterNode)}`;
    return { scene: next, change, allowedPaths };
  }

  if (correction.kind === "position") {
    const ni = nodeIndex(working, element);
    if (ni < 0) return { refused: `position fix refused: element ${element} not found` };
    const shift = correction.shift_px;
    if (!shift || shift.dx === 0 && shift.dy === 0) {
      return { refused: `position fix refused: shift_px is ${JSON.stringify(shift)}, so nothing moves` };
    }
    const before = working.nodes[ni].box;
    const next = applyPositionFix(working, element, shift);
    const after = next.nodes[ni].box;
    return {
      scene: next,
      change: `${element} box.x ${before.x} -> ${after.x}, box.y ${before.y} -> ${after.y}`,
      allowedPaths: new Set([`nodes[${ni}].box.x`, `nodes[${ni}].box.y`]),
    };
  }

  if (correction.kind === "text") {
    const ni = nodeIndex(working, element);
    if (ni < 0) return { refused: `text fix refused: element ${element} not found` };
    const labels = numbers.labels;
    const { slug, entry, candidates } = findLabelEntry(labels, working, element);
    if (!entry) {
      return { refused: `no numbers.labels entry matches element ${element} (tried ${candidates.join(", ")}), so no cap-height or gap numbers exist for it` };
    }
    if (entry.measured === false) {
      return { refused: `numbers.labels.${slug} was not measured${entry.reason ? `: ${entry.reason}` : ""}, so no cap-height or gap numbers exist for it` };
    }
    const { size, spacing } = textTargets(entry);
    if (!size && !spacing) {
      return { refused: `no computable text target in numbers.labels.${slug}: cap heights ${JSON.stringify(entry.cap_height_px)} and median gaps ${JSON.stringify(entry.gap_median_px)} name neither a font-size change (cap-height ratio outside 0.9-1.1) nor a letterSpacing change (gap differs by at least 2 px)` };
    }
    if (size && spacing) {
      return { refused: `both a font-size target (cap height ${size.capOurs} px -> ${size.capRef} px) and a letterSpacing target (median gap ${spacing.oursGap} px -> ${spacing.refGap} px) exist for ${element} in numbers.labels.${slug}; a text correction names no sub-kind, so the intended one cannot be identified without parsing the prose fix string` };
    }
    const target = size ? "size" : "spacing";
    const key = `${element}:${target}`;
    if (appliedText.has(key)) {
      return { refused: `a ${target === "size" ? "font-size" : "letterSpacing"} correction for ${element} was already applied from these numbers; no further computable text target remains for it` };
    }
    const node = working.nodes[ni];
    if (size) {
      const oldSize = node.props?.font?.size;
      const next = applyTextSizeFix(working, element, size.capRef, size.capOurs);
      const newSize = next.nodes[ni].props.font.size;
      if (newSize === oldSize) {
        return { refused: `${element} font size is already at its target ${newSize} px, so the size correction changes nothing` };
      }
      appliedText.add(key);
      return {
        scene: next,
        change: `${element} props.font.size ${oldSize} -> ${newSize} (cap height ${size.capOurs} px -> ${size.capRef} px, ratio ${Math.round(size.ratio * 100) / 100})`,
        allowedPaths: new Set([`nodes[${ni}].props.font.size`]),
      };
    }
    const oldSpacing = node.props?.font?.letterSpacing;
    const next = applyLetterSpacingFix(working, element, spacing.refGap, spacing.oursGap);
    const newSpacing = next.nodes[ni].props.font.letterSpacing;
    if (newSpacing === oldSpacing) {
      return { refused: `${element} letterSpacing is already at its target ${newSpacing}, so the spacing correction changes nothing` };
    }
    appliedText.add(key);
    return {
      scene: next,
      change: `${element} props.font.letterSpacing ${oldSpacing} -> ${newSpacing} (median letter gap ${spacing.oursGap} px -> ${spacing.refGap} px)`,
      allowedPaths: new Set([`nodes[${ni}].props.font.letterSpacing`]),
    };
  }

  return { refused: `kind "${correction.kind}" refused: no translator exists for this kind, so no value source is defined and the target value cannot be computed` };
}

/**
 * Apply every correction in an insight report to a scene.
 * Pure: never touches the disk, never mutates its inputs.
 * @returns {{ scene, applied, refused, allowed: Set<string> }}
 *   applied/refused entries carry element, kind, at_s, source,
 *   plus change (applied) or reason (refused).
 */
export function applyCorrections(scene, report) {
  const corrections = Array.isArray(report?.corrections) ? report.corrections : [];
  const numbers = report?.numbers ?? {};
  let working = scene;
  const applied = [];
  const refused = [];
  const allowed = new Set();
  const appliedText = new Set();
  for (const correction of corrections) {
    const decision = refuseCorrection(correction);
    if (!decision.applicable) {
      refused.push(refusal(correction, decision.reason));
      continue;
    }
    let result;
    try {
      result = applyOne(working, correction, numbers, appliedText);
    } catch (err) {
      refused.push(refusal(correction, err.message));
      continue;
    }
    if (result.refused) {
      refused.push(refusal(correction, result.refused));
      continue;
    }
    for (const p of result.allowedPaths) allowed.add(p);
    working = result.scene;
    applied.push(appliedEntry(correction, result.change));
  }
  return { scene: working, applied, refused, allowed };
}

/**
 * Build the insight report for a fix run. Pure function.
 * diff: { changedPaths, unexpectedPaths } from checkDiff, or null.
 * gate: { pass, reason, errors, determinismHits } or null.
 * error: unreadable-input message, or null.
 */
export function buildFixReport({
  reportArg, sceneArg, outPath, reportOutPath, dryRun,
  applied, refused, diff, gate, written, error,
}) {
  const failedBar = error !== null
    ? "inputs can be read"
    : applied.length === 0
      ? "at least one correction applied (0 applied)"
      : gate && !gate.pass
        ? `gate failed: ${gate.reason}`
        : null;
  const status = failedBar === null ? "PASS" : "FAIL";
  const detail = error !== null
    ? `Cannot run hme fix: ${error}`
    : applied.length === 0
      ? `No correction could be applied: ${refused.length} correction${refused.length === 1 ? " was" : "s were"} refused (reasons in numbers.refused). No scene file was written.`
      : gate && !gate.pass
        ? `Gate failed: ${gate.reason}. No scene file was written.`
        : dryRun
          ? `Dry run: ${applied.length} correction${applied.length === 1 ? "" : "s"} would be applied${refused.length ? `, ${refused.length} refused` : ""}; the gate passed, but no file was written.`
          : `Applied ${applied.length} correction${applied.length === 1 ? "" : "s"}${refused.length ? `, refused ${refused.length}` : ""}; wrote ${outPath}. Gate passed (0 errors, 0 determinism hits).`;
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      report: reportArg,
      scene: sceneArg,
      out: outPath,
      report_out: reportOutPath,
      dry_run: dryRun,
      written,
      applied_count: applied.length,
      refused_count: refused.length,
      applied,
      refused,
      diff: diff ? { changed_paths: diff.changedPaths, changed_count: diff.changedPaths.length, unexpected_paths: diff.unexpectedPaths } : null,
      gate: gate ? {
        passed: gate.pass,
        reason: gate.reason ?? null,
        error_count: (gate.errors ?? []).length,
        determinism_hit_count: (gate.determinismHits ?? []).length,
        errors: gate.errors ?? [],
        determinism_hits: gate.determinismHits ?? [],
      } : null,
      error,
    },
    // The input corrections verbatim: the report lists what was
    // asked for; numbers.applied / numbers.refused list what
    // happened to each one.
    corrections: [],
    context: {
      thresholds: { errors: 0, determinism_hits: 0 },
      control_ceiling: null,
      meaning: status === "PASS"
        ? "The fixed scene passed the gate (only the intended paths changed, 0 schema errors, 0 determinism hits), so the new file is a valid scene with the corrections applied."
        : "No fixed scene was written. Read numbers.refused for why each correction was refused, or numbers.gate for why the gate failed.",
    },
    next: status === "PASS" && !dryRun
      ? `hme validate ${outPath}`
      : `hme fix --report ${reportArg} --scene ${sceneArg} --out ${outPath}${reportOutPath ? ` --report-out ${reportOutPath}` : ""}`,
    limits: [
      "The fixer never parses the prose fix string: every value comes from the report numbers plus the scene.",
      "The gate checks the scene schema, the determinism lint, and that only the intended paths changed. It does not re-render or re-measure the video.",
      "A text correction names no sub-kind: when both a font-size target and a letterSpacing target exist for one element, the correction is refused as ambiguous rather than guessed.",
      "The fixer never overwrites an existing scene file.",
    ],
  };
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${label} ${path}: ${err.message}`);
  }
}

// Run `hme fix --report <report.json> --scene <scene.json>
// --out <new-scene.json> [--report-out <report.json>] [--dry-run]`.
// Returns the process exit code: 0 written and gate passed (or
// dry-run plan passes), 1 gate failed or every correction refused,
// 2 usage error or unreadable input. Never prints a stack trace.
export function runFix(argv) {
  let reportArg = null;
  let sceneArg = null;
  let outPath = null;
  let reportOutPath = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const needValue = (flag) => {
      if (i + 1 >= argv.length) {
        console.error(`hme fix: ${flag} needs a file path`);
        console.error(USAGE);
        return null;
      }
      return argv[++i];
    };
    if (a === "--report") {
      reportArg = needValue(a);
      if (reportArg === null) return 2;
    } else if (a === "--scene") {
      sceneArg = needValue(a);
      if (sceneArg === null) return 2;
    } else if (a === "--out") {
      outPath = needValue(a);
      if (outPath === null) return 2;
    } else if (a === "--report-out") {
      reportOutPath = needValue(a);
      if (reportOutPath === null) return 2;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      return 0;
    } else if (a.startsWith("--")) {
      console.error(`hme fix: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      console.error(`hme fix: unexpected argument "${a}"`);
      console.error(USAGE);
      return 2;
    }
  }
  if (!reportArg || !sceneArg || !outPath) {
    console.error("hme fix: --report, --scene and --out are all required");
    console.error(USAGE);
    return 2;
  }

  // Unreadable inputs: still write a FAIL insight report when a
  // report destination is known, then exit 2.
  const errorReport = (error) => {
    const report = buildFixReport({
      reportArg, sceneArg, outPath, reportOutPath, dryRun,
      applied: [], refused: [], diff: null, gate: null, written: false, error,
    });
    report.corrections = [];
    const w = writeInsightReport(report, dryRun ? null : reportOutPath);
    if (w === 2) console.error("hme fix: could not write the insight report");
    return 2;
  };

  let report;
  let scene;
  try {
    report = readJson(resolve(reportArg), "report");
  } catch (err) {
    console.error(`hme fix: ${err.message}`);
    return errorReport(err.message);
  }
  try {
    scene = readJson(resolve(sceneArg), "scene");
  } catch (err) {
    console.error(`hme fix: ${err.message}`);
    return errorReport(err.message);
  }
  if (!Array.isArray(report.corrections)) {
    const error = `report ${reportArg} has no corrections array`;
    console.error(`hme fix: ${error}`);
    return errorReport(error);
  }

  const { scene: working, applied, refused, allowed } = applyCorrections(scene, report);
  const diff = checkDiff(scene, working, allowed);

  if (applied.length === 0) {
    const out = buildFixReport({
      reportArg, sceneArg, outPath, reportOutPath, dryRun,
      applied, refused, diff, gate: null, written: false, error: null,
    });
    out.corrections = report.corrections;
    if (dryRun) {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } else {
      writeInsightReport(out, reportOutPath);
    }
    return 1;
  }

  if (dryRun) {
    const validation = validateNewScene(working);
    const gate = {
      pass: diff.pass && validation.pass,
      reason: !diff.pass
        ? `diff check failed: unexpected changed paths: ${diff.unexpectedPaths.join(", ")}`
        : !validation.pass
          ? `validate check failed: ${validation.errors[0] ? `${validation.errors[0].code} ${validation.errors[0].path} ${validation.errors[0].message}` : `determinism lint hit: ${validation.determinismHits[0].rule} at line ${validation.determinismHits[0].line}`}`
          : null,
      errors: validation.errors,
      determinismHits: validation.determinismHits,
    };
    const out = buildFixReport({
      reportArg, sceneArg, outPath, reportOutPath, dryRun,
      applied, refused, diff, gate, written: false, error: null,
    });
    out.corrections = report.corrections;
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return gate.pass ? 0 : 1;
  }

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  const gateResult = runGate({ oldScene: scene, newScene: working, allowed, outPath: resolve(outPath) });
  const gate = {
    pass: gateResult.pass,
    reason: gateResult.reason ?? null,
    errors: gateResult.validation?.errors ?? [],
    determinismHits: gateResult.validation?.determinismHits ?? [],
  };
  const out = buildFixReport({
    reportArg, sceneArg, outPath, reportOutPath, dryRun,
    applied, refused, diff, gate, written: gateResult.written, error: null,
  });
  out.corrections = report.corrections;
  writeInsightReport(out, reportOutPath);
  return gateResult.pass ? 0 : 1;
}
