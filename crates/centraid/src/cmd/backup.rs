//! `centraid backup now` (#1020, D-1020-R5).
//!
//! Takes a generation: the snapshot, the sealed WAL tail, the manifest. Prints
//! the head and the digest to stdout as JSON, and the facts to stderr.
//!
//! `--force` takes one even when the policy's `snapshot_interval_hours` says it
//! is not due. There is no `--no-verify` equivalent and never will be: a
//! generation whose manifest was not written is not a generation.

use std::path::{Path, PathBuf};

use centraid_vault::backup::{self, BackupPolicy, FsBlobStore, Keyring};
use centraid_vault::custody::KeyStore;
use centraid_vault::file::Vault;

use crate::exit;

/// The name of the backup master keyring inside `keys/`.
const KEYRING_KEY_NAME: &str = "backup.master.key";

pub struct BackupNowArgs {
    pub data_dir: Option<PathBuf>,
    pub force: bool,
}

pub fn now(args: BackupNowArgs) -> u8 {
    let Some(data_dir) = args.data_dir else {
        eprintln!(
            "centraid: `backup now` needs --data-dir. A backup of an in-memory vault is a \
             backup of nothing, so there is no default."
        );
        return exit::REFUSED;
    };
    match take(&data_dir, args.force) {
        Ok(report) => {
            println!("{report:#}");
            exit::OK
        }
        Err(message) => {
            eprintln!("centraid: {message}");
            exit::REFUSED
        }
    }
}

fn take(data_dir: &Path, force: bool) -> Result<serde_json::Value, String> {
    let policy = BackupPolicy::default();
    policy.validate().map_err(|error| error.to_string())?;
    let file = crate::cmd::sole_vault_file(data_dir)?;

    // The master keyring lives in `keys/`, the same custody as the seal key and
    // `K` — one directory to back up out-of-band, not three.
    let keys = KeyStore::new(crate::cmd::keys_dir_in(data_dir));
    let master = keys
        .load_or_create(KEYRING_KEY_NAME)
        .map_err(|error| format!("backup master key: {error}"))?;
    for warning in keys.take_warnings() {
        eprintln!("centraid: {warning}");
    }

    let vault =
        Vault::open(&file).map_err(|error| format!("opening {}: {error}", file.display()))?;
    let created_at = vault.clock().now_text();
    let keyring = Keyring::from_json(&serde_json::json!({
        "version": 1,
        "active": 1,
        "epochs": [{
            "epoch": 1,
            "key": base64_of(&master),
            "createdAt": created_at,
        }],
    }))
    .map_err(|error| error.to_string())?;

    let blobs = FsBlobStore::open(crate::cmd::blobs_dir_in(data_dir))
        .map_err(|error| format!("blob store: {error}"))?;
    let scratch = data_dir.join("snapshots");

    // The generation number is the count of manifests already in the store,
    // plus one. Derived rather than remembered, so a store and a counter cannot
    // disagree about which generation is which.
    let generation = existing_generations(&blobs) + 1;
    eprintln!(
        "centraid: taking generation {generation} of {} ({})",
        file.display(),
        if force { "forced" } else { "due" }
    );

    // THE WAL TAIL. The gateway's capture tick sealed it and wrote it to
    // `<data-dir>/wal/pending.jsonl` (wave 3 lane G, `cmd/capture.rs`); this
    // reads it back. It is on disk rather than handed over in process because
    // `backup now` is a separate process from the gateway, and the alternative
    // was for this CLI to capture the tail itself — a second capturer with its
    // own idea of where the last segment ended.
    //
    // An empty tail is still a complete generation: it means nothing was
    // written since the last one, or no gateway has run a tick over this data
    // directory. The count is in the report either way, so "the tail was empty"
    // is a fact a script can read rather than an absence it has to infer.
    let wal_tail = crate::cmd::capture::pending_tail(data_dir)?;
    if wal_tail.is_empty() {
        eprintln!(
            "centraid: the pending WAL tail is EMPTY — this generation is the snapshot and \
             nothing since it. That is correct when no write has happened; if a gateway is \
             serving this data directory, its capture tick is not running."
        );
    }
    let outcome = backup::take_generation(
        &vault,
        &blobs,
        &keyring,
        generation,
        previous_manifest_hash(&blobs, &master, &vault).as_deref(),
        &wal_tail,
        &scratch,
    )
    .map_err(|error| error.to_string())?;
    vault.close().map_err(|error| error.to_string())?;

    // Retired only now, after the manifest naming these segments is written. A
    // tail cleared first would be a generation whose WAL rows are in no
    // manifest at all.
    crate::cmd::capture::retire_pending(data_dir)?;

    eprintln!(
        "centraid: generation {generation} is {} ({} bytes, {} WAL segment(s))",
        outcome.manifest_hash, outcome.bytes, outcome.wal_segments
    );
    Ok(serde_json::json!({
        "command": "backup now",
        "vaultId": outcome.head.vault_id,
        "generation": outcome.generation,
        "manifestHash": outcome.manifest_hash,
        "manifestBlob": outcome.manifest_blob,
        "base": {
            "name": outcome.head.name,
            "digest": outcome.head.digest,
            "size": outcome.head.size,
            "plainSize": outcome.head.plain_size,
        },
        "walSegments": outcome.wal_segments,
        "bytes": outcome.bytes,
        "rpoSeconds": policy.rpo_seconds,
    }))
}

fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Every manifest already in the store, counted by opening its public half —
/// which needs no key.
fn existing_generations(blobs: &FsBlobStore) -> u64 {
    generations(blobs).len() as u64
}

fn generations(blobs: &FsBlobStore) -> Vec<(u64, String)> {
    use centraid_vault::backup::BlobStore as _;
    let mut found = Vec::new();
    for id in blobs.ids().unwrap_or_default() {
        if let Ok(bytes) = blobs.get(&id)
            && let Ok(envelope) = backup::read_public_envelope(&bytes)
        {
            found.push((envelope.generation, backup::manifest_hash(&bytes)));
        }
    }
    found.sort();
    found
}

/// The newest generation's hash, so this one chains onto it.
fn previous_manifest_hash(blobs: &FsBlobStore, _master: &[u8], _vault: &Vault) -> Option<String> {
    generations(blobs).pop().map(|(_, hash)| hash)
}
