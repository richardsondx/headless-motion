// Retry for the VM write gate (2026-11-07): regular-file writes from any
// process fail with EPERM, operation not permitted, for seconds to minutes
// at a time, then start working again, with no change in permissions,
// disk space, or ownership. Reads work, pipe writes work, the file tools
// work, only exec-process writes to regular files are gated, on every
// filesystem at once (overlay, tmpfs, /dev/shm, btrfs). The gate flips
// on its own; nothing inside the sandbox can turn it off. So every file
// write in the renderer retries on EPERM until the gate opens, instead
// of failing the whole render on the first blocked write.
//
// Policy: one attempt per second, up to 10 attempts (about 10 seconds)
// per write. That rides out a brief flip of the gate. It is deliberately
// SHORT: a process that starts blocked stays blocked for its whole life
// (proven 2026-11-07: a render retried page.html for 10 minutes and
// never wrote a byte, while fresh processes wrote fine in the same
// minutes), so a long in-process retry only burns time. The real retry
// is at the process level, in cli.mjs: a gate failure spawns a fresh
// process, which gets a fresh gate assignment. A write that still fails
// after that throws the last error, unchanged, so a real permission
// problem still surfaces.
// No wall clock here: prompt 01 bans the clock in src/, and the retry
// count is the only timing evidence we need.
import { writeFileSync, mkdirSync } from "node:fs";

export const RETRY_MAX = 10;
export const RETRY_DELAY_MS = 1000;

let retryCount = 0;
export function takeRetryCount() {
  const n = retryCount;
  retryCount = 0;
  return n;
}

export function isTransientWriteError(e) {
  return e && (e.code === "EPERM" || e.code === "EACCES" || e.code === "EIO");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function writeFileRetry(path, data, options) {
  let last;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      writeFileSync(path, data, options);
      return;
    } catch (e) {
      last = e;
      if (!isTransientWriteError(e) || attempt === RETRY_MAX) throw e;
      retryCount++;
      sleepSync(RETRY_DELAY_MS);
    }
  }
  throw last;
}

export function mkdirRetry(path, options) {
  let last;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      mkdirSync(path, options);
      return;
    } catch (e) {
      last = e;
      if (!isTransientWriteError(e) || attempt === RETRY_MAX) throw e;
      retryCount++;
      sleepSync(RETRY_DELAY_MS);
    }
  }
  throw last;
}

export async function writeFileRetryAsync(path, data, options) {
  let last;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      writeFileSync(path, data, options);
      return;
    } catch (e) {
      last = e;
      if (!isTransientWriteError(e) || attempt === RETRY_MAX) throw e;
      retryCount++;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw last;
}

export async function mkdirRetryAsync(path, options) {
  let last;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      mkdirSync(path, options);
      return;
    } catch (e) {
      last = e;
      if (!isTransientWriteError(e) || attempt === RETRY_MAX) throw e;
      retryCount++;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw last;
}
