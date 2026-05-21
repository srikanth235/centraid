/*
 * Centraid gateway state — split across THREE SQLite files, each with its
 * own connection, migration ladder, and `PRAGMA user_version`:
 *
 *   gateway     (`centraid-gateway.sqlite`)
 *     users          — the user identity row(s). Single-user model today;
 *                      schema is multi-user-ready so a future shift to
 *                      multi-tenant doesn't need a column-add migration.
 *     user_prefs     — global prefs keyed by (user_id, key); JSON-encoded
 *                      values. Real FK-cascaded from `users` (same file).
 *
 *   chat        (`centraid-chat.sqlite`)
 *     chat_sessions  — chat sessions, scoped by `user_id`. A session is the
 *                      single chat concept — its id IS the chat window id.
 *                      Carries a nullable `origin_app_id` (the app the chat
 *                      was opened from; NULL = started from the centraid
 *                      shell), a sticky `mode` ('full' | 'data'), per-turn
 *                      `turn_count`, and the runner-resume handle
 *                      (`adapter_kind` + `adapter_session_id`).
 *
 *                      NOTE: `chat_sessions.user_id` is *application-enforced*,
 *                      NOT a real foreign key. `users` lives in a different
 *                      SQLite file and SQLite has no cross-file foreign keys,
 *                      so deleting a user no longer cascades its sessions —
 *                      callers must clean those up themselves.
 *     chat_messages  — append-only message log, real FK-cascaded from
 *                      `chat_sessions` (same file). Each row carries a
 *                      nullable `app_id` naming the app a tool call in that
 *                      message touched.
 *
 *   automations (`centraid-automations.sqlite`)
 *     automations    — centraid's mirror of registered automations, keyed
 *                      by (origin_app_id, name).
 *     automation_runs / automation_run_nodes / automation_state
 *                    — the automation run-audit + ctx.state surface
 *                      (issue #80). One run row per automation fire, one
 *                      node row per ctx.tool/ctx.agent/ctx.invoke call,
 *                      one state row per (automation, key). Runtime-owned;
 *                      never reachable from handler `db` or the
 *                      `centraid_sql_*` agent tools. All three tables stay
 *                      together so a cross-app `ctx.invoke` child can link
 *                      its `parent_run_id` self-FK into one joinable DAG.
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
 * Chat file migration ladder — `chat_sessions` + `chat_messages`.
 *
 * `chat_sessions.user_id` is kept as a plain column but has NO foreign
 * key: `users` now lives in a different SQLite file and cross-file FKs
 * aren't possible. The relationship is application-enforced. `chat_messages`
 * still cascades from `chat_sessions` (same file).
 */
export const CHAT_MIGRATIONS: readonly string[] = [
  // 0 → 1: baseline schema for the chat file.
  `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      origin_app_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'full',
      adapter_kind TEXT,
      adapter_session_id TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_app_updated
      ON chat_sessions(user_id, origin_app_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      app_id TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, idx),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id);
  `,
];

/**
 * Automations file migration ladder — the `automations` mirror plus the
 * automation run-audit + ctx.state tables. All three audit tables stay
 * in one file so a cross-app `ctx.invoke` child run can link its
 * `parent_run_id` self-FK into one joinable DAG (a self-FK can't cross
 * SQLite files). Runtime-owned; never reachable from handler `db` or the
 * `centraid_sql_*` agent tools.
 */
export const AUTOMATION_MIGRATIONS: readonly string[] = [
  // 0 → 1: automations mirror table.
  //
  // The cron schedule itself + last/next-run telemetry live in the host
  // scheduler (openclaw cron on remote, OS scheduler on local — see
  // issue #70). This table is centraid's own *mirror* so the desktop UI
  // can list automations per app, the reconciliation pass at
  // `gateway_start` can diff DB-vs-host to clean up zombies, and editors
  // have one place to read the canonical prompt + manifest.
  //
  // We don't FK to the apps registry (`_registry.json`) — it's a file,
  // not a SQLite table — but the reconciliation pass treats a missing
  // origin_app_id as "stale, remove." `origin_app_id` is nullable for
  // forward-compat with app-less automations (not built in v0); today
  // it is always set.
  `
    CREATE TABLE IF NOT EXISTS automations (
      origin_app_id TEXT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      manifest_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (origin_app_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_automations_app
      ON automations(origin_app_id);
  `,
  // 1 → 2: automation run-audit + ctx.state tables (issue #80).
  //
  // `origin_app_id` is nullable on `automation_runs` / `automation_state`
  // for forward-compat with app-less automations (not built in v0);
  // today it is always set. `automation_runs.parent_run_id` uses
  // `ON DELETE SET NULL` so deleting one app's runs doesn't FK-fail
  // when another app has a cross-app child pointing at them.
  `
    CREATE TABLE IF NOT EXISTS automation_runs (
      run_id          TEXT PRIMARY KEY,
      origin_app_id   TEXT,
      automation_name TEXT NOT NULL,
      trigger_kind    TEXT NOT NULL,
      parent_run_id   TEXT REFERENCES automation_runs(run_id) ON DELETE SET NULL,
      input_json      TEXT,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      ok              INTEGER NOT NULL DEFAULT 0,
      error           TEXT,
      summary         TEXT,
      output_json     TEXT,
      pinned          INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_app_name_started
      ON automation_runs(origin_app_id, automation_name, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_parent
      ON automation_runs(parent_run_id);

    CREATE TABLE IF NOT EXISTS automation_run_nodes (
      node_id       TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES automation_runs(run_id) ON DELETE CASCADE,
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
      output_tokens INTEGER,
      child_run_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_automation_run_nodes_by_run
      ON automation_run_nodes(run_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_automation_run_nodes_by_tool
      ON automation_run_nodes(name, started_at DESC);

    CREATE TABLE IF NOT EXISTS automation_state (
      origin_app_id   TEXT,
      automation_name TEXT NOT NULL,
      key             TEXT NOT NULL,
      value_json      TEXT,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (origin_app_id, automation_name, key)
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

/** Open the chat (chat_sessions + chat_messages) DB file. */
export function openChatDb(dbPath: string): DatabaseSync {
  return openDb(dbPath, CHAT_MIGRATIONS, 'chat');
}

/** Lazy provider for the chat (chat_sessions + chat_messages) DB file. */
export function makeChatDbProvider(dbPath: string): DatabaseProvider {
  return makeProvider(dbPath, CHAT_MIGRATIONS, 'chat');
}

/** Open the automations (mirror + run-audit + ctx.state) DB file. */
export function openAutomationDb(dbPath: string): DatabaseSync {
  return openDb(dbPath, AUTOMATION_MIGRATIONS, 'automation');
}

/** Lazy provider for the automations (mirror + run-audit + ctx.state) DB file. */
export function makeAutomationDbProvider(dbPath: string): DatabaseProvider {
  return makeProvider(dbPath, AUTOMATION_MIGRATIONS, 'automation');
}
