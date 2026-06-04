/*
 * The central analytics migration ladder — `centraid-analytics.sqlite`
 * (issue #98, decision 4). The Insights domain, folded into app-engine under
 * `insights/` while keeping its own barrel and one-way internal boundary (#151).
 *
 * Push-based analytics: at run completion the runtime write-throughs a
 * one-row summary to this gateway-scoped file. Full run detail stays in the
 * per-app `runtime.sqlite` (automation *and* chat runs); this file is the
 * single source the Insights screen reads, so it has no cross-file scan and no
 * cron aggregator. The write is best-effort — a failure never fails the run,
 * and the per-app file stays authoritative for a future backfill.
 *
 * The provider is built through app-engine's shared `openMigratedDb` /
 * `makeMigratedDbProvider` so this file opens with the same load-bearing
 * WAL / `busy_timeout` / FK pragmas and the same migrate runner as every other
 * centraid SQLite file.
 */

import { openMigratedDb, makeMigratedDbProvider, type DatabaseProvider } from '../stores/gateway-db.js';
import type { DatabaseSync } from 'node:sqlite';

export const ANALYTICS_MIGRATIONS: readonly string[] = [
  // 0 → 1: one summary row per agent run, every kind.
  `
    CREATE TABLE IF NOT EXISTS run_summary (
      run_id                   TEXT PRIMARY KEY,
      kind                     TEXT NOT NULL,
      automation_ref           TEXT,
      app_id                   TEXT,
      trigger                  TEXT NOT NULL,
      trigger_origin           TEXT,
      ok                       INTEGER NOT NULL DEFAULT 0,
      pinned                   INTEGER NOT NULL DEFAULT 0,
      summary                  TEXT,
      note                     TEXT,
      error                    TEXT,
      retry_of                 TEXT,
      model                    TEXT,
      started_at               INTEGER NOT NULL,
      ended_at                 INTEGER,
      total_input_tokens       INTEGER,
      total_output_tokens      INTEGER,
      total_cache_read_tokens  INTEGER,
      total_cache_write_tokens INTEGER,
      total_cost_usd           REAL,
      step_count               INTEGER,
      tool_count               INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_run_summary_started
      ON run_summary(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_run_summary_kind_ref
      ON run_summary(kind, automation_ref, started_at DESC);
  `,
];

/** Open the central `centraid-analytics.sqlite` (run summaries). */
export function openAnalyticsDb(dbPath: string): DatabaseSync {
  return openMigratedDb(dbPath, ANALYTICS_MIGRATIONS, 'analytics');
}

/** Lazy provider for the central `centraid-analytics.sqlite` file. */
export function makeAnalyticsDbProvider(dbPath: string): DatabaseProvider {
  return makeMigratedDbProvider(dbPath, ANALYTICS_MIGRATIONS, 'analytics');
}
