import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Per-app handler logs: JSONL appends to `<app-data-dir>/logs.jsonl`, rotated
 * to `.1` past MAX_BYTES; reads merge both files oldest-first.
 */
export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
  source: "query" | "action";
  /** Handler id (filename stem under queries/ actions/). */
  handler: string;
}

export type LogLevel = LogEntry["level"];

const FILENAME = "logs.jsonl";
const ROTATED = "logs.jsonl.1";
const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB before rotation
const READ_HARD_CAP = 500;

export async function appendLogs(
  appDataDir: string,
  entries: LogEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  const file = path.join(appDataDir, FILENAME);
  const payload = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

  await fs.mkdir(appDataDir, { recursive: true }).catch(() => {});
  try {
    await fs.appendFile(file, payload, "utf8");
  } catch (error) {
    // Best-effort: never fail the handler request.
    console.error(
      `[centraid] log append failed for ${appDataDir}: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  // Rotate after write; failure here is non-fatal.
  try {
    const stat = await fs.stat(file);
    if (stat.size >= MAX_BYTES) {
      const rotated = path.join(appDataDir, ROTATED);
      await fs.rename(file, rotated);
    }
  } catch {
    /* best effort */
  }
}

export interface ReadLogsOptions {
  limit?: number;
  sinceTs?: number;
  level?: LogLevel;
}

/** Most recent matching entries, newest first, unified across rotation. */
export async function readLogs(
  appDataDir: string,
  opts: ReadLogsOptions = {}
): Promise<LogEntry[]> {
  const limit = Math.max(
    1,
    Math.min(READ_HARD_CAP, Math.floor(opts.limit ?? 100))
  );

  const current = path.join(appDataDir, FILENAME);
  const rotated = path.join(appDataDir, ROTATED);

  const [curText, rotText] = await Promise.all([
    readMaybe(current),
    readMaybe(rotated),
  ]);
  const all = parseJsonl(curText).concat(parseJsonl(rotText));

  const filtered = all.filter((e) => {
    if (opts.sinceTs !== undefined && e.ts < opts.sinceTs) return false;
    if (opts.level && e.level !== opts.level) return false;
    return true;
  });

  filtered.sort((a, b) => b.ts - a.ts);
  return filtered.slice(0, limit);
}

async function readMaybe(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function parseJsonl(text: string): LogEntry[] {
  if (!text) return [];
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Partial<LogEntry>;
      if (
        typeof obj.ts === "number" &&
        (obj.level === "info" ||
          obj.level === "warn" ||
          obj.level === "error") &&
        typeof obj.msg === "string" &&
        (obj.source === "query" || obj.source === "action") &&
        typeof obj.handler === "string"
      ) {
        out.push(obj as LogEntry);
      }
    } catch {
      /* skip corrupted line */
    }
  }
  return out;
}
