import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Persistent per-app handler logs.
 *
 * Each handler execution appends one JSONL line per `ScopedLog` call to
 * `<app-data-dir>/logs.jsonl`. When the file grows past `MAX_BYTES`, it's
 * rotated to `logs.jsonl.1` (overwriting any previous rotation). This is a
 * simple ring of two files — enough for an interactive log tail in the
 * Cloud panel without committing to a structured log store.
 *
 * Reads merge the current file with the rotated one (oldest first), then
 * apply newest-first / filter / limit semantics in `readLogs`.
 */
export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
  source: 'query' | 'action' | 'cron';
  /** Handler id (filename stem under queries/ actions/ crons/). */
  handler: string;
}

export type LogLevel = LogEntry['level'];

const FILENAME = 'logs.jsonl';
const ROTATED = 'logs.jsonl.1';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB before rotation
const READ_HARD_CAP = 500;

export async function appendLogs(appDataDir: string, entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const file = path.join(appDataDir, FILENAME);
  const payload = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

  await fs.mkdir(appDataDir, { recursive: true }).catch(() => {});
  try {
    await fs.appendFile(file, payload, 'utf8');
  } catch (err) {
    // Log persistence is best-effort — never fail the handler request just
    // because logs couldn't be written. Surface via console for diagnostic.
    console.error(
      `[centraid] log append failed for ${appDataDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Rotate after write so the previous rotation is replaced atomically with
  // the just-filled current file. Failure here is non-fatal — next append
  // tries again.
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
  /** Default 100, capped to 500. */
  limit?: number;
  /** Drop entries with `ts < sinceTs` (for polling tail). */
  sinceTs?: number;
  /** Restrict to a single level. */
  level?: LogLevel;
}

/**
 * Returns the most recent matching log entries, newest first. Entries from
 * the rotated file are concatenated underneath the current file before the
 * filter/sort pass, so the caller sees a unified stream across rotation.
 */
export async function readLogs(
  appDataDir: string,
  opts: ReadLogsOptions = {},
): Promise<LogEntry[]> {
  const limit = Math.max(1, Math.min(READ_HARD_CAP, Math.floor(opts.limit ?? 100)));

  const current = path.join(appDataDir, FILENAME);
  const rotated = path.join(appDataDir, ROTATED);

  const [curText, rotText] = await Promise.all([readMaybe(current), readMaybe(rotated)]);
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
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function parseJsonl(text: string): LogEntry[] {
  if (!text) return [];
  const out: LogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Partial<LogEntry>;
      if (
        typeof obj.ts === 'number' &&
        (obj.level === 'info' || obj.level === 'warn' || obj.level === 'error') &&
        typeof obj.msg === 'string' &&
        (obj.source === 'query' || obj.source === 'action' || obj.source === 'cron') &&
        typeof obj.handler === 'string'
      ) {
        out.push(obj as LogEntry);
      }
    } catch {
      /* skip corrupted line */
    }
  }
  return out;
}
