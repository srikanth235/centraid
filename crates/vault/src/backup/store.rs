//! The blob store: content-addressed bytes, moved by digest (#1020,
//! D-1020-R5).
//!
//! A backup artefact is named by what it *is*, not by where it came from, so
//! moving it is a copy and verifying it is a hash. The trait is the seam: lane
//! C's `net` provides an iroh-blobs implementation for moving a generation
//! between hosts, and this module carries the local filesystem one, which is
//! the only back-end v1 ships (R-1020: local filesystem only in v1; provider
//! back-ends are out).
//!
//! ## Two rules the filesystem implementation exists to keep
//!
//! **A put is atomic or it did not happen.** Bytes go to a temp file in the
//! same directory and are renamed into place. A reader therefore sees a whole
//! blob or no blob, never a prefix — and a prefix is the failure that survives
//! every structural check and shows up as a restore that produces a corrupt
//! vault.
//!
//! **A get verifies.** The digest is the name, so a blob whose bytes do not
//! hash to their own name is reported as corruption rather than handed back.
//! Silent bit-rot in a backup is the one failure mode a backup exists to
//! prevent.
//!
//! `blob-door` is deliberately not involved: nothing here opens a socket. The
//! gate's `no-listening-socket` rule holds for this crate without a feature
//! flag.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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

type Result<T> = std::result::Result<T, BlobError>;

fn io_at(path: &Path) -> impl FnOnce(io::Error) -> BlobError + '_ {
    move |source| BlobError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// Content-addressed byte storage. The id is always the sha256 hex of the
/// bytes, so an implementation can never be asked to invent a name.
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
}

/// The digest that names a blob.
#[must_use]
pub fn digest(bytes: &[u8]) -> String {
    centraid_media::format::sha256_hex(bytes)
}

fn check_id(id: &str) -> Result<()> {
    if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(BlobError::InvalidId(id.to_owned()))
    }
}

/// A blob store over one directory, one file per blob named by its digest.
#[derive(Debug, Clone)]
pub struct FsBlobStore {
    root: PathBuf,
}

impl FsBlobStore {
    /// Open (creating) a store rooted at `root`.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root).map_err(io_at(&root))?;
        Ok(Self { root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path_of(&self, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        Ok(self.root.join(id))
    }
}

impl BlobStore for FsBlobStore {
    fn put(&self, bytes: &[u8]) -> Result<String> {
        let id = digest(bytes);
        let target = self.path_of(&id)?;
        if target.exists() {
            return Ok(id);
        }
        // Same directory, so the rename is on one filesystem and therefore
        // atomic. A reader sees the whole blob or no blob.
        let temp = self.root.join(format!("{id}.{}.tmp", std::process::id()));
        fs::write(&temp, bytes).map_err(io_at(&temp))?;
        match fs::rename(&temp, &target) {
            Ok(()) => Ok(id),
            Err(error) => {
                let _ = fs::remove_file(&temp);
                Err(io_at(&target)(error))
            }
        }
    }

    fn get(&self, id: &str) -> Result<Vec<u8>> {
        let path = self.path_of(id)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(BlobError::NotFound { id: id.to_owned() });
            }
            Err(error) => return Err(io_at(&path)(error)),
        };
        // The digest is the name. Bit-rot is reported, never returned.
        let actual = digest(&bytes);
        if actual != id {
            return Err(BlobError::Corrupt {
                id: id.to_owned(),
                actual,
            });
        }
        Ok(bytes)
    }

    fn has(&self, id: &str) -> Result<bool> {
        Ok(self.path_of(id)?.exists())
    }

    fn ids(&self) -> Result<BTreeSet<String>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
            Err(error) => return Err(io_at(&self.root)(error)),
        };
        let mut ids = BTreeSet::new();
        for entry in entries {
            let entry = entry.map_err(io_at(&self.root))?;
            if let Some(name) = entry.file_name().to_str()
                && check_id(name).is_ok()
            {
                ids.insert(name.to_owned());
            }
        }
        Ok(ids)
    }

    fn size(&self, id: &str) -> Result<u64> {
        let path = self.path_of(id)?;
        match fs::metadata(&path) {
            Ok(metadata) => Ok(metadata.len()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Err(BlobError::NotFound { id: id.to_owned() })
            }
            Err(error) => Err(io_at(&path)(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blob_is_named_by_its_bytes_and_a_second_put_is_one_blob() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path()).unwrap();
        let id = store.put(b"generation manifest bytes").unwrap();
        assert_eq!(id, digest(b"generation manifest bytes"));
        assert_eq!(store.put(b"generation manifest bytes").unwrap(), id);
        assert_eq!(store.ids().unwrap().len(), 1);
        assert_eq!(store.get(&id).unwrap(), b"generation manifest bytes");
        assert!(store.has(&id).unwrap());
        assert_eq!(store.size(&id).unwrap(), 25);
    }

    #[test]
    fn a_missing_blob_and_an_invalid_id_are_different_answers() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path()).unwrap();
        let absent = digest(b"never stored");
        assert!(matches!(
            store.get(&absent),
            Err(BlobError::NotFound { .. })
        ));
        assert!(matches!(
            store.get("../../etc/passwd"),
            Err(BlobError::InvalidId(_))
        ));
        assert!(matches!(store.get("abc"), Err(BlobError::InvalidId(_))));
    }

    /// The one failure a backup exists to prevent: silent bit-rot.
    #[test]
    fn a_blob_whose_bytes_rotted_is_reported_as_corrupt_not_returned() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path()).unwrap();
        let id = store.put(b"generation manifest bytes").unwrap();
        let mut rotted = fs::read(dir.path().join(&id)).unwrap();
        rotted[0] ^= 1;
        fs::write(dir.path().join(&id), &rotted).unwrap();
        let error = store.get(&id).unwrap_err();
        assert!(
            matches!(error, BlobError::Corrupt { .. }),
            "bit-rot must be named: {error}"
        );
    }

    #[test]
    fn a_temp_file_is_never_mistaken_for_a_blob() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path()).unwrap();
        store.put(b"real").unwrap();
        fs::write(dir.path().join("deadbeef.1234.tmp"), b"half written").unwrap();
        fs::write(dir.path().join("README"), b"not a blob").unwrap();
        assert_eq!(
            store.ids().unwrap(),
            BTreeSet::from([digest(b"real")]),
            "only hex-digest names are blobs"
        );
    }

    #[test]
    fn a_store_over_a_directory_that_does_not_exist_yet_creates_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path().join("blobs").join("deep")).unwrap();
        assert!(store.root().exists());
        assert!(store.ids().unwrap().is_empty());
    }
}
