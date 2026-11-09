// hme fonts: identify the font in a frame by template matching.
//
// The matching engine is Python (src/checker/font.py), so this module
// spawns the engine venv Python, like compare.mjs does. Nothing here
// reimplements the matcher in JavaScript. Nothing is hardcoded to a
// video, a segment, or a frame count: the frame and the words come from
// the arguments, and the label box is found from the frame itself when
// --box is absent.
//
// Method, from study/2026-11-08-whatthefont-reverse-engineering.md:
// crop the label, render the same string in each candidate Google Fonts
// face at the measured cap height, normalize spacing and scale per word,
// score with grey normalized cross-correlation, rank the top 5. The
// match bar is a best score of at least 0.85 with a margin of at least
// 0.10 over second place. Below the bar the report says plainly that the
// answer is the closest lookalike, not a confirmed match.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");

export const BAR = { score: 0.85, margin: 0.1 };

export const USAGE = [
  "hme fonts: Identify the font in a frame by matching against Google Fonts.",
  "",
  "Usage: hme fonts <frame.png> --text <words> [--out <report.json>]",
  "",
  "Arguments:",
  "  <frame.png>  Path to the frame image.",
  "",
  "Options:",
  "  --text <words>  The words shown in the frame, for example \"EL FASHER\". Required.",
  "  --box <x,y,w,h>  Search rectangle for the label. Without it, the label line is found from the frame.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Exit codes: 0 ok or PASS, 1 FAIL, 2 usage error.",
].join("\n") + "\n";

// Parse "x,y,w,h" into [x, y, w, h], or null when the text is not four
// integers. Pure function, tested without any frame.
export function parseBox(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n))) return null;
  return nums;
}

// Build the insight report from the engine output. Pure function,
// tested without any frame.
export function buildInsightReport(measured) {
  const top = measured.ranking ?? [];
  const best = top[0] ?? null;
  const passes = measured.passes_bar === true;
  const failedBar = passes
    ? null
    : `best score >= ${BAR.score} with margin >= ${BAR.margin} (font match bar)`;
  const detail = best === null
    ? "No candidate font scored."
    : passes
      ? `Best match ${best.family} ${best.weight} scores ${measured.best_score}, ${measured.margin} clear of second place.`
      : `Best match ${best.family} ${best.weight} scores ${measured.best_score}, only ${measured.margin} clear of second place, below the ${BAR.score} bar. This is the closest lookalike, not a confirmed match.`;
  const topLines = top.map((e) => `${e.family} ${e.weight}: ${e.score}`).join("; ");
  return {
    verdict: { status: passes ? "PASS" : "FAIL", failed_bar: failedBar, detail },
    numbers: {
      frame: measured.frame,
      text: measured.text,
      box: measured.box,
      cap_height_px: measured.cap_height_px,
      candidates_scored: measured.candidates_scored,
      candidates_in_library: measured.candidates_in_library,
      cache_dir: measured.cache_dir,
      ranking: top.map((e) => ({
        family: e.family,
        weight: e.weight,
        score: e.score,
        dice: e.dice ?? null,
        note: e.note ?? "",
      })),
      best_score: measured.best_score,
      second_score: measured.second_score,
      margin: measured.margin,
      match_bar: measured.match_bar,
      passes_bar: measured.passes_bar,
      verdict_words: measured.verdict,
      weight_width: measured.weight_width ?? null,
      method: measured.method ?? "",
    },
    corrections: [],
    context: {
      thresholds: { score: BAR.score, margin: BAR.margin },
      control_ceiling: null,
      meaning: best === null
        ? "No font could be matched in this frame."
        : passes
          ? `The label reads as ${best.family} ${best.weight} (score ${measured.best_score}). Top 5: ${topLines}.`
          : `The closest lookalike is ${best.family} ${best.weight} (score ${measured.best_score}), not a confirmed match. Top 5: ${topLines}. The label is a condensed sans, not Anton.`,
    },
    next: best === null
      ? "hme fonts <frame.png> --text \"<words>\" --box <x,y,w,h>"
      : `Swap the "${measured.text}" label font to ${best.family} ${best.weight}, re-render the scene, then run hme compare on the new video.`,
    limits: measured.limits ?? [
      "Template matching can only name fonts already in the library.",
    ],
  };
}

function runEngine(framePath, text, box) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ["-m", "checker.font", "--frame", framePath, "--text", text];
    if (box) args.push("--box", box.join(","));
    const child = spawn(VENV_PYTHON, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: join(REPO_ROOT, "src") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", (err) => rejectPromise(new Error(`could not start ${VENV_PYTHON}: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        rejectPromise(new Error(`font matching failed (exit ${code}):\n${tail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`font matching returned bad JSON:\n${stdout.slice(-500)}`));
      }
    });
  });
}

// Run `hme fonts <frame.png> --text <words> [--box x,y,w,h] [--out <report.json>]`.
// Returns the process exit code: 0 PASS, 1 FAIL, 2 usage or run error.
// Never prints a stack trace.
export async function runFonts(argv) {
  const positionals = [];
  let outPath = null;
  let text = null;
  let box = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme fonts: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a === "--text") {
      if (i + 1 >= argv.length) {
        console.error("hme fonts: --text needs the words shown in the frame");
        console.error(USAGE);
        return 2;
      }
      text = argv[++i];
    } else if (a === "--box") {
      if (i + 1 >= argv.length) {
        console.error("hme fonts: --box needs x,y,w,h");
        console.error(USAGE);
        return 2;
      }
      const parsed = parseBox(argv[++i]);
      if (parsed === null) {
        console.error("hme fonts: --box needs four integers, x,y,w,h");
        console.error(USAGE);
        return 2;
      }
      box = parsed;
    } else if (a.startsWith("--")) {
      console.error(`hme fonts: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    console.error("hme fonts: needs one frame, <frame.png>");
    console.error(USAGE);
    return 2;
  }
  if (text === null || text.trim() === "") {
    console.error("hme fonts: --text is required, for example --text \"EL FASHER\"");
    console.error(USAGE);
    return 2;
  }
  const framePath = resolve(positionals[0]);
  if (!existsSync(framePath)) {
    console.error(`hme fonts: no such file: ${positionals[0]}`);
    return 2;
  }
  if (!existsSync(VENV_PYTHON)) {
    console.error(`hme fonts: engine venv Python is missing: ${VENV_PYTHON}`);
    return 2;
  }
  try {
    const measured = await runEngine(framePath, text, box);
    const report = buildInsightReport(measured);
    return writeInsightReport(report, outPath);
  } catch (err) {
    console.error(`hme fonts: ${err.message}`);
    return 2;
  }
}
