//! THE BYTE DOOR: where a member's bytes are on this device (#1025 S3,
//! [#1080](https://github.com/srikanth235/centraid/issues/1080) ruling 6).
//!
//! A vault keeps rows. A device keeps the bytes those rows name, in one of two
//! homes: the app's own content store — a directory of files named by their
//! BLAKE3, `crates/blobs` — or, for an original the operating system's photo
//! library already holds, that library, which the phone never copies into its
//! sandbox. [`BlobStore`] is the door a host puts in front of both with
//! [`crate::file::Vault::with_blobs`]: a command spills bytes through it, and a
//! read asks it where bytes are.
//!
//! ## ONE QUESTION, THREE ANSWERS
//!
//! [`BlobStore::locate`] answers [`Located`]: a file in the store, an item in
//! the operating system's library under an identifier only the shell can
//! resolve, or nowhere on this device. The store's own file is asked first,
//! because a platform opens a path in place and a library lookup costs the
//! shell a round trip; the library answers only for bytes the store does not
//! hold. A store with no library beside it answers from its files alone,
//! which is the trait's default.
//!
//! `crate::backup::store` re-exports these names for the plane #1080's
//! cut-over deletes.

use std::collections::BTreeSet;
use std::io;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("blob {id} is not in the store")]
    NotFound { id: String },
    #[error("blob {id} hashes to {actual} — the store is corrupt")]
    Corrupt { id: String, actual: String },
    #[error("blob id {0:?} is not a hex digest")]
    InvalidId(String),
    #[error("blob store io at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// Public because the trait is implemented outside this crate — `crates/blobs`
/// puts the content store behind it (#1025 S3).
pub type Result<T> = std::result::Result<T, BlobError>;

/// Where one hash's bytes are on this device (#1080 ruling 6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Located {
    /// A file in the app's own content store, which a platform opens in place.
    Store(PathBuf),
    /// The operating system's library holds them under this identifier — a
    /// PhotoKit local identifier, a MediaStore id — and only the shell can open
    /// them.
    OsLibrary(String),
    /// Not on this device.
    Nowhere,
}

/// Content-addressed byte storage. The id is always the 64-lowercase-hex
/// BLAKE3 of the bytes, so an implementation can never be asked to invent a
/// name.
pub trait BlobStore {
    /// Store bytes, returning their digest. Idempotent: the same bytes twice
    /// are one blob.
    fn put(&self, bytes: &[u8]) -> Result<String>;
    /// Fetch bytes by digest, verifying them.
    fn get(&self, id: &str) -> Result<Vec<u8>>;
    /// Whether the store holds a blob, without reading it.
    fn has(&self, id: &str) -> Result<bool>;
    /// Every digest the store holds, sorted.
    fn ids(&self) -> Result<BTreeSet<String>>;
    /// The stored size, for sizing a restore before fetching it.
    fn size(&self, id: &str) -> Result<u64>;
    /// The FILE these bytes are in, when this store holds them whole.
    ///
    /// THE ANSWER `Vault::content_location` GIVES A GRID (#1025 S3). Every cell
    /// of a photo grid is a path the platform opens directly, and a store that
    /// could only answer `get(&str) -> Vec<u8>` would mean the core buffering a
    /// photograph so a view could buffer it again. `None` is a real answer: the
    /// bytes are not in this store.
    fn path_of(&self, id: &str) -> Result<Option<PathBuf>>;
    /// WHERE THESE BYTES ARE ON THIS DEVICE. See the module header.
    ///
    /// The default knows only this store's own files, which is all a store with
    /// no library beside it can know.
    fn locate(&self, id: &str) -> Result<Located> {
        Ok(self.path_of(id)?.map_or(Located::Nowhere, Located::Store))
    }
}
