/*
 * Centraid SQLite state. app-engine owns the CONVERSATION-LEDGER BAND of the
 * vault's `journal.db` — the old standalone `transcripts.db` folded into the
 * journal file (one fewer file per vault; both carry the same append-heavy,
 * derived-growth profile that keeps `vault.db` — the sovereign asset — small).
 *
 *   journal.db (`<vaultDir>/<vaultId>/journal.db`) — one per vault, TWO bands:
 *     · the audit band (consent receipts, provenance, invocations, checks) —
 *       owned by the vault package, versioned by ITS single-rung ladder via
 *       `PRAGMA user_version`, append-only by contract;
 *     · the conversation-ledger band (this module) — the vault's conversation
 *       ledger + automation KV + the run-summary rollup. Runtime-owned and
 *       mutable (turns finish, titles change, CASCADE deletes), so it is NOT
 *       part of the append-only audit contract.
 *
 *   Ledger-band tables:
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
 *                        The band's one semantic misfit: mutable WORKING
 *                        state (trigger cursors, handler KV), not history.
 *                        It stays for pragmatics — per-vault, transactional
 *                        with fires, travels with export; its true kin is
 *                        the sync spine's cursor sidecars in vault.db, and
 *                        it can promote there if backup asymmetry ever
 *                        makes the placement matter.
 *     run_summary      — a VIEW over turns ⋈ conversations (+ dominant
 *                        model from items): one row per finished run, every
 *                        kind — the Insights source. The ledger tables ARE
 *                        the data; there is no write path and nothing to
 *                        rebuild. Scoped per vault so a central store can
 *                        never aggregate across vaults (#280).
 *
 *     `turns.conversation_id` and `items.turn_id` and `attachments.item_id`
 *     are real same-file FKs (CASCADE): deleting a conversation drops its
 *     turns, items, and attachment rows. `turns.parent_turn_id` stays a
 *     plain column (a sub-run's parent may be recorded before this row in
 *     the same transaction batch). Runtime-owned; never reachable from
 *     handler `db` or the `centraid_sql_*` agent tools.
 *
 * Versioning: the file's `PRAGMA user_version` belongs to the vault package's
 * audit-band ladder — this module must never stamp it. The ledger band is
 * instead ENSURED on open: every statement below is `IF NOT EXISTS`, so
 * `ensureConversationLedger` is idempotent, safe against a file the vault has
 * already migrated, and safe in the reverse order too (a worker that opens the
 * journal before the vault does creates only the ledger band; the vault's
 * ladder still runs from user_version 0 when the plane mounts). Pre-1.0 a
 * ledger shape change edits the DDL in place and dev vaults are recreated
 * (v0: no data migrations); post-1.0 the band gets its own versioning story.
 *
 * The old gateway identity file (`identity.sqlite`: users + user_prefs) is
 * gone — the vault owner IS the user (`core_vault.owner_party_id`), and
 * device-level prefs live in a plain JSON file (see `prefs-store.ts`).
 *
 * Each opener gets one connection per file. A host's worker subprocesses
 * (which may construct the runtime in every context but only the gateway
 * worker serves HTTP) never open a file unless they actually serve a route,
 * because providers open lazily. A worker connection coexists with the
 * gateway's own journal handle via WAL + busy_timeout.
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * Lazy provider for a `DatabaseSync` handle. Stores call this once on
 * their first method invocation; the provider opens the file (and ensures
 * the ledger band) on first call and caches the handle.
 *
 * Lazy because a host's registration code may run in every worker
 * subprocess — only the gateway worker actually serves the HTTP routes
 * that touch this state, so deferring file open keeps stray DB handles
 * out of workers that never read or write.
 *
 * NOTE (#280): a provider may resolve to a DIFFERENT handle across calls —
 * the gateway wires "the ACTIVE vault's journal.db" as one provider, so
 * a vault switch changes what it returns. Stores that cache prepared
 * statements must compare the handle per call and re-prepare on change.
 */
export type DatabaseProvider = () => DatabaseSync;

/**
 * The conversation-ledger band of the vault's `journal.db` (issue #98 → #190
 * shape, moved per-vault and merged with the run-summary rollup by #280,
 * folded from the standalone `transcripts.db` into the journal file).
 * Every statement is `IF NOT EXISTS` — see the versioning note above.
 */
export const CONVERSATION_LEDGER_DDL = `
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
      archived           INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      CHECK (kind IN ('chat','automation','build'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
      ON conversations(user_id, pinned DESC, updated_at DESC);
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
      idempotency_key          TEXT,
      ok                       INTEGER NOT NULL DEFAULT 0,
      error                    TEXT,
      feedback                 TEXT,
      -- Persisted non-fatal system notes for the turn (issue #424): a JSON
      -- array of {level, code?, message}. Backs the visible context-reset
      -- note so a reload replays what the live stream showed. NULL = none.
      notices                  TEXT,
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
      CHECK (trigger IN ('scheduled','manual','replay','on_failure','compile','interactive')),
      CHECK (feedback IS NULL OR feedback IN ('up','down'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_turns_conversation
      ON turns(conversation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_turns_started
      ON turns(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_turns_parent
      ON turns(parent_turn_id);
    -- Idempotency lookup (issue #420, Wave 6): a duplicate turn POST with the
    -- same key on the same conversation resolves to the already-recorded turn
    -- instead of re-running. Not UNIQUE — automations/legacy rows leave it NULL.
    CREATE INDEX IF NOT EXISTS idx_turns_idempotency
      ON turns(conversation_id, idempotency_key);

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
    ) STRICT;
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
    ) STRICT;
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
    ) STRICT;

    -- run_summary is a VIEW, not a table: one row per FINISHED run, every
    -- kind — the Insights/Executions source. It used to be a denormalized
    -- table maintained by a best-effort dual write at finishTurn, justified
    -- when the rollup lived in a different file (central analytics.sqlite,
    -- #280); with the ledger and the rollup in ONE file there is no boundary
    -- left to denormalize across, so the ledger tables above are simply THE
    -- source and the view is the lens (no write path, no drift).
    -- automation_ref/app_id derivation and the dominant-model pick
    -- mirror the old write-through exactly.
    CREATE VIEW IF NOT EXISTS run_summary AS
      SELECT
        t.id             AS run_id,
        c.kind           AS kind,
        CASE WHEN c.kind = 'automation' THEN c.automation_id END AS automation_ref,
        CASE
          WHEN c.kind = 'automation' AND instr(c.automation_id, '/') > 1
            THEN substr(c.automation_id, 1, instr(c.automation_id, '/') - 1)
          ELSE c.app_id
        END              AS app_id,
        -- The automation's display name (issue: orphaned runs showing the raw
        -- ref) — conversations.title is refreshed when the stable automation
        -- conversation is ensured and outlives the automation manifest being
        -- deleted. NULLIF empties it out since the column defaults to ''.
        CASE WHEN c.kind = 'automation' THEN NULLIF(c.title, '') END AS automation_name,
        t.trigger        AS trigger,
        t.trigger_origin AS trigger_origin,
        t.ok             AS ok,
        t.pinned         AS pinned,
        t.summary        AS summary,
        t.note           AS note,
        t.error          AS error,
        t.retry_of       AS retry_of,
        (SELECT i.model FROM items i
          WHERE i.turn_id = t.id AND i.model IS NOT NULL AND i.kind IN ('step','agent')
          GROUP BY i.model
          ORDER BY SUM(COALESCE(i.input_tokens,0)+COALESCE(i.output_tokens,0)) DESC
          LIMIT 1)       AS model,
        t.started_at               AS started_at,
        t.ended_at                 AS ended_at,
        t.total_input_tokens       AS total_input_tokens,
        t.total_output_tokens      AS total_output_tokens,
        t.total_cache_read_tokens  AS total_cache_read_tokens,
        t.total_cache_write_tokens AS total_cache_write_tokens,
        t.total_cost_usd           AS total_cost_usd,
        t.step_count               AS step_count,
        t.tool_count               AS tool_count
      FROM turns t
      JOIN conversations c ON c.id = t.conversation_id
      WHERE t.ended_at IS NOT NULL;
`;

/**
 * Conversation search plane (issue #420, Wave 3) — an FTS5 shadow table over
 * chat/build conversation titles + inbound message text, kept in sync by
 * triggers, exactly mirroring the vault's own FTS pattern (schema/fts.ts):
 * `snippet()` for match context, `unicode61 remove_diacritics 2` tokenizer.
 *
 * Grain is ONE row per conversation (not per item): the indexed `body` is the
 * concatenation of every inbound `message_in` item's text. Assistant answers
 * live in `items.output_json` as a JSON envelope, not indexable in a pure-SQL
 * trigger, so titles + the user's own words are the search surface — the words
 * a user actually remembers a thread by. Because a conversation accretes items
 * incrementally, the item trigger re-derives the whole `body` row on each
 * text-bearing insert (chat threads are small; this is a bounded recompute).
 *
 * The backfill at the tail is `NOT EXISTS`-guarded, so it populates rows once
 * when the index is first created on a pre-existing dev vault and is a no-op
 * on every subsequent open — keeping the whole block idempotent like the rest
 * of the ledger DDL.
 */
export const CONVERSATION_FTS_DDL = `
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_conversation USING fts5(
      conversation_id UNINDEXED,
      title,
      body,
      tokenize = "unicode61 remove_diacritics 2"
    );

    CREATE TRIGGER IF NOT EXISTS fts_conversation_conv_ai
      AFTER INSERT ON conversations WHEN new.kind IN ('chat','build') BEGIN
      INSERT INTO fts_conversation(conversation_id, title, body)
        VALUES (new.id, new.title, '');
    END;

    CREATE TRIGGER IF NOT EXISTS fts_conversation_conv_au
      AFTER UPDATE OF title ON conversations WHEN new.kind IN ('chat','build') BEGIN
      DELETE FROM fts_conversation WHERE conversation_id = old.id;
      INSERT INTO fts_conversation(conversation_id, title, body)
        SELECT new.id, new.title,
          (SELECT COALESCE(group_concat(i.text, ' '), '')
             FROM items i JOIN turns t ON t.id = i.turn_id
            WHERE t.conversation_id = new.id AND i.text IS NOT NULL AND i.text <> '');
    END;

    CREATE TRIGGER IF NOT EXISTS fts_conversation_conv_ad
      AFTER DELETE ON conversations BEGIN
      DELETE FROM fts_conversation WHERE conversation_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS fts_conversation_item_ai
      AFTER INSERT ON items WHEN new.text IS NOT NULL AND new.text <> '' BEGIN
      DELETE FROM fts_conversation
        WHERE conversation_id = (SELECT conversation_id FROM turns WHERE id = new.turn_id);
      INSERT INTO fts_conversation(conversation_id, title, body)
        SELECT c.id, c.title,
          (SELECT COALESCE(group_concat(i.text, ' '), '')
             FROM items i JOIN turns t ON t.id = i.turn_id
            WHERE t.conversation_id = c.id AND i.text IS NOT NULL AND i.text <> '')
          FROM conversations c
         WHERE c.id = (SELECT conversation_id FROM turns WHERE id = new.turn_id)
           AND c.kind IN ('chat','build');
    END;

    INSERT INTO fts_conversation(conversation_id, title, body)
      SELECT c.id, c.title,
        (SELECT COALESCE(group_concat(i.text, ' '), '')
           FROM items i JOIN turns t ON t.id = i.turn_id
          WHERE t.conversation_id = c.id AND i.text IS NOT NULL AND i.text <> '')
        FROM conversations c
       WHERE c.kind IN ('chat','build')
         AND NOT EXISTS (SELECT 1 FROM fts_conversation f WHERE f.conversation_id = c.id);
`;

/**
 * Idempotently create the conversation-ledger band on an open journal
 * handle. Never touches `PRAGMA user_version` — that belongs to the vault
 * package's audit-band ladder on the same file. Callers that already hold
 * the vault's own journal handle (the gateway's vault plane) use this
 * directly instead of opening a second connection.
 */
export function ensureConversationLedger(db: DatabaseSync): void {
  db.exec(CONVERSATION_LEDGER_DDL);
  db.exec(CONVERSATION_FTS_DDL);
}

/**
 * Open a vault's `journal.db` at `dbPath` for ledger-band use: set the
 * per-connection pragmas (WAL journal, FK enforcement, busy_timeout) and
 * ensure the conversation-ledger tables exist. Safe on a file the vault
 * package has already migrated (the audit band and its user_version are
 * untouched) and on a bare path (only the ledger band is created; the
 * vault's ladder still runs when the plane mounts the file).
 *
 * Pragmas run outside any transaction (journal_mode in particular), then
 * the ensure executes its `IF NOT EXISTS` DDL.
 */
export function openJournalDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // busy_timeout: wait up to 30s for a lock instead of failing
  // immediately. Load-bearing twice over: the multi-client gateway
  // (standalone daemon) and the worker subprocesses that open the SAME
  // journal file the gateway's vault plane holds open.
  //
  // wal_autocheckpoint=0: the vault's WAL shipper (issue #408) is the sole
  // checkpointer of journal.db — its backup segments are raw WAL byte
  // ranges, valid only while the WAL is append-only between the shipper's
  // own TRUNCATE checkpoints. This is a PERFORMANCE HINT, not a correctness
  // requirement (issue #411 action 1): the shipper VERIFIES salts/offsets at
  // every capture and breaks the generation on any foreign checkpoint, so a
  // default-autocheckpointing ledger connection (this one commits!) resetting
  // the WAL in place at the 1000-page threshold is caught and healed while a
  // shipper is ticking (and harmless when none is — no stream exists to hole).
  // The pragma just keeps that heal — a full base re-upload — rare.
  // Per connection, so EVERY by-path opener sets it, not just the vault's.
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=30000;
    PRAGMA wal_autocheckpoint=0;
  `);
  ensureConversationLedger(db);
  return db;
}

/**
 * Wrap a fixed `dbPath` into a lazy `DatabaseProvider`. The provider
 * opens the journal file on the first call (ensuring the ledger band as a
 * side effect) and caches the handle for subsequent calls.
 */
export function makeJournalDbProvider(dbPath: string): DatabaseProvider {
  let db: DatabaseSync | undefined;
  return () => {
    if (!db) db = openJournalDb(dbPath);
    return db;
  };
}
