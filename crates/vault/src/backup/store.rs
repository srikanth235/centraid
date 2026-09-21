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

/// Public because the trait is implemented outside this crate — `crates/blobs`
/// puts the byte plane's store behind it (#1025 S3).
pub type Result<T> = std::result::Result<T, BlobError>;

fn io_at(path: &Path) -> impl FnOnce(io::Error) -> BlobError + '_ {
    move |source| BlobError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// Content-addressed byte storage. The id is always the 64-lowercase-hex
/// digest of the bytes, so an implementation can never be asked to invent a
/// name.
///
/// **Two implementations, and they are not interchangeable** (#1025 S3).
/// [`FsBlobStore`] keeps BACKUP ARTEFACTS, named by that digest, and is the only
/// one this crate ships. A member's OWN bytes are kept by the byte plane's
/// `centraid_blobs::ByteStore`, which is BLAKE3-named, holds partial blobs and
/// is what `Vault::with_blobs` takes — `centraid_core::bytes` is the door that
/// puts it behind this trait.
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
    /// photograph so a view could buffer it again. `None` is a real answer — a
    /// blob this device holds only part of, or not at all — and it is the
    /// normal state of a seat whose rows have arrived and whose bytes have not.
    fn path_of(&self, id: &str) -> Result<Option<PathBuf>>;
}

/// The digest that names a BACKUP artefact.
///
/// **BLAKE3, and it used to be content_hash** (#1025 S4, D-1025-S4-1). The clause
/// that stood here said an artefact's identity is sealed by
/// `contracts/golden/format-golden.json` across two languages, so changing it is
/// a re-keying event and not housekeeping (D-1020-R1). Both halves were true and
/// neither survives: there is one language now, the golden regenerates through
/// its own generator in this slice, and **v0 backup artefacts are not restorable
/// by v1 at all** — v0-no-legacy, so the re-keying event has no key to re-key.
/// What that clause protected was a released predecessor, and there is none.
///
/// It is the same function as `crate::content::content_digest`, deliberately:
/// two names for one hash is how a store ends up verifying a member's bytes
/// with the wrong one.
#[must_use]
pub fn digest(bytes: &[u8]) -> String {
    centraid_media::format::content_hash_hex(bytes)
}

fn check_id(id: &str) -> Result<()> {
    if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(BlobError::InvalidId(id.to_owned()))
    }
}

/// A store of BACKUP ARTEFACTS over one directory, one file per blob named by
/// its BLAKE3 digest.
///
/// **Backup only** (#1025 S3, D-1025-S3-1). It used to take a `Naming` and
/// serve the content plane too, under `open_content`, which is how a device
/// came to hold two content stores — this one, written by `Vault::with_blobs`,
/// and iroh's, written by every transfer. `Naming` and `open_content` are gone
/// with it; a member's bytes live in `centraid_blobs::ByteStore` and nowhere
/// else.
#[derive(Debug, Clone)]
pub struct FsBlobStore {
    root: PathBuf,
}

impl FsBlobStore {
    /// Open (creating) a store of backup artefacts, named by their digest.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root).map_err(io_at(&root))?;
        Ok(Self { root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The file this id NAMES. Says nothing about whether it is there; the
    /// trait's `path_of` is the one that does.
    fn file_of(&self, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        Ok(self.root.join(id))
    }
}

impl BlobStore for FsBlobStore {
    /// **Durable, and under a name two writers cannot both choose** (#1029 B13).
    ///
    /// Reference A: "`FsBlobStore::put` never fsyncs, and its temp name is only
    /// `{id}.{pid}.tmp`, so two threads can collide." Both halves were real and
    /// both are fixed by [`crate::backup::spool::write_durably`], which is the
    /// one place this crate writes a file it intends to survive a crash:
    ///
    /// - the bytes are fsynced, **and so is the directory** — a rename is not
    ///   durable until its directory is synced, and without that there is a
    ///   window in which the bytes exist and the name does not, which for a
    ///   backup object is the same as the object never having been written;
    /// - the temp name carries 16 random bytes as well as the process id, so
    ///   two threads of one process cannot meet on it. Without that, one writer
    ///   renames a file the other is still filling, and the store ends up
    ///   holding a half-written object under the digest of a whole one — which
    ///   `get` would then report as corruption in the *store* rather than as
    ///   the race it was.
    fn put(&self, bytes: &[u8]) -> Result<String> {
        let id = digest(bytes);
        let target = self.file_of(&id)?;
        if target.exists() {
            return Ok(id);
        }
        crate::backup::spool::write_durably(&target, bytes).map_err(|error| BlobError::Io {
            path: target.clone(),
            source: io::Error::other(error.to_string()),
        })?;
        Ok(id)
    }

    fn get(&self, id: &str) -> Result<Vec<u8>> {
        let path = self.file_of(id)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(BlobError::NotFound { id: id.to_owned() });
            }
            Err(error) => return Err(io_at(&path)(error)),
        };
        // The digest is the name. Bit-rot is reported, never returned — and it
        // is THIS store's digest: a content blob verified with the backup
        // plane's hash would be reported corrupt on every read.
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
        Ok(self.file_of(id)?.exists())
    }

    /// One file per blob, named by its digest, so the path is the name.
    fn path_of(&self, id: &str) -> Result<Option<PathBuf>> {
        let path = self.file_of(id)?;
        Ok(path.exists().then_some(path))
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
        let path = self.file_of(id)?;
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

    /// **B13.** Two writers cannot meet on a temp name, and a put leaves
    /// nothing behind.
    #[test]
    fn a_put_is_durable_and_its_temp_name_cannot_collide() {
        use std::collections::BTreeSet;

        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path()).unwrap();
        let id = store.put(b"a sealed object").unwrap();
        assert_eq!(store.get(&id).unwrap(), b"a sealed object");

        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp file survives a put");

        // The name the defect named — `{id}.{pid}.tmp` — is one string for
        // every writer in a process. This one is not.
        let path = dir.path().join(&id);
        let names: BTreeSet<String> = (0..128)
            .map(|_| crate::backup::spool::unique_temp_name(&path).expect("entropy"))
            .collect();
        assert_eq!(names.len(), 128, "128 draws, 128 names");
    }

    #[test]
    fn a_store_over_a_directory_that_does_not_exist_yet_creates_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path().join("blobs").join("deep")).unwrap();
        assert!(store.root().exists());
        assert!(store.ids().unwrap().is_empty());
    }
}
