//! Backup: one snapshot, three uses, plus the WAL stream (#1020, D-1020-R5).
//!
//! ## What a generation is
//!
//! ```text
//! generation = a COMPLETE base copy of the vault  (content-addressed, by digest)
//!            + the WAL segments after it          (sealed, deterministic nonces)
//!            + one manifest                       (centraid-snapshot/2)
//! ```
//!
//! The base copy is **not** the seat snapshot, and [`base`] is where that is
//! argued: D-1020-D1-7's "one snapshot, three uses" holds for the seat's
//! bootstrap and for pre-migration safety, and is wrong for a backup, because a
//! seat snapshot deliberately drops every private table — `locker_key`
//! included, which is the row a vault names its own live key with. The restore
//! drill's `restored-census` check is what found it (D-1020-R8).
//!
//! The WAL is what makes the RPO a number rather than a hope: the snapshot is
//! taken every `snapshot_interval_hours`, and the segments between snapshots
//! are sealed and shipped every `rpo_seconds`. A restore replays the snapshot
//! and then the segments, and `--at` simply stops the replay early.
//!
//! ## Modules
//!
//! | Module | What it owns |
//! |---|---|
//! | [`base`] | the COMPLETE base copy a generation is built from (D-1020-R8) |
//! | [`keyring`] | the master epochs, the HKDF derivations, the chunk address |
//! | [`wal`] | the segment address, its seal, and replay order |
//! | [`manifest`] | the `centraid-snapshot/2` envelope and the generation chain |
//! | [`policy`] | [`BackupPolicy`], one set of clocks and budgets |
//! | [`store`] | the content-addressed blob store (local filesystem in v1) |
//! | [`kit`] | the recovery kit — the one artefact that carries keys |
//! | [`restore`] | `restore_check`, `restore_drill`, fencing and the recover phases |
//! | [`drill`] | the CI drill: back up, lose everything, recover, re-pair a seat |
//!
//! ## The command is the gateway's, not the CLI's
//!
//! `centraid backup now` is a **command through the core**. The CLI is a
//! client: it asks the gateway to take a snapshot and seal the WAL tail, and
//! prints the head and the digest. That is not ceremony — the gateway holds the
//! one writable connection and the keys, so a CLI that built a generation
//! itself would be a second gateway with its own idea of what is committed.

pub mod base;
pub mod drill;
pub mod keyring;
pub mod kit;
pub mod manifest;
pub mod policy;
pub mod restore;
pub mod store;
pub mod wal;

use std::path::Path;

pub use base::{BaseHead, build_backup_base};
pub use keyring::{
    Keyring, KeyringEpoch, KeyringError, chunk_id, derive_data_key, derive_dedup_key,
};
pub use kit::{
    KitError, LockerKeyEntry, RecoveryKitDocument, RecoveryKitTarget, parse_recovery_kit,
    recovery_kit_fingerprint, wrap_recovery_kit,
};
pub use manifest::{
    ChunkRef, Generation, ManifestError, PublicEnvelope, SNAPSHOT_FORMAT, manifest_hash,
    open_manifest, read_public_envelope, seal_manifest,
};
pub use policy::{BackupPolicy, BackupPolicyError, CasAck, MIN_RPO_SECONDS};
pub use restore::{
    RecoverPhase, RestoreDrillReport, RestoredPairReport, SealKeyVerdict, restore_check,
    restore_drill,
};
pub use store::{BlobError, BlobStore, FsBlobStore, digest};
pub use wal::{WalAddress, WalError, WalSegment};

use crate::file::Vault;

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error(transparent)]
    Vault(#[from] crate::error::VaultError),
    #[error(transparent)]
    Keyring(#[from] KeyringError),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error(transparent)]
    Wal(#[from] WalError),
    #[error(transparent)]
    Blob(#[from] BlobError),
    #[error("backup: {0}")]
    Other(String),
}

/// What `backup now` did, and what the CLI prints.
#[derive(Debug, Clone)]
pub struct BackupOutcome {
    /// The complete base copy this generation is built from.
    pub head: BaseHead,
    pub generation: u64,
    /// The generation's own address: the sha256 of its stored manifest.
    pub manifest_hash: String,
    /// The blob the stored manifest lives at.
    pub manifest_blob: String,
    /// Sealed WAL segments in this generation.
    pub wal_segments: usize,
    pub bytes: u64,
}

/// Take a generation: snapshot, seal the WAL tail, write the manifest.
///
/// The `previous` hash chains this generation to the last one, so a restore can
/// walk backwards and a **gap is visible** rather than silently skipped.
pub fn take_generation(
    vault: &Vault,
    blobs: &dyn BlobStore,
    keyring: &Keyring,
    generation: u64,
    previous: Option<&str>,
    wal_tail: &[(WalSegment, Vec<u8>)],
    scratch: &Path,
) -> Result<BackupOutcome, BackupError> {
    let (key_epoch, master) = keyring.active_master()?;
    let head = base::build_backup_base(vault, scratch)?;
    let artefact = std::fs::read(scratch.join(&head.name))
        .map_err(|error| BackupError::Other(format!("reading the base copy: {error}")))?;
    let mut bytes = artefact.len() as u64;
    let snapshot_blob = blobs.put(&artefact)?;

    // Seal each segment under its own address. Deterministic nonces mean a
    // re-run of the same tail is byte-identical and therefore one blob.
    let mut sealed_segments = Vec::with_capacity(wal_tail.len());
    for (segment, plain) in wal_tail {
        let sealed = wal::seal_segment(&master, &head.vault_id, &segment.address(), plain)?;
        bytes += sealed.len() as u64;
        let blob_id = blobs.put(&sealed)?;
        let mut stored = segment.clone();
        stored.blob_id = blob_id;
        sealed_segments.push(stored);
    }

    let envelope = PublicEnvelope {
        key_epoch,
        created_at: vault.clock().now_text(),
        generation,
        prev_manifest_hash: previous.map(str::to_owned),
        chunk_index: vec![ChunkRef {
            id: snapshot_blob.clone(),
            size: artefact.len() as u64,
        }],
        app_meta: serde_json::json!({
            "source": "centraid-gateway",
            "base": {
                "digest": head.digest,
                "name": head.name,
                "plainSize": head.plain_size,
            },
        }),
    };
    let payload = serde_json::json!({
        "entries": [{
            "path": head.name,
            "kind": "base",
            "size": artefact.len(),
            "chunks": [snapshot_blob],
            "sha256": store::digest(&artefact),
        }],
        "wal": sealed_segments.iter().map(|segment| serde_json::json!({
            "db": segment.db,
            "generation": segment.generation,
            "group": segment.group,
            "startOffset": segment.start_offset,
            "endOffset": segment.end_offset,
            "tickMs": segment.tick_ms,
            "blob": segment.blob_id,
        })).collect::<Vec<_>>(),
    });
    let (stored, hash) = manifest::seal_manifest(&master, &head.vault_id, &envelope, &payload)?;
    bytes += stored.len() as u64;
    let manifest_blob = blobs.put(&stored)?;
    Ok(BackupOutcome {
        head,
        generation,
        manifest_hash: hash,
        manifest_blob,
        wal_segments: sealed_segments.len(),
        bytes,
    })
}
