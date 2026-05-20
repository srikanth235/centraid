/*
 * Per-app `automations.sqlite` schema, types, and migration ladder.
 *
 * The file holds three tables — `runs`, `run_nodes`, `state` —
 * documented in detail in `automation-runs-store.ts`. The schema is
 * exported separately so callers (the desktop UI in particular) can
 * import the row types without pulling in the SQLite-backed store
 * implementation.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export const AUTOMATIONS_DB_FILE = 'automations.sqlite';

export type AutomationTriggerKind = 'scheduled' | 'manual' | 'replay' | 'on_failure';
export type AutomationRunNodeKind = 'tool' | 'agent';

export interface AutomationRunRow {
  readonly runId: string;
  readonly automationName: string;
  readonly triggerKind: AutomationTriggerKind;
  readonly parentRunId?: string;
  readonly inputJson?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly summary?: string;
  readonly outputJson?: string;
}

export interface AutomationRunNodeRow {
  readonly nodeId: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly batchId?: number;
  readonly kind: AutomationRunNodeKind;
  readonly name: string;
  readonly argsJson?: string;
  readonly outputJson?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface AutomationStateEntry {
  readonly automationName: string;
  readonly key: string;
  readonly valueJson: string;
  readonly updatedAt: number;
}

export const AUTOMATIONS_MIGRATIONS: readonly string[] = [
  // 0 → 1: baseline audit schema. See issue #80 § Schema.
  `
    CREATE TABLE IF NOT EXISTS runs (
      run_id          TEXT PRIMARY KEY,
      automation_name TEXT NOT NULL,
      trigger_kind    TEXT NOT NULL,
      parent_run_id   TEXT REFERENCES runs(run_id),
      input_json      TEXT,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      ok              INTEGER NOT NULL DEFAULT 0,
      error           TEXT,
      summary         TEXT,
      output_json     TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_by_name_started
      ON runs(automation_name, started_at DESC);

    CREATE TABLE IF NOT EXISTS run_nodes (
      node_id       TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      ordinal       INTEGER NOT NULL,
      batch_id      INTEGER,
      kind          TEXT NOT NULL,
      name          TEXT NOT NULL,
      args_json     TEXT,
      output_json   TEXT,
      ok            INTEGER NOT NULL,
      error         TEXT,
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER,
      duration_ms   INTEGER,
      input_tokens  INTEGER,
      output_tokens INTEGER
    );
    CREATE INDEX IF NOT EXISTS run_nodes_by_run
      ON run_nodes(run_id, ordinal);
    CREATE INDEX IF NOT EXISTS run_nodes_by_tool
      ON run_nodes(name, started_at DESC);

    CREATE TABLE IF NOT EXISTS state (
      automation_name TEXT NOT NULL,
      key             TEXT NOT NULL,
      value_json      TEXT,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (automation_name, key)
    );
  `,
];

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > AUTOMATIONS_MIGRATIONS.length) {
    throw new Error(
      `automations.sqlite is at version ${current} but this build only supports up to ${AUTOMATIONS_MIGRATIONS.length}. ` +
        `Please update centraid before opening this database.`,
    );
  }
  if (current === AUTOMATIONS_MIGRATIONS.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = current; v < AUTOMATIONS_MIGRATIONS.length; v++) {
      db.exec(AUTOMATIONS_MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/**
 * Open the per-app `automations.sqlite` file at the given path,
 * configure pragmas, and run pending migrations. Idempotent.
 */
export function openAutomationsDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
  `);
  migrate(db);
  return db;
}

/**
 * Resolve the path to the per-app `automations.sqlite` from the app's
 * data directory. Mirrors how `data.sqlite` lives at `<appDir>/data.sqlite`.
 */
export function automationsDbPath(appDir: string): string {
  return path.join(appDir, AUTOMATIONS_DB_FILE);
}
