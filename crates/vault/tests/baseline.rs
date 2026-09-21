//! The baseline migration IS the corpus's schema (D-1020-D1-1, D-1020-D1-2).
//!
//! `contracts/migrations/001_baseline.sql` is generated from the corpus, so the
//! claim it makes is testable: found a v1 file from it and its `sqlite_master`
//! must equal the corpus's, object for object, SQL for SQL.
//!
//! **The exclusions, and every one's reason.** The generator leaves out exactly
//! three classes of object, and this test confirms each is back in the founded
//! file anyway — because SQLite creates it itself:
//!
//! | Excluded | Why | Back in the file? |
//! |---|---|---|
//! | FTS shadow tables (`fts_*_{data,idx,content,docsize,config}`) | `CREATE VIRTUAL TABLE` creates them; issuing their DDL too is an error | yes, 90 of them |
//! | `sqlite_sequence` | created for the first `AUTOINCREMENT` table; a hand-written `CREATE TABLE` for it is refused | yes |
//! | `sqlite_autoindex_*` | implicit, created by the UNIQUE constraint that needs it, and not nameable in DDL | yes, and not in `sqlite_master` with a `sql` at all |
//!
//! So the answer to "what is excluded from the comparison" is **nothing**. The
//! founded schema and the corpus's schema are equal as sets and as text, EXCEPT
//! for what the LADDER does above the baseline, in both directions:
//!
//! - what a rung ADDS — rung two's four revision guards (#1020, D-1020-N2),
//!   rung three's four backup-index objects and rung four's four blob-custody
//!   objects (#1029 §2, §4) — named in `LADDER_OBJECTS`;
//! - what rung five DROPS — the planes v1 does not have (#1029) — named in
//!   `DROPPED_OBJECTS`;
//! - the one table rung five ALTERS — `locker_item`, which loses the
//!   `connection_id` column that pointed into `sync_connection` — named in
//!   `ALTERED_OBJECTS`.
//!
//! All three are named rather than matched by prefix, so a table that comes
//! back, a drop that stops running and an object arriving from nowhere are each
//! a failure with a name. Any future exclusion has to be added to this table
//! with its reason, and the assertion below is what forces that.

mod common;

use std::collections::BTreeMap;

use centraid_vault::{APPLICATION_ID, Vault, head_version};

/// What the ladder adds above the baseline: rung two's four revision guards
/// (#1020, D-1020-N2), rung three's in-vault backup index and rung four's blob
/// custody — a file key per blob, and where its bytes are (#1029 §2, §4).
///
/// The corpus is a v0 file and knows nothing of the v1 ladder above rung one,
/// so a founded v1 file legitimately carries exactly these and nothing else.
/// Named here rather than filtered by prefix: a guard that stopped being
/// created, or an object arriving from somewhere, both have to show up as a
/// failure.
const LADDER_OBJECTS: [&str; 12] = [
    "backup_base_range",
    "backup_base_range_by_hash",
    "backup_blob_custody",
    "backup_blob_custody_by_role",
    "backup_blob_placement",
    "backup_blob_placement_by_object",
    "backup_object_range",
    "backup_object_range_by_object",
    "core_entity_revision_no_self_parent",
    "core_entity_revision_parent_is_immutable",
    "core_entity_revision_parent_is_same_object",
    "core_link_no_revises_edge",
];

/// WHAT RUNG FIVE DROPS (#1029): the storage of every plane this umbrella
/// deleted in code — sharing, the outbox, the replica plane, per-device blob
/// wrapping, automations, connectors, agents and the conversation ledger band —
/// with each dropped table's own indexes and triggers, the `fts_conversation`
/// virtual table's five shadow tables, the `run_summary` view over the ledger
/// and the `core_entity_revoke_on_purge` trigger whose whole body was an UPDATE
/// on `share_authority`.
///
/// `access_device` and `access_device_secret` are deliberately NOT here:
/// `Vault::enrol_device` has live callers and the base copy carries
/// `access_device_secret` as a sealed custody property (#1029 B1).
const DROPPED_OBJECTS: [&str; 119] = [
    "access_agent",
    "access_agent_secret",
    "attachments",
    "automation_state",
    "automation_trigger_cursor",
    "blob_device_content_key",
    "blob_device_wrap_key",
    "blob_device_wrap_key_touch_updated_at",
    "blob_outbox",
    "blob_outbox_touch_updated_at",
    "blob_replica",
    "conversation_archive",
    "conversation_digest",
    "conversation_harness_sessions",
    "conversation_item_count_ad",
    "conversation_item_count_ai",
    "conversation_provider_consent",
    "conversation_turn_locks",
    "conversation_workspace_selection",
    "conversations",
    "core_entity_revoke_on_purge",
    "fts_conversation",
    "fts_conversation_config",
    "fts_conversation_content",
    "fts_conversation_conv_ad",
    "fts_conversation_conv_ai",
    "fts_conversation_conv_au",
    "fts_conversation_data",
    "fts_conversation_docsize",
    "fts_conversation_idx",
    "fts_conversation_item_ad",
    "fts_conversation_item_ai",
    "fts_conversation_turn_ad",
    "harness_health",
    "idx_attachments_hash",
    "idx_attachments_item",
    "idx_automation_trigger_cursor_updated",
    "idx_blob_device_content_key_device",
    "idx_blob_outbox_retry",
    "idx_conversation_archive_conv",
    "idx_conversation_archive_sha",
    "idx_conversation_archive_unpruned",
    "idx_conversation_digest_automation",
    "idx_conversation_harness_latest",
    "idx_conversation_provider_consent_active",
    "idx_conversations_app",
    "idx_conversations_automation",
    "idx_conversations_user_updated",
    "idx_harness_health_breaker",
    "idx_items_by_model",
    "idx_items_by_turn",
    "idx_items_run_rollup",
    "idx_items_turn_call",
    "idx_outbox_item_authority",
    "idx_outbox_item_connection",
    "idx_outbox_item_published_message",
    "idx_outbox_item_recipient_party",
    "idx_outbox_item_status",
    "idx_outbox_item_target",
    "idx_replica_intent_device_status",
    "idx_replica_invocation_commit_intent",
    "idx_replica_log_epoch_commit",
    "idx_replica_log_epoch_seq",
    "idx_replica_log_row",
    "idx_replica_parked_grant",
    "idx_sync_connection_run_connection",
    "idx_sync_external_entity",
    "idx_sync_import_batch_connection",
    "idx_sync_import_row_batch",
    "idx_trigger_ingress_expiry",
    "idx_trigger_ingress_source_position",
    "idx_turns_conversation",
    "idx_turns_idempotency",
    "idx_turns_parent",
    "idx_turns_started",
    "items",
    "locker_item_connection_idx",
    "outbox_item",
    "replica_intent_outcome",
    "replica_intent_outcome_touch_updated_at",
    "replica_invocation_commit",
    "replica_log",
    "replica_meta",
    "replica_parked_payload",
    "run_summary",
    "share_authority",
    "share_authority_granted_by",
    "share_authority_live_answer",
    "share_authority_principal",
    "share_authority_request",
    "share_authority_request_open",
    "share_authority_subject",
    "share_authority_use",
    "share_delivery_config",
    "share_fulfillment",
    "share_fulfillment_touch_updated_at",
    "share_party_vault_binding",
    "share_party_vault_binding_live_party",
    "share_party_vault_binding_not_self_ai",
    "share_party_vault_binding_not_self_au",
    "share_subscription",
    "share_subscription_lineage",
    "share_subscription_lineage_target",
    "share_subscription_member",
    "share_subscription_subscribed_page_idx",
    "share_subscription_touch_updated_at",
    "sync_connection",
    "sync_connection_credential",
    "sync_connection_credential_touch_updated_at",
    "sync_connection_cursor",
    "sync_connection_cursor_touch_updated_at",
    "sync_connection_health",
    "sync_connection_health_touch_updated_at",
    "sync_connection_run",
    "sync_external_entity",
    "sync_import_batch",
    "sync_import_row",
    "trigger_ingress",
    "turns",
];

/// The one object rung five ALTERS rather than creates or drops.
///
/// `locker_item.connection_id` was a foreign key into `sync_connection`, "the
/// connector this password belongs to". There is no connector runtime, so the
/// column and its index go — which makes this table's DDL differ from the
/// corpus's by exactly one line.
const ALTERED_OBJECTS: [&str; 1] = ["locker_item"];

/// Every schema object of a file, keyed by `(type, name)`.
fn schema_of(connection: &rusqlite::Connection) -> BTreeMap<(String, String), String> {
    let mut statement = connection
        .prepare(
            r"SELECT type, name, sql FROM sqlite_master
                WHERE sql IS NOT NULL
                  AND name NOT LIKE 'sqlite\_stat%' ESCAPE '\'
                ORDER BY type, name",
        )
        .expect("the query prepares");
    statement
        .query_map([], |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                row.get::<_, String>(2)?,
            ))
        })
        .expect("the query runs")
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()
        .expect("the rows read")
}

#[test]
fn a_founded_v1_file_carries_exactly_the_corpuss_schema() {
    let golden = centraid_ontology::golden::open_golden().expect("the corpus inflates");
    let corpus = rusqlite::Connection::open(golden.db_path()).expect("the corpus opens");
    let expected = schema_of(&corpus);

    let scratch = common::Scratch::empty("baseline").expect("a vault is founded");
    let actual = scratch
        .vault
        .read(|connection| Ok(schema_of(connection)))
        .expect("the founded schema reads");

    let mut findings: Vec<String> = Vec::new();
    let mut dropped: Vec<&str> = Vec::new();
    for (key, sql) in &expected {
        match actual.get(key) {
            None if DROPPED_OBJECTS.contains(&key.1.as_str()) => dropped.push(key.1.as_str()),
            None => findings.push(format!(
                "{} `{}` is in the corpus and not founded",
                key.0, key.1
            )),
            Some(found) if found != sql => {
                if !ALTERED_OBJECTS.contains(&key.1.as_str()) {
                    findings.push(format!("{} `{}`: the DDL differs", key.0, key.1));
                }
            }
            Some(_) => {}
        }
    }
    dropped.sort_unstable();
    let mut beyond: Vec<&str> = Vec::new();
    for key in actual.keys() {
        if expected.contains_key(key) {
            continue;
        }
        if LADDER_OBJECTS.contains(&key.1.as_str()) {
            beyond.push(key.1.as_str());
            continue;
        }
        findings.push(format!(
            "{} `{}` is founded and not in the corpus",
            key.0, key.1
        ));
    }
    beyond.sort_unstable();
    assert_eq!(findings.join("\n"), "");
    // AND THE DROPS ARE RUNG FIVE'S, NAMED. A table that came back, or a drop
    // that stopped running, is this assertion rather than a silent pass.
    assert_eq!(dropped, DROPPED_OBJECTS);
    // AND THE DELTA IS THE LADDER, NAMED (#1020, close pass). A founded file is
    // the baseline PLUS every rung above it, so the difference from the corpus
    // is not "nothing" any more — it is exactly rung two's four guards and rung
    // three's four backup-index objects, and anything else appearing here is a
    // rung nobody declared.
    assert_eq!(beyond, LADDER_OBJECTS);

    // NOT VACUOUS. Two empty schemas compare equal, which is the one way this
    // could pass for free.
    assert!(
        expected.len() > 700,
        "only {} objects in the corpus",
        expected.len()
    );
    assert_eq!(
        expected.len() + LADDER_OBJECTS.len() - DROPPED_OBJECTS.len(),
        actual.len()
    );
}

#[test]
fn the_three_excluded_classes_are_created_by_sqlite_itself() {
    let scratch = common::Scratch::empty("excluded").expect("a vault is founded");
    let (shadows, sequence, autoindexes): (i64, i64, i64) = scratch
        .vault
        .read(|connection| {
            Ok((
                connection.query_row(
                    r"SELECT COUNT(*) FROM sqlite_master
                        WHERE type = 'table' AND name LIKE 'fts\_%' ESCAPE '\'
                          AND sql LIKE 'CREATE TABLE%'",
                    [],
                    |row| row.get(0),
                )?,
                connection.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_sequence'",
                    [],
                    |row| row.get(0),
                )?,
                connection.query_row(
                    r"SELECT COUNT(*) FROM sqlite_master
                        WHERE name LIKE 'sqlite\_autoindex%' ESCAPE '\'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("the counts read");
    // 17 virtual tables × 5 shadow tables each: rung five drops
    // `fts_conversation` with the ledger band it indexed (#1029).
    assert_eq!(shadows, 85);
    assert_eq!(sequence, 1);
    assert!(autoindexes > 0, "no implicit index was created");
    // And none of the three appears in the baseline's own text.
    assert!(!centraid_vault::migrations::BASELINE_SQL.contains("CREATE TABLE sqlite_sequence"));
}

#[test]
fn the_fifty_seven_fts_sync_triggers_survive_the_baseline() {
    // THE SLIP THIS CATCHES. An FTS sync trigger is named `fts_<table>_ai`,
    // which starts with the virtual table's name and an underscore exactly as a
    // shadow table does; excluding shadow objects by name alone dropped all of
    // them, and a seat's first write then wrote nothing into the index.
    let scratch = common::Scratch::empty("fts").expect("a vault is founded");
    let triggers: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                r"SELECT COUNT(*) FROM sqlite_master
                    WHERE type = 'trigger' AND name LIKE 'fts\_%' ESCAPE '\'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    // 57 in the corpus, less the six `fts_conversation_*` sync triggers rung
    // five drops with the conversation ledger band (#1029).
    assert_eq!(triggers, 51);
}

#[test]
fn the_entity_kind_registry_is_derived_and_equals_what_v0s_ladder_seeded() {
    // D-1020-D1-15. The derivation is "a logical name whose table keys into
    // `core_entity(entity_id)` on its own primary key", read off the DDL. This
    // holds it to v0's answer in BOTH directions, because a derivation that
    // over-registers turns a child row into an entity and one that
    // under-registers makes an app's first insert fail its foreign key.
    let golden = centraid_ontology::golden::open_golden().expect("the corpus inflates");
    let corpus = rusqlite::Connection::open(golden.db_path()).expect("the corpus opens");
    let mut statement = corpus
        .prepare("SELECT kind FROM core_entity_kind ORDER BY kind")
        .expect("the query prepares");
    let seeded: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .expect("the query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("the rows read");

    let scratch = common::Scratch::empty("kinds").expect("a vault is founded");
    let derived: Vec<String> = scratch
        .vault
        .read(|connection| {
            let mut statement =
                connection.prepare("SELECT kind FROM core_entity_kind ORDER BY kind")?;
            Ok(statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?)
        })
        .expect("the kinds read");

    assert_eq!(seeded.len(), 52, "the corpus's own count");
    let missing: Vec<&String> = seeded
        .iter()
        .filter(|kind| !derived.contains(kind))
        .collect();
    let extra: Vec<&String> = derived
        .iter()
        .filter(|kind| !seeded.contains(kind))
        .collect();
    assert_eq!(
        (missing.is_empty(), extra.is_empty()),
        (true, true),
        "missing {missing:?}, extra {extra:?}"
    );
    // A spot check that the exclusions are the RIGHT ones: a child row of an
    // expense is not an entity, and a machinery band's row is not either.
    assert!(derived.iter().any(|kind| kind == "tally.expense"));
    assert!(!derived.iter().any(|kind| kind == "tally.expense_split"));
    assert!(!derived.iter().any(|kind| kind == "share.authority"));
}

#[test]
fn the_two_pragmas_and_the_replica_seed_are_written() {
    let scratch = common::Scratch::empty("pragmas").expect("a vault is founded");
    let (application_id, user_version, journal): (i64, i64, String) = scratch
        .vault
        .read(|connection| {
            Ok((
                connection.query_row("PRAGMA application_id", [], |row| row.get(0))?,
                connection.query_row("PRAGMA user_version", [], |row| row.get(0))?,
                connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?,
            ))
        })
        .expect("the pragmas read");
    assert_eq!(application_id, APPLICATION_ID);
    // v1's OWN axis. The corpus is a v0 file at rung 11; a v1 file is at 1,
    // because there is no v0-artifact compatibility and the v0 ladder number
    // says nothing about a v1 file (D-1020-D1-2).
    assert_eq!(user_version, head_version());
    // Rung two is the revision guards (#1020, D-1020-N2); rung three is the
    // in-vault backup index and rung four is blob custody (#1029 §2, §4); rung
    // five is the cut (#1029). Spelled out rather than left as
    // `head_version()` alone: a rung silently vanishing would still satisfy the
    // line above.
    assert_eq!(user_version, 5);
    assert_eq!(journal, "wal");
}

#[test]
fn reopening_a_founded_file_changes_nothing() {
    let scratch = common::Scratch::founded("reopen").expect("a vault is founded");
    let before = scratch
        .vault
        .read(|connection| Ok(schema_of(connection)))
        .expect("the schema reads");
    let path = scratch.vault.path().to_path_buf();
    let reopened = Vault::open(&path).expect("it reopens");
    assert_eq!(reopened.schema_version(), head_version());
    let after = reopened
        .read(|connection| Ok(schema_of(connection)))
        .expect("the schema reads");
    assert_eq!(before, after);
    // And no pre-migration snapshot was taken, because nothing migrated: the
    // one-snapshot rule costs nothing on an up-to-date file.
    let snapshots = centraid_vault::snapshot::pre_migration_dir(&path);
    assert!(!snapshots.exists(), "a snapshot was taken for no migration");
}
