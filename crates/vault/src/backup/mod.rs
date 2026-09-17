//! Backup: the base, the spool, and the generation that names them (#1029 §2).
//!
//! ## What a generation is
//!
//! ```text
//! generation = a page-identical base, split into sealed 4 MiB ranges
//!            + the sealed page segments after it, in txid order
//!            + one sealed manifest, chained to the previous one by its name
//! ```
//!
//! It is **an append stream, not a point in time** (F10). "Keep one per day" was
//! undefined over an open-ended stream and repacking could purge segments inside
//! a retained generation; the **base is the retention unit**, and a daily base
//! is cheap because unchanged ranges reuse existing objects. "Restore as of"
//! therefore means "pick a base and a txid", which is the only granularity a
//! member can reason about.
//!
//! A generation id is **128 random bits and orders nothing** (F3). Epochs belong
//! to the lease and they are W5's.
//!
//! ## Modules
//!
//! | Module | What it owns |
//! |---|---|
//! | [`wal`] | reading SQLite's log: header, salts, checksum chain, commit boundaries |
//! | [`segment`] | the page segment — the format W4 and W5 both read — and its replay |
//! | [`capture`] | the debounced, commit-bounded tick, and the checkpoint it owns |
//! | [`spool`] | sealed segments that outlive a checkpoint, and the durable cursor |
//! | [`base`] | the page-identical base, its ranges, and the in-vault dedup index |
//! | [`objects`] | sealing, and §4's verify-before-upload |
//! | [`manifest`] | the generation manifest and its hash chain |
//! | [`store`] | the content-addressed object store (local filesystem in v0) |
//! | [`policy`] | [`BackupPolicy`], one set of clocks and budgets |
//! | [`restore`] | restore, replay, fencing and the recover phases |
//! | [`drill`] | the CI drill: back up, lose everything, recover |
//!
//! ## What was here and is gone
//!
//! `kit` — the scrypt-wrapped recovery kit file — is deleted (§5, Reference A's
//! "the v0-kit compatibility clause: nothing v0 was ever released"). **The
//! written 24 words replace it.** A file that carries keys is a file that can be
//! copied, and the whole of §0 is that every key derives from a phrase the
//! member holds.
//!
//! `keyring`'s two masters are gone with it (B11): there is one root key, §0
//! derives it, and [`objects::ObjectKeys`] is the only thing that holds it.

pub mod base;
pub mod capture;
pub mod drill;
pub mod manifest;
pub mod objects;
pub mod policy;
pub mod restore;
pub mod segment;
pub mod spool;
pub mod store;
pub mod wal;

use std::path::{Path, PathBuf};

pub use base::{BaseHead, BaseRange, build_base, restore_base};
pub use capture::{
    CaptureError, CaptureOutcome, CapturePolicy, CaptureReason, CheckpointOutcome, Debounce,
    capture, checkpoint,
};
pub use manifest::{
    GenerationManifest, MANIFEST_FORMAT, ManifestError, ManifestHead, SegmentRef, chain_from,
};
pub use objects::{ObjectKeys, ObjectsError};
pub use policy::{BackupPolicy, BackupPolicyError, CasAck, MIN_RPO_SECONDS};
pub use restore::{
    DataDirLock, RecoverPhase, RestoreDrillReport, RestoredPairReport, SealKeyVerdict,
    restore_check, restore_drill,
};
pub use segment::{GenerationId, PageSegment, SegmentError};
pub use spool::{Spool, SpoolCursor, SpoolEntry, SpoolError};
pub use store::{BlobError, BlobStore, FsBlobStore, digest};
pub use wal::{WalCursor, WalError};

use crate::file::Vault;

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error(transparent)]
    Vault(#[from] crate::error::VaultError),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error(transparent)]
    Capture(#[from] CaptureError),
    #[error(transparent)]
    Base(#[from] base::BaseError),
    #[error(transparent)]
    Objects(#[from] ObjectsError),
    #[error(transparent)]
    Segment(#[from] SegmentError),
    #[error(transparent)]
    Spool(#[from] SpoolError),
    #[error(transparent)]
    Blob(#[from] BlobError),
    #[error("backup: {0}")]
    Other(String),
}

/// The layout a vault's backup state lives in, under its data directory.
///
/// Everything here is **derived**: it can be rebuilt from the vault and the
/// store, so it is excluded from OS backup like every other vault-derived path
/// (§1, F5). The exclusion itself is the mobile shell's, in W1.
#[derive(Debug, Clone)]
pub struct BackupHome {
    root: PathBuf,
}

impl BackupHome {
    /// Open (creating) the backup home under a data directory.
    ///
    /// # Errors
    /// [`BackupError`] when the directories cannot be made.
    pub fn open(root: impl AsRef<Path>) -> Result<Self, BackupError> {
        let root = root.as_ref().to_path_buf();
        for child in ["objects", "spool", "scratch"] {
            std::fs::create_dir_all(root.join(child))
                .map_err(|error| BackupError::Other(format!("making the backup home: {error}")))?;
        }
        Ok(Self { root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where sealed objects live. In v0 this is the local filesystem; W4 puts a
    /// gateway behind the same trait.
    ///
    /// # Errors
    /// [`BlobError`] when the directory cannot be opened.
    pub fn objects(&self) -> Result<FsBlobStore, BlobError> {
        FsBlobStore::open(self.root.join("objects"))
    }

    /// The spool.
    ///
    /// # Errors
    /// [`SpoolError`] when the directory cannot be opened.
    pub fn spool(&self) -> Result<Spool, SpoolError> {
        Spool::open(self.root.join("spool"))
    }

    /// The spool's directory, for a caller that has to remove it.
    #[must_use]
    pub fn spool_dir(&self) -> PathBuf {
        self.root.join("spool")
    }

    /// Scratch for a base copy, which is deleted as soon as it is sealed.
    #[must_use]
    pub fn scratch(&self) -> PathBuf {
        self.root.join("scratch")
    }

    /// Where the head of the manifest chain is written down (B12).
    #[must_use]
    pub fn head_path(&self) -> PathBuf {
        self.root.join("head.json")
    }
}

/// What taking a generation did.
#[derive(Debug, Clone)]
pub struct BackupOutcome {
    pub generation: GenerationId,
    /// The manifest's object name, which is the generation's address and the
    /// next generation's `prevManifest`.
    pub manifest: String,
    pub base: BaseHead,
    /// Segments this generation shipped, in txid order.
    pub segments: Vec<SegmentRef>,
    pub last_txid: u64,
    /// Bytes this generation newly cost the store: reused ranges are not
    /// counted, because nothing was uploaded for them (F10).
    pub new_bytes: u64,
}

/// **Take a generation: checkpoint, base, then the tail — in that order** (B5).
///
/// B5 is an ordering bug and the fix is the order:
///
/// 1. **Capture and checkpoint first.** Everything committed so far is in the
///    spool, and the log is empty, so the copy in step 2 is the whole state.
/// 2. **Take the base**, page-identical, from that quiet file. It covers the
///    txid the cursor stood at.
/// 3. **Collect the pending tail after the base** — which now includes the
///    commit step 2 itself made, writing the range index into the vault. The old
///    code collected the tail *first*, so the manifest paired a newer base with
///    older frames and `--at` meant nothing.
/// 4. Seal the manifest, chained to `previous` by its object name.
/// 5. **Only then release the spool**, and only through the txid the store
///    acked (§2).
///
/// # Errors
/// [`BackupError`] for anything a step refused. A refusal leaves the spool
/// intact: nothing is released until the whole generation is stored.
pub fn take_generation(
    vault: &Vault,
    keys: &ObjectKeys,
    home: &BackupHome,
    previous: Option<&str>,
) -> Result<BackupOutcome, BackupError> {
    let blobs = home.objects()?;
    let spool = home.spool()?;

    // 1. Everything committed is in the spool, and the log is quiet.
    capture::capture(vault, &spool, keys)?;
    capture::checkpoint(vault, &spool)?;
    let cursor = spool.cursor()?.ok_or_else(|| {
        BackupError::Other("capture left no cursor, which cannot happen".to_owned())
    })?;

    // 2. The base, page-identical, from the quiet file.
    let base_census = vault.census()?;
    let base = base::build_base(
        vault,
        keys,
        &blobs,
        cursor.generation,
        cursor.last_txid,
        &home.scratch(),
    )?;

    // 3. THE TAIL, AFTER THE BASE (B5). Writing the range index was a commit,
    // so there is a tail to collect and it belongs to this generation.
    capture::capture(vault, &spool, keys)?;

    // 4. Every spooled segment above the base goes into the store, and the
    // store's ack is what a release will later be measured against.
    let mut segments = Vec::new();
    let mut new_bytes = base.new_bytes();
    for entry in spool.entries()? {
        if entry.last_txid <= base.txid {
            continue;
        }
        // THE SAME CIPHERTEXT IS RE-SENT, NEVER RESEALED (B9, §4). The spool
        // holds the bytes that were sealed once; a retry reads them back and
        // puts them again.
        let sealed = spool.read(&entry)?;
        let object = blobs.put(&sealed)?;
        let plain = keys.open(centraid_media::object::Kind::Segment, &sealed)?;
        let segment = PageSegment::decode(&plain)?;
        new_bytes += sealed.len() as u64;
        segments.push(SegmentRef {
            object,
            first_txid: segment.first_txid,
            last_txid: segment.last_txid,
            bytes: sealed.len() as u64,
            census: segment.census,
        });
    }
    segments.sort_by_key(|segment| segment.first_txid);

    let manifest = GenerationManifest::of(
        &base,
        vault.clock().now_text(),
        previous.map(str::to_owned),
        base_census,
        segments.clone(),
    );
    let (sealed, name) = manifest.seal(keys)?;
    let stored = blobs.put(&sealed)?;
    debug_assert_eq!(stored, name, "the store names by BLAKE3");
    new_bytes += sealed.len() as u64;

    let last_txid = manifest.last_txid();
    ManifestHead {
        vault_id: keys.vault_id_hex(),
        manifest: name.clone(),
        generation: base.generation,
        last_txid,
    }
    .write(&home.head_path())?;

    // 5. THE ACK IS THE ONLY REMOVER (§2). Everything above is stored, so the
    // spool may let go of it — and the cursor records the ack, which is what a
    // later checkpoint measures its coverage from.
    spool.release_through(last_txid)?;
    if let Some(cursor) = spool.cursor()? {
        spool.record_cursor(&SpoolCursor {
            acked_txid: last_txid.max(cursor.acked_txid),
            ..cursor
        })?;
    }

    Ok(BackupOutcome {
        generation: base.generation,
        manifest: name,
        base,
        segments,
        last_txid,
        new_bytes,
    })
}
