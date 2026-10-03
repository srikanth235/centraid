//! The snapshot plane: the vault backed up as page-identical snapshots, from
//! first principles ([#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! A snapshot is the live vault copied page for page into a scratch file, cut
//! into 4 MiB ranges, each range a file in `centraid-sealed/2`
//! ([`centraid_media::sealed`]) named from its own BLAKE3, plus one manifest
//! naming the ranges. An unchanged range has an unchanged name, so a snapshot
//! uploads only the ranges that changed since one the gateway already holds,
//! and the gateway is asked rather than an index kept: there is no custody
//! table, no placement row and no packs index anywhere (#1080 rulings 4, 5).
//!
//! | Module | What it owns |
//! |---|---|
//! | [`naming`] | the keys from the root key, and the names the vault's content implies |
//! | [`store`] | the [`store::Store`] trait one destination answers, and [`store::MemoryStore`] |
//! | [`ledger`] | `<stem>.backup.db`: destinations, the queue, confirmations, snapshots |
//! | [`spool`] | `<stem>.spool/`: sealed parts waiting to move, under a byte budget |
//! | [`retention`] | which snapshots to keep, and which names are garbage |
//!
//! ## WHAT IS DEVICE-LOCAL AND DERIVED
//!
//! The ledger and the spool live beside the vault file and are never inside
//! it: a snapshot of the vault therefore never carries the state of its own
//! upload. Both are rebuilt from the gateway's answers — `exists` for what is
//! held, `snapshots` for what is registered — so losing them costs a
//! re-upload, never a backup. The shells exclude both from OS backup.
//!
//! ## WHAT THIS PLANE DOES NOT DO
//!
//! It speaks to one destination through [`store::Store`] and never to a
//! socket; the gateway client and the phone's drain and media pipeline are
//! built over it. It coexists with [`crate::backup`] until the cut-over that
//! deletes that plane and takes this one's name.

pub mod ledger;
pub mod naming;
pub mod retention;
pub mod spool;
pub mod store;

use crate::error::VaultError;

/// Everything the plane refuses.
#[derive(Debug, thiserror::Error)]
pub enum PlaneError {
    /// SQLite (the vault's or the ledger's) or the filesystem, with a full
    /// disk classified as [`VaultError::DiskFull`].
    #[error(transparent)]
    Vault(#[from] VaultError),
    /// A part that did not seal or did not open.
    #[error(transparent)]
    Sealed(#[from] centraid_media::sealed::SealedError),
    /// The destination refused, or could not be reached.
    #[error(transparent)]
    Store(#[from] store::StoreError),
    /// A rule of the plane itself was broken.
    #[error("{context}")]
    Invariant { context: String },
}

impl From<rusqlite::Error> for PlaneError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Vault(VaultError::from(error))
    }
}

impl From<std::io::Error> for PlaneError {
    fn from(error: std::io::Error) -> Self {
        Self::Vault(VaultError::from(error))
    }
}

pub(crate) fn invariant(context: impl Into<String>) -> PlaneError {
    PlaneError::Invariant {
        context: context.into(),
    }
}

/// The result of anything in this plane.
pub type Result<T> = std::result::Result<T, PlaneError>;
