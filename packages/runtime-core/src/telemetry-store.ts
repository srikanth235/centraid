/*
 * Centraid telemetry store.
 *
 * A single shared SQLite database — `<stateDir>/centraid-telemetry.sqlite` —
 * holds spans (one row per handler invocation) and events (one row per
 * `log.*` call or system event) across every app. Mirrors the chat-history
 * pattern (see `chat-history.ts`): telemetry is platform metadata, kept
 * out of each app's user-facing `data.sqlite` so the agent's
 * `centraid_sql_*` tools can't read it and so schema changes don't
 * fan out to N app databases.
 *
 * Implements `TelemetryWriter` from runtime-core. The plugin injects this
 * into the `Runtime`, which plumbs it through `handler-runner` so a
 * finished invocation produces one span row + N event rows in a single
 * transaction.
 *
 * Capacity controls (small-scale, <10 users — we want to never crash
 * SQLite, not to compete with Datadog):
 *
 *   1. Per-invocation event count cap. A runaway handler emitting 100k
 *      `log.info`s gets truncated to `MAX_EVENTS_PER_RECORD` with a
 *      synthesized "events truncated" marker. Enforced in `recordHandler`.
 *   2. Per-event byte cap. Each `msg` is truncated to `MAX_EVENT_BYTES`
 *      with a "…(truncated)" suffix.
 *   3. Per-record transaction. Spans + events for one invocation go in a
 *      single `BEGIN IMMEDIATE … COMMIT`, so we never hold a write lock
 *      across handler boundaries.
 *   4. Token-bucket admission. A simple counter limits the number of
 *      `recordHandler` *records* persisted per second; over the limit,
 *      records are silently dropped (we keep the most recent ones — the
 *      common failure mode is a tight loop, and the user wants visibility
 *      into the start and end of that loop, not the middle 9k rows).
 *
 * TTL semantics:
 *   - `expires_at` is set per row based on level/status. Defaults below.
 *   - A background sweeper (interval = `SWEEP_INTERVAL_MS`) does
 *     `DELETE … WHERE expires_at < unixepoch_ms()` in bounded batches,
 *     then `PRAGMA incremental_vacuum` so the file actually shrinks.
 *   - `auto_vacuum = INCREMENTAL` MUST be set before the first write;
 *     we set it on the connection right after open, before any
 *     `CREATE TABLE`.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  TelemetryAppSettings,
  TelemetryAppSettingsPatch,
  TelemetryKind,
  TelemetryLevel,
  TelemetryReadEntry,
  TelemetryReadOptions,
  TelemetrySpanRecord,
  TelemetryWriter,
} from './telemetry.js';
import {
  DEFAULT_SETTINGS,
  LEVEL_RANK,
  MAX_RECORDS_PER_SEC,
  READ_HARD_CAP,
  SWEEP_BATCH,
  SWEEP_INTERVAL_MS,
  TELEMETRY_SCHEMA,
  applyEventCaps,
  eventTtl,
  isLevelString,
  safeParseOverrides,
  spanTtl,
} from './telemetry-helpers.js';

export interface TelemetryStoreOptions {
  /** Override sweep interval (tests use a short value). */
  sweepIntervalMs?: number;
  /** Override admission limit (tests use 0 to disable). */
  maxRecordsPerSec?: number;
  /** Inject a clock for deterministic TTL/throttle tests. */
  now?: () => number;
}

export class TelemetryStore implements TelemetryWriter {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly maxRecordsPerSec: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;
  private closed = false;

  // Token-bucket state for write admission.
  private bucketWindowStart = 0;
  private bucketCount = 0;
  private droppedSinceLastWarn = 0;
  private lastDropWarnAt = 0;

  private readonly stmts: {
    insertSpan: StatementSync;
    insertEvent: StatementSync;
    readEvents: StatementSync;
    readEventsLevel: StatementSync;
    deleteSpansApp: StatementSync;
    deleteEventsApp: StatementSync;
    sweepSpans: StatementSync;
    sweepEvents: StatementSync;
    getSettings: StatementSync;
    upsertSettings: StatementSync;
    deleteSettingsApp: StatementSync;
  };

  // Per-app settings cache. Cleared on `setAppSettings` and `deleteApp`.
  // Settings rarely change but are read on every `recordHandler` call, so
  // caching avoids a SELECT per invocation.
  private readonly settingsCache = new Map<string, TelemetryAppSettings>();

  constructor(dbPath: string, opts: TelemetryStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxRecordsPerSec = opts.maxRecordsPerSec ?? MAX_RECORDS_PER_SEC;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;

    this.db = new DatabaseSync(dbPath);
    // auto_vacuum must be set BEFORE the first table is created on a fresh
    // DB, otherwise the setting is ignored and the file never reclaims
    // space when rows are deleted.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    this.db.exec(TELEMETRY_SCHEMA);

    this.stmts = {
      insertSpan: this.db.prepare(
        `INSERT INTO spans
           (span_id, trace_id, parent_id, app_id, kind, handler,
            started_at, duration_ms, status, error, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(span_id) DO NOTHING`,
      ),
      insertEvent: this.db.prepare(
        `INSERT INTO events
           (app_id, ts, trace_id, span_id, level, source, handler, msg, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      readEvents: this.db.prepare(
        `SELECT ts, level, source, handler, msg
         FROM events
         WHERE app_id = ? AND ts >= ?
         ORDER BY ts DESC
         LIMIT ?`,
      ),
      readEventsLevel: this.db.prepare(
        `SELECT ts, level, source, handler, msg
         FROM events
         WHERE app_id = ? AND ts >= ? AND level = ?
         ORDER BY ts DESC
         LIMIT ?`,
      ),
      deleteSpansApp: this.db.prepare(`DELETE FROM spans WHERE app_id = ?`),
      deleteEventsApp: this.db.prepare(`DELETE FROM events WHERE app_id = ?`),
      // Bounded deletes so a large sweep doesn't hold the write lock for
      // seconds. We loop in `sweep()` until each statement reports 0 changes.
      sweepSpans: this.db.prepare(
        `DELETE FROM spans WHERE span_id IN
           (SELECT span_id FROM spans WHERE expires_at < ? LIMIT ?)`,
      ),
      sweepEvents: this.db.prepare(
        `DELETE FROM events WHERE id IN
           (SELECT id FROM events WHERE expires_at < ? LIMIT ?)`,
      ),
      getSettings: this.db.prepare(
        `SELECT enabled, min_level, overrides_json
         FROM app_settings WHERE app_id = ?`,
      ),
      upsertSettings: this.db.prepare(
        `INSERT INTO app_settings (app_id, enabled, min_level, overrides_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET
           enabled = excluded.enabled,
           min_level = excluded.min_level,
           overrides_json = excluded.overrides_json,
           updated_at = excluded.updated_at`,
      ),
      deleteSettingsApp: this.db.prepare(`DELETE FROM app_settings WHERE app_id = ?`),
    };

    if (this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        try {
          this.sweep();
        } catch {
          /* sweeper is best-effort; never let a sweep error crash the loop */
        }
      }, this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  // -------------------------------------------------------------------------
  // TelemetryWriter
  // -------------------------------------------------------------------------

  async recordHandler(record: TelemetrySpanRecord): Promise<void> {
    if (this.closed) return;

    // Per-app gating runs BEFORE admission so a disabled app doesn't burn
    // tokens. Settings are cached in-memory and refreshed on every
    // `setAppSettings` call, so this is a hash lookup in the hot path.
    const settings = this.loadSettings(record.appId);
    if (!settings.enabled) return;

    if (!this.admit()) return;

    const minRank = LEVEL_RANK[settings.minLevel];
    const filtered =
      minRank === 0 ? record.events : record.events.filter((e) => LEVEL_RANK[e.level] >= minRank);
    const truncated = applyEventCaps(filtered);
    const now = this.now();

    // One transaction per invocation. BEGIN IMMEDIATE so two concurrent
    // recordHandler calls serialize cleanly instead of upgrading mid-stmt.
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch {
      // SQLITE_BUSY under contention — drop this record rather than
      // blocking the handler-runner. The next sweep/admission will catch up.
      return;
    }

    try {
      const overrides = settings.retentionDaysOverrides;
      this.stmts.insertSpan.run(
        record.spanId,
        record.traceId,
        record.parentId ?? null,
        record.appId,
        record.kind,
        record.handler,
        record.startedAt,
        Math.max(0, Math.floor(record.durationMs)),
        record.status,
        record.error ?? null,
        spanTtl(record.status, record.startedAt, overrides),
      );

      for (const ev of truncated) {
        this.stmts.insertEvent.run(
          record.appId,
          ev.ts,
          record.traceId,
          record.spanId,
          ev.level,
          record.kind,
          record.handler,
          ev.msg,
          eventTtl(ev.level, ev.ts, overrides),
        );
      }

      this.db.exec('COMMIT');
      void now; // reserved for future per-tx metrics
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
    }
  }

  async readEvents(appId: string, opts: TelemetryReadOptions = {}): Promise<TelemetryReadEntry[]> {
    if (this.closed) return [];
    const limit = Math.max(1, Math.min(READ_HARD_CAP, Math.floor(opts.limit ?? 100)));
    const sinceTs = opts.sinceTs ?? 0;
    const rows = opts.level
      ? (this.stmts.readEventsLevel.all(appId, sinceTs, opts.level, limit) as Array<{
          ts: number;
          level: TelemetryLevel;
          source: TelemetryKind;
          handler: string;
          msg: string;
        }>)
      : (this.stmts.readEvents.all(appId, sinceTs, limit) as Array<{
          ts: number;
          level: TelemetryLevel;
          source: TelemetryKind;
          handler: string;
          msg: string;
        }>);
    return rows.map((r) => ({
      ts: Number(r.ts),
      level: r.level,
      msg: r.msg,
      source: r.source,
      handler: r.handler,
    }));
  }

  async deleteApp(appId: string): Promise<void> {
    if (this.closed) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmts.deleteSpansApp.run(appId);
      this.stmts.deleteEventsApp.run(appId);
      this.stmts.deleteSettingsApp.run(appId);
      this.db.exec('COMMIT');
      this.settingsCache.delete(appId);
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-app settings
  // -------------------------------------------------------------------------

  async getAppSettings(appId: string): Promise<TelemetryAppSettings> {
    if (this.closed) return { ...DEFAULT_SETTINGS };
    return this.loadSettings(appId);
  }

  async setAppSettings(
    appId: string,
    patch: TelemetryAppSettingsPatch,
  ): Promise<TelemetryAppSettings> {
    if (this.closed) return { ...DEFAULT_SETTINGS };

    // Merge over current settings so missing keys retain their value.
    // `loadSettings` returns a fresh object so it's safe to mutate.
    const current = this.loadSettings(appId);
    const next: TelemetryAppSettings = {
      enabled: patch.enabled ?? current.enabled,
      minLevel: patch.minLevel ?? current.minLevel,
      retentionDaysOverrides: patch.retentionDaysOverrides ?? current.retentionDaysOverrides,
    };

    const overridesText = next.retentionDaysOverrides
      ? JSON.stringify(next.retentionDaysOverrides)
      : null;
    this.stmts.upsertSettings.run(
      appId,
      next.enabled ? 1 : 0,
      next.minLevel,
      overridesText,
      this.now(),
    );
    this.settingsCache.set(appId, next);
    return next;
  }

  /**
   * Synchronous cached read. Falls back to DEFAULT_SETTINGS on a fresh app.
   * Called from `recordHandler` on the hot path, so it must not touch
   * disk after the first hit per app.
   */
  private loadSettings(appId: string): TelemetryAppSettings {
    const cached = this.settingsCache.get(appId);
    if (cached) return { ...cached };

    const row = this.stmts.getSettings.get(appId) as
      | { enabled: number; min_level: string; overrides_json: string | null }
      | undefined;
    const settings: TelemetryAppSettings = row
      ? {
          enabled: row.enabled !== 0,
          minLevel: isLevelString(row.min_level) ? row.min_level : 'info',
          retentionDaysOverrides: row.overrides_json
            ? safeParseOverrides(row.overrides_json)
            : undefined,
        }
      : { ...DEFAULT_SETTINGS };
    this.settingsCache.set(appId, settings);
    return { ...settings };
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Delete rows past their TTL. Called by the interval timer; also
   * exposed for tests. Loops the bounded delete statement until no more
   * rows match, then issues `incremental_vacuum` so the file shrinks.
   */
  sweep(): { spans: number; events: number } {
    if (this.closed) return { spans: 0, events: 0 };
    const cutoff = this.now();
    let spans = 0;
    let events = 0;
    // Loop the bounded deletes until clear. The `LIMIT` keeps each
    // statement short so other writers aren't blocked for long.
    for (;;) {
      const r = this.stmts.sweepSpans.run(cutoff, SWEEP_BATCH);
      const changes = Number(r.changes);
      spans += changes;
      if (changes === 0) break;
    }
    for (;;) {
      const r = this.stmts.sweepEvents.run(cutoff, SWEEP_BATCH);
      const changes = Number(r.changes);
      events += changes;
      if (changes === 0) break;
    }
    if (spans + events > 0) {
      try {
        this.db.exec('PRAGMA incremental_vacuum(1000);');
      } catch {
        /* ignore */
      }
    }
    return { spans, events };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Token-bucket admission with a 1-second window. Returns false when the
   * caller should be dropped. We deliberately do NOT queue dropped
   * records — the goal is to protect SQLite from a runaway handler, and
   * queuing would just defer the same write storm.
   */
  private admit(): boolean {
    if (this.maxRecordsPerSec <= 0) return true;
    const now = this.now();
    if (now - this.bucketWindowStart >= 1000) {
      this.bucketWindowStart = now;
      this.bucketCount = 0;
      // Best-effort: emit a single warn-level system event if we dropped
      // records during the previous window. Avoids log spam under storms.
      if (this.droppedSinceLastWarn > 0 && now - this.lastDropWarnAt >= 60_000) {
        this.lastDropWarnAt = now;
        // Best-effort console; this is plugin-host noise, not user-app log.
        // eslint-disable-next-line no-console
        console.warn(
          `[centraid] telemetry: dropped ${this.droppedSinceLastWarn} records under load`,
        );
        this.droppedSinceLastWarn = 0;
      }
    }
    if (this.bucketCount >= this.maxRecordsPerSec) {
      this.droppedSinceLastWarn += 1;
      return false;
    }
    this.bucketCount += 1;
    return true;
  }
}
