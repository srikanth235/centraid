// Thin Electron shell over gateway-outage-log-core.ts's pure logic.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

import {
  capOutageLog,
  formatOutageLogFile,
  OUTAGE_LOG_CAP,
  parseOutageLogFile,
} from "./gateway-outage-log-core.js";
import type { OutageLogEvent } from "./gateway-outage-log-core.js";

const OUTAGE_LOG_FILE = "gateway-outage-log.jsonl";

function outageLogPath(): string {
  return path.join(app.getPath("userData"), OUTAGE_LOG_FILE);
}

export function loadOutageLog(): OutageLogEvent[] {
  try {
    return parseOutageLogFile(readFileSync(outageLogPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stdout.write(
        `[gateway-outage-log] failed to read: ${String(error)}\n`
      );
    }
    return [];
  }
}

/**
 * Append, cap, persist atomically (temp + rename); no-op when empty.
 * Drops legacy `projection-mark` lines (#665) — never write one.
 */
export function persistOutageEvents(
  existing: readonly OutageLogEvent[],
  events: OutageLogEvent[]
): OutageLogEvent[] {
  if (events.length === 0) return existing as OutageLogEvent[];
  const next = capOutageLog([...existing, ...events], OUTAGE_LOG_CAP);
  try {
    const target = outageLogPath();
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, formatOutageLogFile(next), { mode: 0o600 });
    renameSync(tmp, target);
  } catch (error) {
    process.stdout.write(
      `[gateway-outage-log] failed to persist: ${String(error)}\n`
    );
  }
  return next;
}
