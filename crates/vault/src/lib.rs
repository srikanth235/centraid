//! The authority's file: the vault, its gate, its doors and its backup plane.
//!
//! Everything durable a Centraid phone knows is in one SQLite file, and
//! everything that writes to that file goes through [`Vault::commit`]
//! ([#1020](https://github.com/srikanth235/centraid/issues/1020)). The model it
//! holds is the one of [#1135](https://github.com/srikanth235/centraid/issues/1135):
//! an `entity` for everything with a title and a trash, a `kind` row for what it
//! is, typed `edge`s for how things are joined, `blob`s and `derivative`s for
//! bytes, an `origin` and a `source` for what is followed. `docs/vault-ontology.md`
//! says what each table means; this crate is the writer.
//!
//! ## The interface its consumers use
//!
//! | Consumer | What it uses |
//! |---|---|
//! | `crates/apps/kit` | [`Vault::page_raw`], [`page::and_row_filters`], [`page::apply_field_mask`], [`commands::Registry`] |
//! | `crates/search` | the `search` index [`index`] keeps, read through [`Vault::read`] |
//! | `crates/core` | [`Vault`], its commands and doors, [`backup`], [`blob`] |
//!
//! `crates/api-proto` is deliberately **not** a dependency: everything here is
//! plain Rust and the conversion to wire messages happens at the edge.

#![forbid(unsafe_code)]

pub mod access;
pub mod backup;
pub mod blob;
pub mod bootstrap;
pub mod bytes;
pub mod canonical;
pub mod clock;
pub mod commands;
pub mod custody;
pub mod error;
pub mod file;
pub mod index;
pub mod journal;
pub mod log;
pub mod migrations;
pub mod model;
pub mod page;
pub mod snapshot;
pub mod testdoor;
pub mod time;
pub mod value;

/// SQLite, AS THIS CRATE LINKS IT.
///
/// Re-exported rather than depended on twice, so a test that opens a vault file
/// raw (`crates/core-ffi/tests/contract.rs`) gets the same TYPE this crate
/// uses and not a second rusqlite that happens to unify today.
///
/// **It is not an invitation.** The `sql-confinement` rule still refuses SQL
/// outside the allowed crates; what this exports is the handle, not the query
/// language.
pub use rusqlite;

pub use access::{Decision, Principal, Verb, evaluate_access};
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
