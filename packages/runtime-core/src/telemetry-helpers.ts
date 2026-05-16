/*
 * Constants + pure helpers used by `TelemetryStore`.
 *
 * Pulled out to keep `telemetry-store.ts` focused on the class. Anything
 * that doesn't need access to a SQLite connection lives here: per-row
 * TTL math, message truncation, JSON-parse for the settings overrides
 * column, the level rank lookup, and the in-DB constants (caps, TTL
 * defaults, sweep cadence). See `telemetry-store.ts` for the rationale
 * behind each cap.
 *
 * Schema note: telemetry is now sharded one SQLite file per app at
 * `<appsDir>/<appId>/telemetry.sqlite`. The file IS the per-app scope, so
 * neither `spans` nor `events` carries an `app_id` column, and the
 * settings table holds exactly one row (enforced by a CHECK constraint).
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { TelemetryAppSettings, TelemetryLevel, TelemetryStatus } from './telemetry.js';

/**
 * Initial schema executed once on first open of an app's telemetry file.
 * Idempotent (uses IF NOT EXISTS). `auto_vacuum = INCREMENTAL` MUST be
 * applied separately *before* this block on a fresh DB — see the
 * `getOrOpen` helper in telemetry-store.
 */
export const TELEMETRY_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS spans (
    span_id     TEXT PRIMARY KEY,
    trace_id    TEXT NOT NULL,
    parent_id   TEXT,
    kind        TEXT NOT NULL,
    handler     TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    status      TEXT NOT NULL,
    error       TEXT,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spans_started ON spans(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_spans_expires ON spans(expires_at);
  CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    trace_id    TEXT,
    span_id     TEXT,
    level       TEXT NOT NULL,
    source      TEXT NOT NULL,
    handler     TEXT NOT NULL,
    msg         TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_level_ts ON events(level, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_expires ON events(expires_at);
  CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);

  -- Single-row settings table. The CHECK enforces id=1 so a buggy upsert
  -- can't accidentally insert a second row; readers always SELECT WHERE
  -- id = 1.
  CREATE TABLE IF NOT EXISTS app_settings (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    enabled        INTEGER NOT NULL DEFAULT 1,
    min_level      TEXT NOT NULL DEFAULT 'info',
    overrides_json TEXT,
    updated_at     INTEGER NOT NULL
  );
`;

// --- caps ------------------------------------------------------------------

export const MAX_EVENTS_PER_RECORD = 500;
export const MAX_EVENT_BYTES = 8 * 1024; // 8 KiB per msg
export const MAX_RECORDS_PER_SEC = 200; // token bucket admission ceiling, PER APP
export const READ_HARD_CAP = 500;

// --- connection cache ------------------------------------------------------

/**
 * LRU cap on open per-app telemetry connections. Each entry holds a
 * `DatabaseSync` + prepared statements + per-app bucket state. At <10 active
 * apps the cap never trips; the limit exists so a registry with dozens of
 * historical apps can't pin one FD per app forever.
 */
export const MAX_OPEN_APP_CONNS = 16;

// --- TTLs (ms) -------------------------------------------------------------

export const DAY = 24 * 60 * 60 * 1000;
const TTL_SPAN_OK = 7 * DAY;
const TTL_SPAN_ERR = 30 * DAY;
const TTL_EVENT_INFO = 7 * DAY;
const TTL_EVENT_WARN = 14 * DAY;
const TTL_EVENT_ERROR = 30 * DAY;

// --- sweeper ---------------------------------------------------------------

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
export const SWEEP_BATCH = 5000;

// --- settings --------------------------------------------------------------

export const DEFAULT_SETTINGS: TelemetryAppSettings = {
  enabled: true,
  minLevel: 'info',
};

export const LEVEL_RANK: Record<TelemetryLevel, number> = { info: 0, warn: 1, error: 2 };

export function isLevelString(s: unknown): s is TelemetryLevel {
  return s === 'info' || s === 'warn' || s === 'error';
}

export type Overrides = TelemetryAppSettings['retentionDaysOverrides'];

export function spanTtl(status: TelemetryStatus, startedAt: number, o: Overrides): number {
  const defaultMs = status === 'error' ? TTL_SPAN_ERR : TTL_SPAN_OK;
  const overrideDays = status === 'error' ? o?.spanErr : o?.spanOk;
  return startedAt + (overrideDays != null ? overrideDays * DAY : defaultMs);
}

export function eventTtl(level: TelemetryLevel, ts: number, o: Overrides): number {
  const defaultMs =
    level === 'error' ? TTL_EVENT_ERROR : level === 'warn' ? TTL_EVENT_WARN : TTL_EVENT_INFO;
  const overrideDays =
    level === 'error' ? o?.eventError : level === 'warn' ? o?.eventWarn : o?.eventInfo;
  return ts + (overrideDays != null ? overrideDays * DAY : defaultMs);
}

/**
 * Byte-safe truncation of a user-supplied log message. We can't slice on
 * char count because `msg` is arbitrary UTF-8 and a single emoji can be
 * 4 bytes — char-slicing would let users sneak past the byte cap. Slice
 * on bytes and trim trailing U+FFFD replacement chars to recover from
 * the multi-byte boundary.
 */
export function truncateMsg(msg: string): string {
  if (Buffer.byteLength(msg, 'utf8') <= MAX_EVENT_BYTES) return msg;
  const buf = Buffer.from(msg, 'utf8').subarray(0, MAX_EVENT_BYTES - 16);
  return buf.toString('utf8').replace(/[�]+$/, '') + '…(truncated)';
}

/**
 * Apply per-record event count + per-event byte caps. Returns a new
 * array; the caller's slice is left untouched. When the count cap trips,
 * the tail is replaced with a single "events truncated" marker so the UI
 * surfaces the drop instead of pretending it didn't happen.
 */
export function applyEventCaps(
  events: Array<{ ts: number; level: TelemetryLevel; msg: string }>,
): Array<{ ts: number; level: TelemetryLevel; msg: string }> {
  const out: Array<{ ts: number; level: TelemetryLevel; msg: string }> = [];
  const overLimit = events.length > MAX_EVENTS_PER_RECORD;
  const headCount = overLimit ? MAX_EVENTS_PER_RECORD - 1 : events.length;
  for (let i = 0; i < headCount; i++) {
    const ev = events[i]!;
    out.push({ ts: ev.ts, level: ev.level, msg: truncateMsg(ev.msg) });
  }
  if (overLimit) {
    const dropped = events.length - headCount;
    const last = events[events.length - 1]!;
    out.push({
      ts: last.ts,
      level: 'warn',
      msg: `[telemetry] events truncated: ${dropped} of ${events.length} dropped`,
    });
  }
  return out;
}

/**
 * Prepared-statement bundle for one app's connection. Held on the
 * `AppConn` so the hot path is a hash lookup, not a re-prepare.
 */
export interface AppStmts {
  insertSpan: StatementSync;
  insertEvent: StatementSync;
  readEvents: StatementSync;
  readEventsLevel: StatementSync;
  sweepSpans: StatementSync;
  sweepEvents: StatementSync;
  getSettings: StatementSync;
  upsertSettings: StatementSync;
  deleteSettings: StatementSync;
}

export function prepareStmts(db: DatabaseSync): AppStmts {
  return {
    insertSpan: db.prepare(
      `INSERT INTO spans
         (span_id, trace_id, parent_id, kind, handler,
          started_at, duration_ms, status, error, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(span_id) DO NOTHING`,
    ),
    insertEvent: db.prepare(
      `INSERT INTO events
         (ts, trace_id, span_id, level, source, handler, msg, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    readEvents: db.prepare(
      `SELECT ts, level, source, handler, msg
       FROM events
       WHERE ts >= ?
       ORDER BY ts DESC
       LIMIT ?`,
    ),
    readEventsLevel: db.prepare(
      `SELECT ts, level, source, handler, msg
       FROM events
       WHERE ts >= ? AND level = ?
       ORDER BY ts DESC
       LIMIT ?`,
    ),
    sweepSpans: db.prepare(
      `DELETE FROM spans WHERE span_id IN
         (SELECT span_id FROM spans WHERE expires_at < ? LIMIT ?)`,
    ),
    sweepEvents: db.prepare(
      `DELETE FROM events WHERE id IN
         (SELECT id FROM events WHERE expires_at < ? LIMIT ?)`,
    ),
    getSettings: db.prepare(
      `SELECT enabled, min_level, overrides_json FROM app_settings WHERE id = 1`,
    ),
    upsertSettings: db.prepare(
      `INSERT INTO app_settings (id, enabled, min_level, overrides_json, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled,
         min_level = excluded.min_level,
         overrides_json = excluded.overrides_json,
         updated_at = excluded.updated_at`,
    ),
    deleteSettings: db.prepare(`DELETE FROM app_settings WHERE id = 1`),
  };
}

export function safeParseOverrides(s: string): TelemetryAppSettings['retentionDaysOverrides'] {
  try {
    const raw = JSON.parse(s) as Record<string, unknown>;
    const out: NonNullable<TelemetryAppSettings['retentionDaysOverrides']> = {};
    const keys = ['eventInfo', 'eventWarn', 'eventError', 'spanOk', 'spanErr'] as const;
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        out[k] = Math.floor(v);
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
