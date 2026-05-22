/*
 * Centraid gateway state — split across TWO SQLite files, each with its
 * own connection, migration ladder, and `PRAGMA user_version`:
 *
 *   gateway     (`centraid-gateway.sqlite`)
 *     users          — the user identity row(s). Single-user model today;
 *                      schema is multi-user-ready so a future shift to
 *                      multi-tenant doesn't need a column-add migration.
 *     user_prefs     — global prefs keyed by (user_id, key); JSON-encoded
 *                      values. Real FK-cascaded from `users` (same file).
 *
 *   activity    (`centraid-activity.sqlite`) — the unified agent-run ledger
 *     automations      — user-owned automations, keyed by a UUID `id`.
 *                        `user_id` is the owner; `name` is unique per
 *                        user. No `origin_app_id` — an automation is no
 *                        longer scoped to the app it was authored from
 *                        (issue #90 model-B).
 *     chat_sessions    — conversation containers, scoped by `user_id`. A
 *                        session is the single chat concept — its id IS
 *                        the chat window id. No `origin_app_id`: chat is
 *                        a flat per-user store (issue #90); `appId` is
 *                        per-turn context, never persisted on the session.
 *     runs             — one row per agent run. A chat turn, an automation
 *                        fire, and a builder iteration are the same object;
 *                        `kind` discriminates. Carries denormalized
 *                        token/cost rollups written at finish.
 *     run_nodes        — the ordered agentic trace. One row per model
 *                        inference call (`kind='step'`), tool call, or
 *                        sub-run. A chat turn's transcript is folded here:
 *                        `chat_messages` no longer exists (issue #90).
 *     automation_state — per-automation KV, keyed by (automation_id, key).
 *
 *     All five tables stay in one file so a sub-run can link its
 *     `parent_run_id` self-FK into one joinable DAG (a self-FK can't
 *     cross SQLite files), and `runs.chat_session_id` is a real same-file
 *     FK. Runtime-owned; never reachable from handler `db` or the
 *     `centraid_sql_*` agent tools.
 *
 * Each file gets one connection and one provider. The OpenClaw plugin's
 * worker subprocesses (which construct the runtime in every context but
 * only the gateway worker serves HTTP) never open a file unless they
 * actually serve a route, because providers open lazily.
 *
 * Migration policy: pre-1.0, the baseline slot can absorb shape changes.
 * Once we ship 1.0 we flip to strict append-only.
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * Lazy provider for a `DatabaseSync` handle. Stores call this once on
 * their first method invocation; the provider opens the file (and runs
 * migrations) on first call and caches the handle.
 *
 * Lazy because the OpenClaw plugin's `register()` runs in every worker
 * subprocess — only the gateway worker actually serves the HTTP routes
 * that touch this state, so deferring file open keeps stray DB handles
 * out of workers that never read or write.
 */
export type DatabaseProvider = () => DatabaseSync;

/**
 * Gateway file migration ladder — `users` + `user_prefs`. The user
 * identity gets its own table (rather than a key='id' row in a generic
 * key/value bag) so other tables can carry a real FK reference. Prefs
 * are scoped per user from day one — single-user today, but the shape
 * doesn't need to change if we ever go multi-tenant. `user_prefs`
 * cascades from `users` (same file).
 */
export const GATEWAY_MIGRATIONS: readonly string[] = [
  // 0 → 1: baseline schema for the gateway (users) file.
  `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `,
];

/**
 * Activity file migration ladder — the unified agent-run ledger
 * (issue #90). The `automations` table plus a generalized
 * `runs` / `run_nodes` ledger and the `automation_state` KV.
 *
 * `runs` / `run_nodes` are the run-audit tables from issue #80
 * generalized: a chat turn, an automation fire, and a builder iteration
 * are all the same object — an agent run — and `kind` discriminates.
 * `run_nodes.kind='step'` is the genuinely-new node: one primary
 * model-inference call, where per-call token + cost accounting lives.
 *
 * Model-B identity (issue #90): automations are user-owned and keyed by
 * a UUID `id` — no `origin_app_id`. A run for `kind='automation'` points
 * at `automation_id`; the JS-handler engine is gone, an automation fire
 * is now an agent turn driven by the manifest prompt. All tables stay in
 * one file so a sub-run can link its `parent_run_id` self-FK into one
 * joinable DAG. Runtime-owned; never reachable from handler `db` or the
 * `centraid_sql_*` agent tools.
 */
export const ACTIVITY_MIGRATIONS: readonly string[] = [
  // 0 → 1: drop the legacy `automations` definition table.
  //
  // Issue #91: an automation is a first-class *project* on disk — its
  // own directory under `automationsDir`, with `automation.json` as the
  // source of truth. There is no SQLite definition table any more; this
  // migration is edited in place (v0, no backfill) to drop the table a
  // pre-#91 build created.
  `
    DROP INDEX IF EXISTS idx_automations_user;
    DROP TABLE IF EXISTS automations;
  `,
  // 1 → 2: `chat_sessions` + the unified `runs` / `run_nodes` ledger +
  // automation KV (issue #90 — no backfill, v0).
  //
  // `chat_sessions` — conversation containers. The id IS the chat window
  // id. `user_id` is a plain column with no FK (`users` lives in the
  // separate gateway file); the relationship is application-enforced.
  // No `origin_app_id`: chat is a flat per-user store. The transcript is
  // NOT stored here — a chat turn is a `runs` row and its messages are
  // `run_nodes` (issue #90 fold; `chat_messages` is gone).
  //
  // `runs` — one row per agent run. `kind` discriminates
  // chat / automation / build; `automation_id` is set for
  // kind='automation', `chat_session_id` for kind='chat', `app_id` for
  // kind='build'. `chat_session_id` is a real same-file FK so deleting a
  // session cascades its turns. `parent_run_id` is the sub-run DAG edge.
  // The `total_*` columns are a denormalized rollup written at finish,
  // exclusive of child sub-runs, so a SUM over every run is the true
  // grand total with no double-count.
  //
  // `run_nodes` — the ordered trace. `kind='step'` is one primary
  // model-inference call (token accounting lives here — input tokens
  // compound across steps, cache read/write differ per call);
  // `kind IN ('tool','agent','invoke')` are the per-call audit rows.
  // `cost_usd` is frozen at write time from a per-model price table;
  // NULL means "no price known" (distinct from a genuine $0).
  `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL,
      title              TEXT NOT NULL DEFAULT '',
      mode               TEXT NOT NULL DEFAULT 'full',
      adapter_kind       TEXT,
      adapter_session_id TEXT,
      turn_count         INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
      ON chat_sessions(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS runs (
      id                       TEXT PRIMARY KEY,
      kind                     TEXT NOT NULL DEFAULT 'automation',
      automation_id            TEXT,
      chat_session_id          TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
      app_id                   TEXT,
      trigger                  TEXT NOT NULL,
      parent_run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
      note                     TEXT,
      summary                  TEXT,
      input_json               TEXT,
      output_json              TEXT,
      ok                       INTEGER NOT NULL DEFAULT 0,
      error                    TEXT,
      pinned                   INTEGER NOT NULL DEFAULT 0,
      retry_of                 TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_runs_automation_started
      ON runs(automation_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_started
      ON runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_chat_session
      ON runs(chat_session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_parent
      ON runs(parent_run_id);

    CREATE TABLE IF NOT EXISTS run_nodes (
      id                 TEXT PRIMARY KEY,
      run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ordinal            INTEGER NOT NULL,
      batch_id           INTEGER,
      kind               TEXT NOT NULL,
      model              TEXT,
      provider           TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cache_read_tokens  INTEGER,
      cache_write_tokens INTEGER,
      cost_usd           REAL,
      app_id             TEXT,
      name               TEXT,
      args_json          TEXT,
      output_json        TEXT,
      child_run_id       TEXT,
      ok                 INTEGER NOT NULL DEFAULT 1,
      error              TEXT,
      started_at         INTEGER NOT NULL,
      ended_at           INTEGER,
      duration_ms        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_run_nodes_by_run
      ON run_nodes(run_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_run_nodes_by_model
      ON run_nodes(model, started_at DESC);

    CREATE TABLE IF NOT EXISTS automation_state (
      automation_id TEXT NOT NULL,
      key           TEXT NOT NULL,
      value_json    TEXT,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (automation_id, key)
    );
  `,
  // 2 → 3: `runs.trigger_origin` — what *source* fired the run (issue
  // #96). Once an automation can fire from a cron schedule, an inbound
  // webhook, or an explicit "Run now", the Executions tab needs to show
  // which. Nullable: pre-#96 rows leave it NULL.
  `
    ALTER TABLE runs ADD COLUMN trigger_origin TEXT;
  `,
];

/**
 * Run the pending migration tail of `migrations` against `db`. `label`
 * names the file in the version-mismatch error. Idempotent on an
 * already-current DB; throws if the DB is at a version newer than this
 * build understands.
 */
function migrate(db: DatabaseSync, migrations: readonly string[], label: string): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > migrations.length) {
    throw new Error(
      `${label} DB is at version ${current} but this build only supports up to ${migrations.length}. ` +
        `Please update centraid before opening this database.`,
    );
  }
  if (current === migrations.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = current; v < migrations.length; v++) {
      db.exec(migrations[v]!);
      // v is a loop index bounded by migrations.length, never user input,
      // so it's safe to interpolate into the PRAGMA (which doesn't accept
      // bind parameters).
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
 * Open a centraid DB file at `dbPath`, set the per-connection pragmas
 * (WAL journal, FK enforcement), and run the pending migration tail of
 * `migrations`. Idempotent on an already-current DB; throws if the DB is
 * at a version newer than this build understands.
 *
 * Pragmas must run outside any transaction (journal_mode in particular),
 * so they happen before migrate() opens its BEGIN IMMEDIATE block.
 */
function openDb(dbPath: string, migrations: readonly string[], label: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
  `);
  migrate(db, migrations, label);
  return db;
}

/**
 * Wrap a fixed `dbPath` into a lazy `DatabaseProvider`. The provider
 * opens the file on the first call (running migrations as a side effect)
 * and caches the handle for subsequent calls.
 */
function makeProvider(
  dbPath: string,
  migrations: readonly string[],
  label: string,
): DatabaseProvider {
  let db: DatabaseSync | undefined;
  return () => {
    if (!db) db = openDb(dbPath, migrations, label);
    return db;
  };
}

/** Open the gateway (users + user_prefs) DB file. */
export function openGatewayDb(dbPath: string): DatabaseSync {
  return openDb(dbPath, GATEWAY_MIGRATIONS, 'gateway');
}

/** Lazy provider for the gateway (users + user_prefs) DB file. */
export function makeGatewayDbProvider(dbPath: string): DatabaseProvider {
  return makeProvider(dbPath, GATEWAY_MIGRATIONS, 'gateway');
}

/** Open the activity (automations + chat_sessions + runs + run_nodes + ctx.state) DB file. */
export function openActivityDb(dbPath: string): DatabaseSync {
  return openDb(dbPath, ACTIVITY_MIGRATIONS, 'activity');
}

/** Lazy provider for the activity (automations + chat_sessions + runs + run_nodes + ctx.state) DB file. */
export function makeActivityDbProvider(dbPath: string): DatabaseProvider {
  return makeProvider(dbPath, ACTIVITY_MIGRATIONS, 'activity');
}
