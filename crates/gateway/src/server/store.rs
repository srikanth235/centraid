//! THE OBJECTS, AS FILES (#1080).
//!
//! `objects/<vault hex>/<name[0..2]>/<name hex>`: one sealed object per file,
//! fanned out by the name's first byte so no directory grows past a few
//! thousand entries. **There is no path a client chooses**: both segments are
//! hex of 32 bytes the rules already parsed, so there is nothing to escape.
//!
//! # STAGED, VERIFIED, RENAMED
//!
//! An upload streams into `incoming/<random>.part` while it is hashed, is
//! flushed and synced, and moves into place only when the rules say "store":
//! a rename, then a sync of the directory, so the name a `201` acknowledged is
//! on disk before the answer leaves. A crash before the rename leaves a staged
//! file [`ObjectStore::clear_staged`] removes when `serve` next starts; a
//! crash after it leaves a file with no row, which the next `PUT` of that name
//! replaces.
//!
//! # A FULL DISK IS A CODE
//!
//! `ENOSPC` while staging or moving is `DISK_FULL`, a refusal the phone shows
//! as "the gateway's disk is full" and retries later; any other I/O error is a
//! store fault, `INTERNAL`.

use std::io::{ErrorKind, Read as _};
use std::path::{Path, PathBuf};

use tokio::io::AsyncWriteExt as _;

use crate::rules::code::Refusal;
use crate::rules::ids::{Digest, Name, VaultId};
use crate::rules::state::{Fault, StoreFault};

/// Where uploads are staged before the rules admit them.
pub const INCOMING_DIR: &str = "incoming";
/// Where admitted objects live.
pub const OBJECTS_DIR: &str = "objects";

/// The object directory of one gateway.
#[derive(Debug, Clone)]
pub struct ObjectStore {
    objects: PathBuf,
    incoming: PathBuf,
}

/// Why staging stopped.
#[derive(Debug)]
pub enum StageError {
    /// More bytes than the limit the caller set.
    TooLarge { limit: u64 },
    /// The disk refused.
    DiskFull,
    /// Anything else the filesystem said.
    Io(std::io::Error),
}

impl From<std::io::Error> for StageError {
    fn from(error: std::io::Error) -> Self {
        if is_disk_full(&error) {
            Self::DiskFull
        } else {
            Self::Io(error)
        }
    }
}

impl From<StageError> for Fault {
    fn from(error: StageError) -> Self {
        match error {
            StageError::TooLarge { limit } => Refusal::TooLarge { limit }.into(),
            StageError::DiskFull => Refusal::DiskFull.into(),
            StageError::Io(error) => StoreFault::new(error.to_string()).into(),
        }
    }
}

/// `ENOSPC` and its quota cousin.
#[must_use]
pub fn is_disk_full(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded
    )
}

impl ObjectStore {
    /// Open or create the store under `data_dir`.
    ///
    /// # Errors
    ///
    /// If either directory cannot be created.
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        let objects = data_dir.join(OBJECTS_DIR);
        let incoming = data_dir.join(INCOMING_DIR);
        std::fs::create_dir_all(&objects)?;
        std::fs::create_dir_all(&incoming)?;
        Ok(Self { objects, incoming })
    }

    /// Remove every upload a crash left staged. **Only the process that
    /// serves calls this, before it serves**: `pair`, `scrub` and `pairings`
    /// open the same directory beside a running `serve`, and clearing the
    /// staging area under it would unlink uploads in flight.
    ///
    /// # Errors
    ///
    /// If the staging area cannot be read.
    pub fn clear_staged(&self) -> std::io::Result<usize> {
        let mut cleared = 0;
        for entry in std::fs::read_dir(&self.incoming)?.flatten() {
            if std::fs::remove_file(entry.path()).is_ok() {
                cleared += 1;
            }
        }
        Ok(cleared)
    }

    /// Where one object lives.
    #[must_use]
    pub fn path(&self, vault: &VaultId, name: &Name) -> PathBuf {
        let name = name.hex();
        self.objects.join(vault.hex()).join(&name[..2]).join(name)
    }

    /// Begin staging one upload of at most `limit` bytes.
    ///
    /// # Errors
    ///
    /// If the staging file cannot be created.
    pub async fn stage(&self, limit: u64) -> Result<Staged, StageError> {
        let path = self
            .incoming
            .join(format!("{}.part", hex::encode(rand::random::<[u8; 16]>())));
        let file = tokio::fs::File::create(&path).await?;
        Ok(Staged {
            file: tokio::io::BufWriter::with_capacity(1 << 20, file),
            path: Some(path),
            hasher: blake3::Hasher::new(),
            size: 0,
            limit,
        })
    }

    /// Move a staged upload into place as `name`, replacing whatever a
    /// tombstoned or damaged object left there, and sync the directory.
    ///
    /// # Errors
    ///
    /// `DISK_FULL`, or a store fault.
    pub fn commit(
        &self,
        mut staged: StagedFile,
        vault: &VaultId,
        name: &Name,
    ) -> Result<(), Fault> {
        let target = self.path(vault, name);
        let parent = target
            .parent()
            .ok_or_else(|| StoreFault::new("an object path has no parent"))?;
        std::fs::create_dir_all(parent).map_err(StageError::from)?;
        std::fs::rename(&staged.path, &target).map_err(StageError::from)?;
        staged.committed = true;
        sync_dir(parent).map_err(StageError::from)?;
        Ok(())
    }

    /// Unlink one object's bytes. Already gone is not an error.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn remove(&self, vault: &VaultId, name: &Name) -> Result<(), Fault> {
        match std::fs::remove_file(self.path(vault, name)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StoreFault::new(error.to_string()).into()),
        }
    }

    /// The digest and size of what is on disk at `name`, read whole: the
    /// scrub's question. `None` when there is no file. Blocking.
    ///
    /// # Errors
    ///
    /// Any read error but "not found".
    pub fn read_digest(
        &self,
        vault: &VaultId,
        name: &Name,
    ) -> std::io::Result<Option<(Digest, u64)>> {
        let mut file = match std::fs::File::open(self.path(vault, name)) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut hasher = blake3::Hasher::new();
        let mut buffer = vec![0_u8; 1 << 20];
        let mut size = 0_u64;
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            size += read as u64;
        }
        Ok(Some((Digest::from_hash(&hasher.finalize()), size)))
    }

    /// Flip the first bit of a stored object behind every rule's back: what a
    /// test does to prove the scrub finds rot.
    ///
    /// # Errors
    ///
    /// If the object cannot be read or rewritten.
    pub fn flip_bit(&self, vault: &VaultId, name: &Name) -> std::io::Result<()> {
        let path = self.path(vault, name);
        let mut bytes = std::fs::read(&path)?;
        if let Some(first) = bytes.first_mut() {
            *first ^= 1;
        }
        std::fs::write(&path, bytes)
    }
}

/// An upload being staged: written and hashed as it arrives.
#[derive(Debug)]
pub struct Staged {
    file: tokio::io::BufWriter<tokio::fs::File>,
    path: Option<PathBuf>,
    hasher: blake3::Hasher,
    size: u64,
    limit: u64,
}

impl Staged {
    /// Append some of the upload.
    ///
    /// # Errors
    ///
    /// `TooLarge` past the limit, `DiskFull`, or an I/O error.
    pub async fn write(&mut self, bytes: &[u8]) -> Result<(), StageError> {
        self.size = self.size.saturating_add(bytes.len() as u64);
        if self.size > self.limit {
            return Err(StageError::TooLarge { limit: self.limit });
        }
        self.hasher.update(bytes);
        self.file.write_all(bytes).await?;
        Ok(())
    }

    /// The upload is complete: flush, sync, and report what arrived.
    ///
    /// # Errors
    ///
    /// `DiskFull` or an I/O error.
    pub async fn finish(mut self) -> Result<StagedFile, StageError> {
        self.file.flush().await?;
        self.file.get_mut().sync_all().await?;
        let path = self.path.take().unwrap_or_default();
        Ok(StagedFile {
            path,
            digest: Digest::from_hash(&self.hasher.finalize()),
            size: self.size,
            committed: false,
        })
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A complete, synced upload, not yet admitted. Dropped uncommitted, its file
/// is removed.
#[derive(Debug)]
pub struct StagedFile {
    path: PathBuf,
    /// What the bytes hash to.
    pub digest: Digest,
    /// How many there were.
    pub size: u64,
    committed: bool,
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Make a rename in `dir` durable. A no-op where directories cannot be opened.
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> VaultId {
        VaultId::from_bytes([0x11; 32])
    }

    fn name() -> Name {
        Name::from_bytes([0xab; 32])
    }

    #[tokio::test]
    async fn a_staged_upload_lands_at_its_name_and_nothing_is_left_behind() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let store = ObjectStore::open(dir.path()).expect("opens");
        let mut staged = store.stage(100).await.expect("stages");
        staged.write(b"sealed ").await.expect("writes");
        staged.write(b"bytes").await.expect("writes");
        let file = staged.finish().await.expect("finishes");
        assert_eq!(file.digest, Digest::of(b"sealed bytes"));
        assert_eq!(file.size, 12);
        store.commit(file, &vault(), &name()).expect("commits");
        let path = store.path(&vault(), &name());
        assert!(path.ends_with(format!("{}/ab/{}", vault(), name())));
        assert_eq!(std::fs::read(&path).expect("reads"), b"sealed bytes");
        assert_eq!(
            store.read_digest(&vault(), &name()).expect("reads"),
            Some((Digest::of(b"sealed bytes"), 12))
        );
        assert_eq!(
            std::fs::read_dir(dir.path().join(INCOMING_DIR))
                .expect("reads")
                .count(),
            0,
            "the staging area is empty after a commit"
        );
    }

    /// An upload that is refused, or that runs past its limit, leaves no file.
    #[tokio::test]
    async fn an_abandoned_upload_leaves_nothing() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let store = ObjectStore::open(dir.path()).expect("opens");
        let mut staged = store.stage(4).await.expect("stages");
        assert!(matches!(
            staged.write(b"too long").await,
            Err(StageError::TooLarge { limit: 4 })
        ));
        drop(staged);
        let finished = {
            let mut staged = store.stage(100).await.expect("stages");
            staged.write(b"refused").await.expect("writes");
            staged.finish().await.expect("finishes")
        };
        drop(finished);
        assert_eq!(
            std::fs::read_dir(dir.path().join(INCOMING_DIR))
                .expect("reads")
                .count(),
            0
        );
        assert_eq!(store.read_digest(&vault(), &name()).expect("reads"), None);
    }

    /// A second process opening the directory — `pair` beside a running
    /// `serve` — leaves an upload in flight alone; only `clear_staged`, which
    /// `serve` calls before it serves, removes what a crash left.
    #[tokio::test]
    async fn opening_the_store_never_touches_an_upload_in_flight() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let serving = ObjectStore::open(dir.path()).expect("opens");
        let mut staged = serving.stage(100).await.expect("stages");
        staged.write(b"in flight").await.expect("writes");
        let second = ObjectStore::open(dir.path()).expect("a second process opens");
        let file = staged.finish().await.expect("still there to finish");
        serving
            .commit(file, &vault(), &name())
            .expect("and to commit");
        drop(second);
        let leftover = serving.stage(100).await.expect("stages");
        std::mem::forget(leftover);
        assert_eq!(serving.clear_staged().expect("clears"), 1);
    }

    #[test]
    fn a_full_disk_is_its_own_answer() {
        assert!(is_disk_full(&std::io::Error::from(ErrorKind::StorageFull)));
        assert!(!is_disk_full(&std::io::Error::from(
            ErrorKind::PermissionDenied
        )));
        assert!(matches!(
            Fault::from(StageError::from(std::io::Error::from(
                ErrorKind::StorageFull
            ))),
            Fault::Refused(Refusal::DiskFull)
        ));
    }
}
