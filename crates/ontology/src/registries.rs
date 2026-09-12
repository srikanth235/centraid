//! The v0 registries, embedded.
//!
//! `contracts/schema/v0-registries.json` is transcribed from
//! `packages/vault/src/schema` by `contracts/tools/export-v0-registries.ts`.
//! This module EMBEDS it with `include_str!` rather than reading it from disk,
//! for two reasons: a shipped binary must not depend on a repository path, and
//! a registry that is compiled in cannot drift from the crate that was built
//! with it. The regeneration step is a source edit, not a runtime concern.
//!
//! The registries are still v0's to change until wave 6
//! ([#1020](https://github.com/srikanth235/centraid/issues/1020)); nothing here
//! re-decides them.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

const EMBEDDED: &str = include_str!("../../../contracts/schema/v0-registries.json");

#[derive(Debug, Clone, Deserialize)]
pub struct V0Registries {
    #[serde(rename = "ontologyVersion")]
    pub ontology_version: String,
    /// The LOW end of the accepted `PRAGMA user_version` window: what the #929
    /// golden corpus was frozen at (#1020, D-1020-A1).
    #[serde(rename = "userVersion")]
    pub user_version: i64,
    /// The HIGH end: what a freshly founded v0 vault reaches today, the length
    /// of v0's migration ladder.
    #[serde(rename = "ladderUserVersion")]
    pub ladder_user_version: i64,
    /// The schemas that are life data, and the bands that are plumbing. Only
    /// an ontology pack's entity gets a `core_entity` membership row.
    #[serde(rename = "ontologyPacks")]
    pub ontology_packs: Vec<String>,
    #[serde(rename = "machineryBands")]
    pub machinery_bands: Vec<String>,
    #[serde(rename = "auditBand")]
    pub audit_band: AuditBand,
    #[serde(rename = "privateTables")]
    pub private_tables: Vec<PrivateTable>,
    #[serde(rename = "localTables")]
    pub local_tables: Vec<LocalTable>,
    #[serde(rename = "sealedColumns")]
    pub sealed_columns: BTreeMap<String, Vec<String>>,
    pub entities: Vec<Entity>,
    #[serde(rename = "contentReferences")]
    pub content_references: Vec<ContentReference>,
    #[serde(rename = "retentionWindows")]
    pub retention_windows: BTreeMap<String, RetentionWindow>,
    #[serde(rename = "snapshotExclusions")]
    pub snapshot_exclusions: Vec<SnapshotExclusion>,
    /// The replicated-table ALLOW-LIST: the physical tables a seat's copy
    /// holds. An allow-list, not a deny-list (#1014 G13) — a table replicates
    /// because it is named here. Ext bands (`ext_`, `extdraft_`) are the one
    /// dynamic member and are admitted by PREFIX, so they are not in this
    /// list; ask `is_replicated_table` (#1020, D-1020-D1-12).
    #[serde(rename = "replicatedTables")]
    pub replicated_tables: Vec<String>,
    /// The numbers the log plane is built out of. A Rust constant that
    /// disagreed with one of these would be a silent protocol change.
    #[serde(rename = "replicaConstants")]
    pub replica_constants: ReplicaConstants,
}

/// The replica plane's constants, transcribed from v0 (#1020, D-1020-D1-12).
#[derive(Debug, Clone, Deserialize)]
pub struct ReplicaConstants {
    /// Compatibility. A mismatch is a re-bootstrap.
    #[serde(rename = "schemaEpoch")]
    pub schema_epoch: i64,
    /// Additive progress INSIDE one schema epoch. Conflating the two makes
    /// every additive column a full re-bootstrap (plane census seam 5).
    #[serde(rename = "ddlVersion")]
    pub ddl_version: i64,
    #[serde(rename = "seatSqliteFloor")]
    pub seat_sqlite_floor: String,
    /// Rows in one commit above which the images are gzipped.
    #[serde(rename = "producerMaxRows")]
    pub producer_max_rows: usize,
    /// COMPRESSED bytes above which a commit is deferred.
    #[serde(rename = "deferThresholdBytes")]
    pub defer_threshold_bytes: usize,
    #[serde(rename = "logRetentionDays")]
    pub log_retention_days: i64,
    #[serde(rename = "logRetentionMaxRows")]
    pub log_retention_max_rows: i64,
    /// How long a recorded seat cursor keeps pinning the retention floor.
    #[serde(rename = "seatHoldDays")]
    pub seat_hold_days: i64,
    /// Matches the log's retention floor ON PURPOSE: an outcome that outlived
    /// the log rows its `commit_seq` points into can no longer tell a seat
    /// where its effect landed.
    #[serde(rename = "idempotencyWindowDays")]
    pub idempotency_window_days: i64,
    #[serde(rename = "seatLogMaxPage")]
    pub seat_log_max_page: i64,
    /// Tables captured but never served to a seat — logged with `local = 1`.
    #[serde(rename = "localTables")]
    pub local_tables: Vec<String>,
    #[serde(rename = "jsonKeyExclusions")]
    pub json_key_exclusions: Vec<JsonKeyExclusion>,
}

/// JSON keys stripped from a replicated row image before it reaches the log.
#[derive(Debug, Clone, Deserialize)]
pub struct JsonKeyExclusion {
    pub table: String,
    pub column: String,
    #[serde(rename = "jsonKeys")]
    pub json_keys: Vec<String>,
}

/// The `audit` band: its physical tables, and the write-once subset whose
/// triggers refuse both UPDATE and DELETE outside the archive pass.
#[derive(Debug, Clone, Deserialize)]
pub struct AuditBand {
    pub tables: Vec<String>,
    #[serde(rename = "appendOnlyTables")]
    pub append_only_tables: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PrivateTable {
    pub table: String,
    /// `credential`, `gateway-job` or `peer-link` — the only three kinds.
    pub kind: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LocalTable {
    pub table: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Entity {
    /// The schema-qualified logical name, `core.party`.
    pub logical: String,
    /// The physical table, `core_party`.
    pub table: String,
    pub label: String,
    /// `append-only`, `mutable`, `trash` or `machinery`.
    pub lifecycle: String,
    #[serde(rename = "projectionOf")]
    pub projection_of: Option<String>,
    #[serde(rename = "deletionRoles")]
    pub deletion_roles: Vec<DeletionRole>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeletionRole {
    pub column: String,
    pub parent: String,
    pub role: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContentReference {
    pub table: String,
    pub column: String,
    #[serde(rename = "onlyLive")]
    pub only_live: Option<String>,
    #[serde(rename = "documentHead")]
    pub document_head: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RetentionWindow {
    pub days: i64,
    /// The duty that enforces the window.
    #[serde(rename = "duty")]
    pub duty: DutyName,
}

/// A duty's name is one of a small closed set; kept as a string so a new duty
/// in v0 does not fail to parse here before anyone has decided what v1 calls it.
pub type DutyName = String;

#[derive(Debug, Clone, Deserialize)]
pub struct SnapshotExclusion {
    pub table: String,
    pub reason: String,
}

/// The embedded registries, parsed once.
///
/// # Panics
///
/// Only if the embedded fixture is not the shape this module declares, which is
/// a build-time fact: the file is compiled in, so a malformed one cannot reach
/// a shipped binary without failing this crate's own tests first.
pub fn v0_registries() -> &'static V0Registries {
    static PARSED: OnceLock<V0Registries> = OnceLock::new();
    PARSED.get_or_init(|| {
        serde_json::from_str(EMBEDDED)
            .expect("contracts/schema/v0-registries.json is the shape registries.rs declares")
    })
}

/// Physical table names that never leave the gateway.
pub fn private_table_names() -> Vec<&'static str> {
    v0_registries()
        .private_tables
        .iter()
        .map(|entry| entry.table.as_str())
        .collect()
}

/// Physical table names that are deliberately unregistered.
pub fn local_table_names() -> Vec<&'static str> {
    v0_registries()
        .local_tables
        .iter()
        .map(|entry| entry.table.as_str())
        .collect()
}

/// Is this physical table one a seat's copy holds?
///
/// The allow-list plus the two ext-band PREFIXES, which is the whole of v0's
/// `isReplicatedTable` (#1014 G13; #1020, D-1020-D1-12). The prefixes are not
/// in the fixture because an ext band's physical name is generated per app, so
/// a list of them would be a list of one vault's apps.
#[must_use]
pub fn is_replicated_table(name: &str) -> bool {
    name.starts_with("ext_")
        || name.starts_with("extdraft_")
        || v0_registries()
            .replicated_tables
            .iter()
            .any(|table| table == name)
}

/// Every sealed column, as `(physical table, column)` pairs.
///
/// The registry keys sealed columns by LOGICAL entity name, which SQL cannot
/// use; the physical name is the logical one underscore-joined, the same
/// derivation `resolveEntity` makes.
pub fn sealed_physical_columns() -> Vec<(String, String)> {
    v0_registries()
        .sealed_columns
        .iter()
        .flat_map(|(entity, columns)| {
            let table = entity.replacen('.', "_", 1);
            columns
                .iter()
                .map(move |column| (table.clone(), column.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_fixture_parses_and_is_not_empty() {
        let registries = v0_registries();
        assert_eq!(registries.ontology_version, crate::ONTOLOGY_VERSION);
        assert!(!registries.private_tables.is_empty());
        assert!(!registries.local_tables.is_empty());
        assert!(!registries.entities.is_empty());
        assert!(!registries.sealed_columns.is_empty());
    }

    #[test]
    fn the_replicated_allow_list_is_the_whole_list_and_holds_no_private_table() {
        // 109 names as of #1014 G13 (plane census §1.7). The number is here
        // because a PARSE that silently shortened the list is exactly the
        // failure `export-v0-registries.ts` can have, and a seat missing a
        // table is not visible until a row does not arrive.
        let registries = v0_registries();
        assert_eq!(registries.replicated_tables.len(), 109);
        // THE ONE PROPERTY THE PRIVATE LIST EXISTS FOR, from the other side: a
        // table is never both. A table with replicated references is SPLIT
        // (`access_device` / `access_device_secret`), never listed twice.
        let overlap: Vec<&str> = private_table_names()
            .into_iter()
            .filter(|name| is_replicated_table(name))
            .collect();
        assert_eq!(overlap.join(", "), "");
        // And the prefixes, which are not in the fixture.
        assert!(is_replicated_table("ext_tally_thing"));
        assert!(is_replicated_table("extdraft_tally_thing"));
        assert!(!is_replicated_table("replica_log"));
    }

    #[test]
    fn the_replica_constants_are_v0s_numbers() {
        let constants = &v0_registries().replica_constants;
        assert_eq!(constants.schema_epoch, 4);
        assert_eq!(constants.ddl_version, 0);
        assert_eq!(constants.producer_max_rows, 2_000);
        assert_eq!(constants.defer_threshold_bytes, 1_000_000);
        assert_eq!(constants.log_retention_days, 30);
        assert_eq!(constants.log_retention_max_rows, 200_000);
        assert_eq!(constants.seat_hold_days, 14);
        // The window and the retention floor are the same number on purpose.
        assert_eq!(
            constants.idempotency_window_days,
            constants.log_retention_days
        );
        assert_eq!(constants.seat_log_max_page, 10_000);
        assert_eq!(constants.local_tables, ["replica_intent_outcome"]);
        assert_eq!(constants.json_key_exclusions.len(), 1);
        let exclusion = &constants.json_key_exclusions[0];
        assert_eq!(exclusion.table, "access_receipt");
        assert_eq!(exclusion.column, "detail_json");
        assert_eq!(exclusion.json_keys, ["output"]);
    }

    #[test]
    fn every_private_table_declares_one_of_the_three_kinds_and_a_reason() {
        // #996 ruling R3: three kinds, and only three. A fourth would be a
        // decision, and a decision does not arrive by transcription.
        let findings: Vec<String> = v0_registries()
            .private_tables
            .iter()
            .filter_map(|entry| {
                let kind_ok = matches!(
                    entry.kind.as_str(),
                    "credential" | "gateway-job" | "peer-link"
                );
                (!kind_ok || entry.reason.trim().is_empty()).then(|| {
                    format!(
                        "{}: kind `{}`, reason `{}`",
                        entry.table, entry.kind, entry.reason
                    )
                })
            })
            .collect();
        assert_eq!(findings.join("\n"), "");
    }

    #[test]
    fn every_entity_declares_a_label_and_a_lifecycle() {
        let findings: Vec<String> = v0_registries()
            .entities
            .iter()
            .filter_map(|entity| {
                let lifecycle_ok = matches!(
                    entity.lifecycle.as_str(),
                    "append-only" | "mutable" | "trash" | "machinery"
                );
                (!lifecycle_ok || entity.label.trim().is_empty()).then(|| {
                    format!(
                        "{}: `{}` / `{}`",
                        entity.logical, entity.label, entity.lifecycle
                    )
                })
            })
            .collect();
        assert_eq!(findings.join("\n"), "");
    }
}
