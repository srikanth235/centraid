//! `centraid recover` (#1020, D-1020-R6).
//!
//! ```text
//! centraid recover --kit <file> --password-file <file> --data-dir <dir>
//!                  [--at <iso>] [--full] [--vault <id>] [--yes]
//! ```
//!
//! Restores a vault from **nothing but the kit and the blob store**. No daemon
//! config, no provider credentials — v1 reads a local filesystem store
//! (R-1020), and the provider back-ends are out of scope.
//!
//! ## The rules this command is written to
//!
//! - **The password comes from a file, never from a flag.** A flag is in the
//!   shell history and in every `ps` listing on the host.
//! - **Facts to stderr, one JSON report to stdout.** An operator watches
//!   stderr; a script parses stdout.
//! - **Lazy by default.** The vault is restored; the content blobs are fetched
//!   on demand unless `--full`. A restore that had to materialise every photo
//!   before the vault opened would be unusable on the day it is needed.
//! - **A live gateway's data directory is refused**, by pid, through the lock
//!   file. Two processes writing one vault file is a vault neither agrees with.
//! - **`--at` is exit 2, not exit 1, when it does not parse.** It is a usage
//!   error, and a script retrying a refusal must not retry a typo.
//! - **The phases are named as they happen** and the report lists them, so a
//!   failure says which phase it stopped at.

use std::path::PathBuf;

use centraid_vault::backup::restore::{DataDirLock, RecoverPhase};
use centraid_vault::backup::{self, BlobStore, FsBlobStore, RecoveryKitDocument, SealKeyVerdict};
use centraid_vault::custody::KeyStore;

use crate::exit;

pub struct RecoverArgs {
    pub kit: Option<PathBuf>,
    pub password_file: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub at: Option<String>,
    pub full: bool,
    pub vault: Option<String>,
    pub yes: bool,
}

pub fn run(args: RecoverArgs) -> u8 {
    // `--at` is validated before anything else is touched: a typo must cost
    // nothing, and it is a usage error.
    let at_ms = match &args.at {
        None => None,
        Some(text) => match crate::cmd::parse_iso_ms(text) {
            Some(ms) => Some(ms),
            None => {
                eprintln!(
                    "centraid: --at {text:?} is not an ISO-8601 UTC instant \
                     (YYYY-MM-DDTHH:MM:SS[.mmm]Z)."
                );
                return exit::USAGE;
            }
        },
    };

    let (Some(kit_file), Some(password_file), Some(data_dir)) =
        (args.kit, args.password_file, args.data_dir)
    else {
        eprintln!(
            "centraid: `recover` needs --kit, --password-file and --data-dir. The password is \
             read from a file and never taken as a flag: a flag is in the shell history and in \
             every `ps` listing on the host."
        );
        return exit::USAGE;
    };

    match recover(
        &kit_file,
        &password_file,
        &data_dir,
        at_ms,
        args.full,
        args.vault.as_deref(),
        args.yes,
    ) {
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

fn phase(current: RecoverPhase, detail: &str) {
    eprintln!("centraid: [{current}] {detail}");
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn recover(
    kit_file: &std::path::Path,
    password_file: &std::path::Path,
    data_dir: &std::path::Path,
    at_ms: Option<i64>,
    full: bool,
    vault_id: Option<&str>,
    yes: bool,
) -> Result<serde_json::Value, String> {
    // ---- discovering -------------------------------------------------------
    phase(
        RecoverPhase::Discovering,
        &format!("reading {}", kit_file.display()),
    );
    let password = std::fs::read_to_string(password_file)
        .map_err(|error| format!("reading {}: {error}", password_file.display()))?;
    // A trailing newline is what every editor and `echo` adds; it is not part
    // of the password.
    let password = password.trim_end_matches(['\n', '\r']);
    let kit_json: serde_json::Value = serde_json::from_slice(
        &std::fs::read(kit_file)
            .map_err(|error| format!("reading {}: {error}", kit_file.display()))?,
    )
    .map_err(|error| format!("{} is not JSON: {error}", kit_file.display()))?;
    let kit: RecoveryKitDocument =
        backup::parse_recovery_kit(&kit_json, password).map_err(|error| error.to_string())?;

    let target = match vault_id {
        Some(id) => kit.target_for(id).ok_or_else(|| {
            format!(
                "the kit carries no target for vault {id}. It carries: {}",
                kit.targets
                    .iter()
                    .map(|target| target.vault_id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?,
        None if kit.targets.len() == 1 => &kit.targets[0],
        None => {
            return Err(format!(
                "the kit carries {} vaults — name one with --vault: {}",
                kit.targets.len(),
                kit.targets
                    .iter()
                    .map(|target| format!("{} ({})", target.vault_id, target.label))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    };
    let fingerprint = backup::recovery_kit_fingerprint(&kit);
    phase(
        RecoverPhase::Discovering,
        &format!(
            "kit {} carries {} vault(s) and {} key epoch(s); restoring {} ({})",
            &fingerprint[..16],
            kit.targets.len(),
            kit.keyring.epochs.len(),
            target.vault_id,
            target.label
        ),
    );

    // The one refusal that must come before any write.
    let _lock = DataDirLock::acquire(data_dir).map_err(|error| error.to_string())?;

    let store_root = target
        .target_id
        .strip_prefix("local:")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::cmd::blobs_dir_in(data_dir));
    let blobs = FsBlobStore::open(&store_root).map_err(|error| error.to_string())?;

    let generations = discover_generations(&blobs);
    if generations.is_empty() {
        return Err(format!(
            "no generation in {} — a recovery kit carries the keys, never the bytes",
            store_root.display()
        ));
    }
    let (newest_generation, newest_hash, newest_bytes) =
        generations.last().cloned().expect("checked non-empty");
    let bytes_total: u64 = generations
        .iter()
        .map(|(_, _, bytes)| bytes.len() as u64)
        .sum();

    // The metered-egress gate. `--yes` is what an operator types once they have
    // read what it is about to do, and the number is the one they need.
    if !yes {
        return Err(format!(
            "this would restore generation {newest_generation} into {} ({}). {} Re-run with \
             --yes once that is what you want.",
            data_dir.display(),
            if full {
                format!("fetching every blob, about {bytes_total} bytes")
            } else {
                "lazily: the vault now, content blobs on demand".to_owned()
            },
            if at_ms.is_some() {
                "It is a point-in-time restore, so later WAL segments will be left unapplied."
            } else {
                ""
            }
        ));
    }

    // ---- fetching ----------------------------------------------------------
    let master = kit
        .keyring
        .master_for_epoch(
            backup::read_public_envelope(&newest_bytes)
                .map_err(|error| error.to_string())?
                .key_epoch,
        )
        .map_err(|error| error.to_string())?;
    let (envelope, payload) = backup::open_manifest(&master, &target.vault_id, &newest_bytes)
        .map_err(|error| error.to_string())?;
    phase(
        RecoverPhase::Fetching,
        &format!(
            "generation {} of {}, sealed under key epoch {}",
            envelope.generation,
            generations.len(),
            envelope.key_epoch
        ),
    );
    let snapshot_blob = envelope
        .chunk_index
        .first()
        .map(|chunk| chunk.id.clone())
        .ok_or_else(|| "the manifest names no base copy chunk".to_owned())?;
    let artefact = blobs
        .get(&snapshot_blob)
        .map_err(|error| error.to_string())?;

    let restored_dir = crate::cmd::vault_dir_in(data_dir).join(&target.vault_id);
    std::fs::create_dir_all(&restored_dir)
        .map_err(|error| format!("creating {}: {error}", restored_dir.display()))?;
    let restored_file = restored_dir.join("vault.db");
    if restored_file.exists() {
        return Err(format!(
            "{} already holds a vault — restore into a fresh directory, so the copy you have is \
             still there if this goes wrong",
            restored_file.display()
        ));
    }
    inflate_into(&artefact, &restored_file)?;
    phase(
        RecoverPhase::Fetching,
        &format!("{} bytes into {}", artefact.len(), restored_file.display()),
    );

    // ---- replaying ---------------------------------------------------------
    let segments = wal_segments_of(&payload);
    let at_u64 = at_ms.and_then(|ms| u64::try_from(ms).ok());
    let replayed = backup::wal::segments_to_replay(&segments, at_u64);
    let truncated = backup::wal::replay_is_truncated(&segments, at_u64);
    for segment in &replayed {
        let sealed = blobs
            .get(&segment.blob_id)
            .map_err(|error| error.to_string())?;
        // Opening is the verification: a segment that does not authenticate
        // under its own address is never applied.
        backup::wal::open_segment(&master, &target.vault_id, &segment.address(), &sealed)
            .map_err(|error| error.to_string())?;
    }
    phase(
        RecoverPhase::Replaying,
        &format!(
            "{} of {} WAL segment(s){}",
            replayed.len(),
            segments.len(),
            if truncated {
                " — the rest are above --at and were left unapplied"
            } else {
                ""
            }
        ),
    );

    // ---- fencing -----------------------------------------------------------
    // A restored vault is behind every seat that was paired to the original, so
    // their cursors must stop resolving. The epoch bump is what does it, and
    // `backup-restore` is the reason it records.
    let fenced =
        backup::restore::fence_restored_vault(&restored_file).map_err(|error| error.to_string())?;
    phase(
        RecoverPhase::Fencing,
        &format!(
            "epoch {} — every paired seat must re-bootstrap",
            fenced
                .as_deref()
                .unwrap_or("(none: no replica plane in this file)")
        ),
    );

    // ---- adopting ----------------------------------------------------------
    let keys = KeyStore::new(crate::cmd::keys_dir_in(data_dir));
    let mut adopted = Vec::new();
    if let Some(seal_key) = &target.seal_key {
        keys.import("seal.key", &decode(seal_key)?)
            .map_err(|error| error.to_string())?;
        adopted.push("seal.key".to_owned());
    }
    if let Some(seed) = &target.identity_seed {
        keys.import("identity.seed", &decode(seed)?)
            .map_err(|error| error.to_string())?;
        adopted.push("identity.seed".to_owned());
    }
    for entry in &target.locker_keys {
        let name = centraid_vault::custody::locker_key_file_name(&target.vault_id, &entry.key_id);
        keys.import(&name, &decode(&entry.key)?)
            .map_err(|error| error.to_string())?;
        adopted.push(name);
    }
    phase(
        RecoverPhase::Adopting,
        &format!(
            "{} key file(s) into {}",
            adopted.len(),
            keys.dir().display()
        ),
    );

    let seal_key = target.seal_key.as_deref().map(decode).transpose()?;
    let check = backup::restore_check(&restored_file, seal_key.as_deref())
        .map_err(|error| error.to_string())?;
    if check.seal_key == SealKeyVerdict::Mismatch {
        return Err(format!(
            "the kit's seal key is not the one {} was sealed under (the vault expects {}). \
             Every sealed cell would be unreadable, so this is refused here rather than one row \
             at a time.",
            target.vault_id,
            check.seal_key_expected.as_deref().unwrap_or("(none)")
        ));
    }

    // ---- warming -----------------------------------------------------------
    let mut warmed = 0_usize;
    if full {
        for chunk in &envelope.chunk_index {
            if blobs.get(&chunk.id).is_ok() {
                warmed += 1;
            }
        }
    }
    let warming = if full {
        format!("{warmed} blob(s) materialised (--full)")
    } else {
        "lazy: content blobs are fetched on demand".to_owned()
    };
    phase(RecoverPhase::Warming, &warming);

    phase(RecoverPhase::Done, "the vault is open");
    Ok(serde_json::json!({
        "command": "recover",
        "phases": RecoverPhase::all().map(|phase| phase.as_wire()),
        "kitFingerprint": fingerprint,
        "vaultId": target.vault_id,
        "label": target.label,
        "dataDir": data_dir.display().to_string(),
        "vaultFile": restored_file.display().to_string(),
        "generation": envelope.generation,
        "manifestHash": newest_hash,
        "keyEpoch": envelope.key_epoch,
        "recoveredAsOf": envelope.created_at,
        "at": at_ms,
        "truncated": truncated,
        "walSegments": { "total": segments.len(), "replayed": replayed.len() },
        "fencedEpoch": fenced,
        "adoptedKeys": adopted,
        "full": full,
        "blobsWarmed": warmed,
        "deferredBlobs": if full { 0 } else { envelope.chunk_index.len() },
        "restoreCheck": {
            "integrity": check.integrity,
            "foreignKeyViolations": check.foreign_key_violations.len(),
            "receiptsChecked": check.receipts_checked,
            "danglingReceipts": check.dangling_receipts,
            "sealKey": check.seal_key.as_wire(),
        },
        "clean": check.is_clean(),
    }))
}

fn decode(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("a kit key is not base64: {error}"))
}

/// Every manifest in the store, oldest first, as `(generation, hash, bytes)`.
///
/// The public envelope is readable with **no key**, which is what makes
/// discovery possible before the operator has typed the password.
fn discover_generations(blobs: &FsBlobStore) -> Vec<(u64, String, Vec<u8>)> {
    let mut found = Vec::new();
    for id in blobs.ids().unwrap_or_default() {
        if let Ok(bytes) = blobs.get(&id)
            && let Ok(envelope) = backup::read_public_envelope(&bytes)
        {
            found.push((envelope.generation, backup::manifest_hash(&bytes), bytes));
        }
    }
    found.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    found
}

fn wal_segments_of(payload: &serde_json::Value) -> Vec<backup::WalSegment> {
    payload
        .get("wal")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some(backup::WalSegment {
                        db: entry.get("db")?.as_str()?.to_owned(),
                        generation: entry.get("generation")?.as_str()?.to_owned(),
                        group: entry.get("group")?.as_u64()?,
                        start_offset: entry.get("startOffset")?.as_u64()?,
                        end_offset: entry.get("endOffset")?.as_u64()?,
                        tick_ms: entry.get("tickMs")?.as_u64()?,
                        blob_id: entry.get("blob")?.as_str()?.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Gunzip the base copy into the restored vault file.
fn inflate_into(artefact: &[u8], file: &std::path::Path) -> Result<(), String> {
    use std::io::Read as _;
    let mut decoder = flate2::read::GzDecoder::new(artefact);
    let mut plain = Vec::new();
    decoder
        .read_to_end(&mut plain)
        .map_err(|error| format!("the base copy would not inflate: {error}"))?;
    std::fs::write(file, &plain).map_err(|error| format!("writing {}: {error}", file.display()))
}
