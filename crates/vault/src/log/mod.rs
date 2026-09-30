//! THE COMMIT PAIR, AND THE SHAPE OF A TABLE.
//!
//! This module used to be the **replica log plane** — `replica_log` holding a
//! full row image per change, `replica_meta` holding the singleton position,
//! the session-extension capture that filled them, the page door that served
//! them and the applier that replayed them. All of it existed for a SEAT, and
//! there is no seat ([#1029](https://github.com/srikanth235/centraid/issues/1029)
//! §1, §6): the log had one writer and no reader, so a full second copy of
//! every row was being written for nobody.
//!
//! What is left:
//!
//! - [`guard`] — `BEGIN IMMEDIATE` → body → `COMMIT`, with an `update_hook`
//!   collecting the tables a commit touched, which is what a change event is
//!   made of.
//! - [`identifiers`] — `PRAGMA table_info` and SQL identifier quoting, which
//!   were never part of the log plane and are used by every SQL-building
//!   caller in this crate.
//!
//! `commit_seq` went with the plane. It was the position a seat's cursor
//! chased; nothing else ever read it.

pub mod census;
pub mod guard;
pub mod identifiers;

pub use census::RunningCensus;
pub use guard::{ChangeCensus, CommitResult, CommitTx};
pub use identifiers::{primary_key_of, quoted, table_columns};

/// The replica plane's constants, from the transcribed registry.
///
/// Read through a function rather than copied into Rust constants: a number
/// here that disagreed with v0's would be a silent protocol change, and the
/// registry fixture is the one place either side can be held to.
#[must_use]
pub fn constants() -> &'static centraid_ontology::registries::ReplicaConstants {
    &centraid_ontology::registries::v0_registries().replica_constants
}
