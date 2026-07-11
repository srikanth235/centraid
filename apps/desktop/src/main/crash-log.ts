/*
 * Crash capture (issue #351) — electron wiring around the pure core in
 * crash-log-core.ts.
 *
 * Before this module, main.ts had no `uncaughtException`/`unhandledRejection`
 * handlers at all: an unexpected error in a background timer, IPC handler,
 * or promise chain would either crash the whole desktop app (dropping
 * SQLite state without the graceful WAL-checkpoint quit path ever running)
 * or, for an unhandled rejection, just vanish depending on the Node
 * version's default. Neither leaves a post-mortem trail.
 *
 * The posture here is deliberate: log + persist + CONTINUE, never
 * `process.exit()`. A desktop shell has long-lived background work
 * (gateway monitor, reminder monitor, phone-link) that owners expect to
 * keep running; one bad promise in one of them shouldn't take the whole
 * app down. Electron's renderer/GPU process crashes are a separate
 * concern (a different process) and are unaffected by this.
 */

import { app } from 'electron';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatCrashLine, shouldRotate, toCrashRecord, type CrashKind } from './crash-log-core.js';

const CRASH_LOG_FILE = 'crash.log';
/** Single-generation rotation (crash.log -> crash.log.1) past this size. */
const MAX_BYTES = 2 * 1024 * 1024;

function crashLogPath(): string {
  return path.join(app.getPath('userData'), CRASH_LOG_FILE);
}

function rotateIfNeeded(file: string): void {
  try {
    const { size } = statSync(file);
    if (shouldRotate(size, MAX_BYTES)) renameSync(file, `${file}.1`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stdout.write(`[crash-log] rotation check failed: ${String(err)}\n`);
    }
  }
}

/** Log to stdout AND persist a structured line, best-effort. */
export function recordCrash(kind: CrashKind, err: unknown): void {
  const record = toCrashRecord(kind, err);
  const line = formatCrashLine(record);
  process.stdout.write(`[crash] ${line}`);
  try {
    const file = crashLogPath();
    rotateIfNeeded(file);
    appendFileSync(file, line, { mode: 0o600 });
  } catch (writeErr) {
    process.stdout.write(`[crash-log] failed to persist crash log: ${String(writeErr)}\n`);
  }
}

let installed = false;

/**
 * Install the process-level crash handlers. Idempotent; call once, as
 * early as possible in main.ts (before `app.whenReady()`) so early-boot
 * failures are captured too.
 */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', (err) => {
    // See the module doc comment: log + persist + continue, deliberately.
    recordCrash('uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    recordCrash('unhandledRejection', reason);
  });
}
