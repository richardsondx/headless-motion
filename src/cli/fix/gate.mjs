// Validation gate for `hme fix`.
//
// Two checks, both before any write:
//   (1) Diff old vs new scene and assert only the intended paths
//       changed. The caller supplies the allowed path set (or a path
//       predicate); the gate returns pass/fail plus the actual
//       changed paths.
//   (2) Validate the new scene in memory: the schema plus
//       cross-reference checks from src/scene/validate.mjs
//       (validateScene takes a scene object) and the determinism
//       lint over the serialized scene text, in memory.
// A failed gate writes no file and reports FAIL. The write step
// writes only after both checks pass, and refuses to overwrite an
// existing file.
//
// Determinism lint, in-memory: src/scene/lint-determinism.mjs
// exports RULES and blankComments. lintSceneText reuses both: the
// real rule set (same ids and regexes as the file lint; no file-skip
// lists, since a serialized scene has no filename, and lintDir on a
// scene file applies no skip either, since no scene filename is a
// harness or runtime file). A rule added or changed in
// lint-determinism.mjs is picked up here with no mirror to update;
// the tests pin the in-memory lint against the real v5 scene
// (0 hits both ways).
//
// Design: ~/workspace/handover-motion-fixer/design-first-principles.md
// (C5, rebuilt design, gate). This gate is what catches the unit A
// visible.out problem: the validator flags visible.out past duration
// as a KEY_RANGE error, so a scene with out 216 and duration 192
// fails the gate.
//
// Pure except runGate's write: diffScenes, checkDiff,
// validateNewScene, and lintSceneText never touch the disk and
// never mutate their inputs. runGate writes only on a full pass,
// and only to a path that does not already exist.
import { existsSync, writeFileSync } from "node:fs";
import { validateScene } from "../../scene/validate.mjs";
import { blankComments, RULES } from "../../scene/lint-determinism.mjs";

/**
 * Lint serialized scene text in memory, without writing a file.
 * Comments are blanked first (via the linter's own blankComments),
 * then each line is matched against the mirrored rule set.
 *
 * @param {string} text - serialized scene (e.g. JSON.stringify(scene))
 * @returns {{ file: string, line: number, rule: string, text: string }[]}
 *   hits; `file` is "<in-memory scene>" since no file exists.
 */
export function lintSceneText(text) {
  const original = String(text).split("\n");
  const cleaned = blankComments(original.join("\n")).split("\n");
  const hits = [];
  cleaned.forEach((line, idx) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({ file: "<in-memory scene>", line: idx + 1, rule: rule.id, text: original[idx].trim() });
      }
    }
  });
  return hits;
}

/**
 * Recursive JSON diff: dotted paths whose values differ between
 * old and new. Array indices use [i]; object keys use .key.
 * A path is listed once even when a whole subtree differs.
 *
 * @returns {string[]} changed paths, in first-seen order
 */
export function diffScenes(oldScene, newScene, prefix = "", out = []) {
  if (Object.is(oldScene, newScene)) return out;
  if (
    oldScene !== null && newScene !== null &&
    typeof oldScene === "object" && typeof newScene === "object" &&
    Array.isArray(oldScene) === Array.isArray(newScene)
  ) {
    const keys = new Set([...Object.keys(oldScene), ...Object.keys(newScene)]);
    for (const key of keys) {
      const child = Array.isArray(oldScene) ? `${prefix}[${key}]` : prefix ? `${prefix}.${key}` : key;
      diffScenes(oldScene[key], newScene[key], child, out);
    }
    return out;
  }
  out.push(prefix);
  return out;
}

/**
 * Diff check: only the intended paths may have changed.
 *
 * @param {object} oldScene
 * @param {object} newScene
 * @param {Set<string> | string[] | (path: string) => boolean} allowed
 *   the allowed changed-path set, or a predicate over changed paths.
 * @returns {{ pass: boolean, changedPaths: string[], unexpectedPaths: string[] }}
 */
export function checkDiff(oldScene, newScene, allowed) {
  const changedPaths = diffScenes(oldScene, newScene);
  const isAllowed = typeof allowed === "function"
    ? allowed
    : (p) => (allowed instanceof Set ? allowed.has(p) : Array.isArray(allowed) ? allowed.includes(p) : false);
  const unexpectedPaths = changedPaths.filter((p) => !isAllowed(p));
  return { pass: unexpectedPaths.length === 0, changedPaths, unexpectedPaths };
}

/**
 * In-memory validate check: schema plus cross-reference checks
 * (validateScene) and the determinism lint over the serialized
 * scene text. Warnings do not fail the check, matching
 * `hme validate` (PASS is 0 errors and 0 lint hits).
 *
 * @param {object} newScene - the candidate fixed scene (not mutated)
 * @returns {{ pass: boolean, errors: object[], warnings: object[], determinismHits: object[] }}
 */
export function validateNewScene(newScene) {
  const { errors, warnings } = validateScene(newScene);
  const determinismHits = lintSceneText(JSON.stringify(newScene, null, 2));
  return { pass: errors.length === 0 && determinismHits.length === 0, errors, warnings, determinismHits };
}

/**
 * Run both gate checks and write the file only when both pass.
 * Never overwrites an existing file; never writes on a failed gate.
 *
 * @param {object} args
 * @param {object} args.oldScene - the scene before the fix (not mutated)
 * @param {object} args.newScene - the candidate fixed scene (not mutated)
 * @param {Set<string> | string[] | (path: string) => boolean} args.allowed
 * @param {string} args.outPath - where to write the fixed scene
 * @returns {{ pass: boolean, diff: object, validation: object, outPath: string, written: boolean, reason?: string }}
 */
export function runGate({ oldScene, newScene, allowed, outPath }) {
  if (typeof outPath !== "string" || outPath.length === 0) {
    return { pass: false, diff: null, validation: null, outPath, written: false, reason: "gate refused: no out path was supplied" };
  }
  if (existsSync(outPath)) {
    return { pass: false, diff: null, validation: null, outPath, written: false, reason: `gate refused: ${outPath} already exists, will not overwrite` };
  }
  const diff = checkDiff(oldScene, newScene, allowed);
  if (!diff.pass) {
    return {
      pass: false, diff, validation: null, outPath, written: false,
      reason: `diff check failed: unexpected changed paths: ${diff.unexpectedPaths.join(", ")}`,
    };
  }
  const validation = validateNewScene(newScene);
  if (!validation.pass) {
    const first = validation.errors[0];
    const detail = first
      ? `${first.code} ${first.path} ${first.message}`
      : `determinism lint hit: ${validation.determinismHits[0].rule} at line ${validation.determinismHits[0].line}`;
    return {
      pass: false, diff, validation, outPath, written: false,
      reason: `validate check failed: ${detail}`,
    };
  }
  writeFileSync(outPath, `${JSON.stringify(newScene, null, 2)}\n`, "utf8");
  return { pass: true, diff, validation, outPath, written: true };
}
