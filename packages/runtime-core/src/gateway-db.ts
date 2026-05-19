/*
 * Centraid gateway state — single SQLite file (`centraid-gateway.sqlite`)
 * holding every per-user record the gateway owns:
 *
 *   users          — the user identity row(s). Single-user model today;
 *                    schema is multi-user-ready so a future shift to
 *                    multi-tenant doesn't need a column-add migration.
 *   user_prefs     — global prefs keyed by (user_id, key); JSON-encoded
 *                    values. FK-cascaded from `users`.
 *   chat_sessions  — chat-pane sessions, scoped by user_id (FK-cascaded
 *                    from `users`) and app_id. Real FK so deleting a user
 *                    cleans up their sessions atomically.
 *   chat_messages  — append-only message log, FK-cascaded from
 *                    `chat_sessions`.
 *
 * One file, one connection, one migration ladder, real foreign keys
 * (`PRAGMA foreign_keys=ON`). UserStore + ChatHistoryStore both wrap
 * the same `DatabaseSync` handle through a shared `DatabaseProvider`
 * lazy getter — the OpenClaw plugin's worker subprocesses (which
 * construct the runtime in every context but only the gateway worker
 * serves HTTP) never open the file unless they actually serve a route.
 *
 * The earlier two-file split (`centraid-user.sqlite` +
 * `centraid-chat-history.sqlite`) was path-dependent, not principled —
 * we lived with an application-enforced FK on `chat_sessions.user_id`
 * because cross-attached-DB FKs aren't a thing in SQLite. Pre-1.0 with
 * a single-user model and both files in the same directory anyway, the
 * FK + atomic cross-table ops + single backup target are clear wins.
 *
 * Migration policy: pre-1.0, the baseline slot can absorb shape
 * changes. Once we ship 1.0 we flip to strict append-only.
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * Lazy provider for the shared gateway `DatabaseSync` handle. Both stores
 * call this once on their first method invocation; the provider opens the
 * file (and runs migrations) on first call and caches the handle.
 *
 * Lazy because the OpenClaw plugin's `register()` runs in every worker
 * subprocess — only the gateway worker actually serves the HTTP routes
 * that touch this state, so deferring file open keeps stray DB handles
 * out of workers that never read or write.
 */
export type DatabaseProvider = () => DatabaseSync;

export const MIGRATIONS: readonly string[] = [
  // 0 → 1: baseline schema for the entire gateway state file.
  //
  // The user identity gets its own table (rather than a key='id' row in a
  // generic key/value bag) so other tables can carry a real FK reference.
  // Prefs are scoped per user from day one — single-user today, but the
  // shape doesn't need to change if we ever go multi-tenant.
  //
  // All cross-table relationships use `ON DELETE CASCADE` so a `DELETE
  // FROM users WHERE id=?` cleans up that user's prefs, sessions, and
  // messages atomically inside one transaction.
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

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_app_updated
      ON chat_sessions(user_id, app_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, idx),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id);
  `,
  // 1 → 2: automations mirror table.
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
  // app_id as "stale, remove."
  `
    CREATE TABLE IF NOT EXISTS automations (
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      manifest_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_automations_app
      ON automations(app_id);
  `,
];

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `gateway DB is at version ${current} but this build only supports up to ${MIGRATIONS.length}. ` +
        `Please update centraid before opening this database.`,
    );
  }
  if (current === MIGRATIONS.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]!);
      // v is a loop index bounded by MIGRATIONS.length, never user input,
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
 * Open the gateway DB file at `dbPath`, set the per-connection pragmas
 * (WAL journal, FK enforcement), and run the pending migration tail.
 * Idempotent on an already-current DB; throws if the DB is at a version
 * newer than this build understands.
 *
 * Pragmas must run outside any transaction (journal_mode in particular),
 * so they happen before migrate() opens its BEGIN IMMEDIATE block.
 */
export function openGatewayDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
  `);
  migrate(db);
  return db;
}

/**
 * Wrap a fixed `dbPath` into a lazy `DatabaseProvider`. The provider
 * opens the file on the first call (running migrations as a side effect)
 * and caches the handle for subsequent calls. Hosts hand the same
 * provider to every store that wraps the gateway DB so they all share
 * one connection.
 */
export function makeGatewayDbProvider(dbPath: string): DatabaseProvider {
  let db: DatabaseSync | undefined;
  return () => {
    if (!db) db = openGatewayDb(dbPath);
    return db;
  };
}
