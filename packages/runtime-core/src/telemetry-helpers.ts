/*
 * Constants + pure helpers used by `TelemetryStore`.
 *
 * Pulled out to keep `telemetry-store.ts` focused on the class. Anything
 * that doesn't need access to the SQLite connection lives here: per-row
 * TTL math, message truncation, JSON-parse for the settings overrides
 * column, the level rank lookup, and the in-DB constants (caps, TTL
 * defaults, sweep cadence). See `telemetry-store.ts` for the rationale
 * behind each cap.
 */

import type { TelemetryAppSettings, TelemetryLevel, TelemetryStatus } from './telemetry.js';

/**
 * Initial schema executed once on `new TelemetryStore(...)`. Idempotent
 * (uses IF NOT EXISTS). `auto_vacuum = INCREMENTAL` MUST be applied
 * separately *before* this block on a fresh DB — see the constructor.
 */
export const TELEMETRY_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS spans (
    span_id     TEXT PRIMARY KEY,
    trace_id    TEXT NOT NULL,
    parent_id   TEXT,
    app_id      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    handler     TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    status      TEXT NOT NULL,
    error       TEXT,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spans_app_started ON spans(app_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_spans_expires ON spans(expires_at);
  CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id      TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    trace_id    TEXT,
    span_id     TEXT,
    level       TEXT NOT NULL,
    source      TEXT NOT NULL,
    handler     TEXT NOT NULL,
    msg         TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_app_ts ON events(app_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_app_level_ts ON events(app_id, level, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_expires ON events(expires_at);
  CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);

  CREATE TABLE IF NOT EXISTS app_settings (
    app_id         TEXT PRIMARY KEY,
    enabled        INTEGER NOT NULL DEFAULT 1,
    min_level      TEXT NOT NULL DEFAULT 'info',
    overrides_json TEXT,
    updated_at     INTEGER NOT NULL
  );
`;

// --- caps ------------------------------------------------------------------

export const MAX_EVENTS_PER_RECORD = 500;
export const MAX_EVENT_BYTES = 8 * 1024; // 8 KiB per msg
export const MAX_RECORDS_PER_SEC = 200; // token bucket admission ceiling
export const READ_HARD_CAP = 500;

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
