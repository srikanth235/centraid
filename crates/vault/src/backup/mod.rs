//! The backup library: the vault as a tree of small sealed objects, and the
//! engine that moves them to gateways
//! ([#1209](https://github.com/srikanth235/centraid/issues/1209),
//! `contracts/backup/spec.md`).
//!
//! | Module | What it owns |
//! |---|---|
//! | [`naming`] | the keys from the root key, and the vault's claims on content |
//! | [`files`] | every file the vault knows by hash, with what a pass decides by |
//! | [`tree`] | manifest v6: the root, range leaves and the blobs radix tree (§3) |
//! | [`directory`] | the sealed gateway directory (E8) |
//! | [`wal`] | which pages the WAL says changed since the last snapshot |
//! | [`snapshot`] | one pinned read of the vault into a tree: dirty ranges, a periodic full read (§5) |
//! | [`state`] | `<stem>.state.db`: the paired gateways, what each confirmed, the node cache |
//! | [`staging`] | `<stem>.staging/`: sealed ranges and OS-only originals under a byte budget (§6.4) |
//! | [`store`] | the [`store::Store`] trait one gateway answers, and [`store::MemoryStore`] |
//! | [`engine`] | a pass per gateway: head, records, thumbnails, originals, read-back (§6.2, §6.3) |
//! | [`retention`] | which snapshots to keep and which names are garbage (7 daily, 4 weekly, 6 monthly) |
//! | [`restore`] | the vault rebuilt from a gateway in the order R3, the check and the drill (§7) |
//!
//! ## WHAT IS DEVICE-LOCAL AND DERIVED
//!
//! The device state and the staging area live beside the vault file and are
//! never inside it. Both are rebuilt from the gateways' answers, so losing
//! them costs a re-pair and a re-ask, never a backup.
//!
//! ## WHAT THIS PLANE DOES NOT DO
//!
//! It speaks to a gateway through [`store::Store`] and never to a socket; the
//! gateway client and the phone's driver are built over it
//! (`crates/core/src/phone`).

pub mod content;
pub mod directory;
pub mod drill;
pub mod engine;
pub mod files;
pub mod naming;
pub mod restore;
pub mod retention;
pub mod snapshot;
pub mod staging;
pub mod state;
pub mod store;
pub mod tree;
pub mod wal;

use centraid_media::sealed::Name;

use crate::error::VaultError;

/// Everything the plane refuses.
#[derive(Debug, thiserror::Error)]
pub enum PlaneError {
    /// SQLite (the vault's or the device state's) or the filesystem, with a full
    /// disk classified as [`VaultError::DiskFull`].
    #[error(transparent)]
    Vault(#[from] VaultError),
    /// An object that did not seal or did not open.
    #[error(transparent)]
    Sealed(#[from] centraid_media::sealed::SealedError),
    /// The destination refused, or could not be reached.
    #[error(transparent)]
    Store(#[from] store::StoreError),
    /// A tree node a walk needed and the cache did not hold.
    #[error("the tree node {0} is not held")]
    NodeMissing(Name),
    /// The staging area is full (§6.4).
    #[error("the staging area is full")]
    StagingFull,
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
