/*
 * Centraid SQLite state. app-engine owns one migration ladder — the
 * per-vault transcripts file — plus the shared open primitive
 * (`openMigratedDb` / `makeMigratedDbProvider`) that downstream ladders
 * (the vault package's own files stay vault-owned) reuse for the same
 * WAL/busy_timeout/FK pragmas.
 *
 *   transcripts (`<vaultDir>/<vaultId>/transcripts.db`) — one per vault,
 *                the vault's conversation ledger + automation KV + the
 *                run-summary rollup (issue #280: the vault is the unit;
 *                the old per-app `runtime.sqlite` and the central
 *                `analytics.sqlite` both folded into this file)
 *     conversations    — the first-class spine: one durable thread per
 *                        chat window, automation, or builder session.
 *                        `kind` (chat|automation|build) lives here — a
 *                        thread is single-kind. `app_id` scopes a thread
 *                        to its app INSIDE the shared per-vault file (the
 *                        per-app scoping used to be the file itself);
 *                        `user_id` carries the vault owner's party id.
 *                        A conversation binds to its vault at creation —
 *                        it lives in that vault's file, so a mid-thread
 *                        vault switch can never smear a thread across two
 *                        vaults (#280).
 *     turns            — one row per execution: a chat turn, an automation
 *                        fire, a builder iteration. `conversation_id` is a
 *                        NOT NULL, FK-backed, CASCADE spine. Carries
 *                        denormalized token/cost rollups written at finish.
 *     items            — the ordered agentic trace, INCLUDING the inbound
 *                        message. `kind='message_in'` (ordinal 0) is the
 *                        user/trigger input as a first-class message;
 *                        `step` is one model inference call; `tool`/`agent`
 *                        are per-call audit rows.
 *     attachments      — universal inbound-file rows (chat upload OR
 *                        webhook/email file), FK'd to the `message_in` item
 *                        they arrived on. Bytes live content-addressed on
 *                        disk at `<workspace appsDir>/<appId>/blobs/<hash>`,
 *                        never in sqlite. CASCADE off `items`.
 *     automation_state — per-automation KV, keyed by (automation_id, key).
 *     run_summary      — one denormalized row per finished run, every kind.
 *                        The Insights source. Best-effort write-through at
 *                        `finishTurn`; the ledger tables above stay
 *                        authoritative for a rebuild. Lives in the SAME
 *                        per-vault file (same derived/append-heavy growth
 *                        profile) so a central store can never aggregate
 *                        across vaults (#280).
 *
 *     `turns.conversation_id` and `items.turn_id` and `attachments.item_id`
 *     are real same-file FKs (CASCADE): deleting a conversation drops its
 *     turns, items, and attachment rows. `turns.parent_turn_id` stays a
 *     plain column (a sub-run's parent may be recorded before this row in
 *     the same transaction batch). Runtime-owned; never reachable from
 *     handler `db` or the `centraid_sql_*` agent tools.
 *
 * The old gateway identity file (`identity.sqlite`: users + user_prefs) is
 * gone — the vault owner IS the user (`core_vault.owner_party_id`), and
 * device-level prefs live in a plain JSON file (see `prefs-store.ts`).
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
 *
 * NOTE (#280): a provider may resolve to a DIFFERENT handle across calls —
 * the gateway wires "the ACTIVE vault's transcripts.db" as one provider, so
 * a vault switch changes what it returns. Stores that cache prepared
 * statements must compare the handle per call and re-prepare on change.
 */
export type DatabaseProvider = () => DatabaseSync;

/**
 * Per-vault transcripts migration ladder — `transcripts.db`
 * (issue #98 → #190 shape, moved per-vault and merged with the run-summary
 * rollup by #280).
 */
export const TRANSCRIPTS_MIGRATIONS: readonly string[] = [
  // 0 → 1: the per-vault conversation ledger + run-summary rollup. Pre-1.0
  // baseline (no production rows to migrate) — the move from per-app
  // `runtime.sqlite` + central `analytics.sqlite` is absorbed by this slot,
  // not a data migration (#280).
  `
    CREATE TABLE IF NOT EXISTS conversations (
      id                 TEXT PRIMARY KEY,
      kind               TEXT NOT NULL,
      user_id            TEXT NOT NULL,
      app_id             TEXT,
      automation_id      TEXT,
      title              TEXT NOT NULL DEFAULT '',
      adapter_kind       TEXT,
      adapter_session_id TEXT,
      turn_count         INTEGER NOT NULL DEFAULT 0,
      pinned             INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      CHECK (kind IN ('chat','automation','build'))
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
      ON conversations(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_app
      ON conversations(app_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_automation
      ON conversations(automation_id);

    CREATE TABLE IF NOT EXISTS turns (
      id                       TEXT PRIMARY KEY,
      conversation_id          TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      seq                      INTEGER NOT NULL,
      parent_turn_id           TEXT,
      trigger                  TEXT NOT NULL,
      trigger_origin           TEXT,
      note                     TEXT,
      summary                  TEXT,
      output_json              TEXT,
      retry_of                 TEXT,
      ok                       INTEGER NOT NULL DEFAULT 0,
      error                    TEXT,
      pinned                   INTEGER NOT NULL DEFAULT 0,
      started_at               INTEGER NOT NULL,
      ended_at                 INTEGER,
      total_input_tokens       INTEGER,
      total_output_tokens      INTEGER,
      total_cache_read_tokens  INTEGER,
      total_cache_write_tokens INTEGER,
      total_cost_usd           REAL,
      step_count               INTEGER,
      tool_count               INTEGER,
      CHECK (trigger IN ('scheduled','manual','replay','on_failure','interactive'))
    );
    CREATE INDEX IF NOT EXISTS idx_turns_conversation
      ON turns(conversation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_turns_started
      ON turns(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_turns_parent
      ON turns(parent_turn_id);

    CREATE TABLE IF NOT EXISTS items (
      id                 TEXT PRIMARY KEY,
      turn_id            TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      ordinal            INTEGER NOT NULL,
      batch_id           INTEGER,
      kind               TEXT NOT NULL,
      role               TEXT,
      text               TEXT,
      name               TEXT,
      args_json          TEXT,
      output_json        TEXT,
      child_turn_id      TEXT,
      model              TEXT,
      provider           TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cache_read_tokens  INTEGER,
      cache_write_tokens INTEGER,
      cost_usd           REAL,
      app_id             TEXT,
      ok                 INTEGER NOT NULL DEFAULT 1,
      error              TEXT,
      started_at         INTEGER NOT NULL,
      ended_at           INTEGER,
      duration_ms        INTEGER,
      CHECK (kind IN ('message_in','step','tool','agent'))
    );
    CREATE INDEX IF NOT EXISTS idx_items_by_turn
      ON items(turn_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_items_by_model
      ON items(model, started_at DESC);

    CREATE TABLE IF NOT EXISTS attachments (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      hash       TEXT NOT NULL,
      mime       TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      source     TEXT,
      filename   TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_item
      ON attachments(item_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_hash
      ON attachments(hash);

    CREATE TABLE IF NOT EXISTS automation_state (
      automation_id TEXT NOT NULL,
      key           TEXT NOT NULL,
      value_json    TEXT,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (automation_id, key)
    );

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

/** Open a vault's `transcripts.db` (conversations + turns + items + attachments + ctx.state + run_summary). */
export function openTranscriptsDb(dbPath: string): DatabaseSync {
  return openMigratedDb(dbPath, TRANSCRIPTS_MIGRATIONS, 'transcripts');
}

/** Lazy provider for a vault's `transcripts.db` ledger. */
export function makeTranscriptsDbProvider(dbPath: string): DatabaseProvider {
  return makeMigratedDbProvider(dbPath, TRANSCRIPTS_MIGRATIONS, 'transcripts');
}
