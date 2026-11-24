//! THE OBJECTS, AS APPEND-ONLY PACKFILES (`CGW4`, #1212, spec §4).
//!
//! `packs/<vault hex>/<pack hex>.pack`: sealed objects appended sequentially
//! into per-vault packfiles, addressed by `(pack_id, pack_offset, size)` in
//! `state.db`. **There is no path a client chooses**: `vault` is 32 verified
//! bytes and `pack_id` is 16 random bytes drawn by the gateway.
//!
//! # STAGED, HASHED, SYNCED ONCE, RENAMED, COMMITTED IN ONE TRANSACTION
//!
//! A `POST bundle` streams frames sequentially into `staging/<pack hex>.pack`,
//! hashing each frame incrementally as its bytes arrive. A frame over
//! `MAX_OBJECT_BYTES` is read past without touching the packfile; a frame whose
//! bytes fail `DIGEST_MISMATCH` truncates the staged packfile back to
//! `frame_start_offset` and continues with the rest of the bundle. When the
//! stream ends — whether on clean EOF or mid-frame disconnect — any trailing
//! partial bytes are truncated back to the end of the last complete valid
//! frame, the packfile is `fsync`ed once, atomically renamed into
//! `packs/<vault hex>/<pack hex>.pack`, and all completed frames commit in one
//! `BEGIN IMMEDIATE … COMMIT` SQLite transaction.
//!
//! # A FULL DISK IS A CODE
//!
//! `ENOSPC` while staging or moving is `DISK_FULL`, a refusal the phone shows
//! as "the gateway's disk is full" and retries later; any other I/O error is a
//! store fault, `INTERNAL`.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
#[cfg(feature = "test-harness")]
use std::sync::Arc;

use tokio::io::{AsyncSeekExt as _, AsyncWriteExt as _};

use crate::rules::code::Refusal;
use crate::rules::ids::{Digest, VaultId};
use crate::rules::state::{Fault, StoreFault};

/// Where bundle packfiles and compacted packfiles are staged before promotion.
pub const STAGING_DIR: &str = "staging";
/// Where promoted per-vault packfiles live: `packs/<vault hex>/<pack hex>.pack`.
pub const PACKS_DIR: &str = "packs";
/// Extension of every packfile on disk.
const PACK_EXT: &str = ".pack";
/// Buffer size for sequential packfile I/O (256 KiB).
const IO_BUF_BYTES: usize = 256 * 1024;

/// A 16-byte random packfile identifier, rendered as 32 lowercase hex chars.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PackId([u8; 16]);

impl PackId {
    /// Wrap 16 raw bytes.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Read a 16-byte slice.
    #[must_use]
    pub fn from_slice(slice: &[u8]) -> Option<Self> {
        <[u8; 16]>::try_from(slice).ok().map(Self)
    }

    /// Draw a fresh random 16-byte pack identifier.
    #[must_use]
    pub fn random() -> Self {
        Self(rand::random::<[u8; 16]>())
    }

    /// Raw 16 bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    /// 32 lowercase hex characters.
    #[must_use]
    pub fn hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Parse strictly 32 lowercase hex characters.
    #[must_use]
    pub fn parse_hex(text: &str) -> Option<Self> {
        if text.len() != 32
            || !text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return None;
        }
        let mut bytes = [0_u8; 16];
        hex::decode_to_slice(text, &mut bytes).ok()?;
        Some(Self(bytes))
    }
}

impl core::fmt::Debug for PackId {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.hex())
    }
}

impl core::fmt::Display for PackId {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.hex())
    }
}

impl core::str::FromStr for PackId {
    type Err = &'static str;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::parse_hex(text).ok_or("a pack id is 32 lowercase hex characters")
    }
}

/// Physical location of an object's bytes inside a vault's packfile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackLocation {
    pub pack_id: PackId,
    pub pack_offset: u64,
}

/// One `.pack` file under `packs/<vault>/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoredPack {
    pub vault: VaultId,
    pub pack_id: PackId,
    pub len: u64,
    /// When it was last modified, in milliseconds since the Unix epoch.
    pub modified_ms: i64,
}

/// One file currently in `staging/`, for the orphan sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedEntry {
    pub path: PathBuf,
    pub modified_ms: i64,
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

/// The packfile object store of one gateway.
#[derive(Debug, Clone)]
pub struct ObjectStore {
    packs: PathBuf,
    staging: PathBuf,
    /// What only a test may do to this store.
    #[cfg(feature = "test-harness")]
    knobs: Arc<crate::server::knobs::Knobs>,
}

impl ObjectStore {
    /// Open or create the packfile store under `data_dir`.
    ///
    /// # Errors
    ///
    /// If either directory cannot be created.
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        let packs = data_dir.join(PACKS_DIR);
        let staging = data_dir.join(STAGING_DIR);
        std::fs::create_dir_all(&packs)?;
        std::fs::create_dir_all(&staging)?;
        Ok(Self {
            packs,
            staging,
            #[cfg(feature = "test-harness")]
            knobs: Arc::default(),
        })
    }

    /// The test knobs of this store.
    #[cfg(feature = "test-harness")]
    #[must_use]
    pub fn knobs(&self) -> &crate::server::knobs::Knobs {
        &self.knobs
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
        for entry in std::fs::read_dir(&self.staging)?.flatten() {
            if std::fs::remove_file(entry.path()).is_ok() {
                cleared += 1;
            }
        }
        Ok(cleared)
    }

    /// Every file currently inside `staging/`, with its modification timestamp.
    ///
    /// # Errors
    ///
    /// If `staging/` cannot be read.
    pub fn staged_entries(&self) -> std::io::Result<Vec<StagedEntry>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.staging)?.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            out.push(StagedEntry {
                path: entry.path(),
                modified_ms: modified_ms(&meta),
            });
        }
        Ok(out)
    }

    /// Every `.pack` file under `packs/`, across all vaults.
    ///
    /// # Errors
    ///
    /// If `packs/` cannot be read.
    pub fn pack_files(&self) -> std::io::Result<Vec<StoredPack>> {
        let mut found = Vec::new();
        for vault_dir in std::fs::read_dir(&self.packs)?.flatten() {
            let Some(vault) = vault_dir
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<VaultId>().ok())
            else {
                continue;
            };
            if !vault_dir.path().is_dir() {
                continue;
            }
            found.extend(read_vault_packs(&vault_dir.path(), vault)?);
        }
        Ok(found)
    }

    /// Every `.pack` file under `packs/<vault hex>/`.
    ///
    /// # Errors
    ///
    /// If the directory exists and cannot be read.
    pub fn vault_pack_files(&self, vault: &VaultId) -> std::io::Result<Vec<StoredPack>> {
        let dir = self.vault_packs_dir(vault);
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        read_vault_packs(&dir, *vault)
    }

    /// Directory holding `vault`'s packfiles: `packs/<vault hex>`.
    #[must_use]
    pub fn vault_packs_dir(&self, vault: &VaultId) -> PathBuf {
        self.packs.join(vault.hex())
    }

    /// Path to one packfile: `packs/<vault hex>/<pack hex>.pack`.
    #[must_use]
    pub fn pack_path(&self, vault: &VaultId, pack_id: &PackId) -> PathBuf {
        self.vault_packs_dir(vault)
            .join(format!("{}{PACK_EXT}", pack_id.hex()))
    }

    /// Path to a staged packfile: `staging/<pack hex>.pack`.
    #[must_use]
    pub fn staging_pack_path(&self, pack_id: &PackId) -> PathBuf {
        self.staging.join(format!("{}{PACK_EXT}", pack_id.hex()))
    }

    /// Byte length of `packs/<vault>/<pack_id>.pack`, or `None` if missing.
    #[must_use]
    pub fn pack_len(&self, vault: &VaultId, pack_id: &PackId) -> Option<u64> {
        std::fs::metadata(self.pack_path(vault, pack_id))
            .ok()
            .filter(std::fs::Metadata::is_file)
            .map(|meta| meta.len())
    }

    /// Whether `packs/<vault>/<loc.pack_id>.pack` exists and covers
    /// `[loc.pack_offset .. loc.pack_offset + size]`.
    #[must_use]
    pub fn has_slice(&self, vault: &VaultId, loc: PackLocation, size: u64) -> bool {
        loc.pack_offset.checked_add(size).is_some_and(|end| {
            self.pack_len(vault, &loc.pack_id)
                .is_some_and(|len| len >= end)
        })
    }

    /// Begin a new bundle's packfile staging session. The file on disk is
    /// created lazily on the first non-refused frame.
    #[must_use]
    pub fn stage_pack(&self) -> PackStaging {
        PackStaging {
            staging_dir: self.staging.clone(),
            pack: None,
            committed_len: 0,
            active: None,
            #[cfg(feature = "test-harness")]
            knobs: Arc::clone(&self.knobs),
        }
    }

    /// Atomically move a synced staged packfile into `packs/<vault>/<pack>.pack`
    /// and sync the parent directory.
    ///
    /// # Errors
    ///
    /// `DISK_FULL`, or a store fault.
    pub fn promote_pack(&self, mut staged: StagedPack, vault: &VaultId) -> Result<PackId, Fault> {
        let vault_dir = self.vault_packs_dir(vault);
        std::fs::create_dir_all(&vault_dir).map_err(StageError::from)?;
        let target = self.pack_path(vault, &staged.pack_id);
        std::fs::rename(&staged.staged_path, &target).map_err(StageError::from)?;
        staged.promoted = true;
        sync_dir(&vault_dir).map_err(StageError::from)?;
        #[cfg(feature = "test-harness")]
        self.knobs.renamed();
        Ok(staged.pack_id)
    }

    /// Atomically promote a staged compaction packfile without triggering
    /// bundle-upload test hooks.
    ///
    /// # Errors
    ///
    /// `DISK_FULL`, or a store fault.
    pub fn promote_compacted_pack(
        &self,
        mut staged: StagedPack,
        vault: &VaultId,
    ) -> Result<PackId, Fault> {
        let vault_dir = self.vault_packs_dir(vault);
        std::fs::create_dir_all(&vault_dir).map_err(StageError::from)?;
        let target = self.pack_path(vault, &staged.pack_id);
        std::fs::rename(&staged.staged_path, &target).map_err(StageError::from)?;
        staged.promoted = true;
        sync_dir(&vault_dir).map_err(StageError::from)?;
        Ok(staged.pack_id)
    }

    /// Unlink one `.pack` file. Already gone is not an error.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn remove_pack(&self, vault: &VaultId, pack_id: &PackId) -> Result<(), Fault> {
        match std::fs::remove_file(self.pack_path(vault, pack_id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StoreFault::new(error.to_string()).into()),
        }
    }

    /// Unlink an arbitrary staged file (for `orphans_once`). Already gone is not an error.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn remove_staged_file(&self, path: &Path) -> Result<(), Fault> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StoreFault::new(error.to_string()).into()),
        }
    }

    /// Remove `packs/<vault hex>/` completely (`delete-vault`).
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn remove_vault_packs(&self, vault: &VaultId) -> Result<(), Fault> {
        let dir = self.vault_packs_dir(vault);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {
                sync_dir(&self.packs).map_err(|error| StoreFault::new(error.to_string()))?;
                Ok(())
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StoreFault::new(error.to_string()).into()),
        }
    }

    /// Positioned exact read from `file` at `offset` without loading the rest
    /// of the packfile into memory.
    ///
    /// # Errors
    ///
    /// `UnexpectedEof` if the file ends before `offset + buf.len()`, or any I/O error.
    pub fn read_at(file: &std::fs::File, offset: u64, buf: &mut [u8]) -> std::io::Result<()> {
        if buf.is_empty() {
            return Ok(());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileExt as _;
            file.read_exact_at(buf, offset)
        }
        #[cfg(not(unix))]
        {
            use std::io::{Read as _, Seek as _, SeekFrom};
            let mut reader = file.try_clone()?;
            reader.seek(SeekFrom::Start(offset))?;
            reader.read_exact(buf)
        }
    }

    /// Read an entire object slice `[loc.pack_offset .. loc.pack_offset + size]`.
    ///
    /// # Errors
    ///
    /// If the packfile is missing, truncated, or unreadable.
    pub fn read_slice(
        &self,
        vault: &VaultId,
        loc: PackLocation,
        size: u64,
    ) -> std::io::Result<Vec<u8>> {
        let len = usize::try_from(size)
            .map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "slice exceeds usize"))?;
        let file = std::fs::File::open(self.pack_path(vault, &loc.pack_id))?;
        let mut buf = vec![0_u8; len];
        Self::read_at(&file, loc.pack_offset, &mut buf)?;
        Ok(buf)
    }

    /// Hash `[offset .. offset + size]` of an already-open packfile using a
    /// caller-supplied scratch buffer (`scrub_once` opens each packfile once).
    ///
    /// # Errors
    ///
    /// `UnexpectedEof` if the packfile is shorter than `offset + size`, or I/O error.
    pub fn hash_slice_in_file(
        file: &std::fs::File,
        offset: u64,
        size: u64,
        scratch: &mut [u8],
    ) -> std::io::Result<Digest> {
        let mut hasher = blake3::Hasher::new();
        let mut pos = offset;
        let mut remaining = size;
        while remaining > 0 {
            let chunk =
                usize::try_from(remaining.min(scratch.len() as u64)).unwrap_or(scratch.len());
            Self::read_at(file, pos, &mut scratch[..chunk])?;
            hasher.update(&scratch[..chunk]);
            pos = pos.saturating_add(chunk as u64);
            remaining -= chunk as u64;
        }
        Ok(Digest::from_hash(&hasher.finalize()))
    }

    /// Compute BLAKE3 of one object's slice on disk (`POST /check`).
    /// Returns `Ok(None)` when the packfile is missing or truncated before the slice;
    /// returns `Ok(Some(wrong_digest))` if truncated mid-slice so `examine`
    /// classifies it as `Corrupt`.
    ///
    /// # Errors
    ///
    /// Any read error other than `NotFound` or `UnexpectedEof`.
    pub fn read_slice_digest(
        &self,
        vault: &VaultId,
        loc: PackLocation,
        size: u64,
    ) -> std::io::Result<Option<Digest>> {
        let file = match std::fs::File::open(self.pack_path(vault, &loc.pack_id)) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let file_len = file.metadata()?.len();
        if loc.pack_offset > file_len || (size > 0 && loc.pack_offset == file_len) {
            return Ok(None);
        }
        let available = file_len.saturating_sub(loc.pack_offset).min(size);
        let mut scratch = vec![0_u8; IO_BUF_BYTES];
        let digest = Self::hash_slice_in_file(&file, loc.pack_offset, available, &mut scratch)?;
        if available < size {
            // Short slice: guaranteed not to match a full slice's digest; if by
            // astronomical coincidence it did, perturb so it marks damaged.
            let mut bytes = *digest.as_bytes();
            bytes[0] ^= 0xff;
            return Ok(Some(Digest::from_bytes(bytes)));
        }
        Ok(Some(digest))
    }

    /// Flip the first bit of a stored object's slice inside its `.pack` file
    /// behind every rule's back: what a test does to prove `scrub` and `check`
    /// detect bit rot without disturbing neighbouring objects in the packfile.
    ///
    /// # Errors
    ///
    /// If the packfile cannot be opened or the slice is empty/out-of-bounds.
    pub fn flip_bit(&self, vault: &VaultId, loc: PackLocation, size: u64) -> std::io::Result<()> {
        if size == 0 {
            return Err(std::io::Error::new(
                ErrorKind::InvalidInput,
                "cannot flip a bit in a zero-length object",
            ));
        }
        let path = self.pack_path(vault, &loc.pack_id);
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)?;
        let mut byte = [0_u8; 1];
        Self::read_at(&file, loc.pack_offset, &mut byte)?;
        byte[0] ^= 1;
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileExt as _;
            file.write_all_at(&byte, loc.pack_offset)
        }
        #[cfg(not(unix))]
        {
            use std::io::{Seek as _, SeekFrom, Write as _};
            let mut writer = file;
            writer.seek(SeekFrom::Start(loc.pack_offset))?;
            writer.write_all(&byte)
        }
    }
}

/// Active frame inside a [`PackStaging`] stream.
#[derive(Debug)]
struct ActiveFrame {
    hasher: blake3::Hasher,
    written: u64,
    limit: u64,
}

/// Incremental async packfile writer for one `POST /bundle` stream.
#[derive(Debug)]
pub struct PackStaging {
    staging_dir: PathBuf,
    pack: Option<(PackId, PathBuf, tokio::io::BufWriter<tokio::fs::File>)>,
    committed_len: u64,
    active: Option<ActiveFrame>,
    #[cfg(feature = "test-harness")]
    knobs: Arc<crate::server::knobs::Knobs>,
}

impl PackStaging {
    /// Start appending a new frame of at most `limit` bytes.
    ///
    /// # Errors
    ///
    /// `DiskFull`, `TooLarge`, or an I/O error creating the staged packfile.
    pub async fn begin_frame(&mut self, limit: u64) -> Result<u64, StageError> {
        #[cfg(feature = "test-harness")]
        if let Some(refusal) = self.knobs.refusing(limit) {
            return Err(refusal);
        }
        if self.active.is_some() {
            self.abort_frame().await?;
        }
        if self.pack.is_none() {
            let pack_id = PackId::random();
            let path = self
                .staging_dir
                .join(format!("{}{PACK_EXT}", pack_id.hex()));
            let file = tokio::fs::File::create(&path).await?;
            self.pack = Some((
                pack_id,
                path,
                tokio::io::BufWriter::with_capacity(IO_BUF_BYTES, file),
            ));
        }
        self.active = Some(ActiveFrame {
            hasher: blake3::Hasher::new(),
            written: 0,
            limit,
        });
        Ok(self.committed_len)
    }

    /// Append bytes of the current frame to the staged packfile.
    ///
    /// # Errors
    ///
    /// `TooLarge` past the frame's cap, `DiskFull`, or an I/O error. Any failure
    /// truncates the staged packfile back to `committed_len`.
    pub async fn write_frame(&mut self, bytes: &[u8]) -> Result<(), StageError> {
        let Some(active) = self.active.as_mut() else {
            return Ok(());
        };
        let next = active.written.saturating_add(bytes.len() as u64);
        if next > active.limit {
            let limit = active.limit;
            let _ = self.abort_frame().await;
            return Err(StageError::TooLarge { limit });
        }
        active.written = next;
        active.hasher.update(bytes);
        if let Some((_, _, writer)) = self.pack.as_mut()
            && let Err(error) = writer.write_all(bytes).await
        {
            let _ = self.abort_frame().await;
            return Err(StageError::from(error));
        }
        Ok(())
    }

    /// Complete the current frame and verify its BLAKE3 against `declared`.
    /// On `DIGEST_MISMATCH` (`Ok(None)`), the staged packfile is truncated back
    /// to `frame_start_offset` so subsequent frames continue cleanly.
    ///
    /// # Errors
    ///
    /// `DiskFull` or an I/O error flushing/truncating the staged packfile.
    pub async fn finish_frame(
        &mut self,
        declared: &Digest,
    ) -> Result<Option<(Digest, u64, u64)>, StageError> {
        let Some(active) = self.active.take() else {
            return Ok(None);
        };
        let computed = Digest::from_hash(&active.hasher.finalize());
        if computed != *declared {
            self.truncate_to_committed().await?;
            return Ok(None);
        }
        if let Some((_, _, writer)) = self.pack.as_mut()
            && let Err(error) = writer.flush().await
        {
            let _ = self.truncate_to_committed().await;
            return Err(StageError::from(error));
        }
        let offset = self.committed_len;
        self.committed_len = self.committed_len.saturating_add(active.written);
        #[cfg(feature = "test-harness")]
        self.knobs.staged(active.written);
        Ok(Some((computed, active.written, offset)))
    }

    /// Discard any partial bytes of an aborted, failed or truncated frame back
    /// to `committed_len`.
    ///
    /// # Errors
    ///
    /// An I/O error truncating or seeking the staged packfile.
    pub async fn abort_frame(&mut self) -> Result<(), StageError> {
        self.active = None;
        self.truncate_to_committed().await
    }

    async fn truncate_to_committed(&mut self) -> Result<(), StageError> {
        let Some((pack_id, path, writer)) = self.pack.take() else {
            return Ok(());
        };
        // `into_inner` drops any unflushed bytes in memory without writing them.
        let mut file = writer.into_inner();
        file.set_len(self.committed_len).await?;
        file.seek(std::io::SeekFrom::Start(self.committed_len))
            .await?;
        self.pack = Some((
            pack_id,
            path,
            tokio::io::BufWriter::with_capacity(IO_BUF_BYTES, file),
        ));
        Ok(())
    }

    /// Finalize the staged packfile when the bundle stream ends (both on clean
    /// EOF and on mid-frame disconnect): truncate any trailing partial frame
    /// bytes back to `committed_len` and `sync_all()` once.
    ///
    /// # Errors
    ///
    /// `DiskFull` or an I/O error syncing the packfile.
    pub async fn finish_pack(mut self) -> Result<Option<StagedPack>, StageError> {
        if self.active.is_some() {
            self.abort_frame().await?;
        }
        let Some((pack_id, path, writer)) = self.pack.take() else {
            return Ok(None);
        };
        let file = writer.into_inner();
        file.set_len(self.committed_len).await?;
        file.sync_all().await?;
        Ok(Some(StagedPack {
            pack_id,
            staged_path: path,
            len: self.committed_len,
            promoted: false,
        }))
    }
}

impl Drop for PackStaging {
    fn drop(&mut self) {
        if let Some((_, path, _)) = self.pack.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A complete, `fsync`ed packfile in `staging/`, ready to be renamed into
/// `packs/<vault>/`. Dropped unpromoted, its staged file is removed.
#[derive(Debug)]
pub struct StagedPack {
    pub pack_id: PackId,
    pub(crate) staged_path: PathBuf,
    pub len: u64,
    pub(crate) promoted: bool,
}

impl StagedPack {
    /// Stage a synchronous packfile written on the blocking pool (used by
    /// `compact_packs_once`), already synced to disk.
    pub(crate) const fn from_synced(pack_id: PackId, staged_path: PathBuf, len: u64) -> Self {
        Self {
            pack_id,
            staged_path,
            len,
            promoted: false,
        }
    }
}

impl Drop for StagedPack {
    fn drop(&mut self) {
        if !self.promoted {
            let _ = std::fs::remove_file(&self.staged_path);
        }
    }
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

fn read_vault_packs(dir: &Path, vault: VaultId) -> std::io::Result<Vec<StoredPack>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)?.flatten() {
        let Some(file_name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(stem) = file_name.strip_suffix(PACK_EXT) else {
            continue;
        };
        let Some(pack_id) = PackId::parse_hex(stem) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        out.push(StoredPack {
            vault,
            pack_id,
            len: meta.len(),
            modified_ms: modified_ms(&meta),
        });
    }
    Ok(out)
}

/// Make a rename or directory removal in `dir` durable.
pub(crate) fn sync_dir(dir: &Path) -> std::io::Result<()> {
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

    #[tokio::test]
    async fn a_staged_pack_appends_frames_truncates_mismatches_and_promotes() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let store = ObjectStore::open(dir.path()).expect("opens");
        let mut staging = store.stage_pack();

        let off0 = staging.begin_frame(100).await.expect("frame 0");
        assert_eq!(off0, 0);
        staging.write_frame(b"first ").await.expect("writes");
        staging.write_frame(b"object").await.expect("writes");
        let (_, len0, pos0) = staging
            .finish_frame(&Digest::of(b"first object"))
            .await
            .expect("finishes")
            .expect("digest matches");
        assert_eq!((pos0, len0), (0, 12));

        // A frame with a bad digest truncates back to offset 12.
        let off_bad = staging.begin_frame(100).await.expect("bad frame");
        assert_eq!(off_bad, 12);
        staging
            .write_frame(b"corrupted frame")
            .await
            .expect("writes");
        assert!(
            staging
                .finish_frame(&Digest::of(b"expected something else"))
                .await
                .expect("finishes")
                .is_none(),
            "mismatch rolls back"
        );

        // Next valid frame still starts at offset 12, followed by partial cut bytes.
        let off1 = staging.begin_frame(100).await.expect("frame 1");
        assert_eq!(off1, 12);
        staging.write_frame(b"second").await.expect("writes");
        let (_, len1, pos1) = staging
            .finish_frame(&Digest::of(b"second"))
            .await
            .expect("finishes")
            .expect("digest matches");
        assert_eq!((pos1, len1), (12, 6));

        // Start a 3rd frame and cut mid-way before finish_pack.
        staging.begin_frame(100).await.expect("cut frame");
        staging.write_frame(b"half").await.expect("partial");

        let pack = staging
            .finish_pack()
            .await
            .expect("syncs")
            .expect("has valid bytes");
        assert_eq!(pack.len, 18);
        let pack_id = store.promote_pack(pack, &vault()).expect("promotes");

        assert_eq!(
            store
                .read_slice(
                    &vault(),
                    PackLocation {
                        pack_id,
                        pack_offset: 0
                    },
                    12
                )
                .expect("slice 0"),
            b"first object"
        );
        assert_eq!(
            store
                .read_slice(
                    &vault(),
                    PackLocation {
                        pack_id,
                        pack_offset: 12
                    },
                    6
                )
                .expect("slice 1"),
            b"second"
        );
        assert_eq!(store.pack_len(&vault(), &pack_id), Some(18));
        assert!(store.staged_entries().expect("staging").is_empty());
    }

    #[tokio::test]
    async fn an_abandoned_pack_leaves_nothing_in_staging() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let store = ObjectStore::open(dir.path()).expect("opens");
        let mut staging = store.stage_pack();
        staging.begin_frame(4).await.expect("begins");
        assert!(matches!(
            staging.write_frame(b"too long").await,
            Err(StageError::TooLarge { limit: 4 })
        ));
        drop(staging);
        assert!(store.staged_entries().expect("reads").is_empty());
    }

    #[tokio::test]
    async fn opening_the_store_never_touches_a_pack_in_flight() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let serving = ObjectStore::open(dir.path()).expect("opens");
        let mut staging = serving.stage_pack();
        staging.begin_frame(100).await.expect("begins");
        staging.write_frame(b"in flight").await.expect("writes");
        let _second = ObjectStore::open(dir.path()).expect("second process opens");
        staging
            .finish_frame(&Digest::of(b"in flight"))
            .await
            .expect("finishes")
            .expect("valid");
        let pack = staging.finish_pack().await.expect("syncs").expect("pack");
        serving.promote_pack(pack, &vault()).expect("promotes");

        let mut leftover = serving.stage_pack();
        leftover.begin_frame(100).await.expect("begins");
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
