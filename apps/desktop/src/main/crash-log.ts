/*
 * Crash capture (#351) — electron wiring around the pure core in
 * crash-log-core.ts.
 *
 * The posture here is deliberate: log + persist + CONTINUE, never
 * `process.exit()`. A desktop shell has long-lived background work
 * (gateway monitor, reminder monitor, phone-link) that owners expect to
 * keep running; one bad promise in one of them shouldn't take the whole
 * app down. Electron's renderer/GPU process crashes are a separate
 * concern (a different process) and are unaffected by this.
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

import {
  formatCrashLine,
  shouldRotate,
  toCrashRecord,
} from "./crash-log-core.js";
import type { CrashKind } from "./crash-log-core.js";

const CRASH_LOG_FILE = "crash.log";
const MAX_BYTES = 2 * 1024 * 1024;

function crashLogPath(): string {
  return path.join(app.getPath("userData"), CRASH_LOG_FILE);
}

function rotateIfNeeded(file: string): void {
  try {
    const { size } = statSync(file);
    if (shouldRotate(size, MAX_BYTES)) renameSync(file, `${file}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stdout.write(
        `[crash-log] rotation check failed: ${String(error)}\n`
      );
    }
  }
}

export function recordCrash(kind: CrashKind, err: unknown): void {
  const record = toCrashRecord(kind, err);
  const line = formatCrashLine(record);
  process.stdout.write(`[crash] ${line}`);
  try {
    const file = crashLogPath();
    rotateIfNeeded(file);
    appendFileSync(file, line, { mode: 0o600 });
  } catch (error) {
    process.stdout.write(
      `[crash-log] failed to persist crash log: ${String(error)}\n`
    );
  }
}

let installed = false;

export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (err) => {
    recordCrash("uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    recordCrash("unhandledRejection", reason);
  });
  // Renderer / GPU / utility process exits (#468).
  app.on("render-process-gone", (_event, webContents, details) => {
    recordCrash(
      "render-process-gone",
      new Error(
        `render process gone reason=${details.reason} exitCode=${details.exitCode} url=${webContents.getURL?.() ?? ""}`
      )
    );
  });
  app.on("child-process-gone", (_event, details) => {
    recordCrash(
      "child-process-gone",
      new Error(
        `child process gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name ?? ""}`
      )
    );
  });
}
