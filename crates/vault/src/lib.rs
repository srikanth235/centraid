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
pub mod converge;
pub mod custody;
pub mod devices;
pub mod error;
pub mod file;
pub mod intents;
// Wave 4 lane assist: the `ledger` band's statements (#1020, D-1020-AS3).
pub mod ledger;
pub mod log;
pub mod migrations;
pub mod page;
pub mod snapshot;
pub mod time;
pub mod value;

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
pub use log::{CommitResult, CommitTx, Cursor, LogOp, LogPage, LogRow, LogState};
pub use migrations::{APPLICATION_ID, head_version};
pub use snapshot::{Fault, SnapshotHead, Step, build_snapshot};
pub use value::{RowImage, Value};
