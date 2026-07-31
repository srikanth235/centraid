/*
 * Electron wiring around gateway-outage-log-core.ts's pure NDJSON logic —
 * persists the gateway-monitor's alert-worthy events under Electron
 * userData so the Gateway page's Alerts tab keeps a history across
 * restarts (issue #351 wave 4; crash-log.ts is the sibling pattern for
 * process crashes, and this follows the same "pure core + thin shell"
 * split — see crash-log-core.ts / gateway-outage-log-core.ts).
 *
 * Read-modify-rewrite on every append, unlike crash-log.ts's size-based
 * rotation: alert events are occasional (probes run every 5s, but
 * transitions/alerts are rare relative to that), so reading the whole
 * (capped-small, ~500-line) file back on every append is cheap and keeps
 * the cap exact instead of approximate.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

import {
  capOutageLog,
  formatOutageLogFile,
  OUTAGE_LOG_CAP,
  OUTAGE_LOG_SCHEMA,
  parseOutageLogFile,
} from "./gateway-outage-log-core.js";
import type {
  OutageLogEvent,
  OutageLogFile,
} from "./gateway-outage-log-core.js";

const OUTAGE_LOG_FILE = "gateway-outage-log.jsonl";

function outageLogPath(): string {
  return path.join(app.getPath("userData"), OUTAGE_LOG_FILE);
}

/**
 * Load the persisted log at boot. Best-effort — a missing file (first
 * launch, or a launch before this wave) or a corrupt one just starts
 * empty rather than blocking the monitor.
 */
export function loadOutageLog(): OutageLogFile {
  try {
    return parseOutageLogFile(readFileSync(outageLogPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stdout.write(
        `[gateway-outage-log] failed to read: ${String(error)}\n`
      );
    }
    return { schema: OUTAGE_LOG_SCHEMA, events: [], projected: {} };
  }
}

function writeOutageLog(file: OutageLogFile): void {
  try {
    const target = outageLogPath();
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, formatOutageLogFile(file), { mode: 0o600 });
    renameSync(tmp, target);
  } catch (error) {
    process.stdout.write(
      `[gateway-outage-log] failed to persist: ${String(error)}\n`
    );
  }
}

/**
 * Persist an advanced (or newly seeded) Inbox projection high-water mark
 * (issue #647 review). Written the moment the mark moves, not batched with the
 * next event: a crash between an accepted HTTP 200 and the next transition
 * must not re-project what the gateway already has.
 */
export function persistProjectionMarks(file: OutageLogFile): void {
  writeOutageLog(file);
}

/**
 * Append `events` onto `existing.events`, cap, and persist (temp + rename —
 * same atomicity idiom as backup-state.ts's `saveBackupState`, so a crash
 * mid-write never leaves a torn file the next boot reads as truth). The
 * per-gateway projection marks ride along unchanged. Returns the capped file
 * so the caller's in-memory copy stays in sync without a second read. A no-op
 * (returns `existing` unchanged, no write) when `events` is empty — most ticks
 * have nothing to log.
 */
export function persistOutageEvents(
  existing: OutageLogFile,
  events: OutageLogEvent[]
): OutageLogFile {
  if (events.length === 0) return existing;
  const next: OutageLogFile = {
    schema: OUTAGE_LOG_SCHEMA,
    events: capOutageLog([...existing.events, ...events], OUTAGE_LOG_CAP),
    projected: existing.projected,
  };
  writeOutageLog(next);
  return next;
}
