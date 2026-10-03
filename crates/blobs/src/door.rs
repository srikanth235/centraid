//! THE ONE STORE, BEHIND THE VAULT'S BYTE DOOR (#1025 S3, D-1025-S3-1).
//!
//! `Vault::with_blobs` takes a [`centraid_vault::bytes::BlobStore`]: six
//! synchronous verbs over one content-addressed store, and the question every
//! read asks — where are these bytes on this device. [`ContentBytes`] is this
//! crate's store wearing that door, so a device holds ONE content store per
//! vault and the vault's commands and reads reach it the same way.
//!
//! ## WHERE A HASH'S BYTES ARE, ASKED IN ORDER
//!
//! [`BlobStore::locate`] asks the store's own file first, because a platform
//! opens a path in place; then, when the ledger is attached, its `local_bytes`
//! row, which names an original the operating system's library holds and the
//! phone never copied (#1080 ruling 6) — an identifier only the shell can
//! resolve. With no file and no row the bytes are nowhere on this device. The
//! ledger is the backup plane's, `<stem>.backup.db`, shared with the core that
//! writes it; this door only reads it.
//!
//! ## What it does NOT do
//!
//! There is no "read the original" here beyond the trait's own `get`, and `get`
//! is for the small things the trait was built for. A grid reads a path through
//! `locate` and opens the file itself; a photograph never crosses this boundary
//! as bytes.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use centraid_vault::backup2::ledger::{Ledger, LocalSource};
use centraid_vault::backup2::naming::PlaintextHash;
use centraid_vault::bytes::{BlobError, BlobStore, Located, Result};

use crate::hash::ContentHash;
use crate::store::{ByteStore, StoreError};

/// The content store, wearing the vault's door.
#[derive(Clone)]
pub struct ContentBytes {
    store: ByteStore,
    ledger: Option<Arc<Mutex<Ledger>>>,
}

impl std::fmt::Debug for ContentBytes {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ContentBytes")
            .field("root", &self.store.root())
            .field("ledger", &self.ledger.is_some())
            .finish()
    }
}

impl ContentBytes {
    /// Wrap an open store. With no ledger the door knows only the store's own
    /// files.
    #[must_use]
    pub const fn new(store: ByteStore) -> Self {
        Self {
            store,
            ledger: None,
        }
    }

    /// The same door, answering for the operating system's library through
    /// the ledger's `local_bytes`. See the module header.
    #[must_use]
    pub fn with_ledger(self, ledger: Arc<Mutex<Ledger>>) -> Self {
        Self {
            ledger: Some(ledger),
            ..self
        }
    }

    /// The store underneath.
    #[must_use]
    pub const fn store(&self) -> &ByteStore {
        &self.store
    }

    /// The ledger this door reads, when one is attached.
    #[must_use]
    pub const fn ledger(&self) -> Option<&Arc<Mutex<Ledger>>> {
        self.ledger.as_ref()
    }

    /// The trait speaks hex; this crate speaks [`ContentHash`]. A value that is
    /// not 64 lowercase hex is the trait's own `InvalidId` and never a lookup.
    fn parse(id: &str) -> Result<ContentHash> {
        ContentHash::parse_hex(id).map_err(|_| BlobError::InvalidId(id.to_owned()))
    }
}

/// A store refusal in the door's own words.
fn door_error(id: &str, error: StoreError) -> BlobError {
    match error {
        StoreError::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound => {
            BlobError::NotFound { id: id.to_owned() }
        }
        StoreError::Io { path, source } => BlobError::Io { path, source },
        StoreError::Corrupt { hash, actual } => BlobError::Corrupt {
            id: hash.to_hex(),
            actual: actual.to_hex(),
        },
    }
}

impl BlobStore for ContentBytes {
    /// Take bytes the vault is spilling. `media.add_asset` and
    /// `core.add_document` reach here with an inline body already in memory,
    /// which is what the trait's shape assumes; a stream goes in through
    /// [`ByteStore::writer`] and never through this door.
    fn put(&self, bytes: &[u8]) -> Result<String> {
        self.store
            .put_bytes(bytes)
            .map(|stored| stored.hash.to_hex())
            .map_err(|error| door_error(&ContentHash::of(bytes).to_hex(), error))
    }

    fn get(&self, id: &str) -> Result<Vec<u8>> {
        let hash = Self::parse(id)?;
        self.store.read(hash).map_err(|error| door_error(id, error))
    }

    fn has(&self, id: &str) -> Result<bool> {
        let hash = Self::parse(id)?;
        self.store
            .is_complete(hash)
            .map_err(|error| door_error(id, error))
    }

    fn ids(&self) -> Result<BTreeSet<String>> {
        Ok(self
            .store
            .hashes()
            .map_err(|error| door_error("", error))?
            .into_iter()
            .map(ContentHash::to_hex)
            .collect())
    }

    fn size(&self, id: &str) -> Result<u64> {
        let hash = Self::parse(id)?;
        self.store
            .size(hash)
            .map_err(|error| door_error(id, error))?
            .ok_or_else(|| BlobError::NotFound { id: id.to_owned() })
    }

    /// The store's own file, read in place. Nothing is exported to a second
    /// copy: a phone that exported every cell of a camera roll would hold the
    /// roll twice.
    fn path_of(&self, id: &str) -> Result<Option<PathBuf>> {
        let hash = Self::parse(id)?;
        self.store
            .path_of(hash)
            .map_err(|error| door_error(id, error))
    }

    fn locate(&self, id: &str) -> Result<Located> {
        if let Some(path) = self.path_of(id)? {
            return Ok(Located::Store(path));
        }
        let Some(ledger) = &self.ledger else {
            return Ok(Located::Nowhere);
        };
        let hash = PlaintextHash::from_bytes(*Self::parse(id)?.as_bytes());
        let ledger = ledger.lock().unwrap_or_else(PoisonError::into_inner);
        let local = ledger.local(&hash).map_err(|error| BlobError::Io {
            path: ledger.path().to_path_buf(),
            source: std::io::Error::other(error.to_string()),
        })?;
        Ok(match local {
            Some(row) if row.source == LocalSource::Os => {
                row.os_ref.map_or(Located::Nowhere, Located::OsLibrary)
            }
            // A STORE ROW WITH NO FILE is bytes that left the store — evicted,
            // or never written — and the file is the truth, not the row.
            Some(_) | None => Located::Nowhere,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_vault::backup2::ledger::LocalBytes;

    fn door(dir: &tempfile::TempDir) -> (ContentBytes, Arc<Mutex<Ledger>>) {
        let store = ByteStore::open(dir.path().join("vault.bytes")).expect("the store opens");
        let ledger = Arc::new(Mutex::new(
            Ledger::open(Ledger::path_for(&dir.path().join("vault.db"))).expect("the ledger opens"),
        ));
        (
            ContentBytes::new(store).with_ledger(Arc::clone(&ledger)),
            ledger,
        )
    }

    /// THE DOOR'S SIX VERBS over the directory: a put answers the hash the
    /// vault files the row under, and every read names the same bytes.
    #[test]
    fn the_door_puts_and_reads_the_one_store() {
        let dir = tempfile::tempdir().expect("a directory");
        let (door, _) = door(&dir);
        let id = door.put(b"a thumbnail").expect("it lands");
        assert_eq!(id, ContentHash::of(b"a thumbnail").to_hex());
        assert!(door.has(&id).expect("asks"));
        assert_eq!(door.get(&id).expect("reads"), b"a thumbnail");
        assert_eq!(door.size(&id).expect("sizes"), 11);
        assert_eq!(door.ids().expect("lists"), BTreeSet::from([id.clone()]));
        let path = door.path_of(&id).expect("asks").expect("a file");
        assert_eq!(door.locate(&id).expect("locates"), Located::Store(path));

        let absent = ContentHash::of(b"never stored").to_hex();
        assert!(!door.has(&absent).expect("asks"));
        assert!(matches!(door.get(&absent), Err(BlobError::NotFound { .. })));
        assert!(matches!(
            door.size(&absent),
            Err(BlobError::NotFound { .. })
        ));
        assert!(matches!(door.has("NOT-HEX"), Err(BlobError::InvalidId(_))));
    }

    /// WHERE THE BYTES ARE (#1080 ruling 6): the store's file first, then the
    /// library the ledger names, else nowhere — and a store row whose file is
    /// gone is nowhere, because the file is the truth.
    #[test]
    fn locate_answers_the_store_then_the_library_then_nowhere() {
        let dir = tempfile::tempdir().expect("a directory");
        let (door, ledger) = door(&dir);
        let original = ContentHash::of(b"a camera original the library holds");
        let row = LocalBytes {
            hash: PlaintextHash::from_bytes(*original.as_bytes()),
            source: LocalSource::Os,
            os_ref: Some("library-item-1".to_owned()),
            verified_ms: Some(1),
            edited: false,
        };
        ledger
            .lock()
            .expect("the ledger")
            .put_local(&row)
            .expect("records");
        assert_eq!(
            door.locate(&original.to_hex()).expect("locates"),
            Located::OsLibrary("library-item-1".to_owned())
        );
        assert_eq!(
            door.path_of(&original.to_hex()).expect("asks"),
            None,
            "a library item has no path in the store"
        );

        // AN EDIT KEPT IN THE STORE is the store's file, even with a library
        // row beside it: a path opens without the shell.
        let stored = door
            .put(b"a camera original the library holds")
            .expect("lands");
        assert_eq!(stored, original.to_hex());
        assert!(matches!(
            door.locate(&original.to_hex()).expect("locates"),
            Located::Store(_)
        ));

        let evicted = ContentHash::of(b"a document since evicted");
        ledger
            .lock()
            .expect("the ledger")
            .put_local(&LocalBytes {
                hash: PlaintextHash::from_bytes(*evicted.as_bytes()),
                source: LocalSource::Store,
                os_ref: None,
                verified_ms: None,
                edited: false,
            })
            .expect("records");
        assert_eq!(
            door.locate(&evicted.to_hex()).expect("locates"),
            Located::Nowhere
        );

        let bare = ContentBytes::new(door.store().clone());
        assert_eq!(
            bare.locate(&ContentHash::of(b"anything").to_hex())
                .expect("locates"),
            Located::Nowhere,
            "with no ledger the door knows only its files"
        );
    }
}
