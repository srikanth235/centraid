// The durable replica protocol band (#406), in the vault file so a base-table
// mutation and its change entry share one transaction. `refreshReplicaTriggers`
// generates the per-entity triggers from the logical registry, which keeps this
// DDL free of primary-key names and covers live ext tables.

import {
  ROW_VERSION_COLUMN,
  UPDATED_AT_DEFAULT,
  touchUpdatedAt,
} from "./updated-at.js";

/**
 * Build-time replica contract epoch, deliberately independent of PRAGMA
 * user_version: any incompatible wire/trigger change bumps it and rotates
 * every cursor. An invalidation number, not a migration ladder.
 */
// 1 was the v0 contract: per-app shapes over `replica_change`, with
// `core_entity` re-derived on the seat and the `audit` and `ledger` bands
// excluded by band.
//
// 2 IS THE ONE BUMP FOR #996's WAVES 0b AND 1 (issue invariant). Every seat
// holds `vault.db` whole (R1), so what a seat may hold is no longer a
// per-entity question: the file's tables minus the private list
// (`schema/private-tables.ts`) minus the FTS shadow tables. Wave 0b's schema
// changes deliberately carry no bump of their own — this one covers both, and
// a mismatch is a re-bootstrap, never a partial apply.
export const REPLICA_SCHEMA_EPOCH = 3;

/**
 * Orders the ADDITIVE migrations a seat applies, and is deliberately a second
 * number (R5). `schema_epoch` is compatibility — a mismatch means the seat's
 * file cannot be caught up and must be replaced. `ddl_version` is progress
 * inside one epoch: a `ddl` log row carries the statement, and a seat that has
 * applied through version N applies N+1 next. Conflating them would make every
 * additive column a full re-bootstrap.
 */
export const REPLICA_DDL_VERSION = 0;

/**
 * THE OLDEST SQLite ANY SEAT RUNS, and therefore the floor every byte the
 * gateway ships has to clear.
 *
 * The gateway is NOT the oldest build in the system, which is the trap: it
 * runs 3.50.2 (`node:sqlite` on the pinned Node 24.4.1), the browser seat runs
 * 3.53.0 (sqlite-wasm), and the PHONE — expo-sqlite built against SQLCipher —
 * runs **3.49.1**. So "it works here" proves nothing about the seat that
 * matters most, and a snapshot's DDL, its retained FTS sync triggers and the
 * SQL an applier runs must all be expressible in 3.49.
 *
 * What that rules out in practice, all of it newer than the floor:
 * `concat()` / `concat_ws()` (3.44), `octet_length()` (3.43), `unhex()`
 * (3.41), two-argument `json_valid()` (3.45) and the `jsonb_*` family (3.45).
 * What it allows, and what the plane is built from: `STRICT` (3.37),
 * `ON CONFLICT DO UPDATE` (3.24), `RETURNING` (3.35), `->` / `->>` (3.38),
 * generated columns (3.31) and `VACUUM INTO` (3.27, gateway-side anyway).
 *
 * A SEAT NEVER APPLIES A NATIVE CHANGESET. Two of the three builds cannot,
 * the format is versioned by the library that wrote it, and the one build that
 * could is the one that does not need to — which is the whole reason the log
 * carries JSON row images (R5) rather than the changeset the gateway captured.
 */
export const SEAT_SQLITE_FLOOR = "3.49.1";

export const REPLICA_DDL = `
CREATE TABLE IF NOT EXISTS replica_meta (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch            TEXT NOT NULL,
  floor_seq        INTEGER NOT NULL DEFAULT 0 CHECK (floor_seq >= 0),
  schema_epoch     INTEGER NOT NULL CHECK (schema_epoch >= 1),
  ddl_version      INTEGER NOT NULL DEFAULT 0 CHECK (ddl_version >= 0),
  -- The last commit position handed out. Allocated inside the capturing
  -- transaction, so a rolled-back commit leaves no gap a reader can see.
  commit_seq       INTEGER NOT NULL DEFAULT 0 CHECK (commit_seq >= 0),
  trigger_schema_version INTEGER NOT NULL DEFAULT 0 CHECK (trigger_schema_version >= 0),
  active_commit_id TEXT,
  epoch_reason     TEXT NOT NULL DEFAULT 'created',
  epoch_started_at TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO replica_meta (
  singleton, epoch, floor_seq, schema_epoch, trigger_schema_version,
  epoch_reason, epoch_started_at, updated_at
)
VALUES (
  1,
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(6))),
  0,
  ${REPLICA_SCHEMA_EPOCH},
  0,
  'created',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- THE GATEWAY LOG (#996, ruling R5). One row per (table, primary key) per
-- commit, carrying the row's FULL image as JSON — reconstructed inside the
-- originating transaction, because a session changeset omits the columns an
-- UPDATE did not touch and the row is gone by the time the transaction ends.
--
-- WHY JSON AND NOT THE CHANGESET ITSELF. Three SQLite builds have to read this
-- (the gateway's, the phone's, the browser's), a changeset is a binary format
-- versioned by the library that wrote it, and only one of the three can call
-- \`applyChangeset\` at all. Measured, JSON is not the wire penalty it looks
-- like: against a like-for-like table-filtered changeset it is 1.7x worse on
-- updates, within 6% on inserts and 3.2x BETTER on deletes.
--
-- THE TYPE CONTRACT IS THE POINT. \`row_json\` carries BLOBs as base64 and
-- 64-bit integers as strings, and distinguishes SQL NULL from an absent
-- column — see \`packages/core/src/protocol\`. A JSON number cannot hold a
-- rowid past 2^53 and JSON1 rejects BLOBs outright, so a naive encoding is
-- lossy in exactly the two places a photo vault lives.
CREATE TABLE IF NOT EXISTS replica_log (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The canonical commit position every row of one transaction shares. An
  -- intent's durable outcome names it (R24), and a seat applies one commit
  -- per transaction with its cursor in the same transaction.
  commit_seq      INTEGER NOT NULL CHECK (commit_seq > 0),
  epoch           TEXT NOT NULL,
  -- Two numbers, never one (R5): compatibility, then additive progress.
  schema_epoch    INTEGER NOT NULL CHECK (schema_epoch >= 1),
  ddl_version     INTEGER NOT NULL DEFAULT 0 CHECK (ddl_version >= 0),
  -- PHYSICAL table name, not a logical entity: a seat holds the gateway's
  -- schema and applies to the same table the gateway wrote.
  "table"         TEXT NOT NULL,
  op              TEXT NOT NULL CHECK (op IN ('insert','update','delete','ddl')),
  -- The primary key as a JSON array, in declared key order — one element for
  -- the ordinary case, several for a composite key. An array, not a scalar,
  -- so a composite key needs no separator nobody can escape.
  pk_json         TEXT NOT NULL CHECK (json_valid(pk_json)),
  -- The full new row image for insert/update; the full OLD image for delete,
  -- which is the only image a delete has and what a subscriber needs to judge
  -- that the row left its closure. A \`ddl\` row carries its statement here.
  row_json        TEXT CHECK (row_json IS NULL OR json_valid(row_json)),
  -- 1 when the session flagged the change as trigger- or cascade-produced.
  -- Carried, not filtered: a cascaded delete is a real row a seat must apply,
  -- and the flag is what lets a reader tell it from a writer's own statement.
  indirect        INTEGER NOT NULL DEFAULT 0 CHECK (indirect IN (0,1)),
  -- What produced the commit — a command name, an import, the enricher. The
  -- producer bound is denominated per producer, so this is how a bulk writer
  -- is recognised without guessing from row counts.
  producer        TEXT NOT NULL,
  -- 1 when this commit's compressed size crossed the defer threshold, so a
  -- metered seat may skip it and stay CONSISTENT BEHIND IT rather than
  -- half-applied. Every row of one commit carries the same value: a commit is
  -- the unit a seat applies, so it is the unit a seat defers.
  deferred        INTEGER NOT NULL DEFAULT 0 CHECK (deferred IN (0,1)),
  committed_at    TEXT NOT NULL
) STRICT;
-- Tail by seq: the log-tail door's only access path.
CREATE INDEX IF NOT EXISTS idx_replica_log_epoch_seq
  ON replica_log(epoch, seq);
-- Whole commits: a page never ships half a transaction.
CREATE INDEX IF NOT EXISTS idx_replica_log_epoch_commit
  ON replica_log(epoch, commit_seq, seq);
-- The latest row image for one key, which is what a closure diff and the
-- outcome's produced-version set both read.
CREATE INDEX IF NOT EXISTS idx_replica_log_row
  ON replica_log(epoch, "table", pk_json, seq DESC);

CREATE TABLE IF NOT EXISTS replica_change (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch           TEXT NOT NULL,
  commit_id       TEXT NOT NULL,
  entity          TEXT NOT NULL,
  row_id          TEXT NOT NULL,
  op              TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
  old_values_json TEXT CHECK (old_values_json IS NULL OR json_valid(old_values_json)),
  -- Set only on an entry that retention compaction folded OLDER entries of the
  -- same row into: the op of, and the row state before, the oldest change this
  -- entry now stands for. NULL means the entry stands for itself, so a reader
  -- takes op/old_values_json instead. A client whose cursor predates the
  -- folded entries needs that older state to decide filtered membership; see
  -- compactSupersededCommits in replica/change-log.ts.
  prior_op        TEXT CHECK (prior_op IS NULL OR prior_op IN ('insert','update','delete')),
  prior_old_values_json TEXT CHECK (prior_old_values_json IS NULL OR json_valid(prior_old_values_json)),
  changed_at      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_replica_change_epoch_seq
  ON replica_change(epoch, seq);
CREATE INDEX IF NOT EXISTS idx_replica_change_epoch_commit_seq
  ON replica_change(epoch, commit_id, seq);
CREATE INDEX IF NOT EXISTS idx_replica_change_latest_row
  ON replica_change(epoch, entity, row_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_replica_change_changed_at
  ON replica_change(epoch, changed_at, seq);

-- An intent's durable canonical outcome. The generic replica trigger installer
-- publishes this as the internal entity replica.intent, letting the initiating
-- device observe parked/committed/rejected transitions through the same log as
-- ontology writes. The gateway remains responsible for device scoping.
CREATE TABLE IF NOT EXISTS replica_intent_outcome (
  intent_id     TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL,
  app_id        TEXT NOT NULL,
  action        TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (
    status IN ('queued','sending','parked','executed','denied','failed','conflict')
  ),
  invocation_id TEXT,
  reason        TEXT,
  conflict_json TEXT CHECK (conflict_json IS NULL OR json_valid(conflict_json)),
  -- WHO A PARKED WRITE IS WAITING ON (#929): 'owner' when the origin's member
  -- must decide it, 'origin' when the write is queued for the vault that owns
  -- the container, 'gateway' when the host cannot carry it yet. The seat draws
  -- a person from it, so the label rides along — read off the LINK, never a
  -- vault id a member has no name for.
  waiting_on    TEXT CHECK (waiting_on IS NULL OR json_valid(waiting_on)),
  -- The ORIGIN row versions this intent's answer stands for (#929, G1). A
  -- member's pending row drops only when their replica holds them; without the
  -- versions the seat would have to guess, and the guess is what makes a
  -- pending badge clear before the row it wrote arrives.
  answered_versions TEXT
    CHECK (answered_versions IS NULL OR json_valid(answered_versions)),
  -- THE CANONICAL COMMIT POSITION THIS ANSWER STANDS FOR (#996, R24). Every
  -- executed outcome carries it, on the device path as well as the peer path,
  -- and a seat keeps its pending projection until its applied cursor reaches
  -- it. Without the number the seat has to guess, and the guess is what makes
  -- a pending badge clear before the row it wrote arrives.
  commit_seq    INTEGER CHECK (commit_seq IS NULL OR commit_seq > 0),
  -- The (table, pk, row_version) set this intent's commit produced, read from
  -- the captured rows rather than re-queried: a second read could see a LATER
  -- commit's value and settle the intent against work it did not do.
  produced_json TEXT CHECK (produced_json IS NULL OR json_valid(produced_json)),
  -- THE INTENTS THIS ONE WAITS ON (#996, R23). A JSON array of intent ids: an
  -- offline chain is causal, so a rename cannot execute before the create it
  -- renames, and the gateway is where that is enforced rather than in each
  -- app's retry loop.
  depends_on    TEXT CHECK (depends_on IS NULL OR json_valid(depends_on)),
  -- THE END OF THE IDEMPOTENCY WINDOW (#996, R24 / OQ-13). A retry after this
  -- gets an explicit 'expired' answer naming what to do, never a silent
  -- re-execution: the retained outcome is what makes a retry safe, so when it
  -- is gone the honest answer is "I no longer know", not "here, do it again".
  expires_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  ${ROW_VERSION_COLUMN}
) STRICT;
CREATE INDEX IF NOT EXISTS idx_replica_intent_device_status
  ON replica_intent_outcome(device_id, status, updated_at);
${touchUpdatedAt("replica_intent_outcome", "intent_id")}

-- Canonical invocation commit receipts. The mutation, this row and the audit
-- band's invocation now share ONE file and ONE transaction (#916), so the
-- cross-database crash gap this closed cannot reopen; the receipt stays as the
-- replay marker for a crash BETWEEN the write and the audit finalisation, and
-- it is internal protocol state, not a replica-visible entity.
CREATE TABLE IF NOT EXISTS replica_invocation_commit (
  invocation_id       TEXT PRIMARY KEY,
  command_id          TEXT NOT NULL,
  intent_id           TEXT,
  -- Redacted/non-secret post-check + S5 reconstruction material. This row is
  -- in the canonical transaction, so replay can finish the audit band without
  -- re-entering the command handler after a crash.
  audit_json          TEXT NOT NULL CHECK (json_valid(audit_json)),
  committed_at        TEXT NOT NULL,
  -- Set only after one atomic audit-band transaction has verified checks,
  -- provenance, receipt, evidence, explanation, and executed status.
  journal_finalized_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_replica_invocation_commit_intent
  ON replica_invocation_commit(intent_id)
  WHERE intent_id IS NOT NULL;

-- Confirmation-gated commands may remain parked for days. The resumable raw
-- request lives here encrypted under the vault DEK; replica_intent_outcome
-- above carries only the non-secret device-visible status. This table is
-- internal protocol state (never shape/grant addressable and never trigger-
-- published) and is deleted as soon as the owner decides or consent ends.
CREATE TABLE IF NOT EXISTS replica_parked_payload (
  invocation_id TEXT PRIMARY KEY,
  intent_id     TEXT,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  request_sealed TEXT NOT NULL,
  grant_id      TEXT,
  command_id    TEXT NOT NULL,
  command_name  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  parked_at     TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_replica_parked_grant
  ON replica_parked_payload(grant_id, parked_at);
`;
