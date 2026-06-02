/*
 * Centraid SQLite state. app-engine owns two migration ladders — the
 * gateway (identity) file and the per-app runtime (ledger) file — each with
 * its own connection and `PRAGMA user_version`. The shared open primitive
 * (`openMigratedDb` / `makeMigratedDbProvider`) is exported so downstream
 * ladders reuse the same WAL/busy_timeout/FK pragmas: the `insights/`
 * sub-module owns the third ladder (`centraid-analytics.sqlite`, run summaries)
 * and builds its provider through these helpers (#151).
 *
 *   gateway     (`centraid-gateway.sqlite`) — gateway-scoped identity
 *     users          — the user identity row(s). Single-user model today;
 *                      schema is multi-user-ready so a future shift to
 *                      multi-tenant doesn't need a column-add migration.
 *     user_prefs     — global prefs keyed by (user_id, key); JSON-encoded
 *                      values. Real FK-cascaded from `users` (same file).
 *
 *   runtime     (`<appRoot>/runtime.sqlite`) — one per app, the app's
 *                run ledger + chat history + automation KV
 *     chat_sessions    — conversation containers, scoped by `user_id`. A
 *                        session is the single chat concept — its id IS
 *                        the chat window id. Chat is app-scoped (#98):
 *                        every session belongs to the app whose file it
 *                        lives in.
 *     runs             — one row per agent run. A chat turn and an
 *                        automation fire are the same object; `kind`
 *                        discriminates. Carries denormalized token/cost
 *                        rollups written at finish.
 *     run_nodes        — the ordered agentic trace. One row per model
 *                        inference call (`kind='step'`), tool call, or
 *                        sub-run. A chat turn's transcript is folded here.
 *     automation_state — per-automation KV, keyed by (automation_id, key).
 *
 *     Within one app's file `runs.chat_session_id` is a real same-file
 *     FK; `parent_run_id` is a plain column (a cross-app `ctx.invoke`
 *     sub-run's parent lives in another file). Runtime-owned; never
 *     reachable from handler `db` or the `centraid_sql_*` agent tools.
 *
 * (The third ladder — `centraid-analytics.sqlite`, one `run_summary` row per
 * run, the Insights source — lives in the `insights/` sub-module, built through
 * the exported `makeMigratedDbProvider` helper.)
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
/**
 * Per-app run-ledger migration ladder — `runtime.sqlite` (issue #98).
 *
 * Decision 3 of the #98 revision: an app's automation run ledger,
 * chat sessions, and `ctx.state` are per-app, in
 * `<appRoot>/runtime.sqlite` — a separate file from the handler-owned
 * `data.sqlite`, version-persistent. The global
 * `centraid-activity.sqlite` is gone; chat is app-scoped now.
 *
 * `chat_sessions` is the conversation-container table; a chat turn is a
 * `runs` row (`kind='chat'`) and `runs.chat_session_id` is a real
 * same-file FK so deleting a session cascades its turns. The other
 * sub-run edge — `parent_run_id` — stays a plain column with no FK: a
 * cross-app `ctx.invoke` sub-run's parent lives in a *different* app's
 * file and a SQLite FK cannot span files.
 */
export const RUNTIME_MIGRATIONS: readonly string[] = [
  // 0 → 1: the per-app run ledger + chat sessions. `runs.trigger_origin`
  // is in the baseline (a fresh file never needs the #96 column-add).
  `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL,
      title              TEXT NOT NULL DEFAULT '',
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
      trigger_origin           TEXT,
      parent_run_id            TEXT,
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
export function openMigratedDb(
  dbPath: string,
  migrations: readonly string[],
  label: string,
): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // busy_timeout: wait up to 30s for a lock instead of failing
  // immediately. Multi-client gateway (standalone daemon) makes this
  // load-bearing; the Electron embed sees only one client so the gap
  // was previously latent.
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=30000;
  `);
  migrate(db, migrations, label);
  return db;
}

/**
 * Wrap a fixed `dbPath` into a lazy `DatabaseProvider`. The provider
 * opens the file on the first call (running migrations as a side effect)
 * and caches the handle for subsequent calls.
 */
export function makeMigratedDbProvider(
  dbPath: string,
  migrations: readonly string[],
  label: string,
): DatabaseProvider {
  let db: DatabaseSync | undefined;
  return () => {
    if (!db) db = openMigratedDb(dbPath, migrations, label);
    return db;
  };
}

/** Open the gateway (users + user_prefs) DB file. */
export function openGatewayDb(dbPath: string): DatabaseSync {
  return openMigratedDb(dbPath, GATEWAY_MIGRATIONS, 'gateway');
}

/** Lazy provider for the gateway (users + user_prefs) DB file. */
export function makeGatewayDbProvider(dbPath: string): DatabaseProvider {
  return makeMigratedDbProvider(dbPath, GATEWAY_MIGRATIONS, 'gateway');
}

/** Open an app's per-app `runtime.sqlite` (chat_sessions + runs + run_nodes + ctx.state). */
export function openRuntimeDb(dbPath: string): DatabaseSync {
  return openMigratedDb(dbPath, RUNTIME_MIGRATIONS, 'runtime');
}

/** Lazy provider for an app's per-app `runtime.sqlite` run ledger. */
export function makeRuntimeDbProvider(dbPath: string): DatabaseProvider {
  return makeMigratedDbProvider(dbPath, RUNTIME_MIGRATIONS, 'runtime');
}
