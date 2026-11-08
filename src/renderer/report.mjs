// Writes render-report.json on success and on failure. No timestamps in
// the JSON body are added here; callers put the time in report.md only, so
// two runs on the same inputs give byte-identical report.json.
import { resolve } from "node:path";
import { writeFileRetry, mkdirRetry } from "./retry.mjs";

export function writeReport(outDir, report) {
  mkdirRetry(resolve(outDir), { recursive: true });
  writeFileRetry(resolve(outDir, "render-report.json"), JSON.stringify(report, null, 2) + "\n");
  return resolve(outDir, "render-report.json");
}

export function baseReport({ profile, sceneSha256, versions, stage = "validate", code = null, status = "failed", frame = null, message = "" }) {
  return {
    status,
    stage,
    code,
    frame,
    message,
    profile,
    scene_sha256: sceneSha256,
    versions,
    console_errors: [],
    blocked_requests: [],
    ffmpeg_stderr_tail: [],
    ffmpeg_command: [],
    frames_captured: 0,
    elapsed_s: 0,
    capture_workers: 1,
    ffmpeg_threads: "1",
    overrides: [],
    eperm_retries: 0,
  };
}
