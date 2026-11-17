// Watch state: the file channel between the renderer and the
// optional preview server (`hme render --watch`).
//
// The renderer and the server are separate processes, so progress
// travels through two files in the render directory:
//   latest.png  the most recently captured frame
//   watch.json  {status, frame, frames_total, frames_captured}
// status is starting, rendering, done, or failed. There is no wall
// clock in watch.json: it is progress, not evidence, and the render
// report must stay byte-identical across runs.
//
// Every write here is best effort and never throws: a watch write
// must never fail a render. Writes go to a temp file first, then
// rename, so a reader never sees a half-written PNG or JSON file.
import { writeFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const WATCH_STATE_FILE = "watch.json";
export const WATCH_FRAME_FILE = "latest.png";

export function defaultWatchState() {
  return { status: "starting", frame: 0, frames_total: null, frames_captured: 0 };
}

// Write watch.json, best effort. Never throws.
export function writeWatchState(outDir, state) {
  try {
    const dir = resolve(outDir);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${WATCH_STATE_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(state) + "\n");
    renameSync(tmp, join(dir, WATCH_STATE_FILE));
  } catch {
    // Best effort only: the render goes on without a preview.
  }
}

// Write latest.png and watch.json together, best effort. The PNG
// lands first, then the state that names its frame, so a reader
// never sees a state that points at a frame not yet written.
export function writeWatchFrame(outDir, png, state) {
  try {
    const dir = resolve(outDir);
    mkdirSync(dir, { recursive: true });
    const tmpPng = join(dir, `.${WATCH_FRAME_FILE}.tmp`);
    writeFileSync(tmpPng, png);
    renameSync(tmpPng, join(dir, WATCH_FRAME_FILE));
  } catch {
    // Best effort only: the render goes on without a preview.
  }
  writeWatchState(outDir, state);
}

// Read watch.json, best effort. Returns the starting state when
// the file is missing or unreadable.
export function readWatchState(outDir) {
  try {
    const raw = JSON.parse(readFileSync(join(resolve(outDir), WATCH_STATE_FILE), "utf8"));
    if (raw && typeof raw === "object" && typeof raw.status === "string") {
      return {
        status: raw.status,
        frame: typeof raw.frame === "number" ? raw.frame : 0,
        frames_total: typeof raw.frames_total === "number" ? raw.frames_total : null,
        frames_captured: typeof raw.frames_captured === "number" ? raw.frames_captured : 0,
      };
    }
  } catch {
    // Missing or unreadable state means the render has not started.
  }
  return defaultWatchState();
}
