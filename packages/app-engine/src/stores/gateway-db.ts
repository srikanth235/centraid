// governance: allow-repo-hygiene file-size-limit the canonical journal.db ledger-band DDL is one cohesive template-literal schema + its openers; #438 added the conversation_archive/conversation_digest tables in place — the band cannot be split across files without breaking ensureConversationLedger's single-statement idempotence
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
 *     automation_trigger_cursor
 *                      — one durable position per automation trigger source,
 *                        including bounded-gap metadata (`skipped` + window).
 *     trigger_ingress  — short-lived authenticated webhook/provider events;
 *                        gateway plumbing, never user ontology.
 *     run_summary      — a VIEW over turns ⋈ conversations (+ dominant
 *                        model from items): one row per finished run, every
 *                        kind — the Insights source. The ledger tables ARE
 *                        the data; there is no write path and nothing to
 *                        rebuild. Scoped per vault so a central store can
 *                        never aggregate across vaults (#280).
 *     conversation_archive
 *                      — #438 cold-state index: one row per archived
 *                        turn-range SEGMENT sealed into the vault blob CAS.
 *                        `segment_sha256` blobs are CAS GC roots; `pruned_at`
 *                        latches once raw rows are custody-gated-deleted.
 *                        CASCADE off `conversations` (true deletion removes it).
 *     conversation_digest
 *                      — #438 materialized rollup of the ARCHIVED portion,
 *                        one row per conversation, upserted at archive time.
 *                        Insights/Executions union this with live run_summary
 *                        so pruning raw rows stays invisible to every
 *                        dashboard. CASCADE off `conversations`.
 *     runner_health    — workspace × runner × failure-class circuit breakers
 *                        used only at turn boundaries.
 *     conversation_provider_consent
 *                      — explicit conversation × runner egress grants.
 *
 *     `turns.conversation_id` and `items.turn_id` and `attachments.item_id`
 *     are real same-file FKs (CASCADE): deleting a conversation drops its
 *     turns, items, and attachment rows. `turns.parent_turn_id` stays a
 *     plain column (a sub-run's parent may be recorded before this row in
 *     the same transaction batch). Runtime-owned; never reachable from
 *     handler `db` or the `vault_sql` agent tool.
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

import { DatabaseSync } from "node:sqlite";

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
      adapter_usage_json TEXT,
      hydration_count    INTEGER NOT NULL DEFAULT 0,
      last_hydrated_at   INTEGER,
      turn_count         INTEGER NOT NULL DEFAULT 0,
      item_count         INTEGER NOT NULL DEFAULT 0,
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
      -- Explicit handoff-cost marker (D4): estimated canonical-ledger prompt
      -- tokens injected on this turn, separate from ACP-reported usage.
      hydration_tokens         INTEGER,
      ok                       INTEGER NOT NULL DEFAULT 0,
      error                    TEXT,
      feedback                 TEXT,
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
      call_id            TEXT,
      batch_id           INTEGER,
      kind               TEXT NOT NULL,
      role               TEXT,
      text               TEXT,
      name               TEXT,
      args_json          TEXT,
      output_json        TEXT,
      raw_json           TEXT,
      child_turn_id      TEXT,
      model              TEXT,
      provider           TEXT,
      -- ACP semantic thought_level confirmed for this call. NULL means the
      -- runner did not confirm a selectable effort; never infer a default.
      effort             TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cache_read_tokens  INTEGER,
      cache_write_tokens INTEGER,
      cost_usd           REAL,
      -- Provenance for cost_usd (issue #514): 'agent' = runner/ACP reported USD;
      -- 'estimated' = catalog (model-pricing). NULL = legacy or unpriced.
      cost_source        TEXT,
      app_id             TEXT,
      ok                 INTEGER NOT NULL DEFAULT 1,
      error              TEXT,
      started_at         INTEGER NOT NULL,
      ended_at           INTEGER,
      duration_ms        INTEGER,
      CHECK (kind IN ('message_in','step','tool','agent')),
      CHECK (cost_source IS NULL OR cost_source IN ('agent','estimated'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_items_by_turn
      ON items(turn_id, ordinal);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_turn_call
      ON items(turn_id, call_id) WHERE call_id IS NOT NULL;
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
      -- Agent-created files stay in their workspace. The hash verifies the
      -- referenced bytes; no duplicate is copied into the blob CAS.
      workspace_path TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_attachments_item
      ON attachments(item_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_hash
      ON attachments(hash);

    -- ACP resume handles are bindings to the canonical conversation ledger,
    -- never the ledger identity itself. Retaining one row per observed
    -- runner/session lets A → B → A resume A and hydrate only the canonical
    -- turn delta past A's watermark.
    CREATE TABLE IF NOT EXISTS conversation_harness_sessions (
      id                    TEXT PRIMARY KEY,
      conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      runner_kind           TEXT NOT NULL,
      acp_session_id        TEXT NOT NULL,
      usage_snapshot_json   TEXT,
      hydrated_through_seq  INTEGER NOT NULL DEFAULT -1,
      status                TEXT NOT NULL DEFAULT 'warm',
      last_used_at          INTEGER NOT NULL,
      created_at            INTEGER NOT NULL,
      UNIQUE (conversation_id, runner_kind, acp_session_id),
      CHECK (status IN ('active','warm','cold','stale'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_conversation_harness_latest
      ON conversation_harness_sessions(conversation_id, runner_kind, status, last_used_at DESC);

    -- Cross-process single writer. The in-process queue improves UX; this row
    -- is the correctness boundary shared by a gateway and worker processes.
    CREATE TABLE IF NOT EXISTS conversation_turn_locks (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      lock_token      TEXT NOT NULL,
      acquired_at     INTEGER NOT NULL
    ) STRICT;

    -- The workspace choice is an enum resolved by the host to Centraid-owned
    -- roots. Raw client paths never become durable authority. Additional roots
    -- are recorded as explicit per-conversation consent.
    CREATE TABLE IF NOT EXISTS conversation_workspace_selection (
      conversation_id             TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      primary_kind                TEXT NOT NULL,
      additional_directories_json TEXT NOT NULL DEFAULT '[]',
      updated_at                  INTEGER NOT NULL,
      CHECK (primary_kind IN ('vault-data','app','draft'))
    ) STRICT;

    -- Persistent runner circuit breakers. One row per workspace context,
    -- runner and failure class keeps an auth outage independent from a later
    -- transport wedge and prevents one broken project from sidelining a
    -- runner everywhere on the device.
    CREATE TABLE IF NOT EXISTS runner_health (
      workspace_context    TEXT NOT NULL,
      runner_kind          TEXT NOT NULL,
      failure_class        TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      breaker_until        INTEGER,
      half_open_claimed_at INTEGER,
      last_error           TEXT,
      last_failure_at      INTEGER,
      last_ok_at           INTEGER,
      PRIMARY KEY (workspace_context, runner_kind, failure_class),
      CHECK (failure_class IN ('spawn','auth','init','timeout','quota','wedge','exit','unknown'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_runner_health_breaker
      ON runner_health(workspace_context, runner_kind, breaker_until);

    -- Explicit provider-egress grants. Direct consent and ladder-derived
    -- consent are separate rows: removing a runner from one subsystem ladder
    -- revokes only that subsystem's forward grant and never erases a direct
    -- conversation × provider decision.
    CREATE TABLE IF NOT EXISTS conversation_provider_consent (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      runner_kind     TEXT NOT NULL,
      source          TEXT NOT NULL,
      subsystem       TEXT NOT NULL,
      granted_at      INTEGER NOT NULL,
      revoked_at      INTEGER,
      PRIMARY KEY (conversation_id, runner_kind, source, subsystem),
      CHECK (
        (source = 'direct' AND subsystem = '')
        OR
        (source = 'ladder' AND subsystem IN ('assistant','ask','builder','automations'))
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_conversation_provider_consent_active
      ON conversation_provider_consent(conversation_id, runner_kind, subsystem, revoked_at);

    CREATE TABLE IF NOT EXISTS automation_state (
      automation_id TEXT NOT NULL,
      key           TEXT NOT NULL,
      value_json    TEXT,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (automation_id, key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS automation_trigger_cursor (
      automation_id TEXT NOT NULL,
      trigger_index INTEGER NOT NULL,
      source_kind   TEXT NOT NULL,
      position_json TEXT,
      pending_json  TEXT,
      window_from  INTEGER,
      window_to    INTEGER,
      skipped      INTEGER NOT NULL DEFAULT 0,
      gap_reason   TEXT,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (automation_id, trigger_index)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_automation_trigger_cursor_updated
      ON automation_trigger_cursor(updated_at);

    CREATE TABLE IF NOT EXISTS trigger_ingress (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT NOT NULL,
      source_key    TEXT NOT NULL,
      delivery_id   TEXT NOT NULL,
      received_at   INTEGER NOT NULL,
      payload_json  TEXT,
      payload_ref   TEXT,
      expires_at    INTEGER NOT NULL,
      UNIQUE (source, source_key, delivery_id),
      CHECK (source IN ('webhook','poll')),
      CHECK (payload_json IS NOT NULL OR payload_ref IS NOT NULL)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_trigger_ingress_source_position
      ON trigger_ingress(source_key, id);
    CREATE INDEX IF NOT EXISTS idx_trigger_ingress_expiry
      ON trigger_ingress(expires_at);

    -- #438 ledger-band archival index. journal.db grows at machine speed; these
    -- two cold-state tables let it converge to the recent working set. A
    -- turn-range idle past the archive window (default 90d) serializes to a
    -- content-addressed SEGMENT in the vault blob CAS; raw turns/items prune only
    -- after that segment's custody is proven. History changes TEMPERATURE, never
    -- existence — true deletion stays the consent/delete path (hence the CASCADE).
    --
    -- conversation_archive: one row per archived turn-range segment. A whole idle
    -- conversation archives as one (or a few bounded) segment(s); an eternal
    -- automation thread archives aged ranges while the thread stays live. The
    -- segment_sha256 blobs are CAS GC ROOTS (conversationArchiveShas) — the
    -- reconcile sweep must treat them as reachable or it would delete the only
    -- durable copy of pruned rows. pruned_at is the custody-gate LATCH: NULL until
    -- the raw rows are deleted, which happens only once the segment is durably
    -- replicated (remote tier) or resident in the local CAS (local-only vault).
    -- attachment_hashes_json is the JSON array of content hashes the archived
    -- items reference, so ConversationStore.referencedHashes() keeps the
    -- app-engine BlobStore bytes pinned across a prune.
    CREATE TABLE IF NOT EXISTS conversation_archive (
      id                     TEXT PRIMARY KEY,
      conversation_id        TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      seq_from               INTEGER NOT NULL,
      seq_to                 INTEGER NOT NULL,
      from_time              INTEGER NOT NULL,
      to_time                INTEGER NOT NULL,
      turn_count             INTEGER NOT NULL,
      item_count             INTEGER NOT NULL,
      segment_sha256         TEXT NOT NULL CHECK (length(segment_sha256) = 64),
      segment_bytes          INTEGER NOT NULL CHECK (segment_bytes >= 0),
      plaintext_bytes        INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
      attachment_hashes_json TEXT NOT NULL DEFAULT '[]',
      pruned_at              INTEGER,
      created_at             INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_conversation_archive_conv
      ON conversation_archive(conversation_id, seq_from);
    CREATE INDEX IF NOT EXISTS idx_conversation_archive_sha
      ON conversation_archive(segment_sha256);
    -- Partial index for the prune sweep's "not yet pruned" scan.
    CREATE INDEX IF NOT EXISTS idx_conversation_archive_unpruned
      ON conversation_archive(pruned_at) WHERE pruned_at IS NULL;

    -- conversation_digest: one row per conversation, UPSERTED at archive time,
    -- covering ONLY the archived portion (live turns still come from the
    -- run_summary view). Insights and the Executions feed union live run_summary
    -- aggregates with these digest rollups, so pruning raw rows is invisible to
    -- every dashboard — the numbers before archive == digest+live after prune.
    -- models_json / efforts_json keep the confirmed semantic breakdowns
    -- truthful once item rows are gone. first_started_at/last_ended_at
    -- bound the archived span (digests carry no per-day grain — day-grain series
    -- coarsen archived rollups only beyond the archive horizon; see insights-store).
    CREATE TABLE IF NOT EXISTS conversation_digest (
      conversation_id          TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      kind                     TEXT NOT NULL,
      app_id                   TEXT,
      automation_ref           TEXT,
      automation_name          TEXT,
      title                    TEXT NOT NULL DEFAULT '',
      first_started_at         INTEGER,
      last_ended_at            INTEGER,
      run_count                INTEGER NOT NULL DEFAULT 0,
      ok_count                 INTEGER NOT NULL DEFAULT 0,
      err_count                INTEGER NOT NULL DEFAULT 0,
      retry_count              INTEGER NOT NULL DEFAULT 0,
      total_input_tokens       INTEGER NOT NULL DEFAULT 0,
      total_output_tokens      INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_hydration_tokens   INTEGER NOT NULL DEFAULT 0,
      total_cost_usd           REAL NOT NULL DEFAULT 0,
      step_count               INTEGER NOT NULL DEFAULT 0,
      tool_count               INTEGER NOT NULL DEFAULT 0,
      models_json              TEXT NOT NULL DEFAULT '[]',
      efforts_json             TEXT NOT NULL DEFAULT '[]',
      updated_at               INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_conversation_digest_automation
      ON conversation_digest(automation_ref);

    -- run_summary is a VIEW, not a table: one row per FINISHED run, every
    -- kind — the Insights/Executions source. It used to be a denormalized
    -- table maintained by a best-effort dual write at finishTurn, justified
    -- when the rollup lived in a different file (central analytics.sqlite,
    -- #280); with the ledger and the rollup in ONE file there is no boundary
    -- left to denormalize across, so the ledger tables above are simply THE
    -- source and the view is the lens (no write path, no drift).
    -- automation_ref/app_id derivation and the dominant-model / dominant-
    -- provider picks mirror the old write-through exactly. DROP+CREATE so
    -- view shape can evolve on existing vaults (IF NOT EXISTS would stick).
    DROP VIEW IF EXISTS run_summary;
    CREATE VIEW run_summary AS
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
        -- Dominant runner kind (ACP stamps provider = RunnerKind) for Insights
        -- by-runner breakdown (issue #514).
        (SELECT i.provider FROM items i
          WHERE i.turn_id = t.id AND i.provider IS NOT NULL AND i.kind IN ('step','agent')
          GROUP BY i.provider
          ORDER BY SUM(COALESCE(i.input_tokens,0)+COALESCE(i.output_tokens,0)) DESC
          LIMIT 1)       AS provider,
        -- Effort is recorded only after ACP confirms thought_level. Picking
        -- the dominant confirmed value mirrors the model/provider rollups.
        (SELECT i.effort FROM items i
          WHERE i.turn_id = t.id AND i.effort IS NOT NULL AND i.kind IN ('step','agent')
          GROUP BY i.effort
          ORDER BY SUM(COALESCE(i.input_tokens,0)+COALESCE(i.output_tokens,0)) DESC
          LIMIT 1)       AS effort,
        t.started_at               AS started_at,
        t.ended_at                 AS ended_at,
        t.total_input_tokens       AS total_input_tokens,
        t.total_output_tokens      AS total_output_tokens,
        t.total_cache_read_tokens  AS total_cache_read_tokens,
        t.total_cache_write_tokens AS total_cache_write_tokens,
        t.hydration_tokens          AS hydration_tokens,
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

const CONVERSATION_ITEM_COUNT_DDL = `
    CREATE TRIGGER IF NOT EXISTS conversation_item_count_ai
      AFTER INSERT ON items BEGIN
      UPDATE conversations
         SET item_count = item_count + 1
       WHERE id = (SELECT conversation_id FROM turns WHERE id = new.turn_id);
    END;

    CREATE TRIGGER IF NOT EXISTS conversation_item_count_ad
      AFTER DELETE ON items BEGIN
      UPDATE conversations
         SET item_count = MAX(item_count - 1, 0)
       WHERE id = (SELECT conversation_id FROM turns WHERE id = old.turn_id);
    END;
`;

/**
 * Idempotently create the conversation-ledger band on an open journal
 * handle. Never touches `PRAGMA user_version` — that belongs to the vault
 * package's audit-band ladder on the same file. Callers that already hold
 * the vault's own journal handle (the gateway's vault plane) use this
 * directly instead of opening a second connection.
 */
export function ensureConversationLedger(db: DatabaseSync): void {
  // Schema-dependent views are recreated by CONVERSATION_LEDGER_DDL. Upgrade
  // the source tables first on an existing vault, otherwise SQLite rejects
  // CREATE VIEW run_summary when it encounters the new `items.effort` column.
  const existingTable = (name: string): boolean =>
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined;
  if (existingTable("items")) {
    const existingItemCols = (
      db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[]
    ).map((column) => column.name);
    if (!existingItemCols.includes("effort")) {
      db.exec(`ALTER TABLE items ADD COLUMN effort TEXT`);
    }
  }
  if (existingTable("conversation_digest")) {
    const existingDigestCols = (
      db.prepare(`PRAGMA table_info(conversation_digest)`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    if (!existingDigestCols.includes("efforts_json")) {
      db.exec(
        `ALTER TABLE conversation_digest ADD COLUMN efforts_json TEXT NOT NULL DEFAULT '[]'`
      );
    }
    if (!existingDigestCols.includes("total_hydration_tokens")) {
      db.exec(
        `ALTER TABLE conversation_digest ADD COLUMN total_hydration_tokens INTEGER NOT NULL DEFAULT 0`
      );
    }
  }
  if (existingTable("turns")) {
    const existingTurnCols = (
      db.prepare(`PRAGMA table_info(turns)`).all() as { name: string }[]
    ).map((column) => column.name);
    if (!existingTurnCols.includes("hydration_tokens")) {
      db.exec(`ALTER TABLE turns ADD COLUMN hydration_tokens INTEGER`);
    }
  }
  db.exec(CONVERSATION_LEDGER_DDL);
  const conversationCols = (
    db.prepare(`PRAGMA table_info(conversations)`).all() as { name: string }[]
  ).map((c) => c.name);
  if (!conversationCols.includes("item_count")) {
    db.exec(
      `ALTER TABLE conversations ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0`
    );
    db.exec(`
      UPDATE conversations
         SET item_count = (
           SELECT COUNT(*)
             FROM items i
             JOIN turns t ON t.id = i.turn_id
            WHERE t.conversation_id = conversations.id
         )
    `);
  }
  if (!conversationCols.includes("hydration_count")) {
    db.exec(
      `ALTER TABLE conversations ADD COLUMN hydration_count INTEGER NOT NULL DEFAULT 0`
    );
  }
  if (!conversationCols.includes("last_hydrated_at")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN last_hydrated_at INTEGER`);
  }
  // Issue #514: cost provenance on existing vaults created before cost_source.
  const itemCols = (
    db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[]
  ).map((c) => c.name);
  if (!itemCols.includes("cost_source")) {
    db.exec(`ALTER TABLE items ADD COLUMN cost_source TEXT`);
  }
  if (existingTable("attachments")) {
    const attachmentCols = (
      db.prepare(`PRAGMA table_info(attachments)`).all() as { name: string }[]
    ).map((c) => c.name);
    if (!attachmentCols.includes("workspace_path")) {
      db.exec(`ALTER TABLE attachments ADD COLUMN workspace_path TEXT`);
    }
  }
  if (existingTable("runner_health")) {
    const healthCols = (
      db.prepare(`PRAGMA table_info(runner_health)`).all() as { name: string }[]
    ).map((c) => c.name);
    if (!healthCols.includes("half_open_claimed_at")) {
      db.exec(
        `ALTER TABLE runner_health ADD COLUMN half_open_claimed_at INTEGER`
      );
    }
  }
  if (existingTable("conversation_workspace_selection")) {
    const workspaceCols = (
      db
        .prepare(`PRAGMA table_info(conversation_workspace_selection)`)
        .all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    if (!workspaceCols.includes("additional_directories_json")) {
      db.exec(
        `ALTER TABLE conversation_workspace_selection
           ADD COLUMN additional_directories_json TEXT NOT NULL DEFAULT '[]'`
      );
    }
  }
  // Pre-release cut-over: existing single resume handles become the first
  // canonical binding. New turns update this table and keep the legacy
  // conversation columns only as a read-through compatibility projection.
  db.exec(`
    INSERT OR IGNORE INTO conversation_harness_sessions (
      id, conversation_id, runner_kind, acp_session_id,
      usage_snapshot_json, hydrated_through_seq, status, last_used_at, created_at
    )
    SELECT lower(hex(randomblob(16))), c.id, c.adapter_kind, c.adapter_session_id,
           c.adapter_usage_json, COALESCE(MAX(t.seq), -1), 'active',
           c.updated_at, c.created_at
      FROM conversations c
      LEFT JOIN turns t ON t.conversation_id = c.id
     WHERE c.adapter_kind IS NOT NULL AND c.adapter_session_id IS NOT NULL
     GROUP BY c.id
  `);
  db.exec(CONVERSATION_ITEM_COUNT_DDL);
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
  //
  // auto_vacuum=INCREMENTAL (issue #438) bounds journal.db: the ledger-band
  // archival prune frees pages that only `incremental_vacuum` returns to the OS.
  // MUST precede journal_mode=WAL — on a fresh file the setting is pending until
  // the first table is created, but once WAL writes page 1 the header is fixed
  // and the pragma no longer takes at table-create time (only a full VACUUM can
  // then convert). openVaultDb's openFile sets the same pragma on the same file;
  // this by-path opener mirrors it so a journal reached ONLY through app-engine
  // (worker subprocess, standalone daemon) still converges to incremental mode.
  db.exec(`
    PRAGMA page_size=8192;
    PRAGMA auto_vacuum=INCREMENTAL;
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=30000;
    PRAGMA cache_size=-16000;
    PRAGMA mmap_size=67108864;
    PRAGMA temp_store=MEMORY;
    PRAGMA wal_autocheckpoint=0;
  `);
  // One-time conversion for a file created before #438 (auto_vacuum=0, freelist
  // mode) while fleet files are still small. A fresh file reads back 2 here (the
  // pragma above is pending, page 1 already written by WAL); only a pre-existing
  // NON-empty file still reads 0. The pragma above set INCREMENTAL as the VACUUM
  // target, so one full VACUUM rewrites the file into incremental mode. No txn is
  // held and no other connection is on the file yet at open. The WAL shipper
  // (issue #408) treats this whole-file rewrite as a foreign checkpoint and heals
  // via a generation break — a one-time base re-upload, acceptable at small size.
  const autoVacuum = (
    db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
  ).auto_vacuum;
  const pageCount = (
    db.prepare("PRAGMA page_count").get() as { page_count: number }
  ).page_count;
  if (autoVacuum === 0 && pageCount > 0) db.exec("VACUUM");
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
