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
//! [`FsBlobStore`] is the door over one plain directory, for a host with no
//! content store and no library — the tests, and any tool that holds bytes in
//! a folder. A phone's door is `crates/blobs`' `ContentBytes`.

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

/// The byte door over one directory, one file per blob named by its BLAKE3
/// ([`crate::content::content_digest`]).
///
/// **A put is atomic or it did not happen**: the bytes go to a temp file in the
/// same directory, are fsynced, renamed into place, and the directory is
/// fsynced, so a reader sees a whole blob or none and a crash leaves no name
/// without its bytes. The temp name carries the process id and 16 random bytes,
/// so two writers of one process cannot meet on it (#1029 B13).
///
/// **A get verifies**: the digest is the name, so a blob whose bytes do not
/// hash to it is reported as [`BlobError::Corrupt`] rather than handed back.
#[derive(Debug, Clone)]
pub struct FsBlobStore {
    root: PathBuf,
}

fn io_at(path: &Path) -> impl FnOnce(io::Error) -> BlobError + '_ {
    move |source| BlobError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn check_id(id: &str) -> Result<()> {
    if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(BlobError::InvalidId(id.to_owned()))
    }
}

/// A temp name two writers cannot both choose. A name that cannot be made
/// unique is a refusal, never a fixed fallback (#1029 W13, finding 24).
fn unique_temp_name(path: &Path) -> Result<String> {
    use rand::TryRngCore as _;

    let stem = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("blob");
    let mut suffix = [0_u8; 16];
    rand::rngs::OsRng
        .try_fill_bytes(&mut suffix)
        .map_err(|error| BlobError::Io {
            path: path.to_path_buf(),
            source: io::Error::other(format!(
                "the operating system would not give entropy for a temp name: {error}"
            )),
        })?;
    Ok(format!(
        "{stem}.{}.{}.tmp",
        std::process::id(),
        hex::encode(suffix)
    ))
}

fn write_durably(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;

    let dir = path.parent().unwrap_or(Path::new("."));
    let temp = dir.join(unique_temp_name(path)?);
    {
        let mut handle = fs::File::create(&temp).map_err(io_at(&temp))?;
        handle.write_all(bytes).map_err(io_at(&temp))?;
        handle.sync_all().map_err(io_at(&temp))?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(io_at(path)(error));
    }
    sync_dir(dir).map_err(io_at(dir))
}

/// A rename is durable once its directory is.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

/// Windows has no directory fsync; NTFS journals the rename itself.
#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

impl FsBlobStore {
    /// Open (creating) a store over this directory.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root).map_err(io_at(&root))?;
        Ok(Self { root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The file this id NAMES. Says nothing about whether it is there.
    fn file_of(&self, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        Ok(self.root.join(id))
    }
}

impl BlobStore for FsBlobStore {
    fn put(&self, bytes: &[u8]) -> Result<String> {
        let id = crate::content::content_digest(bytes);
        let target = self.file_of(&id)?;
        if target.exists() {
            return Ok(id);
        }
        write_durably(&target, bytes)?;
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
        let actual = crate::content::content_digest(&bytes);
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
    use crate::content::content_digest;

    #[test]
    fn a_blob_is_named_by_its_bytes_and_a_second_put_is_one_blob() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path()).unwrap();
        let id = store.put(b"some bytes").unwrap();
        assert_eq!(id, content_digest(b"some bytes"));
        assert_eq!(store.put(b"some bytes").unwrap(), id);
        assert_eq!(store.ids().unwrap().len(), 1);
        assert_eq!(store.get(&id).unwrap(), b"some bytes");
        assert!(store.has(&id).unwrap());
        assert_eq!(store.size(&id).unwrap(), 10);
    }

    #[test]
    fn a_missing_blob_and_an_invalid_id_are_different_answers() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path()).unwrap();
        let absent = content_digest(b"never stored");
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

    #[test]
    fn a_blob_whose_bytes_rotted_is_reported_as_corrupt_not_returned() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path()).unwrap();
        let id = store.put(b"some bytes").unwrap();
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
    fn a_temp_file_is_never_mistaken_for_a_blob_and_a_put_leaves_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsBlobStore::open(dir.path().join("deep").join("er")).unwrap();
        assert!(store.ids().unwrap().is_empty());
        store.put(b"real").unwrap();
        fs::write(store.root().join("deadbeef.1234.tmp"), b"half written").unwrap();
        fs::write(store.root().join("README"), b"not a blob").unwrap();
        assert_eq!(
            store.ids().unwrap(),
            BTreeSet::from([content_digest(b"real")]),
            "only hex-digest names are blobs"
        );
        let path = store.root().join(content_digest(b"real"));
        let names: BTreeSet<String> = (0..128)
            .map(|_| unique_temp_name(&path).expect("entropy"))
            .collect();
        assert_eq!(names.len(), 128, "128 draws, 128 names");
    }
}
