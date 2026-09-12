//! The v1 schema authority: open a vault file, know its shape, verify it.
//!
//! This is the first crate of the v1 tree
//! ([#1020](https://github.com/srikanth235/centraid/issues/1020)) and it is
//! deliberately narrow. It can OPEN a vault, describe its shape, reproduce v0's
//! golden-corpus digests, and answer two engine-level soundness questions. It
//! cannot yet migrate one, emit its DDL, or run the ladder — the v0 registries
//! under `packages/vault/src/schema` remain the source of the model until wave
//! 6, and this crate reaches them through the transcribed fixture in
//! `contracts/schema/v0-registries.json`.
//!
//! Wave 1's checkpoint is one sentence: **the ontology crate opens the v0
//! golden vault**, and `tests/golden_vault.rs` is that sentence as a test.

#![forbid(unsafe_code)]

pub mod ddl;
pub mod doctor;
pub mod error;
pub mod golden;
pub mod jsvalue;
pub mod registries;
pub mod snapshot;
pub mod vault;

pub use ddl::{DDL_FIXTURE_HEADER, ddl_fixture};
pub use doctor::{DoctorReport, format_doctor_report, vault_doctor};
pub use error::{OntologyError, Result};
pub use snapshot::{
    Compared, SnapshotComparison, TableSnapshot, VaultSnapshot, compare_snapshot, snapshot_table,
    snapshot_tables, snapshot_vault,
};
pub use vault::{EXPECTED_USER_VERSION, ONTOLOGY_VERSION, SchemaObject, Vault};
