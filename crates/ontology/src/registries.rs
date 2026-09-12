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
