//! Named stages of founding and of a migration, so a fault test can stop or fail a real run exactly
//! there (#1191, V17, V18): a child process that pauses at a stage and is killed, or a stage that
//! answers "the disk is full".
//!
//! The hook is per thread and absent by default, so a production run reads one empty cell per
//! stage and nothing else. A hook that returns an error fails the step the way the disk would:
//! `StorageFull` becomes [`crate::VaultError::DiskFull`] through the usual conversion.

use std::cell::Cell;

use crate::error::Result;

/// A point inside founding or a migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Founding: the whole ladder is written to the side file (still in its WAL).
    FoundingLaidDown,
    /// Founding: checkpointed into the one file and closed, not yet flushed to disk.
    FoundingCheckpointed,
    /// Founding: the side file is flushed, not yet renamed to its name.
    FoundingFlushed,
    /// Founding: renamed to its name, the directory not yet flushed.
    FoundingRenamed,
    /// A migration rung has written its changes and has not committed them.
    RungWritten,
    /// A commit's body, index, alerts and history are written; `COMMIT` has not run.
    BeforeCommit,
    /// `COMMIT` has returned: the commit is durable.
    Committed,
    /// `open` ran `PRAGMA quick_check` (counted by a test: a healthy open runs it once).
    QuickChecked,
}

/// What a test installs: called at every stage this thread reaches.
pub type Hook = fn(Stage) -> std::io::Result<()>;

thread_local! {
    static HOOK: Cell<Option<Hook>> = const { Cell::new(None) };
}

/// Install (or remove) this thread's hook.
pub fn set_hook(hook: Option<Hook>) {
    HOOK.with(|cell| cell.set(hook));
}

/// Reach `stage`: run this thread's hook, if any.
///
/// # Errors
/// Whatever the hook answers, as a [`crate::VaultError`].
pub(crate) fn reached(stage: Stage) -> Result<()> {
    match HOOK.with(Cell::get) {
        Some(hook) => hook(stage).map_err(Into::into),
        None => Ok(()),
    }
}
