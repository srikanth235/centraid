//! The v1 schema authority: open a vault file, know its shape, verify it.
//!
//! This is the first crate of the v1 tree
//! ([#1020](https://github.com/srikanth235/centraid/issues/1020)) and it is
//! deliberately narrow. It can OPEN a vault, describe its shape, reproduce v0's
//! golden-corpus digests, and answer two engine-level soundness questions. It
//! cannot migrate one or run the ladder; it reaches the registries through the
//! transcribed fixture in `contracts/schema/v0-registries.json`.
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

pub use ddl::{DDL_FIXTURE_HEADER, ddl_fixture, render_ddl};
pub use doctor::{DoctorReport, format_doctor_report, vault_doctor};
pub use error::{OntologyError, Result};
pub use snapshot::{
    Compared, SnapshotComparison, TableSnapshot, VaultSnapshot, compare_snapshot, snapshot_table,
    snapshot_tables, snapshot_vault,
};
pub use vault::{
    ONTOLOGY_VERSION, SchemaObject, Vault, expected_user_version, ladder_user_version,
};
