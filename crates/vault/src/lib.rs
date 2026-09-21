//! The authority's file: the v1 vault, its commit log, its doors, its commands.
//!
//! This is the umbrella's centre ([#1020](https://github.com/srikanth235/centraid/issues/1020)
//! wave 2, lane D1). Everything durable a Centraid gateway knows is in one
//! SQLite file, and everything that writes to that file goes through
//! [`Vault::commit`].
//!
//! ## What is v0-faithful and what is v1-only
//!
//! **Faithful** — reproduced because a fixture, a seat or a file format depends
//! on the exact behaviour, with the v0 path named in each module's docs: the
//! `replica_meta` / `replica_log` DDL and its constants; session capture, one
//! session per table; the changeset decode including `absent` ≠ NULL and the
//! positional DELETE image; the delta prior; the row-image JSON spelling
//! (`{i}`, `{b64}`, JavaScript's numbers); the log door's paging rules and
//! epoch gate; retention's commit edge and live-cursor hold; the epoch bump's
//! floor derivation; the snapshot pipeline's seven steps and their order; the
//! command gate order and the audit band; the canonical payload hash.
//!
//! **v1-only** — decided here, each with its reason in the module:
//! `PRAGMA application_id = CEN1` and a `user_version` counting v1's OWN
//! migrations (D-1020-D1-2); the commit pair as the only writable connection,
//! with reads held under `query_only` (D-1020-D1-5); the doors as functions
//! rather than routes (D-1020-D1-6); one content-addressed snapshot for backup,
//! bootstrap and pre-migration safety (D-1020-D1-7); `VaultError::DiskFull` as
//! a typed answer (D-1020-D1-8); the baseline migration and its `contracts/`
//! fixture being ONE file (D-1020-D1-13).
//!
//! ## The interface D2, D3 and R consume
//!
//! | Consumer | What it uses |
//! |---|---|
//! | `crates/seat` (D2) | [`log::apply_log_page`], [`log::LogRow`], [`log::Cursor`], [`log::read_log_page`] |
//! | `crates/apps/kit` (D3) | [`Vault::page_raw`], [`page::and_row_filters`], [`page::apply_field_mask`], [`commands::Registry`], the `tally.*` stubs |
//! | recovery (R) | [`snapshot::build_snapshot`], [`snapshot::SnapshotHead`], [`Vault::found`], [`Vault::enrol_device`] |
//!
//! `crates/api-proto` is deliberately **not** a dependency: lane C defines the
//! proto messages concurrently, so everything here is plain Rust and D2 wires
//! the conversion at the edge.

#![forbid(unsafe_code)]

pub mod access;
pub mod audit;
pub mod backup;
pub mod bootstrap;
pub mod clock;
pub mod commands;
pub mod content;
pub mod custody;
pub mod devices;
pub mod error;
pub mod file;
pub mod canonical;
pub mod log;
pub mod migrations;
pub mod operations;
pub mod page;
pub mod snapshot;
pub mod testdoor;
pub mod time;
pub mod value;
pub mod wal_persistence;

/// SQLite, AS THIS CRATE LINKS IT (#1029 W5, hand-off 5).
///
/// `crates/core-ffi` needs the `Connection` and the `ffi` module to make one
/// `sqlite3_file_control` call for `crate::wal_persistence` — the shim the
/// constitution keeps in that crate because it is unsafe. Re-exported rather
/// than depended on twice, so the `Connection` the shim takes is the same TYPE
/// this crate hands it and not a second rusqlite that happens to unify today.
///
/// **It is not an invitation.** The `sql-confinement` rule still refuses SQL
/// outside the four allowed crates; what this exports is the handle, not the
/// query language.
pub use rusqlite;

pub use access::{
    BLIND_SCHEMA, Decision, Principal, RevealUnrepresentable, SealedSubject, Verb, evaluate_access,
    evaluate_reveal,
};
pub use clock::{Clock, ClockIds, FixedClock, Ids, SeededIds, SystemClock};
pub use commands::{
    Command, CommandDefinition, CommandOutcome, CommandStatus, Idempotency, Registry, Risk,
};
pub use error::{IntentRefusal, RebootstrapReason, Result, VaultError};
pub use file::Vault;
pub use log::{ChangeCensus, CommitResult, CommitTx};
pub use migrations::{APPLICATION_ID, head_version};
pub use snapshot::{Fault, SnapshotHead, Step, build_snapshot};
pub use value::{RowImage, Value};
