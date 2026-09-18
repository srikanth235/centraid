//! THE ONE STORE, BEHIND THE VAULT'S BYTE DOOR (#1025 S3, D-1025-S3-1).
//!
//! `Vault::with_blobs` takes a `centraid_vault::backup::store::BlobStore`: five
//! synchronous verbs over one content-addressed store. [`ByteStore`] is the
//! byte plane's, and it is asynchronous because a transfer is. This module is
//! the one place those two shapes meet.
//!
//! ## Why there is a bridge at all, rather than two stores
//!
//! There were two stores, and that was the bug. `Vault::with_blobs` wrote a
//! flat `<vault>.blobs/` CAS; every fetch wrote iroh's `<vault>.bytes`. The
//! read path knew the first and the transfer path knew the second, so a
//! photograph a seat synced could not be displayed and a photograph a window
//! minted could not be served — on the same device, for the same vault. One
//! hash, one store, per device: the store is iroh's, and this is how the vault
//! reaches it.
//!
//! ## THE BLOCKING BRIDGE, AND WHY IT IS A THREAD
//!
//! A command handler is synchronous and holds SQLite's write lock. It cannot
//! await, and the two ways of blocking on a future from inside a runtime are
//! both wrong here: `Handle::block_on` panics when the caller happens to be on
//! a runtime worker, and `block_in_place` needs a multi-threaded runtime that a
//! Swift shell does not have. Which of those a caller is in is not something
//! this door can know — `Vault::execute` is reached from a gateway's
//! `spawn_blocking`, from a CLI with no runtime at all, and from the C ABI.
//!
//! So each call runs on a thread of its own, where there is no runtime context
//! to conflict with, and the caller joins it. The cost is a thread spawn per
//! verb; the alternative is a panic that depends on which caller you are, which
//! is the kind of defect that only appears on the platform you cannot debug.
//!
//! ## What it does NOT do
//!
//! There is no "read the original" here beyond the trait's own `get`, and
//! `get` is for the small things the trait was built for. A grid reads
//! [`crate::store::ByteStore::data_path`] through `path_of` and opens the file
//! itself; a photograph never crosses this boundary as bytes.

use std::collections::BTreeSet;
use std::path::PathBuf;

use centraid_vault::backup::store::{BlobError, BlobStore, Result};

use crate::hash::ContentHash;
use crate::store::ByteStore;

/// The byte plane's store, wearing the vault's door.
#[derive(Debug, Clone)]
pub struct ContentBytes {
    store: ByteStore,
    runtime: tokio::runtime::Handle,
}

impl ContentBytes {
    /// Wrap an open store. `runtime` is the runtime the store's actor runs on;
    /// every verb below is driven on it from a thread of this call's own.
    #[must_use]
    pub fn new(store: ByteStore, runtime: tokio::runtime::Handle) -> Self {
        Self { store, runtime }
    }

    /// The store underneath, for a caller that is already async.
    #[must_use]
    pub const fn store(&self) -> &ByteStore {
        &self.store
    }

    /// Drive one future to completion from a synchronous caller. See the
    /// module header for why this is a thread and not `block_on` in place.
    fn blocking<T: Send, F>(&self, work: F) -> T
    where
        F: FnOnce(&ByteStore) -> std::pin::Pin<Box<dyn Future<Output = T> + Send + '_>> + Send,
    {
        std::thread::scope(|scope| {
            scope
                .spawn(|| self.runtime.block_on(work(&self.store)))
                .join()
                // A PANIC IN THE STORE IS THIS CALLER'S PANIC. Swallowing it
                // would turn a corrupt index into a photograph that is quietly
                // never there.
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
        })
    }

    /// The trait speaks hex; this plane speaks [`ContentHash`]. A value that is
    /// not 64 lowercase hex is the trait's own `InvalidId` and never a lookup.
    fn parse(id: &str) -> Result<ContentHash> {
        ContentHash::parse_hex(id).map_err(|_| BlobError::InvalidId(id.to_owned()))
    }
}

impl BlobStore for ContentBytes {
    /// Take bytes the vault is spilling. `media.add_asset` and
    /// `core.add_document` reach here with an inline body already in memory,
    /// which is what the trait's shape assumes; a camera roll's originals go in
    /// through [`ByteStore::add_path`] and never through this door.
    fn put(&self, bytes: &[u8]) -> Result<String> {
        let owned = bytes::Bytes::copy_from_slice(bytes);
        self.blocking(move |store| Box::pin(async move { store.add_bytes(owned).await }))
            .map(ContentHash::to_hex)
            .map_err(|error| BlobError::Corrupt {
                id: ContentHash::of(bytes).to_hex(),
                actual: error.to_string(),
            })
    }

    fn get(&self, id: &str) -> Result<Vec<u8>> {
        let hash = Self::parse(id)?;
        self.blocking(move |store| Box::pin(async move { store.read(hash).await }))
            .map_err(|_| BlobError::NotFound { id: id.to_owned() })
    }

    /// WHOLE, and nothing less. A blob this device holds part of is a blob the
    /// vault does not have: half a photograph is not a photograph, and a mint
    /// that deduped against one would write a row over bytes still arriving.
    fn has(&self, id: &str) -> Result<bool> {
        let hash = Self::parse(id)?;
        self.blocking(move |store| Box::pin(async move { store.is_complete(hash).await }))
            .map_err(|error| BlobError::Corrupt {
                id: id.to_owned(),
                actual: error.to_string(),
            })
    }

    fn ids(&self) -> Result<BTreeSet<String>> {
        Ok(self
            .blocking(|store| Box::pin(async move { store.complete_hashes().await }))
            .map_err(|error| BlobError::Corrupt {
                id: String::new(),
                actual: error.to_string(),
            })?
            .into_iter()
            .map(ContentHash::to_hex)
            .collect())
    }

    fn size(&self, id: &str) -> Result<u64> {
        let hash = Self::parse(id)?;
        match self
            .blocking(move |store| Box::pin(async move { store.holding(hash).await }))
            .map_err(|error| BlobError::Corrupt {
                id: id.to_owned(),
                actual: error.to_string(),
            })? {
            crate::store::Holding::Complete { bytes } => Ok(bytes),
            // Missing and partial are ONE answer here. The trait's `size` is
            // "how big is the blob you hold", and a device holding part of one
            // holds no answer to that.
            _ => Err(BlobError::NotFound { id: id.to_owned() }),
        }
    }

    /// iroh's own data file, read in place.
    ///
    /// Nothing is exported to a second copy: a phone that exported every cell
    /// of a camera roll would hold the roll twice. The file exists for every
    /// complete blob because the store's inline threshold is zero
    /// (D-1025-S3-2).
    fn path_of(&self, id: &str) -> Result<Option<PathBuf>> {
        let hash = Self::parse(id)?;
        self.blocking(move |store| Box::pin(async move { store.data_path(hash).await }))
            .map_err(|error| BlobError::Corrupt {
                id: id.to_owned(),
                actual: error.to_string(),
            })
    }
}
