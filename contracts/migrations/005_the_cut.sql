-- THE CUT (#1029) — RUNG FIVE.
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung six.
--
-- ## Why a rung, and not a smaller baseline
--
-- `001_baseline.sql` is generated from `contracts/golden/issue-1020/vault.db.gz`,
-- a FROZEN v0 vault with no generator of its own. Dropping a table there means
-- hand-editing a frozen corpus, which is "green by editing the fixture" — the
-- one thing this repository's doctrine forbids. So the corpus keeps describing
-- v0, and the planes v1 does not have leave the schema the way every other
-- schema change leaves it: as a rung (the owner's ruling of 2026-09-21,
-- <https://github.com/srikanth235/centraid/issues/1029#issuecomment-5756495615>).
--
-- A new vault therefore founds these tables and drops them again, in the same
-- `Vault::create`. That is honest and it is cheap — an empty table's `CREATE`
-- and `DROP` are two rows of `sqlite_master`. Squashing the ladder before the
-- first release would make it unnecessary and is recorded as an owner question
-- rather than done here, because a squash is a decision about the migration
-- contract and not a cleanup.
--
-- ## What leaves, and why each plane is gone
--
-- Every table below is the storage of a plane that was deleted in code under
-- this umbrella, not a table that merely has no reader today:
--
-- * **sharing** (nine tables) — the gateway half went in W16-3 under the scope
--   amendment; nothing fulfils a grant, projects a closure into an audience
--   vault, or runs a peer plane between gateways.
-- * **outbox** (`outbox_item`, `blob_outbox`) — the delivery queue of that
--   same plane.
-- * **replica** (five tables) and `blob_replica` — the seat plane left in W2.
--   There is no second copy of a vault to apply a log to.
-- * **blob device keys** (`blob_device_content_key`, `blob_device_wrap_key`) —
--   per-device blob wrapping, superseded by rung four: every blob now has its
--   own file key, held in `backup_blob_custody` (#1029 §4).
-- * **automations** (`automation_state`, `automation_trigger_cursor`,
--   `trigger_ingress`) — `crates/automations` and `crates/assist` left in W2.
-- * **connectors** (the `sync_connection*` family, `sync_external_entity`,
--   `sync_import_batch`, `sync_import_row`) — there is no connector runtime.
-- * **agents** (`access_agent`, `access_agent_secret`) — `Principal::Agent`
--   left in W2; `Principal` has one variant.
-- * **the conversation ledger band** (`conversations`, `turns`, `items`,
--   `attachments` and the five `conversation_*` tables, plus `harness_health`
--   and the `run_summary` view over them) — the assistant and the ledger left
--   in W2. `grep -rn 'INSERT INTO conversation\|INSERT INTO turn\|INSERT INTO
--   item\b\|INSERT INTO attachment' crates --include=*.rs` is empty: no Rust
--   writes a row into this band.
--
-- **What is NOT dropped, and why.** `access_device` and `access_device_secret`
-- stay: `Vault::enrol_device` has live callers and the backup base copy carries
-- `access_device_secret` as a sealed custody property (#1029 B1, sealed by W3 —
-- `crates/vault/src/backup/base.rs`, `tests/snapshot_faults.rs`,
-- `tests/disk_full.rs`). `agent_command` and `agent_command_invocation` stay:
-- they are the command registry and the invocation journal despite their names
-- (renaming them is its own rung). `row_version` stays as a plain revision
-- counter.
--
-- ## Order
--
-- The view and the trigger that read a dropped table go FIRST, because SQLite
-- will not let a table be dropped while a trigger's body names it. Everything
-- else is independent: each table's own indexes and triggers go with it, the
-- FTS virtual table takes its shadow tables with it, and the one foreign key
-- pointing into the set (`locker_item.connection_id`) is dropped as a column.

---- the objects that read a dropped table

-- The whole body of this trigger was an UPDATE on `share_authority`: purging an
-- entity revoked the standing answers about it. With no sharing plane there is
-- nothing to revoke, so the trigger goes rather than being emptied.
DROP TRIGGER IF EXISTS core_entity_revoke_on_purge;

-- A rollup over `turns`, `items` and `conversations`.
DROP VIEW IF EXISTS run_summary;

---- the conversation ledger band

DROP TABLE IF EXISTS fts_conversation;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS turns;
DROP TABLE IF EXISTS conversation_archive;
DROP TABLE IF EXISTS conversation_digest;
DROP TABLE IF EXISTS conversation_harness_sessions;
DROP TABLE IF EXISTS conversation_provider_consent;
DROP TABLE IF EXISTS conversation_turn_locks;
DROP TABLE IF EXISTS conversation_workspace_selection;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS harness_health;

---- sharing (#1029 §7 is a capability over iroh, not nine tables)

DROP TABLE IF EXISTS share_authority_request;
DROP TABLE IF EXISTS share_authority_use;
DROP TABLE IF EXISTS share_delivery_config;
DROP TABLE IF EXISTS share_fulfillment;
DROP TABLE IF EXISTS share_party_vault_binding;
DROP TABLE IF EXISTS share_subscription_lineage;
DROP TABLE IF EXISTS share_subscription_member;
DROP TABLE IF EXISTS share_subscription;
DROP TABLE IF EXISTS share_authority;

---- the outbox

DROP TABLE IF EXISTS outbox_item;
DROP TABLE IF EXISTS blob_outbox;

---- the replica plane

DROP TABLE IF EXISTS replica_intent_outcome;
DROP TABLE IF EXISTS replica_invocation_commit;
DROP TABLE IF EXISTS replica_parked_payload;
DROP TABLE IF EXISTS replica_log;
DROP TABLE IF EXISTS replica_meta;
DROP TABLE IF EXISTS blob_replica;

---- per-device blob wrapping, superseded by rung four's file keys

DROP TABLE IF EXISTS blob_device_content_key;
DROP TABLE IF EXISTS blob_device_wrap_key;

---- automations

DROP TABLE IF EXISTS automation_state;
DROP TABLE IF EXISTS automation_trigger_cursor;
DROP TABLE IF EXISTS trigger_ingress;

---- connectors

DROP TABLE IF EXISTS sync_connection_credential;
DROP TABLE IF EXISTS sync_connection_cursor;
DROP TABLE IF EXISTS sync_connection_health;
DROP TABLE IF EXISTS sync_connection_run;
DROP TABLE IF EXISTS sync_import_row;
DROP TABLE IF EXISTS sync_import_batch;
DROP TABLE IF EXISTS sync_external_entity;
DROP TABLE IF EXISTS sync_connection;

---- agents

DROP TABLE IF EXISTS access_agent_secret;
DROP TABLE IF EXISTS access_agent;

---- the one column that pointed into the set

-- `locker_item.connection_id` was "the connector this password belongs to", a
-- foreign key into `sync_connection`. Its index goes first: SQLite refuses to
-- drop an indexed column.
DROP INDEX IF EXISTS locker_item_connection_idx;
ALTER TABLE locker_item DROP COLUMN connection_id;
