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

import { app } from 'electron';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  capOutageLog,
  formatOutageLogLine,
  OUTAGE_LOG_CAP,
  parseOutageLogLines,
  type OutageLogEvent,
} from './gateway-outage-log-core.js';

const OUTAGE_LOG_FILE = 'gateway-outage-log.jsonl';

function outageLogPath(): string {
  return path.join(app.getPath('userData'), OUTAGE_LOG_FILE);
}

/**
 * Load the persisted log at boot. Best-effort — a missing file (first
 * launch, or a launch before this wave) or a corrupt one just starts
 * empty rather than blocking the monitor.
 */
export function loadOutageLog(): OutageLogEvent[] {
  try {
    return parseOutageLogLines(readFileSync(outageLogPath(), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stdout.write(`[gateway-outage-log] failed to read: ${String(err)}\n`);
    }
    return [];
  }
}

/**
 * Append `events` onto `existing`, cap, and persist (temp + rename — same
 * atomicity idiom as backup-state.ts's `saveBackupState`, so a crash
 * mid-write never leaves a torn file the next boot reads as truth).
 * Returns the capped list so the caller's in-memory copy stays in sync
 * without a second read. A no-op (returns `existing` unchanged, no write)
 * when `events` is empty — most ticks have nothing to log.
 */
export function persistOutageEvents(
  existing: OutageLogEvent[],
  events: OutageLogEvent[],
): OutageLogEvent[] {
  if (events.length === 0) return existing;
  const next = capOutageLog([...existing, ...events], OUTAGE_LOG_CAP);
  try {
    const file = outageLogPath();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, next.map(formatOutageLogLine).join(''), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    process.stdout.write(`[gateway-outage-log] failed to persist: ${String(err)}\n`);
  }
  return next;
}
