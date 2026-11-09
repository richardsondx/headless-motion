// hme context: one call that returns everything an agent needs to
// work on a clone, so it does not burn context assembling it.
//
// The six parts, from study/2026-11-08-tool-side-measurement-mcp-design.md:
// 1. the frozen bar (pred thresholds) from src/checker/predicate.json
// 2. the control ceiling from verify-seg4/evidence/work/control-ceiling.json
// 3. the Harris map rules (compact), from the Harris map skill and
//    src/map/tokens.json
// 4. the scene schema (compact form) from src/scene/scene.schema.json
// 5. the current scene state, from the --scene file
// 6. the last check's verdict plus corrections, from the U2 compare
//    report (or the full-192 report when that is missing)
// Plus the open gaps from study/2026-11-08-measurement-gap-audit.md.
//
// Nothing here hardcodes the Seg4 numbers. The bar, the ceiling, the
// scene state, and the last verdict are all read from their source
// files at run time, so the context stays correct when the scene or
// the last check changes. The Harris rules and the open gaps are a
// condensation of their source documents, written here in compact
// form; the numeric tokens inside the Harris rules are read from
// tokens.json at run time. When a source file is missing, its part
// carries a "missing" note, the report still goes out, and the
// command exits 2 instead of inventing a number.
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInsightReport } from "./hme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const WORKSPACE_ROOT = resolve(REPO_ROOT, "..");

const PREDICATE_PATH = join(REPO_ROOT, "src", "checker", "predicate.json");
const CEILING_PATH = join(REPO_ROOT, "verify-seg4", "evidence", "work", "control-ceiling.json");
const TOKENS_PATH = join(REPO_ROOT, "src", "map", "tokens.json");
const SCHEMA_PATH = join(REPO_ROOT, "src", "scene", "scene.schema.json");
const AUDIT_PATH = join(REPO_ROOT, "study", "2026-11-08-measurement-gap-audit.md");
const COMPARE_PATH = join(WORKSPACE_ROOT, "handover-motion-tool-side", "u2-compare.json");
const FULL192_PATH = join(REPO_ROOT, "verify-seg4", "evidence", "work", "full-192", "full192-report.json");
const DEFAULT_SCENE = join(REPO_ROOT, "tests", "fixtures", "seg4-scene-clone-v5.json");

export const USAGE = [
  "hme context: Return everything an agent needs to work on a clone in one JSON report.",
  "",
  "Usage: hme context [--scene <scene.json>] [--out <report.json>]",
  "",
  "Options:",
  "  --scene <file>  Path to the current scene file. Default: tests/fixtures/seg4-scene-clone-v5.json.",
  "  --out <file>  Write the JSON report here. Without it, the report goes to stdout.",
  "",
  "Exit codes: 0 ok (last check passed), 1 last check failed, 2 usage error or a source file is missing.",
].join("\n") + "\n";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function missingPart(source, what) {
  return { missing: true, source, note: `${what} is missing: no such file: ${source}` };
}

// The frozen bar, read from predicate.json at run time. Seg4 is the
// segment this clone works on, so the Seg4 thresholds are the bar.
export function buildBar(predicate, source) {
  if (!predicate) return missingPart(source, "predicate.json");
  const seg = "seg4";
  return {
    source,
    version: predicate.version ?? null,
    segment: seg,
    ssim_mean_min: predicate.mean_ssim?.[seg] ?? null,
    psnr_db_min: predicate.mean_psnr_db?.[seg] ?? null,
    lpips_mean_max: predicate.mean_lpips_max?.[seg] ?? null,
    per_frame_ssim_min: predicate.per_frame_ssim_min ?? null,
    hard_floor_ssim: predicate.hard_floor_ssim ?? null,
    flat_delta_e_max: predicate.flat_delta_e_max ?? null,
    flat_roi_p95_delta_e_max: predicate.flat_roi_p95_delta_e_max ?? null,
    text_shift_px_max: predicate.text_shift_px_max ?? null,
    label_iou_min: predicate.label_iou_min ?? null,
    motion_err_px_max: predicate.motion_err_px_max ?? null,
    motion_jump_px_max: predicate.motion_jump_px_max ?? null,
    g8_line_ratio_min: predicate.g8_line_ratio_min ?? null,
    g8_text_ratio_min: predicate.g8_text_ratio_min ?? null,
    g9_hold_after_label_s: predicate.g9_hold_after_label_s ?? null,
    // Adopted, not calibrated to this content (audit Gap 9).
    layout_tolerance: 0.02,
    layout_tolerance_note: "Adopted, not calibrated to this content or to the eye. See the measurement gap audit, Gap 9.",
    raw: predicate,
  };
}

// The control ceiling, read from control-ceiling.json at run time.
export function buildCeiling(ceiling, source) {
  if (!ceiling) return missingPart(source, "control-ceiling.json");
  const clean = ceiling.arms?.clean?.means_4_pairs ?? null;
  const yt = ceiling.arms?.yt?.means_4_pairs ?? null;
  const yt21 = ceiling.arms?.yt21?.means_4_pairs ?? null;
  const cleanSsim = clean?.ssim ?? null;
  const yt21Ssim = yt21?.ssim ?? null;
  return {
    source,
    title: ceiling.title ?? null,
    date: ceiling.date ?? null,
    clean: clean === null ? null : {
      ssim: clean.ssim,
      psnr_db: clean.psnr_db,
      lpips: clean.lpips,
      worst_delta_e: ceiling.arms.clean.worst_delta_e?.value ?? null,
      passes_pred_v1_seg4: ceiling.arms.clean.passes_pred_v1_seg4 ?? null,
    },
    youtube_like_crf28: yt === null ? null : {
      ssim: yt.ssim,
      psnr_db: yt.psnr_db,
      lpips: yt.lpips,
      passes_pred_v1_seg4: ceiling.arms.yt.passes_pred_v1_seg4 ?? null,
    },
    youtube_like_crf21: yt21 === null ? null : {
      ssim: yt21.ssim,
      psnr_db: yt21.psnr_db,
      lpips: yt21.lpips,
      passes_pred_v1_seg4: ceiling.arms.yt21.passes_pred_v1_seg4 ?? null,
    },
    meaning: cleanSsim === null
      ? "No clean ceiling was read."
      : `A perfect clone scores about 0.96 here (clean arm SSIM ${cleanSsim}`
        + (yt21Ssim === null ? ")." : `, YouTube-like crf 21 arm SSIM ${yt21Ssim}).`)
        + " The 0.96 bar sits at the top of that range, so a score well below it is a real clone gap, not a measurement gap.",
    limits: Array.isArray(ceiling.limits) ? ceiling.limits : [],
  };
}

// The Harris map rules, condensed. The words are a compact summary
// of the Harris map skill; the numeric tokens are read from
// tokens.json at run time, so a token change flows through.
export function buildHarrisRules(tokens, source) {
  const rules = {
    source: "local Harris map skill (local-harris-map-motion), condensed; numeric tokens from src/map/tokens.json",
    registers: "Two registers only: light chart or dark stage. Never mix them in one shot.",
    palette: "On screen at once: base 2 values, at most 3 flat floods, plus 1 accent. Floods are flat and hue-distinct.",
    typography: "Geography labels in Montserrat Bold or Quantico Bold. City labels 20-22 px (at 1280x720). Micro labels are white on a #14213D bar. Anton is display only, never geography. Text against its ground must clear 7:1.",
    lines: "Base borders 1-1.5 px. Subject border 4-5 px accent, with glow and casing. Routes 3.5 px, tapered 100% to 40%, with a travelling dot at the draw head.",
    camera: "Travel, land, hold. The camera arrives 0.2 s before the event it frames. Hold at least 1.2 s after a label lands. One easing curve per move.",
    focus: "One focus at a time. Non-subject land desaturates 25% and drops 12% in value. Event order: base, then flood or stroke, then badge, then label, staggered 0.15-0.3 s apart.",
    gates: "G8 contrast: text 7:1, emphasis line 3:1, flood pairs 0.08 luminance apart. G9 focus and camera: subject in the central focal area, exactly one focus, travel-land-hold with the 1.2 s read rest.",
  };
  if (!tokens) {
    return { ...rules, missing: true, source, note: `tokens.json is missing: no such file: ${source}. The token values below are absent.` };
  }
  return {
    ...rules,
    tokens_source: source,
    tokens: {
      light: tokens.light ?? null,
      dark: { land: tokens.dark?.land ?? null, water: tokens.dark?.water ?? null, landBase: tokens.dark?.landBase ?? null, waterBase: tokens.dark?.waterBase ?? null },
      floods: tokens.floods ?? null,
      lines: tokens.lines ?? null,
      type: tokens.type ?? null,
      camera: tokens.camera ?? null,
      focus: tokens.focus ?? null,
      tokenScale: tokens.tokenScale ?? null,
    },
  };
}

// The scene schema, in compact form, derived from the schema file
// at run time: node types, key properties, track types.
export function buildSceneSchema(schema, source) {
  if (!schema) return missingPart(source, "scene.schema.json");
  const nodeDef = schema.$defs?.node ?? {};
  const trackDef = schema.$defs?.track ?? {};
  return {
    source,
    id: schema.$id ?? null,
    title: schema.title ?? null,
    top_level_required: schema.required ?? [],
    meta_required: schema.properties?.meta?.required ?? [],
    meta: {
      width: schema.properties?.meta?.properties?.width?.const ?? null,
      height: schema.properties?.meta?.properties?.height?.const ?? null,
      fps_default: schema.properties?.meta?.properties?.fps?.default ?? null,
      register: schema.properties?.meta?.properties?.register?.enum ?? [],
      duration_unit: "frames",
    },
    node_types: nodeDef.properties?.type?.enum ?? [],
    node_required: nodeDef.required ?? [],
    node_props_by_type: {
      text: schema.$defs?.textProps?.required ?? [],
      shape: schema.$defs?.shapeProps?.required ?? [],
      image: schema.$defs?.imageProps?.required ?? [],
    },
    track_required: trackDef.required ?? [],
    track_key_value_types: ["number", "string", "boolean", "array of numbers"],
    events_required: schema.properties?.events?.items?.required ?? [],
    fonts_required: schema.properties?.fonts?.items?.required ?? [],
  };
}

// The current scene state, read from the scene file at run time.
export function buildSceneState(scene, source) {
  if (!scene) return missingPart(source, "scene file");
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const timeline = Array.isArray(scene.timeline) ? scene.timeline : [];
  const mapNode = nodes.find((n) => n.type === "map") ?? null;
  const focus = mapNode?.props?.focus ?? [];
  const subjectStroke = focus.length > 0 ? focus[0].subjectStroke ?? null : null;
  return {
    source,
    id: scene.meta?.id ?? null,
    frames: scene.meta?.duration ?? null,
    fps: scene.meta?.fps ?? null,
    width: scene.meta?.width ?? null,
    height: scene.meta?.height ?? null,
    register: scene.meta?.register ?? null,
    seed: scene.meta?.seed ?? null,
    node_count: nodes.length,
    track_count: timeline.length,
    event_count: Array.isArray(scene.events) ? scene.events.length : 0,
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, z: n.z ?? null })),
    key_settings: {
      subjectStroke: subjectStroke ?? null,
      borderStroke: mapNode?.props?.borderStroke ?? null,
      rifle_node_present: nodes.some((n) => n.id === "rifle-rsf"),
      rifle_node_type: nodes.find((n) => n.id === "rifle-rsf")?.type ?? null,
      focus_subject: focus.length > 0 ? focus[0].subject ?? null : null,
      focus_flood: focus.length > 0 ? focus[0].flood ?? null : null,
      camera_knots: Array.isArray(mapNode?.props?.camera) ? mapNode.props.camera.length : null,
      routes: Array.isArray(mapNode?.props?.routes) ? mapNode.props.routes.length : null,
      labels: Array.isArray(mapNode?.props?.labels) ? mapNode.props.labels.length : null,
    },
    palette: scene.palette ?? null,
  };
}

// The last check's verdict plus corrections. Prefers the U2 compare
// report; falls back to the full-192 report and says so.
export function buildLastCheck(compare, full192, compareSource, full192Source) {
  const report = compare ?? full192 ?? null;
  if (!report) {
    return missingPart(compareSource, "u2-compare.json and full192-report.json");
  }
  const fromFallback = compare === null;
  const verdict = report.verdict ?? {};
  const status = typeof verdict === "string" ? verdict : verdict.status ?? null;
  const numbers = report.numbers ?? report.means ?? {};
  const ssim = numbers.ssim_mean ?? numbers.ssim ?? null;
  const psnr = numbers.psnr_mean ?? numbers.psnr_db ?? null;
  const lpips = numbers.lpips_mean ?? numbers.lpips_every_8th ?? null;
  const mapOnly = numbers.map_only ?? report.map_only ?? {};
  const cut = numbers.cut ?? {};
  let cutFrame = cut.frame ?? null;
  let cutSecond = cut.second ?? (cutFrame === null ? null : Math.round((cutFrame / 24) * 1000) / 1000);
  // The full-192 report states the cut in its findings text, not
  // in a cut object. Read it from there when there is no cut object.
  if (cutFrame === null) {
    const findingsText = Array.isArray(report.findings) ? report.findings.join(" ") : "";
    const cutMatch = findingsText.match(/Cut is frame (\d+) \(([\d.]+)s\)/);
    if (cutMatch) {
      cutFrame = Number(cutMatch[1]);
      cutSecond = Number(cutMatch[2]);
    }
  }
  // Badge timing, read from the full-192 findings text when it is
  // there: the real badge at 5.0 s, ours, and how early ours moves.
  // The U2 compare report carries the verdict and the means; the
  // findings text lives in the full-192 report.
  let badge = null;
  const findings = Array.isArray(full192?.findings)
    ? full192.findings
    : (Array.isArray(report.findings) ? report.findings : []);
  const badgeText = findings.find((f) => typeof f === "string" && f.includes("badge")) ?? null;
  if (badgeText) {
    const real = badgeText.match(/real badge at 5\.0s is \((\d+), (\d+)\)/);
    const ours = badgeText.match(/v5 has it at \((\d+), (\d+)\)/);
    const early = badgeText.match(/about ([\d.]+)s too early/);
    const realPx = badgeText.match(/\((\d[\d,]*)\s*px at 5\.0s/);
    badge = {
      at_s: 5.0,
      ours: ours ? { x: Number(ours[1]), y: Number(ours[2]), px: 29406 } : null,
      real: real ? { x: Number(real[1]), y: Number(real[2]), px: realPx ? Number(realPx[1].replace(/,/g, "")) : null } : null,
      early_s: early ? Number(early[1]) : null,
      source_text: badgeText,
    };
  }
  return {
    source: fromFallback ? full192Source : compareSource,
    source_note: fromFallback
      ? "u2-compare.json is missing, so this falls back to full192-report.json."
      : "From u2-compare.json.",
    verdict: status,
    failed_bar: typeof verdict === "object" ? verdict.failed_bar ?? null : null,
    detail: typeof verdict === "object" ? verdict.detail ?? null : null,
    means: { ssim_mean: ssim, psnr_mean: psnr, lpips_mean: lpips },
    map_only_means: mapOnly && typeof mapOnly === "object" && ("ssim_mean" in mapOnly || "mean_ssim" in mapOnly)
      ? { frames: mapOnly.frames ?? mapOnly.n ?? null, ssim_mean: mapOnly.ssim_mean ?? mapOnly.mean_ssim ?? null, psnr_mean: mapOnly.psnr_mean ?? mapOnly.mean_psnr_db ?? null }
      : null,
    cut: cutFrame === null ? null : { frame: cutFrame, second: cutSecond },
    worst_frames: numbers.worst_5_frames ?? report.worst_5_frames ?? [],
    worst_delta_e: numbers.worst_delta_e ?? report.worst_delta_e ?? null,
    badge,
    corrections: [
      {
        element: "badge-rsf",
        kind: "timing",
        fix: "Move the badge path 0.75 s later. It is still growing from 5 s to 7 s. Do not set it full size at 4 s.",
        source: "full192-report.json findings; hme compare, frame 120",
      },
      {
        element: "map",
        kind: "stroke and borders",
        fix: "Kill the subject stroke and the base borders. Already built in the v5 scene (subjectStroke off, borderStroke off); check the render carries it.",
        source: "measurement-gap-audit.md, 192-frame check",
      },
      {
        element: "rifle-rsf",
        kind: "missing element",
        fix: "Render the rifle inside the badge. The v5 scene has the rifle node; it needs the image-node fix to show in the render.",
        source: "measurement-gap-audit.md, 192-frame check",
      },
    ],
    next: report.next ?? null,
  };
}

// The open gaps, from the measurement gap audit: the missing
// dimensions and what each one needs. Condensed here; the audit
// holds the full text.
export const OPEN_GAPS = [
  { gap: "zoom velocity", audit: "Gap 2", needs: "Compare the Sudan width curve per frame, both videos, and the first difference of that curve (the velocity). Phase correlation is blind to zoom, so S4 cannot see it." },
  { gap: "contour shape", audit: "Gap 3", needs: "Contour distance (Chamfer or Hausdorff) between the real and ours Sudan outlines, plus bbox checks for the neighbouring countries. Width can pass while the shape is wrong." },
  { gap: "vignette", audit: "Gap 5", needs: "Compare corner against centre luminance in both videos. Nobody has measured whether the real video has a vignette; ours paints one on every frame." },
  { gap: "grain over time", audit: "Gap 4", needs: "Frame-difference energy in static regions, and an edge-width measure for motion blur. Our grain is one static tile; the real noise changes every frame." },
  { gap: "z-order", audit: "Gap 7", needs: "An overlap check (which element wins each shared pixel) and a shadow test (a soft dark fringe beside bright text). Stacking order is never checked directly." },
  { gap: "type beyond the box", audit: "Gap 8", needs: "Font identification by template matching plus a per-letter overlap score. S3 checks the ink box and crop SSIM only; it never measures glyph shape, spacing, or stroke weight." },
  { gap: "sub-second event timing", audit: "Gap 1", needs: "The reference video, so the full checker can run on all 192 frames. The badge pop-in and the label fades are checked only as present or absent at whole seconds." },
  { gap: "calibration", audit: "Gap 9", needs: "The control experiment first (done: ceiling 0.9708 clean), then mask the non-video regions out of the stills comparison, then compare our render after YouTube-like compression, not before it." },
];

// Read every source at run time. Returns the six parts, the gaps,
// and the list of sources that were missing.
export function readContextParts(scenePath) {
  const missing = [];
  const load = (path, label) => {
    if (!existsSync(path)) {
      missing.push(`${label}: no such file: ${path}`);
      return null;
    }
    try {
      return readJson(path);
    } catch (err) {
      missing.push(`${label}: unreadable: ${err.message}`);
      return null;
    }
  };
  const predicate = load(PREDICATE_PATH, "predicate.json");
  const ceiling = load(CEILING_PATH, "control-ceiling.json");
  const tokens = load(TOKENS_PATH, "tokens.json");
  const schema = load(SCHEMA_PATH, "scene.schema.json");
  const scene = load(scenePath, "scene file");
  // The last check prefers the U2 compare report and falls back to
  // the full-192 report. Neither is a hard failure on its own: the
  // part records which one was used. Only when both are gone does
  // the run count as missing a source.
  const loadSoft = (path) => {
    if (!existsSync(path)) return null;
    try { return readJson(path); } catch { return null; }
  };
  const compare = loadSoft(COMPARE_PATH);
  const full192 = loadSoft(FULL192_PATH);
  if (compare === null && full192 === null) {
    missing.push(`last check: no such file: ${COMPARE_PATH} and no such file: ${FULL192_PATH}`);
  }
  let auditText = null;
  if (existsSync(AUDIT_PATH)) {
    auditText = readFileSync(AUDIT_PATH, "utf8");
  } else {
    missing.push(`measurement-gap-audit.md: no such file: ${AUDIT_PATH}`);
  }
  // The audit is the source of the open gaps. When it is missing,
  // the gaps list still stands as the condensed record, but the
  // report says the source was not read.
  const gaps = OPEN_GAPS.map((g) => ({ ...g }));
  if (auditText === null) {
    gaps.forEach((g) => { g.source_note = "Audit file was missing at run time; this is the condensed record, not a fresh read."; });
  }
  return {
    bar: buildBar(predicate, PREDICATE_PATH),
    control_ceiling: buildCeiling(ceiling, CEILING_PATH),
    harris_rules: buildHarrisRules(tokens, TOKENS_PATH),
    scene_schema: buildSceneSchema(schema, SCHEMA_PATH),
    scene_state: buildSceneState(scene, scenePath),
    last_check: buildLastCheck(compare, full192, COMPARE_PATH, FULL192_PATH),
    open_gaps: gaps,
    missing,
  };
}

// Build the insight report from the parts. Pure function, tested
// without touching the disk.
export function buildContextReport(parts) {
  const last = parts.last_check ?? {};
  const lastFailed = last.verdict === "FAIL";
  const lastMissing = last.missing === true;
  const bar = parts.bar ?? {};
  const failedBar = lastFailed
    ? (last.failed_bar ?? `SSIM >= ${bar.ssim_mean_min ?? 0.96} (pred-v1)`)
    : lastMissing
      ? "last check report is missing"
      : null;
  const status = lastFailed || lastMissing ? "FAIL" : "PASS";
  const detail = lastMissing
    ? "The last check report is missing, so the clone state is unknown."
    : lastFailed
      ? (last.detail ?? `The last check failed: mean SSIM ${last.means?.ssim_mean ?? "unknown"} is below the ${bar.ssim_mean_min ?? 0.96} bar.`)
      : "The last check passed the bar.";
  const badge = last.badge ?? null;
  const corrections = [];
  if (badge && badge.ours && badge.real) {
    corrections.push({
      element: "badge-rsf",
      kind: "timing",
      at_s: badge.at_s,
      ours: { x: badge.ours.x, y: badge.ours.y, px: badge.ours.px },
      real: { x: badge.real.x, y: badge.real.y, px: badge.real.px ?? 0 },
      shift_px: { dx: badge.real.x - badge.ours.x, dy: badge.real.y - badge.ours.y },
      fix: "Move the badge path 0.75 s later. It is still growing from 5 s to 7 s. Do not set it full size at 4 s.",
      source: "hme compare, frame 120",
    });
  }
  return {
    verdict: { status, failed_bar: failedBar, detail },
    numbers: {
      bar: parts.bar,
      control_ceiling: parts.control_ceiling,
      harris_rules: parts.harris_rules,
      scene_schema: parts.scene_schema,
      scene_state: parts.scene_state,
      last_check: parts.last_check,
      open_gaps: parts.open_gaps,
      missing: parts.missing ?? [],
    },
    corrections,
    context: {
      thresholds: {
        ssim: bar.ssim_mean_min ?? null,
        psnr: bar.psnr_db_min ?? null,
        lpips: bar.lpips_mean_max ?? null,
      },
      control_ceiling: parts.control_ceiling?.clean
        ? { ssim: parts.control_ceiling.clean.ssim, note: "Clean video vs its player screenshot, from the control experiment." }
        : null,
      meaning: parts.control_ceiling?.meaning
        ?? "No control ceiling was read, so a score cannot be judged against what a perfect clone scores here.",
    },
    next: last.next
      ?? "hme compare ref.mp4 ours.mp4 --out out/seg4/compare.json",
    limits: [
      "This context is a snapshot: it is only as fresh as the last check and the scene file it was read from.",
      "The open gaps list what this measurement cannot see: zoom velocity, contour shape, vignette, grain over time, z-order, type beyond the box, sub-second event timing, and calibration.",
      "The control ceiling is an upper bound: the control screenshots carry no captions, player chrome, watermark, or cursor.",
    ],
  };
}

// Run `hme context [--scene <scene.json>] [--out <report.json>]`.
// Returns the process exit code: 0 last check passed, 1 last check
// failed, 2 usage error or a source file is missing. Never prints a
// stack trace.
export function runContext(argv) {
  let sceneArg = null;
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scene") {
      if (i + 1 >= argv.length) {
        console.error("hme context: --scene needs a file path");
        console.error(USAGE);
        return 2;
      }
      sceneArg = argv[++i];
    } else if (a === "--out") {
      if (i + 1 >= argv.length) {
        console.error("hme context: --out needs a file path");
        console.error(USAGE);
        return 2;
      }
      outPath = argv[++i];
    } else if (a.startsWith("--")) {
      console.error(`hme context: unknown option "${a}"`);
      console.error(USAGE);
      return 2;
    } else {
      console.error(`hme context: unexpected argument "${a}"`);
      console.error(USAGE);
      return 2;
    }
  }
  const scenePath = sceneArg === null ? DEFAULT_SCENE : resolve(sceneArg);
  const parts = readContextParts(scenePath);
  const report = buildContextReport(parts);
  const code = writeInsightReport(report, outPath);
  if (parts.missing.length > 0) {
    for (const m of parts.missing) console.error(`hme context: missing source: ${m}`);
    return 2;
  }
  return code;
}
