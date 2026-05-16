/*
 * Centraid telemetry store — one SQLite file per app.
 *
 * Each app has its own `<appsDir>/<appId>/telemetry.sqlite`, holding
 * spans (one row per handler invocation) and events (one row per
 * `log.*` call or system event) for that app and only that app. The
 * file IS the per-app scope: there is no `app_id` column, deleteApp
 * is a file unlink, and a runaway handler in app A can't contend with
 * reads of app B.
 *
 * Implements `TelemetryWriter` from runtime-core. The plugin injects this
 * into the `Runtime`, which plumbs it through `handler-runner` so a
 * finished invocation produces one span row + N event rows in a single
 * transaction in that app's file.
 *
 * Connection lifecycle: connections are opened lazily on first
 * `recordHandler` / `setAppSettings` call for an app and cached in an
 * insertion-order LRU (`MAX_OPEN_APP_CONNS`). Eviction closes the DB
 * handle; the next call reopens. Read-only operations
 * (`readEvents`, `getAppSettings`) skip opening when the file doesn't
 * exist — they return empty / defaults — so polling a never-active app
 * doesn't pin a connection or create a spurious file.
 *
 * Capacity controls (per app, since each file is independent):
 *
 *   1. Per-invocation event count cap. A runaway handler emitting 100k
 *      `log.info`s gets truncated to `MAX_EVENTS_PER_RECORD` with a
 *      synthesized "events truncated" marker. Enforced in `recordHandler`.
 *   2. Per-event byte cap. Each `msg` is truncated to `MAX_EVENT_BYTES`
 *      with a "…(truncated)" suffix.
 *   3. Per-record transaction. Spans + events for one invocation go in a
 *      single `BEGIN IMMEDIATE … COMMIT` on that app's file, so we never
 *      hold a write lock across handler boundaries.
 *   4. Per-app token-bucket admission. Each app's connection carries its
 *      own 1-second bucket capped at `MAX_RECORDS_PER_SEC`; over the
 *      limit, records are silently dropped (we keep the most recent
 *      ones — the common failure mode is a tight loop, and the user
 *      wants visibility into the start and end of that loop, not the
 *      middle 9k rows). A noisy app can only starve itself.
 *
 * TTL semantics:
 *   - `expires_at` is set per row based on level/status. Defaults in
 *     `telemetry-helpers.ts`.
 *   - The interval-driven sweeper (interval = `SWEEP_INTERVAL_MS`)
 *     iterates currently-OPEN connections and runs bounded
 *     `DELETE … WHERE expires_at < unixepoch_ms()` against each, then
 *     `PRAGMA incremental_vacuum`. Cold apps (no recent activity)
 *     accumulate expired rows until their next access — acceptable at
 *     <10 users with day-scale TTLs.
 *   - `auto_vacuum = INCREMENTAL` MUST be set before the first write on
 *     a fresh file; we set it on each connection right after open,
 *     before any `CREATE TABLE`.
 */

import { promises as fsp, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  type AppStmts,
  DEFAULT_SETTINGS,
  LEVEL_RANK,
  MAX_OPEN_APP_CONNS,
  MAX_RECORDS_PER_SEC,
  READ_HARD_CAP,
  SWEEP_BATCH,
  SWEEP_INTERVAL_MS,
  TELEMETRY_SCHEMA,
  applyEventCaps,
  eventTtl,
  isLevelString,
  prepareStmts,
  safeParseOverrides,
  spanTtl,
} from './telemetry-helpers.js';

export interface TelemetryStoreOptions {
  /** Override sweep interval (tests use a short value, 0 disables). */
  sweepIntervalMs?: number;
  /** Override admission limit (tests use 0 to disable). Applied per app. */
  maxRecordsPerSec?: number;
  /** Override the LRU cap on open connections. */
  maxOpenConns?: number;
  /** Inject a clock for deterministic TTL/throttle tests. */
  now?: () => number;
}

interface AppConn {
  db: DatabaseSync;
  stmts: AppStmts;
  // Per-app token-bucket state.
  bucketWindowStart: number;
  bucketCount: number;
  droppedSinceLastWarn: number;
  lastDropWarnAt: number;
  // Single cached settings record for this file.
  settings?: TelemetryAppSettings;
}

export class TelemetryStore implements TelemetryWriter {
  private readonly appsDir: string;
  private readonly now: () => number;
  private readonly maxRecordsPerSec: number;
  private readonly maxOpenConns: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;
  private closed = false;

  // Insertion-order LRU. Map iteration order is insertion order; we
  // re-insert on access to promote, and evict the front (oldest) entry
  // when the cap trips.
  private readonly conns = new Map<string, AppConn>();

  constructor(appsDir: string, opts: TelemetryStoreOptions = {}) {
    this.appsDir = appsDir;
    this.now = opts.now ?? Date.now;
    this.maxRecordsPerSec = opts.maxRecordsPerSec ?? MAX_RECORDS_PER_SEC;
    this.maxOpenConns = opts.maxOpenConns ?? MAX_OPEN_APP_CONNS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;

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
  // Path / open helpers
  // -------------------------------------------------------------------------

  private fileFor(appId: string): string {
    return path.join(this.appsDir, appId, 'telemetry.sqlite');
  }

  /**
   * Open (or reuse) a connection for the given app. Promotes the entry
   * to most-recently-used on hit; opens + caches on miss. Creates the
   * parent directory and applies `auto_vacuum = INCREMENTAL` *before*
   * the first `CREATE TABLE` on a fresh file (SQLite ignores the pragma
   * on an existing DB without an explicit `VACUUM`).
   */
  private getOrOpen(appId: string): AppConn {
    const existing = this.conns.get(appId);
    if (existing) {
      // Promote: re-insert at the back.
      this.conns.delete(appId);
      this.conns.set(appId, existing);
      return existing;
    }
    const file = this.fileFor(appId);
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    db.exec(TELEMETRY_SCHEMA);
    const conn: AppConn = {
      db,
      stmts: prepareStmts(db),
      bucketWindowStart: 0,
      bucketCount: 0,
      droppedSinceLastWarn: 0,
      lastDropWarnAt: 0,
    };
    this.conns.set(appId, conn);
    this.evictIfOverCap();
    return conn;
  }

  private evictIfOverCap(): void {
    while (this.conns.size > this.maxOpenConns) {
      // First entry in insertion order = least recently used.
      const firstKey = this.conns.keys().next().value as string | undefined;
      if (!firstKey) break;
      const victim = this.conns.get(firstKey);
      this.conns.delete(firstKey);
      try {
        victim?.db.close();
      } catch {
        /* ignore */
      }
    }
  }

  // -------------------------------------------------------------------------
  // TelemetryWriter
  // -------------------------------------------------------------------------

  async recordHandler(record: TelemetrySpanRecord): Promise<void> {
    if (this.closed) return;
    const conn = this.getOrOpen(record.appId);

    // Per-app gating runs BEFORE admission so a disabled app doesn't burn
    // tokens. Settings are cached on the conn and refreshed on every
    // `setAppSettings` call, so this is a hash lookup on the hot path.
    const settings = this.loadSettings(conn);
    if (!settings.enabled) return;

    if (!this.admit(conn)) return;

    const minRank = LEVEL_RANK[settings.minLevel];
    const filtered =
      minRank === 0 ? record.events : record.events.filter((e) => LEVEL_RANK[e.level] >= minRank);
    const truncated = applyEventCaps(filtered);

    // One transaction per invocation. BEGIN IMMEDIATE so two concurrent
    // recordHandler calls on the same app serialize cleanly instead of
    // upgrading mid-stmt.
    try {
      conn.db.exec('BEGIN IMMEDIATE');
    } catch {
      // SQLITE_BUSY under contention — drop this record rather than
      // blocking the handler-runner. The next sweep/admission will catch up.
      return;
    }

    try {
      const overrides = settings.retentionDaysOverrides;
      conn.stmts.insertSpan.run(
        record.spanId,
        record.traceId,
        record.parentId ?? null,
        record.kind,
        record.handler,
        record.startedAt,
        Math.max(0, Math.floor(record.durationMs)),
        record.status,
        record.error ?? null,
        spanTtl(record.status, record.startedAt, overrides),
      );

      for (const ev of truncated) {
        conn.stmts.insertEvent.run(
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

      conn.db.exec('COMMIT');
    } catch {
      try {
        conn.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
    }
  }

  async readEvents(appId: string, opts: TelemetryReadOptions = {}): Promise<TelemetryReadEntry[]> {
    if (this.closed) return [];
    // Short-circuit when the file doesn't exist yet: a never-active app
    // shouldn't have a telemetry.sqlite materialized just because the UI
    // polled for its logs.
    if (!this.conns.has(appId) && !existsSync(this.fileFor(appId))) return [];
    const conn = this.getOrOpen(appId);
    const limit = Math.max(1, Math.min(READ_HARD_CAP, Math.floor(opts.limit ?? 100)));
    const sinceTs = opts.sinceTs ?? 0;
    type Row = {
      ts: number;
      level: TelemetryLevel;
      source: TelemetryKind;
      handler: string;
      msg: string;
    };
    const rows = opts.level
      ? (conn.stmts.readEventsLevel.all(sinceTs, opts.level, limit) as Row[])
      : (conn.stmts.readEvents.all(sinceTs, limit) as Row[]);
    return rows.map((r) => ({
      ts: Number(r.ts),
      level: r.level,
      msg: r.msg,
      source: r.source,
      handler: r.handler,
    }));
  }

  /**
   * Close the per-app connection (if any), delete the per-app sqlite
   * file (+ WAL/SHM siblings), and rmdir the parent if empty.
   *
   * The handle MUST be closed before the file unlink on Windows (and
   * before any caller's `rm -rf <appsDir>/<appId>` in deregister
   * cleanup, which is why runtime.ts orders `telemetry.deleteApp` ahead
   * of `cleanupDeregisteredApp`).
   */
  async deleteApp(appId: string): Promise<void> {
    if (this.closed) return;
    const conn = this.conns.get(appId);
    if (conn) {
      this.conns.delete(appId);
      try {
        conn.db.close();
      } catch {
        /* ignore */
      }
    }
    const file = this.fileFor(appId);
    // Unlink the main file plus WAL/SHM siblings created by WAL journaling.
    // Each is best-effort: missing siblings are normal (no writes ever).
    for (const p of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        await fsp.unlink(p);
      } catch {
        /* missing or in-use; ignore */
      }
    }
    // Best-effort rmdir of the per-app dir. Will fail (and we ignore) if
    // the dir still has other files — e.g. for uploaded mode the wrapper
    // dir holds the app bundle, and we leave that to `cleanupDeregisteredApp`.
    try {
      await fsp.rmdir(path.dirname(file));
    } catch {
      /* non-empty or missing; expected for uploaded apps */
    }
  }

  // -------------------------------------------------------------------------
  // Per-app settings
  // -------------------------------------------------------------------------

  async getAppSettings(appId: string): Promise<TelemetryAppSettings> {
    if (this.closed) return { ...DEFAULT_SETTINGS };
    // Don't materialize a file just to answer "what are the defaults?".
    if (!this.conns.has(appId) && !existsSync(this.fileFor(appId))) {
      return { ...DEFAULT_SETTINGS };
    }
    const conn = this.getOrOpen(appId);
    return this.loadSettings(conn);
  }

  async setAppSettings(
    appId: string,
    patch: TelemetryAppSettingsPatch,
  ): Promise<TelemetryAppSettings> {
    if (this.closed) return { ...DEFAULT_SETTINGS };
    const conn = this.getOrOpen(appId);
    const current = this.loadSettings(conn);
    const next: TelemetryAppSettings = {
      enabled: patch.enabled ?? current.enabled,
      minLevel: patch.minLevel ?? current.minLevel,
      retentionDaysOverrides: patch.retentionDaysOverrides ?? current.retentionDaysOverrides,
    };

    const overridesText = next.retentionDaysOverrides
      ? JSON.stringify(next.retentionDaysOverrides)
      : null;
    conn.stmts.upsertSettings.run(next.enabled ? 1 : 0, next.minLevel, overridesText, this.now());
    conn.settings = next;
    return { ...next };
  }

  /**
   * Synchronous cached read against an already-opened conn. Falls back
   * to DEFAULT_SETTINGS if the file has no settings row. Called from
   * `recordHandler` on the hot path, so it must not touch disk after
   * the first hit per app.
   */
  private loadSettings(conn: AppConn): TelemetryAppSettings {
    if (conn.settings) return { ...conn.settings };
    const row = conn.stmts.getSettings.get() as
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
    conn.settings = settings;
    return { ...settings };
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Delete rows past their TTL across all currently-open connections.
   * Cold apps (no conn) are skipped — their expired rows accumulate
   * until next access. At day-scale TTLs and <10 active users that's
   * fine; if it ever becomes a problem we can extend this to glob
   * `<appsDir>/&star;/telemetry.sqlite`.
   */
  sweep(): { spans: number; events: number } {
    if (this.closed) return { spans: 0, events: 0 };
    const cutoff = this.now();
    let spans = 0;
    let events = 0;
    // Snapshot the keys so we can iterate without worrying about
    // promotion-on-access mutating the iteration order.
    const ids = Array.from(this.conns.keys());
    for (const id of ids) {
      const conn = this.conns.get(id);
      if (!conn) continue;
      // Bounded deletes so a large sweep doesn't hold the write lock for
      // seconds. Loop the LIMIT statement until each reports 0 changes.
      for (;;) {
        const r = conn.stmts.sweepSpans.run(cutoff, SWEEP_BATCH);
        const changes = Number(r.changes);
        spans += changes;
        if (changes === 0) break;
      }
      for (;;) {
        const r = conn.stmts.sweepEvents.run(cutoff, SWEEP_BATCH);
        const changes = Number(r.changes);
        events += changes;
        if (changes === 0) break;
      }
      try {
        conn.db.exec('PRAGMA incremental_vacuum(1000);');
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
    for (const conn of this.conns.values()) {
      try {
        conn.db.close();
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Per-app token-bucket admission with a 1-second window. Returns
   * false when the caller should be dropped. We deliberately do NOT
   * queue dropped records — the goal is to protect SQLite from a
   * runaway handler, and queuing would just defer the same write storm.
   *
   * The bucket lives on the conn, so each app gets its own ceiling.
   * A noisy app only starves itself.
   */
  private admit(conn: AppConn): boolean {
    if (this.maxRecordsPerSec <= 0) return true;
    const now = this.now();
    if (now - conn.bucketWindowStart >= 1000) {
      conn.bucketWindowStart = now;
      conn.bucketCount = 0;
      // Best-effort warn if we dropped records in the previous window,
      // rate-limited to one log per minute per app to avoid spam under storms.
      if (conn.droppedSinceLastWarn > 0 && now - conn.lastDropWarnAt >= 60_000) {
        conn.lastDropWarnAt = now;
        // eslint-disable-next-line no-console
        console.warn(
          `[centraid] telemetry: dropped ${conn.droppedSinceLastWarn} records under load`,
        );
        conn.droppedSinceLastWarn = 0;
      }
    }
    if (conn.bucketCount >= this.maxRecordsPerSec) {
      conn.droppedSinceLastWarn += 1;
      return false;
    }
    conn.bucketCount += 1;
    return true;
  }
}
